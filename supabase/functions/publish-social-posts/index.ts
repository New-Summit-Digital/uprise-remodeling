// supabase/functions/publish-social-posts/index.ts
//
// Cron-triggered publisher. Fetches scheduled social_media_posts that are due,
// auto-attaches images (real photo first, AI-generated fallback), publishes to
// Facebook, Instagram, and Google Business Profile, then updates post status.
//
// Changes from Lovable version:
//   - AI image generation: Lovable Gateway → Gemini direct (GOOGLE_API_KEY)
//   - Everything else unchanged (Meta Graph API, Google Business API already direct)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const cronSecret = Deno.env.get("CRON_SECRET");

    const authHeader = req.headers.get("authorization") || "";
    const cronHeader = req.headers.get("x-cron-secret") || "";
    const body = await req.json().catch(() => ({}));

    const isCron = (cronSecret && (body.cron_secret === cronSecret || cronHeader === cronSecret));

    if (!isCron) {
      const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user }, error: userError } = await userClient.auth.getUser();
      if (userError || !user) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }
      const adminClient = createClient(supabaseUrl, serviceRoleKey);
      const { data: roleData } = await adminClient
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .eq("role", "admin")
        .maybeSingle();
      if (!roleData) {
        return jsonResponse({ error: "Admin access required" }, 403);
      }
    }

    const client = createClient(supabaseUrl, serviceRoleKey);

    const now = new Date().toISOString();
    const { data: posts, error: fetchError } = await client
      .from("social_media_posts")
      .select("*")
      .eq("status", "scheduled")
      .lte("scheduled_at", now)
      .order("scheduled_at", { ascending: true })
      .limit(20);

    if (fetchError) {
      console.error("Failed to fetch posts:", fetchError);
      return jsonResponse({ error: fetchError.message }, 500);
    }

    if (!posts || posts.length === 0) {
      console.log("No posts due for publishing");
      return jsonResponse({ published: 0, message: "No posts due" });
    }

    console.log(`Found ${posts.length} posts to publish`);

    for (const post of posts) {
      if (post.media_ids && post.media_ids.length > 0) continue;
      console.log(`Post ${post.id} has no image — attempting auto-match...`);
      const imageId = await autoAttachImage(client, post);
      if (imageId) {
        post.media_ids = [imageId];
        await client.from("social_media_posts").update({ media_ids: [imageId] }).eq("id", post.id);
        console.log(`Post ${post.id}: attached image ${imageId}`);
      } else {
        console.log(`Post ${post.id}: publishing without image`);
      }
    }

    const { data: metaCreds } = await client
      .from("platform_credentials")
      .select("credentials")
      .eq("platform", "meta")
      .maybeSingle();

    let meta = metaCreds?.credentials as any;

    if (meta?.long_lived_user_token && meta?.app_id && meta?.app_secret) {
      meta = await refreshMetaTokens(client, meta);
    }

    let googleRefreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN") || "";
    let googleClientId = Deno.env.get("GOOGLE_CLIENT_ID") || "";
    let googleClientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET") || "";
    let googleLocationName = Deno.env.get("GOOGLE_LOCATION_NAME") || "";
    let googleAccountName = Deno.env.get("GOOGLE_ACCOUNT_NAME") || "";

    const { data: googleCreds } = await client
      .from("platform_credentials")
      .select("credentials")
      .eq("platform", "google_business")
      .maybeSingle();

    if (googleCreds?.credentials) {
      const gc = googleCreds.credentials as any;
      googleClientId = gc.client_id || googleClientId;
      googleClientSecret = gc.client_secret || googleClientSecret;
      googleRefreshToken = gc.refresh_token || googleRefreshToken;
      googleLocationName = gc.location_name || googleLocationName;
      if (gc.account_name && gc.account_name.startsWith("accounts/")) {
        googleAccountName = gc.account_name;
      }
    }

    if (meta?.page_access_token && meta?.page_id && !meta?.instagram_account_id) {
      try {
        const igRes = await fetch(
          `https://graph.facebook.com/v21.0/${meta.page_id}?fields=instagram_business_account&access_token=${meta.page_access_token}`
        );
        const igData = await igRes.json();
        if (igData.instagram_business_account?.id) {
          meta.instagram_account_id = igData.instagram_business_account.id;
          await client.from("platform_credentials").upsert(
            { platform: "meta", credentials: meta },
            { onConflict: "platform" }
          );
          console.log(`IG account discovered: ${meta.instagram_account_id}`);
        }
      } catch (igErr: any) {
        console.error("IG discovery error:", igErr.message);
      }
    }

    const allMediaIds = posts.flatMap((p: any) => p.media_ids || []);
    let mediaMap: Record<string, string> = {};
    if (allMediaIds.length > 0) {
      const { data: mediaItems } = await client
        .from("media_library").select("id, file_url").in("id", allMediaIds);
      const { data: aiMediaItems } = await client
        .from("ai_generated_photos").select("id, file_url").in("id", allMediaIds);
      if (mediaItems) {
        mediaMap = Object.fromEntries(mediaItems.map((m: any) => [m.id, m.file_url]));
      }
      if (aiMediaItems) {
        for (const m of aiMediaItems) mediaMap[m.id] = m.file_url;
      }
    }

    const results: any[] = [];

    for (const post of posts) {
      const postResults: Record<string, any> = {};
      const platforms = post.platforms || [];
      const content = post.content || "";
      const hashtags = post.hashtags || [];
      const fullContent = hashtags.length > 0
        ? `${content}\n\n${hashtags.map((h: string) => h.startsWith("#") ? h : `#${h}`).join(" ")}`
        : content;
      const imageUrls: string[] = (post.media_ids || [])
        .map((id: string) => mediaMap[id])
        .filter(Boolean);
      const imageUrl = imageUrls[0] || null;
      const isCarousel = imageUrls.length > 1;

      if (platforms.includes("facebook") && meta?.page_access_token && meta?.page_id) {
        try {
          postResults.facebook = isCarousel
            ? await publishCarouselToFacebook(meta.page_id, meta.page_access_token, fullContent, imageUrls)
            : await publishToFacebook(meta.page_id, meta.page_access_token, fullContent, imageUrl);
        } catch (e: any) {
          postResults.facebook = { error: e.message, code: e.code, subcode: e.subcode, fbType: e.fbType, fbtrace_id: e.fbtrace_id };
        }
      }

      if (platforms.includes("instagram") && meta?.page_access_token && meta?.instagram_account_id) {
        try {
          postResults.instagram = isCarousel
            ? await publishCarouselToInstagram(meta.instagram_account_id, meta.page_access_token, fullContent, imageUrls)
            : await publishToInstagram(meta.instagram_account_id, meta.page_access_token, fullContent, imageUrl);
        } catch (e: any) {
          postResults.instagram = { error: e.message, code: e.code, subcode: e.subcode, fbType: e.fbType, fbtrace_id: e.fbtrace_id };
        }
      }

      if (
        platforms.includes("google_business") &&
        googleRefreshToken && googleClientId && googleClientSecret && googleLocationName
      ) {
        try {
          postResults.google_business = await publishToGoogleBusiness(
            googleClientId, googleClientSecret, googleRefreshToken,
            googleLocationName, fullContent, imageUrl, googleAccountName
          );
        } catch (e: any) {
          postResults.google_business = { error: e.message };
        }
      }

      const anySuccess = Object.values(postResults).some((r: any) => !r.error);
      const existingNotes = post.notes || "";
      const publishResultStr = JSON.stringify(postResults);
      const updateData: any = {};
      if (anySuccess) {
        updateData.status = "published";
        updateData.published_at = new Date().toISOString();
        updateData.notes = existingNotes ? `${existingNotes} | PUBLISH: ${publishResultStr}` : publishResultStr;
      } else {
        updateData.status = "draft";
        updateData.notes = existingNotes ? `${existingNotes} | PUBLISH FAILED: ${publishResultStr}` : `PUBLISH FAILED: ${publishResultStr}`;
      }
      await client.from("social_media_posts").update(updateData).eq("id", post.id);

      // Log every publish attempt to publish_attempts (one row per platform).
      // This is the observability layer — the watchdog + admin dashboard read from here.
      const attemptRows = Object.entries(postResults).map(([platform, resp]: [string, any]) => ({
        post_id: post.id,
        platform,
        success: !resp?.error,
        response: resp ?? {},
        error_message: resp?.error ?? null,
      }));
      if (attemptRows.length > 0) {
        const { error: logErr } = await client.from("publish_attempts").insert(attemptRows);
        if (logErr) console.error(`publish_attempts insert failed for ${post.id}:`, logErr.message);
      }

      results.push({ id: post.id, ...postResults, published: anySuccess });
    }

    const publishedCount = results.filter((r) => r.published).length;
    console.log(`Published ${publishedCount}/${posts.length} posts`);

    return jsonResponse({ published: publishedCount, total: posts.length, results });
  } catch (error: any) {
    console.error("Publish error:", error);
    return jsonResponse({ error: error.message }, 500);
  }
});

