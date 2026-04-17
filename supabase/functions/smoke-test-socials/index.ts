// supabase/functions/smoke-test-socials/index.ts
//
// Weekly automated smoke test of the full social publishing pipeline.
//
// Behaviour:
//   1. Queues a social_media_post with is_smoke_test=true, scheduled 1 min ago,
//      targeting facebook + instagram + google_business.
//   2. Returns immediately. The */15 cron running publish-social-posts will pick
//      it up and try to publish on the real accounts.
//   3. The hourly publish-watchdog will alert if it's still stuck 30 min later.
//   4. A second cron entry for smoke-test-socials-followup runs 25 min after
//      the initial queue to auto-delete the smoke post from the live platforms
//      so it doesn't clutter the customer's real feed.
//
// Can also be invoked manually from the admin dashboard ("Run Smoke Test Now").
//
// Secrets required:
//   CRON_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Auth: cron secret only. verify_jwt=false in config.toml.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SMOKE_CONTENT =
  "🧪 Internal system check — please ignore. (Uprise Remodeling & Design automated publish test.)";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    // Auth
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

    // Find a media item to attach (smoke posts still need an image for IG to work)
    const { data: imgs } = await supabase
      .from("media_library")
      .select("id, file_url")
      .order("created_at", { ascending: false })
      .limit(10);

    const media = (imgs || []).find((m: any) => m.file_url);
    if (!media) {
      return json({ error: "media_library is empty — cannot smoke-test without an image" }, 500);
    }

    // Queue the smoke-test post, scheduled 1 min in the past
    const scheduledAt = new Date(Date.now() - 60_000).toISOString();
    const { data: inserted, error } = await supabase
      .from("social_media_posts")
      .insert({
        content: SMOKE_CONTENT,
        platforms: ["facebook", "instagram", "google_business"],
        status: "scheduled",
        scheduled_at: scheduledAt,
        media_ids: [media.id],
        category: "smoke_test",
        hashtags: [],
        ai_generated: false,
        is_smoke_test: true,
        notes: "Automated weekly smoke test of publish pipeline",
      })
      .select("id,scheduled_at")
      .single();

    if (error) {
      console.error("smoke-test insert failed:", error);
      return json({ error: error.message }, 500);
    }

    console.log(`Smoke test queued: ${inserted.id}`);
    return json({
      ok: true,
      smoke_post_id: inserted.id,
      scheduled_at: inserted.scheduled_at,
      note: "publish-social-posts cron will pick this up within 15 min. publish-watchdog will alert if it's still stuck after 30 min.",
    });
  } catch (e) {
    console.error("smoke-test fatal:", e);
    return json({ error: (e as Error).message }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
