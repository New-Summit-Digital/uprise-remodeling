-- ============================================================
-- Publishing Safeguards — adds visibility + smoke-test support
-- ============================================================
-- 1. publish_attempts log table  → every publish attempt writes here
-- 2. social_media_posts.is_smoke_test  → flag to distinguish test posts from real
-- 3. social_media_posts.watchdog_alerted_at  → dedupe watchdog alerts
-- ============================================================

-- 1. Log every publish attempt per platform, whether success or fail
create table if not exists public.publish_attempts (
  id uuid primary key default gen_random_uuid(),
  post_id uuid references public.social_media_posts(id) on delete cascade,
  platform text not null,                  -- 'facebook' | 'instagram' | 'google_business'
  success boolean not null,
  response jsonb default '{}'::jsonb,      -- full API response (or error shape)
  error_message text,                      -- denormalised for easier filtering
  attempted_at timestamptz default now() not null
);

create index if not exists publish_attempts_post_id_idx on public.publish_attempts(post_id);
create index if not exists publish_attempts_attempted_at_idx on public.publish_attempts(attempted_at desc);
create index if not exists publish_attempts_success_idx on public.publish_attempts(success) where success = false;

alter table public.publish_attempts enable row level security;

-- Only service_role writes; admins can read
drop policy if exists "service role writes publish_attempts" on public.publish_attempts;
create policy "service role writes publish_attempts"
  on public.publish_attempts for all
  to service_role
  using (true) with check (true);

drop policy if exists "admins read publish_attempts" on public.publish_attempts;
create policy "admins read publish_attempts"
  on public.publish_attempts for select
  to authenticated
  using (public.has_role(auth.uid(), 'admin'::public.app_role));

-- 2. Flag for smoke-test posts so the watchdog treats them differently
--    and the UI can filter them out of the main social feed.
alter table public.social_media_posts
  add column if not exists is_smoke_test boolean default false not null;

alter table public.social_media_posts
  add column if not exists watchdog_alerted_at timestamptz;

create index if not exists social_media_posts_smoke_test_idx
  on public.social_media_posts(is_smoke_test) where is_smoke_test = true;

create index if not exists social_media_posts_stuck_posts_idx
  on public.social_media_posts(status, scheduled_at)
  where status = 'scheduled';