// ─── Auto Image Pipeline ──────────────────────────────────

async function autoAttachImage(client: any, post: any): Promise<string | null> {
  const category = post.category || "general";
  const content = (post.content || "").toLowerCase();

  const realPhotoId = await matchRealPhoto(client, category, content);
  if (realPhotoId) return realPhotoId;
  return await generateAndStoreAIPhoto(client, post);
}

async function matchRealPhoto(client: any, category: string, content: string): Promise<string | null> {
  const keywords = extractKeywords(content);

  const { data: photos } = await client
    .from("media_library")
    .select("id, file_name, tags, category, alt_text")
    .eq("brand_approved", true)
    .limit(100);

  if (!photos || photos.length === 0) return null;

  const remodelKeywords = keywords.filter((kw: string) =>
    ["kitchen", "bathroom", "bath", "basement", "remodel", "remodeling",
     "renovation", "renovated", "finished", "transformation", "transformed",
     "deck", "patio", "porch", "outdoor", "exterior", "interior", "design",
     "home", "house", "cabinet", "cabinets", "countertop", "countertops",
     "tile", "tiles", "shower", "vanity", "flooring", "backsplash",
     "island", "pantry", "custom", "modern", "traditional", "farmhouse",
     "lenexa", "overland", "olathe", "shawnee", "kansas", "metro"].includes(kw)
  );

  if (remodelKeywords.length === 0) return null;

  let bestScore = 0;
  let bestId: string | null = null;

  for (const photo of photos) {
    let score = 0;
    const photoText = [
      photo.file_name || "", photo.alt_text || "", photo.category || "",
      ...(photo.tags || []),
    ].join(" ").toLowerCase();

    if (photo.category && photo.category.toLowerCase() === category.toLowerCase()) {
      score += 3;
    }
    for (const kw of remodelKeywords) {
      if (photoText.includes(kw)) score += 2;
    }
    score += Math.random() * 0.3;

    if (score > bestScore) {
      bestScore = score;
      bestId = photo.id;
    }
  }

  return bestScore >= 7 ? bestId : null;
}

