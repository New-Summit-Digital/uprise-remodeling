import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { getSupabaseClient } from '../_shared/supabase-client.ts';
import { corsHeaders } from '../_shared/cors.ts';

const platformRules: Record<string, { maxLength: number; hashtagCount: string; tone: string }> = {
  facebook: { maxLength: 300, hashtagCount: '3-5', tone: 'conversational, community-focused' },
  instagram: { maxLength: 150, hashtagCount: '20-30', tone: 'visual-first, lifestyle' },
  gbp: { maxLength: 150, hashtagCount: '0', tone: 'professional, local-focused' },
  linkedin: { maxLength: 250, hashtagCount: '3-5', tone: 'professional, thought-leadership' },
  x: { maxLength: 280, hashtagCount: '1-3', tone: 'punchy, concise' },
  tiktok: { maxLength: 150, hashtagCount: '3-5', tone: 'casual, authentic, playful' },
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabase = getSupabaseClient();
    const { calendar_id, platform, title } = await req.json();

    const rules = platformRules[platform] || platformRules.facebook;

    // Load brand voice
    const { data: config } = await supabase
      .from('automation_config')
      .select('*')
      .eq('client_slug', 'uprise-remodeling')
      .single();

    const brandVoice = config?.brand_voice_profile || {};
    const tone = brandVoice.tone || 'professional but warm';

    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY not configured');

    const systemPrompt = `You are a social media manager for Uprise Remodeling, a home remodeling company in Kansas City.

Brand voice: ${tone}
Platform: ${platform}
Platform tone: ${rules.tone}
Max caption length: ${rules.maxLength} words
Hashtag count: ${rules.hashtagCount} hashtags

Write a ${platform} post about: "${title}"

Rules:
- Match the platform's native style exactly
- Include a CTA (link to website, call to action, etc.)
- For GBP: no hashtags, include business location
- For X: under 280 characters total
- Never sound generic or AI-generated
- Reference Kansas City area naturally

Return as JSON:
- caption (string)
- hashtags (array of strings)
- cta (string — the call-to-action text)
- post_type (string: original, blog_crosspost, promotion, or seasonal)`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{ role: 'user', content: `Create a ${platform} post about: ${title}` }],
        system: systemPrompt,
      }),
    });

    if (!claudeRes.ok) {
      throw new Error(`Claude API error: ${claudeRes.status}`);
    }

    const claudeData = await claudeRes.json();
    const responseText = claudeData.content[0].text;

    let postData;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      postData = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(responseText);
    } catch {
      postData = {
        caption: responseText,
        hashtags: [],
        cta: 'Visit upriseremodeling.com',
        post_type: 'original',
      };
    }

    const approvalMode = config?.approval_mode || 'agency_approval';
    const status = approvalMode === 'auto_pilot' ? 'approved' : 'pending_approval';

    const { data: savedPost, error: insertError } = await supabase
      .from('generated_social_posts')
      .insert({
        calendar_id,
        platform,
        caption: postData.caption,
        hashtags: postData.hashtags,
        link_url: 'https://www.upriseremodeling.com',
        post_type: postData.post_type || 'original',
        status,
      })
      .select()
      .single();

    if (insertError) throw insertError;

    // Update calendar
    await supabase
      .from('content_calendar')
      .update({ status: status === 'approved' ? 'approved' : 'pending_approval' })
      .eq('id', calendar_id);

    // Add to approval queue if needed
    if (status === 'pending_approval') {
      await supabase.from('approval_queue').insert({
        content_type: 'social',
        content_id: savedPost.id,
        expires_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
      });
    }

    await supabase.from('activity_log').insert({
      action: 'social_post_generated',
      target: savedPost.id,
      details: { platform, title, status },
    });

    return new Response(JSON.stringify({ success: true, post_id: savedPost.id, status }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
