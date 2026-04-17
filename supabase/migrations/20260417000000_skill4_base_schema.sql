-- ═══════════════════════════════════════════════════════════════════════════
-- Summit Skill 4 Base Schema for Uprise Remodeling
-- ═══════════════════════════════════════════════════════════════════════════
-- Extracted from the generic portion of the BDD production schema
-- (skipped dog-breeder-specific tables: litters, puppies, parent_dogs, puppy_sales)
-- All statements are idempotent (IF NOT EXISTS / DROP IF EXISTS patterns) so
-- this can be re-run safely against a project that already has partial tables.
-- ═══════════════════════════════════════════════════════════════════════════

--
-- PostgreSQL database dump
--

-- (restrict line removed)

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.9

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

-- COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: app_role; Type: TYPE; Schema: public; Owner: -
--

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_role') THEN
    CREATE TYPE public.app_role AS ENUM ('admin',
    'user',
    'viewer',
    'editor');
  END IF;
END $$;


--
-- Name: auto_grant_admin_on_signup(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auto_grant_admin_on_signup() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  whitelist_role public.app_role;
BEGIN
  -- Check if the new user's email is in the whitelist and get the role
  SELECT role INTO whitelist_role 
  FROM public.admin_whitelist 
  WHERE LOWER(email) = LOWER(NEW.email);
  
  IF whitelist_role IS NOT NULL THEN
    -- Grant the specified role
    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.id, whitelist_role)
    ON CONFLICT (user_id, role) DO NOTHING;
    
    -- Mark whitelist entry as used
    UPDATE public.admin_whitelist 
    SET used_at = now() 
    WHERE LOWER(email) = LOWER(NEW.email);
  END IF;
  
  RETURN NEW;
END;
$$;


--
-- Name: has_role(uuid, public.app_role); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.user_roles
        WHERE user_id = _user_id
          AND role = _role
    )
$$;


--
-- Name: is_editor_or_admin(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_editor_or_admin(_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role IN ('admin', 'editor')
  )
$$;


--
-- Name: is_viewer_or_admin(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_viewer_or_admin(_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role IN ('admin', 'viewer')
  )
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_whitelist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.admin_whitelist (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    used_at timestamp with time zone,
    role public.app_role DEFAULT 'admin'::public.app_role NOT NULL
);


--
-- Name: ai_generated_photos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.ai_generated_photos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    file_name text NOT NULL,
    file_url text NOT NULL,
    file_size integer,
    prompt text NOT NULL,
    style text DEFAULT 'lifestyle'::text,
    tags text[] DEFAULT '{}'::text[],
    category text DEFAULT 'general'::text,
    associated_post_id uuid,
    approved boolean DEFAULT false,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: blog_posts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.blog_posts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    slug text NOT NULL,
    excerpt text NOT NULL,
    content text NOT NULL,
    featured_image text,
    category text DEFAULT 'general'::text NOT NULL,
    tags text[] DEFAULT '{}'::text[],
    author text DEFAULT 'Blessed Day Doodles'::text NOT NULL,
    is_published boolean DEFAULT false NOT NULL,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: content_automation_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.content_automation_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    config_type text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    generation_day integer DEFAULT 25 NOT NULL,
    posts_per_month integer DEFAULT 30 NOT NULL,
    posts_per_day integer DEFAULT 1 NOT NULL,
    time_slots text[] DEFAULT '{09:00,15:00}'::text[] NOT NULL,
    content_mix jsonb DEFAULT '{}'::jsonb NOT NULL,
    start_date date,
    end_date date,
    last_run_at timestamp with time zone,
    next_run_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT content_automation_config_config_type_check CHECK ((config_type = ANY (ARRAY['social'::text, 'blog'::text]))),
    CONSTRAINT content_automation_config_generation_day_check CHECK (((generation_day >= 1) AND (generation_day <= 28)))
);


--
-- Name: form_email_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.form_email_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    form_type text NOT NULL,
    recipient_email text NOT NULL,
    notification_status text DEFAULT 'pending'::text NOT NULL,
    notification_resend_id text,
    confirmation_status text DEFAULT 'pending'::text NOT NULL,
    confirmation_resend_id text,
    error_message text,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    lead_source text,
    utm_source text,
    utm_medium text,
    utm_campaign text
);