function extractKeywords(content: string): string[] {
  const stopWords = new Set([
    "the","a","an","is","are","was","were","be","been","being","have","has","had",
    "do","does","did","will","would","could","should","may","might","can","shall",
    "to","of","in","for","on","with","at","by","from","as","into","through",
    "during","before","after","above","below","between","out","off","over","under",
    "again","further","then","once","here","there","when","where","why","how",
    "all","each","every","both","few","more","most","other","some","such","no",
    "not","only","own","same","so","than","too","very","just","because","but",
    "and","or","if","while","about","up","its","it","we","our","you","your",
    "they","them","their","this","that","these","those","what","which","who",
    "whom","i","me","my","he","him","his","she","her",
  ]);
  const words = content
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !stopWords.has(w));
  return [...new Set(words)].slice(0, 15);
}

async function generateAndStoreAIPhoto(client: any, post: any): Promise<string | null> {
  // PORTED: Lovable Gateway → Google AI direct
  const GOOGLE_API_KEY = Deno.env.get("GOOGLE_API_KEY");
  if (!GOOGLE_API_KEY) {
    console.error("GOOGLE_API_KEY not set — cannot generate AI image");
    return null;
  }

  const imagePrompt = `Create an ultra-realistic, editorial interior photograph that would accompany this social media post for Uprise Remodeling & Design, a premium home remodeling company in the Kansas City metro:

"${(post.content || "").substring(0, 500)}"

Style requirements:
- Shot on Canon EOS R5 with RF 24-70mm f/2.8L at 35mm. ISO 200, f/5.6, 1/125s. Natural daylight through windows.
- Architectural digest / Dwell magazine aesthetic — editorial interior photography, NOT stock-photo-looking
- Feature a real-looking finished remodeling space relevant to the post content (kitchen / bathroom / basement / outdoor living / whole home as applicable)
- Clean modern design with warm neutral tones, natural wood, stone countertops, matte finishes
- Shallow depth of field with soft background blur
- The photo MUST look like it was taken by a professional architectural photographer with a DSLR
- NO text overlays, NO watermarks, NO logos, NO borders, NO collages
- NO cartoonish or obviously AI-generated artifacts
- NO people (focus on the space unless the post explicitly describes someone working/living in it)
- Exactly one primary space/room composition
- Accurate architectural details — straight lines, correct proportions, realistic shadows`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=${GOOGLE_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: imagePrompt }] }],
          generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error(`Gemini failed: ${response.status} ${errText.substring(0, 300)}`);
      return null;
    }

    const aiData = await response.json();
    const parts = aiData.candidates?.[0]?.content?.parts ?? [];
    const imagePart = parts.find((p: any) => p.inline_data || p.inlineData);

    if (!imagePart) {
      console.error("Gemini did not return an image");
      return null;
    }

    const base64Data = imagePart.inline_data?.data ?? imagePart.inlineData?.data;
    const imageBytes = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));
    const fileName = `auto-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.png`;

    const { error: uploadError } = await client.storage
      .from("ai-generated-photos")
      .upload(fileName, imageBytes, { contentType: "image/png", upsert: false });

    if (uploadError) {
      console.error("Failed to upload AI image:", uploadError);
      return null;
    }

    const { data: urlData } = client.storage.from("ai-generated-photos").getPublicUrl(fileName);

    const { data: photoRecord, error: insertError } = await client
      .from("ai_generated_photos")
      .insert({
        file_name: fileName,
        file_url: urlData.publicUrl,
        file_size: imageBytes.length,
        prompt: imagePrompt.substring(0, 2000),
        style: "lifestyle",
        category: post.category || "general",
        tags: ["gemini"],
        associated_post_id: post.id,
        approved: true,
      })
      .select()
      .single();

    if (insertError) {
      console.error("Failed to save AI photo record:", insertError);
      return null;
    }

    console.log(`AI image generated and stored: ${photoRecord.id}`);
    return photoRecord.id;
  } catch (err: any) {
    console.error("AI image generation error:", err.message);
    return null;
  }
}

