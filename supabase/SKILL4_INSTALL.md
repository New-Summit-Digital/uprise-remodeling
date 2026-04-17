# Summit Skill 4 — Content Automation Install Guide (Uprise)

This repo is **scaffolded** with the new Skill 4 content automation pipeline but NOT deployed yet. Nothing here is running against Supabase until you follow the steps below.

**Do not worry — the live site is unaffected.** These files sit in the repo waiting until you explicitly deploy them.

---

## What was installed (Apr 17, 2026)

### 16 edge functions (18 total including existing GSC function)
New / from Skill 4 reference:
- `publish-social-posts` — posts to FB/IG/LinkedIn/GBP WITH IMAGE ATTACHED (replaces old buggy `publish-social`)
- `publish-watchdog` — hourly cron, emails you if posts get stuck
- `smoke-test-socials` — weekly cron, proactively tests the publish pipeline
- `notify-editor` — sends "new content ready for review" emails via Resend
- `meta-token-exchange` — refreshes Facebook/Instagram tokens
- `sync-google-reviews` — pulls latest reviews from Google Business Profile
- `google-business-setup`, `google-discover-locations`, `google-oauth-callback`, `google-reviews-callback` — OAuth flows for GBP
- `keyword-research` — Firecrawl + Gemini keyword discovery for remodeling topics
- `generate-ai-photo` — Gemini-primary / FAL-fallback image generation (no-text enforced)
- `optimize-image` — WebP/AVIF conversion + compression

Kept from Uprise's original build:
- `generate-blog`, `generate-social` — remodeling-tailored generators (unchanged)
- `gsc-search-analytics` — Search Console data for admin dashboard

Removed (replaced or BDD-specific):
- `publish-social` → replaced by `publish-social-posts`
- `content-scheduler` → replaced by cron jobs in `20260417000003_cron_jobs.sql`

### 2 migration SQL files
- `20260417000001_publish_attempts_and_smoke_flag.sql` — safeguard schema
- `20260417000003_cron_jobs.sql` — 6 cron schedules

### 4 helper scripts in `/scripts`
- `predeploy-check.py` — verifies `verify_jwt = false` on all cron-called functions
- `queue-test-post.py` — queues a smoke-test post
- `check-test-post.py` — verifies the test post published
- `ig-autodiscover.py` — auto-detects Instagram Business Account from Meta token

### `config.toml` updates
Added `verify_jwt = false` for 16 functions (see Skill 4 rule #7 — prevents the silent cron-401 bug that broke BDD for 2 days).

---

## Before you deploy — prerequisites

### ⚠️ Schema prerequisite
The new edge functions expect these tables, which **do NOT exist in Uprise's current Supabase schema**:
- `social_media_posts` (Uprise has `generated_social_posts` — different name)
- `ai_generated_photos` (Uprise has `generated_media` — different name)
- `platform_credentials` (Uprise has `social_accounts` — different name)
- `media_library`
- `form_email_log`
- `image_optimization_logs`
- `admin_whitelist`
- `user_roles` + `app_role` type + `has_role()` function

**Deploying without creating these tables WILL cause runtime errors.**

Two paths forward:

**Path A — Defer deployment:** Leave this scaffolding in the repo until you're ready to actually launch automation. Nothing breaks.

**Path B — Deploy now:** Requires a prep session to create the schema. Rough plan:
1. Extract the generic table definitions from the reference `bdd-production-schema.sql` (skipping dog-specific tables)
2. Write an Uprise-specific base schema migration
3. Apply it to Supabase
4. Then run the steps below

---

## Deployment steps (when ready)

### 1. Set Supabase secrets
```bash
supabase link --project-ref pmxrjlxfppjpwnrpqmjj
supabase secrets set ANTHROPIC_API_KEY="sk-ant-..."
supabase secrets set GOOGLE_API_KEY="..."           # for Gemini image generation
supabase secrets set FAL_API_KEY="..."              # image fallback + video
supabase secrets set FIRECRAWL_API_KEY="..."        # keyword research
supabase secrets set RESEND_API_KEY="re_..."        # notifications
supabase secrets set CRON_SECRET="$(openssl rand -hex 32)"
```

### 2. Apply migrations
```bash
# After the base schema prerequisites are done:
supabase db push
```

### 3. Run predeploy check
```bash
python3 scripts/predeploy-check.py
# Must exit 0 before deploying functions
```

### 4. Deploy all edge functions
```bash
for fn in publish-social-posts publish-watchdog smoke-test-socials notify-editor \
          meta-token-exchange sync-google-reviews google-business-setup \
          google-discover-locations google-oauth-callback google-reviews-callback \
          keyword-research generate-ai-photo optimize-image; do
  supabase functions deploy "$fn"
done
```

### 5. Apply cron jobs
Open `supabase/migrations/20260417000003_cron_jobs.sql`, replace `PASTE_CRON_SECRET_HERE` with the CRON_SECRET value from step 1, then paste into Supabase SQL editor and run.

### 6. Smoke test end-to-end
```bash
python3 scripts/queue-test-post.py
# Wait 15 minutes for the cron to fire
python3 scripts/check-test-post.py <post-uuid>
```

---

## What's NOT included

- **Niche-specific `auto-tag-image` function** — BDD version was dog-photo-specific. Uprise would need a remodeling photo tagger. Deferred.
- **Niche-specific `auto-generate-monthly-posts`** — BDD version had puppy-specific content mix. Uprise would need a remodeling content mix. Deferred.
- **Niche-specific `bulk-generate-posts`** — same reason. Deferred.
- **Niche-specific `send-form-email`** — BDD version had guardian-home and puppy-inquiry email templates. Uprise form flows different. Deferred.

When Uprise actually starts publishing automated content, these can be written from the Uprise remodeling context.

---

## Reference
- Skill location: `~/.claude/skills/summit-4-automate/`
- Rule #7 (verify_jwt): the BDD outage that justifies the config.toml changes
- Rule #16 (image-required publishing): the reason `publish-social-posts` replaces `publish-social`
- Rule #42 (four-layer safeguard): publish_attempts + watchdog + smoke-test + predeploy-check