--
-- Name: image_optimization_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.image_optimization_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    file_name text NOT NULL,
    bucket text NOT NULL,
    original_size integer NOT NULL,
    optimized_size integer NOT NULL,
    original_format text,
    output_format text DEFAULT 'webp'::text NOT NULL,
    width integer,
    height integer,
    success boolean DEFAULT true NOT NULL,
    error_message text
);


--
-- Name: media_library; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.media_library (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    file_name text NOT NULL,
    file_url text NOT NULL,
    file_size integer,
    mime_type text,
    alt_text text,
    tags text[] DEFAULT '{}'::text[],
    category text DEFAULT 'general'::text,
    uploaded_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    brand_approved boolean DEFAULT false NOT NULL
);


--
-- Name: newsletter_subscribers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.newsletter_subscribers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    subscribed_at timestamp with time zone DEFAULT now() NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    source text DEFAULT 'blog'::text
);


--
-- Name: platform_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.platform_credentials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    platform text NOT NULL,
    credentials jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.reviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reviewer_name text NOT NULL,
    rating integer NOT NULL,
    review_text text,
    source text DEFAULT 'manual'::text NOT NULL,
    source_review_id text,
    review_date timestamp with time zone DEFAULT now() NOT NULL,
    reviewer_avatar text,
    is_visible boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5))),
    CONSTRAINT reviews_source_check CHECK ((source = ANY (ARRAY['google'::text, 'facebook'::text, 'manual'::text])))
);


--
-- Name: social_media_posts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.social_media_posts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    content text NOT NULL,
    platforms text[] DEFAULT '{}'::text[] NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    scheduled_at timestamp with time zone,
    published_at timestamp with time zone,
    media_ids uuid[] DEFAULT '{}'::uuid[],
    category text DEFAULT 'general'::text,
    hashtags text[] DEFAULT '{}'::text[],
    ai_generated boolean DEFAULT false,
    notes text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.user_roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    role public.app_role NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_whitelist admin_whitelist_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_whitelist
    ADD CONSTRAINT admin_whitelist_email_key UNIQUE (email);


--
-- Name: admin_whitelist admin_whitelist_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_whitelist
    ADD CONSTRAINT admin_whitelist_pkey PRIMARY KEY (id);


--
-- Name: ai_generated_photos ai_generated_photos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_generated_photos
    ADD CONSTRAINT ai_generated_photos_pkey PRIMARY KEY (id);


--
-- Name: blog_posts blog_posts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blog_posts
    ADD CONSTRAINT blog_posts_pkey PRIMARY KEY (id);


--
-- Name: blog_posts blog_posts_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blog_posts
    ADD CONSTRAINT blog_posts_slug_key UNIQUE (slug);


--
-- Name: content_automation_config content_automation_config_config_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_automation_config
    ADD CONSTRAINT content_automation_config_config_type_key UNIQUE (config_type);


--
-- Name: content_automation_config content_automation_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_automation_config
    ADD CONSTRAINT content_automation_config_pkey PRIMARY KEY (id);


--
-- Name: form_email_log form_email_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_email_log
    ADD CONSTRAINT form_email_log_pkey PRIMARY KEY (id);


--
-- Name: image_optimization_logs image_optimization_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_optimization_logs
    ADD CONSTRAINT image_optimization_logs_pkey PRIMARY KEY (id);


--
-- Name: media_library media_library_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_library
    ADD CONSTRAINT media_library_pkey PRIMARY KEY (id);


--
-- Name: newsletter_subscribers newsletter_subscribers_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.newsletter_subscribers
    ADD CONSTRAINT newsletter_subscribers_email_key UNIQUE (email);


--
-- Name: newsletter_subscribers newsletter_subscribers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.newsletter_subscribers
    ADD CONSTRAINT newsletter_subscribers_pkey PRIMARY KEY (id);


--
-- Name: platform_credentials platform_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_credentials
    ADD CONSTRAINT platform_credentials_pkey PRIMARY KEY (id);


--
-- Name: platform_credentials platform_credentials_platform_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_credentials
    ADD CONSTRAINT platform_credentials_platform_key UNIQUE (platform);