// ─── Meta Token Refresh ───────────────────────────────────

async function refreshMetaTokens(client: any, meta: any): Promise<any> {
  const expiresAt = meta.user_token_expires_at ? new Date(meta.user_token_expires_at) : null;
  const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  let activeUserToken = meta.long_lived_user_token;
  let activeUserExpiresAt = meta.user_token_expires_at || null;
  let userTokenWasRefreshed = false;

  if (!expiresAt || expiresAt <= sevenDaysFromNow) {
    try {
      const refreshUrl = `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${meta.app_id}&client_secret=${meta.app_secret}&fb_exchange_token=${meta.long_lived_user_token}`;
      const refreshRes = await fetch(refreshUrl);
      const refreshData = await refreshRes.json();

      if (refreshData.access_token) {
        const newExpiresIn = refreshData.expires_in || 5184000;
        activeUserToken = refreshData.access_token;
        activeUserExpiresAt = new Date(Date.now() + newExpiresIn * 1000).toISOString();
        userTokenWasRefreshed = true;
        console.log(`Meta user token auto-refreshed`);
      }
    } catch (refreshErr: any) {
      console.error("Meta refresh error:", refreshErr.message);
    }
  }

  try {
    const acctRes = await fetch(`https://graph.facebook.com/v21.0/me/accounts?access_token=${activeUserToken}`);
    const acctData = await acctRes.json();

    if (acctData.data?.length) {
      const targetPage = acctData.data.find((p: any) => p.id === meta.page_id) || acctData.data[0];
      const didPageTokenChange = meta.page_access_token !== targetPage.access_token;

      if (didPageTokenChange || userTokenWasRefreshed) {
        meta.long_lived_user_token = activeUserToken;
        meta.user_token_expires_at = activeUserExpiresAt;
        meta.page_access_token = targetPage.access_token;
        meta.page_id = targetPage.id;
        meta.page_name = targetPage.name;
        meta.last_refreshed_at = new Date().toISOString();

        await client.from("platform_credentials").upsert(
          { platform: "meta", credentials: meta },
          { onConflict: "platform" }
        );
      }
    }
  } catch (e: any) {
    console.error("Meta rehydrate error:", e.message);
  }

  return meta;
}

