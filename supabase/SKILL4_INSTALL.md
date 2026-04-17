# Summit Skill 4 — Deploy the Automation Pipeline for Uprise

Follow these 6 steps in order. Budget ~30 minutes if you have all the API keys ready.

---

## Step 1 — Collect API keys (do this FIRST, before terminal)

Open accounts + copy keys into a notes doc:

| Key | Where to get it | Required for |
|---|---|---|
| `ANTHROPIC_API_KEY` | https://console.anthropic.com/settings/keys | Text generation |
| `GOOGLE_API_KEY` | https://aistudio.google.com/apikey | Image generation (Gemini) |
| `FAL_API_KEY` | https://fal.ai/dashboard/keys | Image fallback + video |
| `FIRECRAWL_API_KEY` | https://firecrawl.dev/app/api-keys | Keyword research |
| `RESEND_API_KEY` | https://resend.com/api-keys | Email notifications |
| `CRON_SECRET` | Generate: run `openssl rand -hex 32` in terminal | Cron auth |

**Don't skip any** — functions that miss a secret will silently fail when triggered.

---

## Step 2 — Enable auto-recharge on paid APIs

Prevents mid-month outages embarrassing the agency:
- Anthropic: https://console.anthropic.com/settings/billing → Auto-recharge ON
- FAL: https://fal.ai/dashboard/billing → Auto-recharge ON
- Resend is free tier for now

---

## Step 3 — Apply migrations to Supabase

The repo has 2 new migration files that create the base schema + safeguards:

```bash
cd "/Users/elizabeth/Library/CloudStorage/GoogleDrive-liz@bucherdigital.io/Shared drives/New Summit Digital/GITHUB WEBSITE REPOS LOCAL/uprise-remodeling"

supabase link --project-ref pmxrjlxfppjpwnrpqmjj
# Enter DB password when prompted

supabase db push
```

This runs (in order):
1. `20260417000000_skill4_base_schema.sql` — creates app_role, has_role(), admin_whitelist, ai_generated_photos, social_media_posts, platform_credentials, media_library, form_email_log, image_optimization_logs, newsletter_subscribers, user_roles (12 tables + policies)
2. `20260417000001_publish_attempts_and_smoke_flag.sql` — adds publish_attempts table + is_smoke_test column

All statements are idempotent (IF NOT EXISTS) so re-running is safe.

**Verify:** Open the Supabase Table Editor and confirm these tables exist: `ai_generated_photos`, `social_media_posts`, `platform_credentials`, `publish_attempts`, `admin_whitelist`.

---

## Step 4 — Set Supabase secrets

From the same terminal:

```bash
supabase secrets set ANTHROPIC_API_KEY="paste-here"
supabase secrets set GOOGLE_API_KEY="paste-here"
supabase secrets set FAL_API_KEY="paste-here"
supabase secrets set FIRECRAWL_API_KEY="paste-here"
supabase secrets set RESEND_API_KEY="paste-here"
supabase secrets set CRON_SECRET="$(openssl rand -hex 32)"
```

Save the CRON_SECRET value — you need it in Step 6.

---

## Step 5 — Deploy edge functions

```bash
# Pre-deploy safety check (verifies verify_jwt=false on all cron functions)
python3 scripts/predeploy-check.py
# Must exit with "OK" — fix any missing config.toml entries before continuing

# Deploy all 18 functions in one shot
for fn in publish-social-posts publish-watchdog smoke-test-socials notify-editor \
          meta-token-exchange sync-google-reviews google-business-setup \
          google-discover-locations google-oauth-callback google-reviews-callback \
          keyword-research generate-ai-photo optimize-image \
          generate-blog generate-social gsc-search-analytics; do
  echo ">>> deploying $fn"
  supabase functions deploy "$fn"
done
```

This takes ~3-5 minutes. Watch for any failures.

---

## Step 6 — Install cron jobs

1. Open `supabase/cron-jobs-MANUAL.sql` in your editor
2. Replace `PASTE_CRON_SECRET_HERE` with the CRON_SECRET value from Step 4
3. Open Supabase SQL Editor: https://supabase.com/dashboard/project/pmxrjlxfppjpwnrpqmjj/sql/new
4. Paste the entire file contents and click **Run**

This installs 6 crons:
- `publish-social-posts` every 15 min (publishes scheduled posts)
- `auto-generate-monthly-posts` on the 25th at 6am UTC (generates next month)
- `publish-watchdog` hourly at :05 (alerts on stuck posts)
- `smoke-test-socials` weekly Mondays 6am UTC (pipeline health check)
- `trending-scanner` and `performance-tracker` (monthly)

Verify via: `SELECT * FROM cron.job;` in SQL editor.

---

## Step 7 — Seed admin_whitelist

Add yourself (and any editor emails) so the notify-editor function has someone to email:

```sql
-- Run in Supabase SQL Editor
INSERT INTO public.admin_whitelist (email, role)
VALUES ('liz@bucherdigital.io', 'admin')
ON CONFLICT (email) DO NOTHING;

-- Add editor(s) if applicable:
-- INSERT INTO public.admin_whitelist (email, role)
-- VALUES ('jorge@upriseremodeling.com', 'editor')
-- ON CONFLICT (email) DO NOTHING;
```

---

## Step 8 — Connect social platforms

**Facebook + Instagram** (via Meta):
1. In Supabase SQL editor, manually insert the Meta long-lived page token into `platform_credentials`:
   ```sql
   INSERT INTO public.platform_credentials (platform, credentials)
   VALUES ('meta', '{"page_id": "YOUR_FB_PAGE_ID", "page_access_token": "EAAxxxx..."}')
   ON CONFLICT (platform) DO UPDATE SET credentials = EXCLUDED.credentials;
   ```
2. Auto-discover the Instagram Business Account ID:
   ```bash
   python3 scripts/ig-autodiscover.py
   ```

**Google Business Profile**: use the OAuth flow (wired into admin dashboard) or run `supabase functions invoke google-oauth-callback` manually.

---

## Step 9 — Smoke test end-to-end

```bash
python3 scripts/queue-test-post.py
# Note the UUID it prints

# Wait ~16 minutes for the next */15 cron fire

python3 scripts/check-test-post.py <uuid>
# Every platform should show `published`
```

If a platform shows `failed`:
- Check `publish_attempts.error_message` for details
- Common: Meta API 403 → token expired (run `meta-token-exchange`)
- Common: GBP 403 → Google My Business API not enabled (enable in Cloud Console)

---

## ✅ Done — automation is live

Once the smoke test passes, the pipeline will:
- Generate posts from the content calendar on schedule
- Queue them in the approval queue (email sent via notify-editor)
- Publish approved posts to all connected platforms every 15 min
- Watchdog alerts you if anything stalls
- Weekly smoke test catches silent regressions

---

## Rollback plan (if something goes sideways)

**To disable automation without deleting anything:**
```sql
-- Pause all crons
SELECT cron.unschedule(jobname)
FROM cron.job
WHERE jobname IN (
  'publish-social-posts', 'auto-generate-monthly-posts',
  'publish-watchdog', 'smoke-test-socials'
);
```

**To re-enable:** re-run `supabase/cron-jobs-MANUAL.sql`.

The site itself is totally independent — it'll keep running no matter what happens with automation.
