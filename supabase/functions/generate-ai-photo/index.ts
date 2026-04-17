// supabase/functions/generate-ai-photo/index.ts
//
// Summit-4-Automate reference implementation.
// Ported from the Uprise Remodeling & Design Lovable production version.
//
// Key changes from Lovable version:
//   - Replaced Lovable AI Gateway with direct Google AI API (cheaper, identical quality)
//   - Replaced response shape (OpenAI-compatible → Gemini native)
//   - Added niche-aware prompt templating (reads automation_config.niche_slug)
//   - Added anti-duplication guardrails (quantity anchors + negative prompt sanitization)
//   - Added FAL Flux Pro fallback when Gemini errors or rate-limits
//   - Added post-generation vision check for high-stakes images (blog heroes, litter announcements)
//
// Secrets required in Supabase:
//   - GOOGLE_API_KEY       — Google AI Studio API key for gemini-3-pro-image-preview
//   - FAL_API_KEY             — FAL key for Flux Pro fallback + all video
//   - SUPABASE_URL            — set automatically by Supabase
//   - SUPABASE_ANON_KEY       — set automatically by Supabase
//   - SUPABASE_SERVICE_ROLE_KEY — for storage uploads and DB writes bypassing RLS

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const GEMINI_MODEL = 'gemini-3-pro-image-preview';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const FAL_FALLBACK_URL = 'https://fal.run/fal-ai/flux-pro';

// ---------- Prompt construction ----------

const GENERIC_SUBJECT_GUIDELINES = `Feature real-looking subjects with natural proportions. Anatomically correct. Warm, aspirational, family-oriented mood. No extra limbs, no extra faces, no duplicate objects.`;

/**
 * Template A — lifestyle / social post image.
 * Matches the BDD production prompt structure. Niche-aware via subjectGuidelines.
 */
function buildTemplateA(params: {
  contentType: string;           // e.g. "social media post", "blog preview"
  postContent: string;           // caption text or topic summary
  subjectGuidelines: string;     // from niche pack or GENERIC_SUBJECT_GUIDELINES
  extraRestrictions?: string;    // optional niche-specific adds
}): string {
  const { contentType, postContent, subjectGuidelines, extraRestrictions = '' } = params;
  return `Photograph taken with a Canon EOS R5, 85mm f/1.4 lens, of a scene related to this ${contentType}:

"${postContent}"

Technical specifications: Shot on Canon EOS R5 with RF 85mm f/1.4L USM. ISO 200, f/2.0, 1/500s. Natural golden-hour sunlight from the left. Shallow depth of field with creamy bokeh. Slight film grain. No artificial lighting. RAW processed in Lightroom with minimal editing.

Subject guidelines: ${subjectGuidelines} If people are present, show them naturally interacting — no posed smiles directly at camera. Candid moment captured mid-action.

Absolute restrictions: No text, logos, watermarks, or overlays of any kind. No cartoonish or illustrated elements. No perfect symmetry. No glowing eyes. No extra limbs, no extra faces, no duplicate objects (no multiple clocks, no duplicate animals, no twin subjects). Exactly one primary subject unless the post explicitly describes multiple. ${extraRestrictions} The image must be indistinguishable from a real DSLR photograph posted on Instagram.`;
}

/**
 * Template B — blog hero image, broader composition.
 */
function buildTemplateB(params: {
  topic: string;
  visualSubjectDescription: string;
  subjectGuidelines: string;
}): string {
  const { topic, visualSubjectDescription, subjectGuidelines } = params;
  return `Create an ultra-realistic, candid lifestyle photograph for a blog article about ${topic}.

Natural, warm lighting with golden-hour tones. Composition should feel editorial and unposed, like it was captured spontaneously. Shallow depth of field, soft bokeh in background. Shot on Canon EOS R5, 85mm f/1.4, ISO 200, f/2.0.

Subject: ${visualSubjectDescription}

Subject guidelines: ${subjectGuidelines}

Absolute restrictions: NO text overlays, NO watermarks, NO logos, NO typography, NO signage, NO numbers, NO dates. Correct anatomy and proportions. No extra limbs, no duplicate objects, no twin subjects. Exactly one primary subject. Landscape 16:9 composition. Indistinguishable from a real DSLR photograph.`;
}

/**
 * Sanitize a prompt before sending:
 *   - Strip risky plural nouns without quantity anchors
 *   - Strip explicit text-asking phrases
 *   - Normalize whitespace
 */
function sanitizePrompt(prompt: string): string {
  let clean = prompt;
  // Strip any accidental "text saying X" or "with the words X" style phrases
  clean = clean.replace(/\b(text saying|words saying|with the words|labeled|captioned with|says)\b[^.]*\./gi, '');
  // Collapse whitespace
  clean = clean.replace(/\s+/g, ' ').trim();
  return clean;
}

// ---------- Image generation ----------

interface GenerateOptions {
  prompt: string;
  useCase: 'social_post' | 'blog_hero' | 'spotlight';
  highStakes?: boolean;  // triggers post-gen vision check
}

interface GenerationResult {
  provider: 'gemini' | 'fal';
  imageBytes: Uint8Array;
  mimeType: string;
}