// ─── Platform Publishers ──────────────────────────────────

async function publishToFacebook(
  pageId: string, pageAccessToken: string, message: string, imageUrl: string | null
): Promise<any> {
  let url: string, body: any;
  if (imageUrl) {
    url = `https://graph.facebook.com/v21.0/${pageId}/photos`;
    body = new URLSearchParams({ message, url: imageUrl, access_token: pageAccessToken });
  } else {
    url = `https://graph.facebook.com/v21.0/${pageId}/feed`;
    body = new URLSearchParams({ message, access_token: pageAccessToken });
  }

  const res = await fetch(url, { method: "POST", body });
  const data = await res.json();

  if (data.error) {
    const err: any = new Error(`[${data.error.code || "unknown"}] ${data.error.message}`);
    err.code = data.error.code;
    err.subcode = data.error.error_subcode;
    err.fbType = data.error.type;
    err.fbtrace_id = data.error.fbtrace_id;
    throw err;
  }
  return { success: true, post_id: data.id || data.post_id };
}

async function publishToInstagram(
  igAccountId: string, pageAccessToken: string, caption: string, imageUrl: string | null
): Promise<any> {
  if (!imageUrl) throw new Error("Instagram requires an image to publish");

  const containerRes = await fetch(
    `https://graph.facebook.com/v21.0/${igAccountId}/media`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_url: imageUrl, caption, access_token: pageAccessToken }),
    }
  );
  const containerData = await containerRes.json();

  if (containerData.error) {
    const err: any = new Error(`[${containerData.error.code || "unknown"}] ${containerData.error.message}`);
    err.code = containerData.error.code;
    err.subcode = containerData.error.error_subcode;
    err.fbType = containerData.error.type;
    err.fbtrace_id = containerData.error.fbtrace_id;
    throw err;
  }

  const containerId = containerData.id;
  await new Promise((resolve) => setTimeout(resolve, 5000));

  const publishRes = await fetch(
    `https://graph.facebook.com/v21.0/${igAccountId}/media_publish`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creation_id: containerId, access_token: pageAccessToken }),
    }
  );
  const publishData = await publishRes.json();

  if (publishData.error) {
    const err: any = new Error(`[${publishData.error.code || "unknown"}] ${publishData.error.message}`);
    err.code = publishData.error.code;
    err.subcode = publishData.error.error_subcode;
    err.fbType = publishData.error.type;
    err.fbtrace_id = publishData.error.fbtrace_id;
    throw err;
  }
  return { success: true, media_id: publishData.id };
}