--
-- Name: reviews reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_pkey PRIMARY KEY (id);


--
-- Name: social_media_posts social_media_posts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_media_posts
    ADD CONSTRAINT social_media_posts_pkey PRIMARY KEY (id);


--
-- Name: user_roles user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (id);


--
-- Name: user_roles user_roles_user_id_role_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_role_key UNIQUE (user_id, role);


--
-- Name: idx_blog_posts_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_blog_posts_category ON public.blog_posts USING btree (category);


--
-- Name: idx_blog_posts_published; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_blog_posts_published ON public.blog_posts USING btree (is_published, published_at DESC);


--
-- Name: idx_blog_posts_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_blog_posts_slug ON public.blog_posts USING btree (slug);


--
-- Name: idx_reviews_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_reviews_source ON public.reviews USING btree (source);


--
-- Name: idx_reviews_visible; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_reviews_visible ON public.reviews USING btree (is_visible) WHERE (is_visible = true);


--
-- Name: ai_generated_photos update_ai_generated_photos_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

DROP TRIGGER IF EXISTS update_ai_generated_photos_updated_at ON public.ai_generated_photos;
CREATE TRIGGER update_ai_generated_photos_updated_at BEFORE UPDATE ON public.ai_generated_photos FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: blog_posts update_blog_posts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

DROP TRIGGER IF EXISTS update_blog_posts_updated_at ON public.blog_posts;
CREATE TRIGGER update_blog_posts_updated_at BEFORE UPDATE ON public.blog_posts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: content_automation_config update_content_automation_config_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

DROP TRIGGER IF EXISTS update_content_automation_config_updated_at ON public.content_automation_config;
CREATE TRIGGER update_content_automation_config_updated_at BEFORE UPDATE ON public.content_automation_config FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: media_library update_media_library_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

DROP TRIGGER IF EXISTS update_media_library_updated_at ON public.media_library;
CREATE TRIGGER update_media_library_updated_at BEFORE UPDATE ON public.media_library FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: platform_credentials update_platform_credentials_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

DROP TRIGGER IF EXISTS update_platform_credentials_updated_at ON public.platform_credentials;
CREATE TRIGGER update_platform_credentials_updated_at BEFORE UPDATE ON public.platform_credentials FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: reviews update_reviews_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

DROP TRIGGER IF EXISTS update_reviews_updated_at ON public.reviews;
CREATE TRIGGER update_reviews_updated_at BEFORE UPDATE ON public.reviews FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: social_media_posts update_social_media_posts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

DROP TRIGGER IF EXISTS update_social_media_posts_updated_at ON public.social_media_posts;
CREATE TRIGGER update_social_media_posts_updated_at BEFORE UPDATE ON public.social_media_posts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: ai_generated_photos ai_generated_photos_associated_post_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_generated_photos
    ADD CONSTRAINT ai_generated_photos_associated_post_id_fkey FOREIGN KEY (associated_post_id) REFERENCES public.social_media_posts(id) ON DELETE SET NULL;


--
-- Name: media_library media_library_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_library
    ADD CONSTRAINT media_library_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES auth.users(id);


--
-- Name: social_media_posts social_media_posts_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_media_posts
    ADD CONSTRAINT social_media_posts_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: user_roles user_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: ai_generated_photos Admins can delete AI photos; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Admins can delete AI photos" ON public.ai_generated_photos;
