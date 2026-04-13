import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { getSupabaseClient } from '../_shared/supabase-client.ts';
import { corsHeaders } from '../_shared/cors.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabase = getSupabaseClient();
    const { calendar_id, keyword, title } = await req.json();

    // Load automation config for brand voice
    const { data: config } = await supabase
      .from('automation_config')
      .select('*')
      .eq('client_slug', 'uprise-remodeling')
      .single();

    const brandVoice = config?.brand_voice_profile || {};
    const tone = brandVoice.tone || 'professional but warm';
    const vocabulary = brandVoice.vocabulary || [];
    const avoidPhrases = brandVoice.avoid_phrases || [];
    const localRefs = brandVoice.local_references || [];

    // Generate blog post via Claude API
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY not configured');

    const systemPrompt = `You are a blog writer for Uprise Remodeling, a home remodeling company in the Kansas City metro area.

Brand voice: ${tone}
Preferred vocabulary: ${vocabulary.join(', ')}
Phrases to AVOID: ${avoidPhrases.join(', ')}
Local references to weave in naturally: ${localRefs.join(', ')}

Write a blog post targeting the keyword "${keyword || title}". Requirements:
- 800-1500 words
- Use H2 and H3 headings (proper hierarchy)
- Include at least 2 internal links to service pages (use placeholder URLs like /kitchen-remodels, /bathroom-remodels, /basement-finishes, /outdoor-projects)
- Include 1 internal link to the contact page (/contact)
- First paragraph must contain the target keyword
- At least 1 H2 must contain the target keyword
- Conversational, helpful tone — not salesy
- Include practical tips homeowners can use

Return as JSON with these fields:
- title (string)
- slug (string, URL-friendly)
- meta_title (string, under 60 chars)
- meta_description (string, under 160 chars)
- body_markdown (string, full blog post in markdown)
- category (string)
- tags (array of strings)`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{ role: 'user', content: `Write a blog post about: ${title || keyword}` }],
        system: systemPrompt,
      }),
    });

    if (!claudeRes.ok) {
      const errBody = await claudeRes.text();
      throw new Error(`Claude API error: ${claudeRes.status} ${errBody}`);
    }

    const claudeData = await claudeRes.json();
    const responseText = claudeData.content[0].text;

    // Parse JSON from response
    let blogData;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      blogData = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(responseText);
    } catch {
      // If JSON parse fails, use the raw text
      blogData = {
        title: title || keyword,
        slug: (title || keyword).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        meta_title: title || keyword,
        meta_description: `Learn about ${title || keyword} from Uprise Remodeling.`,
        body_markdown: responseText,
        category: 'Home Remodeling',
        tags: [keyword],
      };
    }

    // SEO compliance check
    const seoChecks = {
      has_h2: /^## /m.test(blogData.body_markdown),
      meta_title_length: (blogData.meta_title || '').length <= 60,
      meta_desc_length: (blogData.meta_description || '').length <= 160,
      has_internal_links: (blogData.body_markdown.match(/\]\(\//g) || []).length >= 2,
      has_keyword_in_title: blogData.title.toLowerCase().includes((keyword || '').toLowerCase()),
      word_count: blogData.body_markdown.split(/\s+/).length,
    };

    const seoScore = Object.values(seoChecks).filter(v => v === true || (typeof v === 'number' && v >= 800)).length;

    // Determine status based on approval mode
    const approvalMode = config?.approval_mode || 'agency_approval';
    const status = approvalMode === 'auto_pilot' ? 'approved' : 'pending_approval';

    // Save generated blog
    const { data: savedBlog, error: insertError } = await supabase
      .from('generated_blogs')
      .insert({
        calendar_id,
        title: blogData.title,
        slug: blogData.slug,
        body_markdown: blogData.body_markdown,
        meta_title: blogData.meta_title,
        meta_description: blogData.meta_description,
        category: blogData.category,
        tags: blogData.tags,
        word_count: seoChecks.word_count,
        seo_score: Math.round((seoScore / 6) * 100),
        status,
      })
      .select()
      .single();

    if (insertError) throw insertError;

    // Update calendar status
    await supabase
      .from('content_calendar')
      .update({ status: status === 'approved' ? 'approved' : 'pending_approval' })
      .eq('id', calendar_id);

    // Add to approval queue if needed
    if (status === 'pending_approval') {
      await supabase.from('approval_queue').insert({
        content_type: 'blog',
        content_id: savedBlog.id,
        expires_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
      });
    }

    // Log activity
    await supabase.from('activity_log').insert({
      action: 'blog_generated',
      target: savedBlog.id,
      details: { title: blogData.title, seo_score: seoScore, status },
    });

    return new Response(JSON.stringify({ success: true, blog_id: savedBlog.id, status }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
