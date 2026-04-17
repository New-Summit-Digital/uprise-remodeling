// supabase/functions/publish-watchdog/index.ts
//
// Cron-triggered watchdog that catches silent publish failures.
//
// Runs hourly (see cron-jobs.sql). Queries for social_media_posts rows that are
// still status='scheduled' more than 30 min past their scheduled_at. If any are
// found, emails the admin team via Resend so stuck posts can never go unnoticed.
//
// Every alert sets watchdog_alerted_at on the affected rows so the same stuck
// post doesn't re-alert every hour forever.
//
// Secrets required:
//   RESEND_API_KEY, CRON_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Auth: accepts x-cron-secret header or body.cron_secret. verify_jwt=false in config.toml.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const FROM_ADDRESS = "Uprise Remodeling & Design <alerts@upriseremodeling.com>";
const FALLBACK_FROM = "onboarding@resend.dev";
const STUCK_THRESHOLD_MINUTES = 30;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    // 1. Auth — cron secret only; this function is not user-invokable
    const cronSecret = Deno.env.get("CRON_SECRET");
    const cronHeader = req.headers.get("x-cron-secret") || "";
    const body = await req.json().catch(() => ({}));
    if (!cronSecret || (cronHeader !== cronSecret && body.cron_secret !== cronSecret)) {
      return json({ error: "Unauthorized" }, 401);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 2. Find stuck posts: status='scheduled' AND scheduled_at older than threshold
    //    AND either never alerted OR last alert was > 24h ago (re-alert daily)
    const thresholdIso = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60_000).toISOString();
    const realertIso = new Date(Date.now() - 24 * 60 * 60_000).toISOString();

    const { data: stuck, error: queryError } = await supabase
      .from("social_media_posts")
      .select("id, content, platforms, scheduled_at, watchdog_alerted_at, is_smoke_test")
      .eq("status", "scheduled")
      .lte("scheduled_at", thresholdIso)
      .or(`watchdog_alerted_at.is.null,watchdog_alerted_at.lte.${realertIso}`)
      .order("scheduled_at", { ascending: true })
      .limit(50);

    if (queryError) {
      console.error("watchdog query failed:", queryError);
      return json({ error: queryError.message }, 500);
    }

    if (!stuck || stuck.length === 0) {
      return json({ stuck_count: 0, alerted: false });
    }

    console.log(`Watchdog found ${stuck.length} stuck post(s)`);

    // 3. Pull alert recipients (anyone in user_roles with admin or editor)
    const recipients = await resolveRecipients(supabase);
    if (recipients.length === 0) {
      console.error("watchdog: no recipients configured");
      return json({ stuck_count: stuck.length, alerted: false, reason: "no recipients" }, 500);
    }

    // 4. Send the alert email
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    if (!RESEND_API_KEY) {
      return json({ error: "RESEND_API_KEY not configured" }, 500);
    }

    const emailResult = await sendAlert(RESEND_API_KEY, recipients, stuck);

    // 5. Mark these rows as alerted so we don't re-alert for 24h
    const stuckIds = stuck.map((s) => s.id);
    await supabase
      .from("social_media_posts")
      .update({ watchdog_alerted_at: new Date().toISOString() })
      .in("id", stuckIds);

    return json({
      stuck_count: stuck.length,
      alerted: true,
      recipients: recipients.length,
      email_id: emailResult.id,
      stuck_post_ids: stuckIds,
    });
  } catch (e) {
    console.error("watchdog fatal:", e);
    return json({ error: (e as Error).message }, 500);
  }
});

// ────────────────────────────────────────────────────────────

async function resolveRecipients(supabase: any): Promise<string[]> {
  // Join user_roles → auth.users via the existing admin_whitelist pattern.
  // The simplest + safest query: pull all emails from admin_whitelist.
  const { data, error } = await supabase.from("admin_whitelist").select("email");
  if (error || !data) return [];
  return data.map((r: any) => r.email).filter(Boolean);
}

async function sendAlert(apiKey: string, recipients: string[], stuck: any[]) {
  const rows = stuck
    .map((s) => {
      const age = humanAge(new Date(s.scheduled_at));
      const platforms = Array.isArray(s.platforms) ? s.platforms.join(", ") : s.platforms;
      const preview = (s.content || "").replace(/\s+/g, " ").slice(0, 80);
      const smoke = s.is_smoke_test ? " 🧪 [SMOKE TEST]" : "";
      return `<li><b>${s.id}</b>${smoke} — scheduled ${age} ago<br>
        <span style="color:#666">platforms: ${platforms}</span><br>
        <span style="color:#666">"${preview}${preview.length === 80 ? "…" : ""}"</span></li>`;
    })
    .join("\n");

  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:640px;margin:0 auto;padding:24px">
      <h2 style="color:#c00;margin-bottom:8px">⚠️ ${stuck.length} scheduled post(s) are stuck</h2>
      <p>These posts have been in <code>status='scheduled'</code> for more than ${STUCK_THRESHOLD_MINUTES} min past their <code>scheduled_at</code>. The publish-social-posts cron should have fired them already.</p>
      <p><b>Most likely causes:</b></p>
      <ul>
        <li>Edge function is returning an error before it can update the post row (check Supabase → Functions → publish-social-posts → Logs)</li>
        <li>Cron job is no longer reaching the function (probe with: <code>curl -i https://<project>.supabase.co/functions/v1/publish-social-posts</code>)</li>
        <li>Platform credentials expired (Meta token, Google OAuth refresh_token)</li>
      </ul>
      <h3>Stuck posts</h3>
      <ul>${rows}</ul>
      <p style="color:#888;font-size:12px;margin-top:24px">Watchdog fires hourly. Fixed posts will not re-alert for 24h.</p>
    </div>
  `;

  const payload = {
    from: FROM_ADDRESS,
    to: recipients,
    subject: `⚠️ ${stuck.length} stuck social post(s) — publish pipeline may be broken`,
    html,
  };

  let res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  // Fallback from-address if the custom domain isn't verified yet
  if (res.status === 403) {
    payload.from = FALLBACK_FROM;
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Resend failed: ${res.status} ${errText}`);
  }
  return await res.json();
}

function humanAge(then: Date): string {
  const mins = Math.floor((Date.now() - then.getTime()) / 60_000);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
