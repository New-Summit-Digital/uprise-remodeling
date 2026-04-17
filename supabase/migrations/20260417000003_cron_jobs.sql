-- ============================================================
-- Uprise Remodeling — Skill 4 Cron Jobs — run this in Supabase SQL Editor ONCE
-- Replace PASTE_CRON_SECRET_HERE with your CRON_SECRET before running
-- ============================================================

-- Enable pg_net (required for cron jobs to call edge functions)
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema extensions;

-- Reusable helper to avoid duplicating the long call chain
do $$
declare
  fn_base text := 'https://pmxrjlxfppjpwnrpqmjj.supabase.co/functions/v1/';
  cron_secret text := 'PASTE_CRON_SECRET_HERE';  -- ← REPLACE THIS
begin

  -- 1. Publish scheduled social posts every 15 minutes
  perform cron.schedule(
    'publish-social-posts',
    '*/15 * * * *',
    format($sql$
      select net.http_post(
        url := '%s' || 'publish-social-posts',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', %L
        ),
        body := jsonb_build_object('cron_secret', %L)
      ) as request_id
    $sql$, fn_base, cron_secret, cron_secret)
  );

  -- 2. Generate next month's social posts on the 25th at 6am UTC (midnight CT)
  perform cron.schedule(
    'auto-generate-monthly-posts',
    '0 6 25 * *',
    format($sql$
      select net.http_post(
        url := '%s' || 'auto-generate-monthly-posts',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', %L
        ),
        body := jsonb_build_object('cron_secret', %L)
      ) as request_id
    $sql$, fn_base, cron_secret, cron_secret)
  );

  -- 3. Generate blog articles on the 25th at 7am UTC (1 hour after social)
  perform cron.schedule(
    'generate-blog-articles',
    '0 7 25 * *',
    format($sql$
      select net.http_post(
        url := '%s' || 'generate-blog-articles',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', %L
        ),
        body := jsonb_build_object('auto_generate', true, 'cron_secret', %L)
      ) as request_id
    $sql$, fn_base, cron_secret, cron_secret)
  );

  -- 4. Daily puppy spotlight at 1am UTC (7pm CT the night before — arrives in approval queue)
  perform cron.schedule(
    'generate-puppy-post',
    '0 1 * * *',
    format($sql$
      select net.http_post(
        url := '%s' || 'generate-puppy-post',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', %L
        ),
        body := jsonb_build_object('cron_secret', %L)
      ) as request_id
    $sql$, fn_base, cron_secret, cron_secret)
  );

  -- 5. Weekly Meta token refresh (Sundays at 3am UTC)
  perform cron.schedule(
    'meta-token-refresh',
    '0 3 * * 0',
    format($sql$
      select net.http_post(
        url := '%s' || 'meta-token-exchange',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', %L
        ),
        body := jsonb_build_object('action', 'refresh-token', 'cron_secret', %L)
      ) as request_id
    $sql$, fn_base, cron_secret, cron_secret)
  );

  -- 6. Google reviews sync daily at 2am UTC
  perform cron.schedule(
    'sync-google-reviews',
    '0 2 * * *',
    format($sql$
      select net.http_post(
        url := '%s' || 'sync-google-reviews',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', %L
        ),
        body := '{}'::jsonb
      ) as request_id
    $sql$, fn_base, cron_secret)
  );

  -- 7. Publish watchdog — every hour. Alerts if any post is stuck in
  --    status='scheduled' more than 30 min past its scheduled_at.
  perform cron.schedule(
    'publish-watchdog',
    '5 * * * *',
    format($sql$
      select net.http_post(
        url := '%s' || 'publish-watchdog',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', %L
        ),
        body := jsonb_build_object('cron_secret', %L)
      ) as request_id
    $sql$, fn_base, cron_secret, cron_secret)
  );

  -- 8. Weekly smoke test — Mondays at 6am UTC. Queues a real multi-platform
  --    test post, lets publish-social-posts + publish-watchdog detect failures.
  perform cron.schedule(
    'smoke-test-socials',
    '0 6 * * 1',
    format($sql$
      select net.http_post(
        url := '%s' || 'smoke-test-socials',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', %L
        ),
        body := jsonb_build_object('cron_secret', %L)
      ) as request_id
    $sql$, fn_base, cron_secret, cron_secret)
  );

end $$;

-- Verify
select jobname, schedule, active from cron.job order by jobname;