// ─────────────────────────────────────────────────────────────
// Carousel publishers — multi-image posts (up to 10 slides)
// ─────────────────────────────────────────────────────────────

async function publishCarouselToFacebook(
  pageId: string, pageAccessToken: string, message: string, imageUrls: string[]
): Promise<any> {
  if (!imageUrls.length) throw new Error("Facebook carousel requires at least 1 image");
  const slides = imageUrls.slice(0, 10); // FB carousel cap is 10

  // Upload each photo as unpublished, collect media_fbid's
  const mediaFbids: string[] = [];
  for (const url of slides) {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${pageId}/photos`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, published: false, access_token: pageAccessToken }),
      }
    );
    const data = await res.json();
    if (data.error) {
      const err: any = new Error(`FB carousel slide upload failed: [${data.error.code}] ${data.error.message}`);
      err.code = data.error.code;
      err.subcode = data.error.error_subcode;
      err.fbtrace_id = data.error.fbtrace_id;
      throw err;
    }
    mediaFbids.push(data.id);
  }

  // Create the carousel feed post attaching all photo ids
  const feedRes = await fetch(
    `https://graph.facebook.com/v21.0/${pageId}/feed`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        attached_media: mediaFbids.map((id) => ({ media_fbid: id })),
        access_token: pageAccessToken,
      }),
    }
  );
  const feedData = await feedRes.json();
  if (feedData.error) {
    const err: any = new Error(`FB carousel publish failed: [${feedData.error.code}] ${feedData.error.message}`);
    err.code = feedData.error.code;
    err.subcode = feedData.error.error_subcode;
    err.fbtrace_id = feedData.error.fbtrace_id;
    throw err;
  }
  return { success: true, post_id: feedData.id, slide_count: slides.length, carousel: true };
}

async function publishCarouselToInstagram(
  igAccountId: string, pageAccessToken: string, caption: string, imageUrls: string[]
): Promise<any> {
  if (!imageUrls.length) throw new Error("Instagram carousel requires at least 1 image");
  if (imageUrls.length === 1) {
    return publishToInstagram(igAccountId, pageAccessToken, caption, imageUrls[0]);
  }
  const slides = imageUrls.slice(0, 10); // IG carousel cap is 10

  // 1. Create an IG media container for each slide with is_carousel_item=true
  const childIds: string[] = [];
  for (const url of slides) {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${igAccountId}/media`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_url: url,
          is_carousel_item: true,
          access_token: pageAccessToken,
        }),
      }
    );
    const data = await res.json();
    if (data.error) {
      const err: any = new Error(`IG carousel slide container failed: [${data.error.code}] ${data.error.message}`);
      err.code = data.error.code;
      err.subcode = data.error.error_subcode;
      err.fbtrace_id = data.error.fbtrace_id;
      throw err;
    }
    childIds.push(data.id);
  }

  // Wait for child containers to be ready (IG requires ~5s processing)
  await new Promise((resolve) => setTimeout(resolve, 6000));

  // 2. Create the CAROUSEL parent container
  const parentRes = await fetch(
    `https://graph.facebook.com/v21.0/${igAccountId}/media`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        media_type: "CAROUSEL",
        children: childIds.join(","),
        caption,
        access_token: pageAccessToken,
      }),
    }
  );
  const parentData = await parentRes.json();
  if (parentData.error) {
    const err: any = new Error(`IG carousel parent failed: [${parentData.error.code}] ${parentData.error.message}`);
    err.code = parentData.error.code;
    err.subcode = parentData.error.error_subcode;
    err.fbtrace_id = parentData.error.fbtrace_id;
    throw err;
  }

  await new Promise((resolve) => setTimeout(resolve, 5000));

  // 3. Publish the carousel
  const publishRes = await fetch(
    `https://graph.facebook.com/v21.0/${igAccountId}/media_publish`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creation_id: parentData.id, access_token: pageAccessToken }),
    }
  );
  const publishData = await publishRes.json();
  if (publishData.error) {
    const err: any = new Error(`IG carousel publish failed: [${publishData.error.code}] ${publishData.error.message}`);
    err.code = publishData.error.code;
    err.subcode = publishData.error.error_subcode;
    err.fbtrace_id = publishData.error.fbtrace_id;
    throw err;
  }
  return { success: true, media_id: publishData.id, slide_count: slides.length, carousel: true };
}