CREATE POLICY "Admins can delete AI photos" ON public.ai_generated_photos FOR DELETE USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: blog_posts Admins can delete blog posts; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Admins can delete blog posts" ON public.blog_posts;
CREATE POLICY "Admins can delete blog posts" ON public.blog_posts FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: content_automation_config Admins can delete config; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Admins can delete config" ON public.content_automation_config;
CREATE POLICY "Admins can delete config" ON public.content_automation_config FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: image_optimization_logs Admins can delete optimization logs; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Admins can delete optimization logs" ON public.image_optimization_logs;
CREATE POLICY "Admins can delete optimization logs" ON public.image_optimization_logs FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: platform_credentials Admins can delete platform credentials; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Admins can delete platform credentials" ON public.platform_credentials;
CREATE POLICY "Admins can delete platform credentials" ON public.platform_credentials FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: reviews Admins can delete reviews; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Admins can delete reviews" ON public.reviews;
CREATE POLICY "Admins can delete reviews" ON public.reviews FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: newsletter_subscribers Admins can delete subscribers; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Admins can delete subscribers" ON public.newsletter_subscribers;
CREATE POLICY "Admins can delete subscribers" ON public.newsletter_subscribers FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: content_automation_config Admins can insert config; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Admins can insert config" ON public.content_automation_config;
CREATE POLICY "Admins can insert config" ON public.content_automation_config FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: platform_credentials Admins can insert platform credentials; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Admins can insert platform credentials" ON public.platform_credentials;
CREATE POLICY "Admins can insert platform credentials" ON public.platform_credentials FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: reviews Admins can insert reviews; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Admins can insert reviews" ON public.reviews;
CREATE POLICY "Admins can insert reviews" ON public.reviews FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: image_optimization_logs Admins can manage optimization logs; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Admins can manage optimization logs" ON public.image_optimization_logs;
CREATE POLICY "Admins can manage optimization logs" ON public.image_optimization_logs FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: admin_whitelist Admins can manage whitelist; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Admins can manage whitelist" ON public.admin_whitelist;
CREATE POLICY "Admins can manage whitelist" ON public.admin_whitelist TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: platform_credentials Admins can select platform credentials; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Admins can select platform credentials" ON public.platform_credentials;
CREATE POLICY "Admins can select platform credentials" ON public.platform_credentials FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: image_optimization_logs Admins can update optimization logs; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Admins can update optimization logs" ON public.image_optimization_logs;
CREATE POLICY "Admins can update optimization logs" ON public.image_optimization_logs FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: platform_credentials Admins can update platform credentials; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Admins can update platform credentials" ON public.platform_credentials;
CREATE POLICY "Admins can update platform credentials" ON public.platform_credentials FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: reviews Admins can update reviews; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Admins can update reviews" ON public.reviews;
CREATE POLICY "Admins can update reviews" ON public.reviews FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: newsletter_subscribers Admins can update subscribers; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Admins can update subscribers" ON public.newsletter_subscribers;
CREATE POLICY "Admins can update subscribers" ON public.newsletter_subscribers FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: form_email_log Admins can view email logs; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Admins can view email logs" ON public.form_email_log;
CREATE POLICY "Admins can view email logs" ON public.form_email_log FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: newsletter_subscribers Admins can view subscribers; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Admins can view subscribers" ON public.newsletter_subscribers;
CREATE POLICY "Admins can view subscribers" ON public.newsletter_subscribers FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: admin_whitelist Admins can view whitelist; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Admins can view whitelist" ON public.admin_whitelist;
CREATE POLICY "Admins can view whitelist" ON public.admin_whitelist FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: newsletter_subscribers Anyone can subscribe to newsletter; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Anyone can subscribe to newsletter" ON public.newsletter_subscribers;
CREATE POLICY "Anyone can subscribe to newsletter" ON public.newsletter_subscribers FOR INSERT TO authenticated, anon WITH CHECK (((email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'::text) AND (is_active = true) AND ((source IS NULL) OR (source = ANY (ARRAY['blog'::text, 'popup'::text, 'footer'::text, 'application'::text, 'contact'::text])))));


--
-- Name: blog_posts Anyone can view published blog posts; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Anyone can view published blog posts" ON public.blog_posts;
CREATE POLICY "Anyone can view published blog posts" ON public.blog_posts FOR SELECT USING ((is_published = true));


--
-- Name: reviews Anyone can view visible reviews; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Anyone can view visible reviews" ON public.reviews;
CREATE POLICY "Anyone can view visible reviews" ON public.reviews FOR SELECT USING ((is_visible = true));


--
-- Name: media_library Editors and admins can delete media; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Editors and admins can delete media" ON public.media_library;
CREATE POLICY "Editors and admins can delete media" ON public.media_library FOR DELETE TO authenticated USING (public.is_editor_or_admin(auth.uid()));


--
-- Name: social_media_posts Editors and admins can delete social posts; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Editors and admins can delete social posts" ON public.social_media_posts;
CREATE POLICY "Editors and admins can delete social posts" ON public.social_media_posts FOR DELETE TO authenticated USING (public.is_editor_or_admin(auth.uid()));


--
-- Name: ai_generated_photos Editors and admins can insert AI photos; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Editors and admins can insert AI photos" ON public.ai_generated_photos;
CREATE POLICY "Editors and admins can insert AI photos" ON public.ai_generated_photos FOR INSERT WITH CHECK (public.is_editor_or_admin(auth.uid()));


--
-- Name: blog_posts Editors and admins can insert blog posts; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Editors and admins can insert blog posts" ON public.blog_posts;
CREATE POLICY "Editors and admins can insert blog posts" ON public.blog_posts FOR INSERT TO authenticated WITH CHECK (public.is_editor_or_admin(auth.uid()));


--
-- Name: media_library Editors and admins can insert media; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Editors and admins can insert media" ON public.media_library;
CREATE POLICY "Editors and admins can insert media" ON public.media_library FOR INSERT TO authenticated WITH CHECK (public.is_editor_or_admin(auth.uid()));


--
-- Name: social_media_posts Editors and admins can insert social posts; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Editors and admins can insert social posts" ON public.social_media_posts;
CREATE POLICY "Editors and admins can insert social posts" ON public.social_media_posts FOR INSERT TO authenticated WITH CHECK (public.is_editor_or_admin(auth.uid()));


--
-- Name: content_automation_config Editors and admins can select config; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Editors and admins can select config" ON public.content_automation_config;
CREATE POLICY "Editors and admins can select config" ON public.content_automation_config FOR SELECT TO authenticated USING (public.is_editor_or_admin(auth.uid()));


--
-- Name: media_library Editors and admins can select media; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Editors and admins can select media" ON public.media_library;
CREATE POLICY "Editors and admins can select media" ON public.media_library FOR SELECT TO authenticated USING (public.is_editor_or_admin(auth.uid()));


--
-- Name: social_media_posts Editors and admins can select social posts; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Editors and admins can select social posts" ON public.social_media_posts;
CREATE POLICY "Editors and admins can select social posts" ON public.social_media_posts FOR SELECT TO authenticated USING (public.is_editor_or_admin(auth.uid()));


--
-- Name: ai_generated_photos Editors and admins can update AI photos; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Editors and admins can update AI photos" ON public.ai_generated_photos;
CREATE POLICY "Editors and admins can update AI photos" ON public.ai_generated_photos FOR UPDATE USING (public.is_editor_or_admin(auth.uid()));


--
-- Name: blog_posts Editors and admins can update blog posts; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Editors and admins can update blog posts" ON public.blog_posts;
CREATE POLICY "Editors and admins can update blog posts" ON public.blog_posts FOR UPDATE TO authenticated USING (public.is_editor_or_admin(auth.uid()));


--
-- Name: content_automation_config Editors and admins can update config; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Editors and admins can update config" ON public.content_automation_config;
CREATE POLICY "Editors and admins can update config" ON public.content_automation_config FOR UPDATE TO authenticated USING (public.is_editor_or_admin(auth.uid()));


--
-- Name: media_library Editors and admins can update media; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Editors and admins can update media" ON public.media_library;
CREATE POLICY "Editors and admins can update media" ON public.media_library FOR UPDATE TO authenticated USING (public.is_editor_or_admin(auth.uid()));


--
-- Name: social_media_posts Editors and admins can update social posts; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Editors and admins can update social posts" ON public.social_media_posts;
CREATE POLICY "Editors and admins can update social posts" ON public.social_media_posts FOR UPDATE TO authenticated USING (public.is_editor_or_admin(auth.uid()));


--
-- Name: ai_generated_photos Editors and admins can view AI photos; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Editors and admins can view AI photos" ON public.ai_generated_photos;
CREATE POLICY "Editors and admins can view AI photos" ON public.ai_generated_photos FOR SELECT USING (public.is_editor_or_admin(auth.uid()));


--
-- Name: blog_posts Editors and admins can view all blog posts; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Editors and admins can view all blog posts" ON public.blog_posts;
CREATE POLICY "Editors and admins can view all blog posts" ON public.blog_posts FOR SELECT TO authenticated USING (public.is_editor_or_admin(auth.uid()));


--
-- Name: reviews Editors and admins can view all reviews; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Editors and admins can view all reviews" ON public.reviews;
CREATE POLICY "Editors and admins can view all reviews" ON public.reviews FOR SELECT TO authenticated USING (public.is_editor_or_admin(auth.uid()));


--
-- Name: form_email_log Editors and admins can view email logs; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Editors and admins can view email logs" ON public.form_email_log;
CREATE POLICY "Editors and admins can view email logs" ON public.form_email_log FOR SELECT TO authenticated USING (public.is_editor_or_admin(auth.uid()));


--
-- Name: image_optimization_logs Editors and admins can view optimization logs; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Editors and admins can view optimization logs" ON public.image_optimization_logs;
CREATE POLICY "Editors and admins can view optimization logs" ON public.image_optimization_logs FOR SELECT TO authenticated USING (public.is_editor_or_admin(auth.uid()));


--
-- Name: reviews Editors can delete reviews; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Editors can delete reviews" ON public.reviews;
CREATE POLICY "Editors can delete reviews" ON public.reviews FOR DELETE TO authenticated USING (public.is_editor_or_admin(auth.uid()));


--
-- Name: reviews Editors can insert reviews; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Editors can insert reviews" ON public.reviews;
CREATE POLICY "Editors can insert reviews" ON public.reviews FOR INSERT TO authenticated WITH CHECK (public.is_editor_or_admin(auth.uid()));


--
-- Name: reviews Editors can update reviews; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Editors can update reviews" ON public.reviews;
CREATE POLICY "Editors can update reviews" ON public.reviews FOR UPDATE TO authenticated USING (public.is_editor_or_admin(auth.uid()));


--
-- Name: user_roles Only admins can delete user roles; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Only admins can delete user roles" ON public.user_roles;
CREATE POLICY "Only admins can delete user roles" ON public.user_roles FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: user_roles Only admins can insert user roles; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Only admins can insert user roles" ON public.user_roles;
CREATE POLICY "Only admins can insert user roles" ON public.user_roles FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: admin_whitelist Only admins can read admin whitelist; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Only admins can read admin whitelist" ON public.admin_whitelist;
CREATE POLICY "Only admins can read admin whitelist" ON public.admin_whitelist FOR SELECT USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: user_roles Only admins can update user roles; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Only admins can update user roles" ON public.user_roles;
CREATE POLICY "Only admins can update user roles" ON public.user_roles FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: user_roles Users can view own roles; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Users can view own roles" ON public.user_roles;
CREATE POLICY "Users can view own roles" ON public.user_roles FOR SELECT TO authenticated USING ((auth.uid() = user_id));


--
-- Name: blog_posts Viewers can view all blog posts; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Viewers can view all blog posts" ON public.blog_posts;
CREATE POLICY "Viewers can view all blog posts" ON public.blog_posts FOR SELECT TO authenticated USING (public.is_viewer_or_admin(auth.uid()));


--
-- Name: reviews Viewers can view all reviews; Type: POLICY; Schema: public; Owner: -
--

DROP POLICY IF EXISTS "Viewers can view all reviews" ON public.reviews;
CREATE POLICY "Viewers can view all reviews" ON public.reviews FOR SELECT TO authenticated USING (public.is_viewer_or_admin(auth.uid()));


--
-- Name: admin_whitelist; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_whitelist ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_generated_photos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_generated_photos ENABLE ROW LEVEL SECURITY;

--
-- Name: blog_posts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.blog_posts ENABLE ROW LEVEL SECURITY;

--
-- Name: content_automation_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.content_automation_config ENABLE ROW LEVEL SECURITY;

--
-- Name: form_email_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.form_email_log ENABLE ROW LEVEL SECURITY;

--
-- Name: image_optimization_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.image_optimization_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: media_library; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.media_library ENABLE ROW LEVEL SECURITY;

--
-- Name: newsletter_subscribers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.newsletter_subscribers ENABLE ROW LEVEL SECURITY;

--
-- Name: platform_credentials; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.platform_credentials ENABLE ROW LEVEL SECURITY;

--
-- Name: reviews; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;

--
-- Name: social_media_posts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.social_media_posts ENABLE ROW LEVEL SECURITY;

--
-- Name: user_roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

-- (unrestrict line removed)

