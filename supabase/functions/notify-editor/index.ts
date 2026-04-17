// supabase/functions/notify-editor/index.ts
//
// Sends an email to the editor/admin when new content is ready for review.
// Called by content generation functions (generate-blog, generate-social, bulk-generate)
// after they queue content for review.
//
// Pulls recipient emails from admin_whitelist (admin + editor roles).
// Uses Resend API (RESEND_API_KEY env var).
//
// NOTE: Written fresh for the new project — original Lovable source was not retrievable.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Update FROM_ADDRESS to whatever verified domain/address you have in Resend.
// Until the custom domain is verified, the function falls back to Resend's
// onboarding@resend.dev sender.
const FROM_ADDRESS = "Uprise Remodeling & Design <notifications@upriseremodeling.com>";
const FALLBACK_FROM = "onboarding@resend.dev";
const DASHBOARD_REVIEW_URL = "https://upriseremodeling.com/admin/review";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    if (!RESEND_API_KEY) {
      return json({ error: "RESEND_API_KEY not configured" }, 500);
    }

    const body = await req.json().catch(() => ({}));
    const {
      content_type = "social",
      count = 0,
      details = "",
      override_recipients,
    } = body;

    let recipients: string[] = [];
    if (Array.isArray(override_recipients) && override_recipients.length > 0) {
      recipients = override_recipients.filter((e: any) => typeof e === "string");
    } else {
      const adminClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
      );
      const { data: whitelist } = await adminClient
        .from("admin_whitelist")
        .select("email, role")
        .in("role", ["admin", "editor"]);

      recipients = (whitelist || []).map((r: any) => r.email).filter(Boolean);
    }

    if (recipients.length === 0) {
      console.warn("No recipients found in admin_whitelist — skipping notification");
      return json({ sent: 0, reason: "No recipients configured" });
    }

    const contentTypeLabels: Record<string, string> = {
      social: "social media posts",
      blog: "blog articles",
      project_spotlight: "project spotlight",
      review: "reviews",
    };
    const label = contentTypeLabels[content_type] || content_type;

    const subject = count === 1
      ? `New ${label} ready for review`
      : `${count} new ${label} ready for review`;

    const htmlBody = `<!DOCTYPE html>
<html>
<head><style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #faf5f0; padding: 20px; }
  .card { max-width: 560px; margin: 40px auto; background: white; border-radius: 12px; padding: 32px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); }
  h1 { color: #7a2e1f; margin-top: 0; }
  .summary { background: #f5ede6; border-radius: 8px; padding: 16px; margin: 20px 0; }
  .cta { display: inline-block; margin-top: 12px; padding: 12px 24px; background: #7a2e1f; color: white; text-decoration: none; border-radius: 8px; font-weight: 600; }
  .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #eee; font-size: 12px; color: #999; }
</style></head>
<body>
  <div class="card">
    <h1>🐾 Content ready for review</h1>
    <p>Hi there!</p>
    <p>${count === 1 ? "One" : count} new ${label} ${count === 1 ? "is" : "are"} waiting for your approval.</p>
    <div class="summary">
      <strong>Details:</strong><br>
      ${details || "Check the dashboard for full details."}
    </div>
    <a href="${DASHBOARD_REVIEW_URL}" class="cta">Review and Approve →</a>
    <div class="footer">
      You're receiving this because you're an admin or editor for Uprise Remodeling & Design.<br>
      Automated notification from the content automation engine.
    </div>
  </div>
</body>
</html>`;

    const textBody = `${subject}\n\n${details || "Check the dashboard for full details."}\n\nReview: ${DASHBOARD_REVIEW_URL}`;

    const results = await Promise.all(
      recipients.map((to) => sendEmail({
        to, subject, html: htmlBody, text: textBody, apiKey: RESEND_API_KEY,
      }))
    );

    const succeeded = results.filter((r) => r.ok).length;
    const failed = results.length - succeeded;

    console.log(`notify-editor: sent ${succeeded}/${results.length} (failed: ${failed})`);

    return json({
      sent: succeeded,
      failed,
      recipients: recipients.length,
      failures: results.filter((r) => !r.ok).map((r) => r.error),
    });

  } catch (error: any) {
    console.error("notify-editor error:", error);
    return json({ error: error.message || "Internal error" }, 500);
  }
});

async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
  apiKey: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    let res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      if (res.status === 403 || errBody.includes("domain") || errBody.includes("not verified")) {
        console.warn(`Custom from address rejected, falling back to ${FALLBACK_FROM}`);
        res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: FALLBACK_FROM,
            to: opts.to,
            subject: opts.subject,
            html: opts.html,
            text: opts.text,
          }),
        });
        if (!res.ok) {
          const fallbackErr = await res.text();
          return { ok: false, error: `Resend fallback failed: ${fallbackErr.substring(0, 200)}` };
        }
      } else {
        return { ok: false, error: `Resend error ${res.status}: ${errBody.substring(0, 200)}` };
      }
    }

    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