async function publishToGoogleBusiness(
  clientId: string, clientSecret: string, refreshToken: string,
  locationName: string, summary: string, imageUrl: string | null, accountName?: string
): Promise<any> {
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret,
      refresh_token: refreshToken, grant_type: "refresh_token",
    }),
  });
  const tokenText = await tokenRes.text();
  let tokenData: any;
  try { tokenData = JSON.parse(tokenText); }
  catch { throw new Error(`Google token non-JSON: ${tokenText.substring(0, 200)}`); }

  if (!tokenData.access_token) {
    throw new Error(`Failed to get Google access token: ${JSON.stringify(tokenData)}`);
  }
  const accessToken = tokenData.access_token;

  let fullLocationPath: string;
  if (locationName.startsWith("accounts/")) {
    fullLocationPath = locationName;
  } else {
    const locPart = locationName.startsWith("locations/") ? locationName : `locations/${locationName}`;
    if (accountName) {
      const acctPart = accountName.startsWith("accounts/") ? accountName : `accounts/${accountName}`;
      fullLocationPath = `${acctPart}/${locPart}`;
    } else {
      try {
        const acctRes = await fetch(
          "https://mybusinessaccountmanagement.googleapis.com/v1/accounts",
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const acctData = await acctRes.json();
        if (acctData.accounts?.length > 0) {
          const acctName = acctData.accounts[0].name;
          fullLocationPath = `${acctName}/${locPart}`;

          const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
          const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
          const saveClient = createClient(supabaseUrl, serviceRoleKey);
          const { data: existingCreds } = await saveClient
            .from("platform_credentials")
            .select("credentials")
            .eq("platform", "google_business")
            .maybeSingle();
          if (existingCreds?.credentials) {
            const updated = { ...(existingCreds.credentials as any), account_name: acctName };
            await saveClient.from("platform_credentials").upsert(
              { platform: "google_business", credentials: updated },
              { onConflict: "platform" }
            );
          }
        } else {
          fullLocationPath = locPart;
        }
      } catch {
        fullLocationPath = locPart;
      }
    }
  }

  const postBody: any = { languageCode: "en", topicType: "STANDARD", summary };
  if (imageUrl) postBody.media = [{ mediaFormat: "PHOTO", sourceUrl: imageUrl }];

  const postUrl = `https://mybusiness.googleapis.com/v4/${fullLocationPath}/localPosts`;
  const postRes = await fetch(postUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(postBody),
  });

  const postText = await postRes.text();
  let postData: any;
  try { postData = JSON.parse(postText); }
  catch { throw new Error(`GBP non-JSON (${postRes.status}): ${postText.substring(0, 300)}`); }

  if (postData.error) {
    throw new Error(`[${postData.error.code || "unknown"}] ${postData.error.message || JSON.stringify(postData.error)}`);
  }
  return { success: true, post_name: postData.name };
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