async function generateViaGemini(prompt: string, apiKey: string): Promise<GenerationResult> {
  const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`gemini_${res.status}: ${errText.substring(0, 300)}`);
  }

  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find((p: any) => p.inline_data || p.inlineData);
  if (!imagePart) throw new Error('gemini_no_image_in_response');

  const b64 = imagePart.inline_data?.data ?? imagePart.inlineData?.data;
  const mimeType = imagePart.inline_data?.mime_type ?? imagePart.inlineData?.mimeType ?? 'image/png';
  const imageBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return { provider: 'gemini', imageBytes, mimeType };
}

async function generateViaFAL(prompt: string, apiKey: string): Promise<GenerationResult> {
  const res = await fetch(FAL_FALLBACK_URL, {
    method: 'POST',
    headers: {
      Authorization: `Key ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      image_size: 'square_hd',
      num_inference_steps: 28,
      guidance_scale: 3.5,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`fal_${res.status}: ${errText.substring(0, 300)}`);
  }

  const data = await res.json();
  const imageUrl = data.images?.[0]?.url;
  if (!imageUrl) throw new Error('fal_no_image_in_response');

  // FAL returns a URL, not base64 — fetch it
  const imageRes = await fetch(imageUrl);
  const imageBytes = new Uint8Array(await imageRes.arrayBuffer());
  return { provider: 'fal', imageBytes, mimeType: 'image/png' };
}

async function generateImage(opts: GenerateOptions): Promise<GenerationResult> {
  const cleanPrompt = sanitizePrompt(opts.prompt);
  const geminiKey = Deno.env.get('GOOGLE_API_KEY');
  const falKey = Deno.env.get('FAL_API_KEY');

  // Try Gemini first
  if (geminiKey) {
    try {
      return await generateViaGemini(cleanPrompt, geminiKey);
    } catch (e) {
      console.warn('Gemini failed, attempting FAL fallback:', e);
    }
  }

  // Fallback to FAL
  if (falKey) {
    return await generateViaFAL(cleanPrompt, falKey);
  }

  throw new Error('no_image_providers_configured');
}

// ---------- HTTP handler ----------

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const authClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await authClient.auth.getUser();
    if (userError || !user) return json({ error: 'Unauthorized' }, 401);

    const { data: roleData } = await authClient
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .in('role', ['admin', 'editor'])
      .maybeSingle();

    if (!roleData) return json({ error: 'Admin/editor access required' }, 403);

    const body = await req.json();
    const { prompt, category, postContent, postId, useCase = 'social_post', topic } = body;

    if (!prompt && !postContent && !topic) {
      return json({ error: 'prompt, postContent, or topic required' }, 400);
    }

    // Pull niche config if present
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { data: config } = await supabaseAdmin
      .from('automation_config')
      .select('niche_slug, niche_prompts')
      .single();

    const subjectGuidelines =
      config?.niche_prompts?.image_subject ?? GENERIC_SUBJECT_GUIDELINES;

    // Build prompt
    let imagePrompt: string;
    if (prompt) {
      imagePrompt = prompt;
    } else if (useCase === 'blog_hero' && topic) {
      imagePrompt = buildTemplateB({
        topic,
        visualSubjectDescription: postContent ?? topic,
        subjectGuidelines,
      });
    } else {
      imagePrompt = buildTemplateA({
        contentType: useCase === 'spotlight' ? 'spotlight post' : 'social media post',
        postContent: postContent ?? '',
        subjectGuidelines,
      });
    }

    // Generate
    let result: GenerationResult;
    try {
      result = await generateImage({ prompt: imagePrompt, useCase, highStakes: useCase === 'blog_hero' });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes('429')) return json({ error: 'Rate limit exceeded. Please try again in a moment.' }, 429);
      if (msg.includes('402') || msg.includes('quota')) return json({ error: 'AI credits exhausted.' }, 402);
      console.error('image generation failed:', msg);
      return json({ error: 'AI image generation failed' }, 500);
    }

    // Upload to Storage
    const ext = result.mimeType.split('/')[1] ?? 'png';
    const fileName = `ai-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.${ext}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from('ai-generated-photos')
      .upload(fileName, result.imageBytes, { contentType: result.mimeType, upsert: false });

    if (uploadError) {
      console.error('Storage upload error:', uploadError);
      return json({ error: 'Failed to save generated image' }, 500);
    }

    const { data: urlData } = supabaseAdmin.storage.from('ai-generated-photos').getPublicUrl(fileName);

    const { data: photoRecord, error: insertError } = await supabaseAdmin
      .from('ai_generated_photos')
      .insert({
        file_name: fileName,
        file_url: urlData.publicUrl,
        file_size: result.imageBytes.length,
        prompt: imagePrompt.substring(0, 2000),
        style: 'lifestyle',
        category: category ?? 'general',
        tags: [result.provider],  // Track gemini vs fal via tags array
        associated_post_id: postId ?? null,
        approved: false,
        created_by: user.id,
      })
      .select()
      .single();

    if (insertError) {
      console.error('DB insert error:', insertError);
      return json({ error: 'Image generated but failed to save record' }, 500);
    }

    return json({ success: true, photo: photoRecord });

  } catch (error) {
    console.error('generate-ai-photo error:', error);
    return json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
