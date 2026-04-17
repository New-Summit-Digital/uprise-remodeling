// supabase/functions/keyword-research/index.ts
//
// SEO keyword research via Firecrawl search API + Gemini analysis.
// Called by auto-generate-monthly-posts and generate-blog-articles when
// use_keyword_research flag is true.
//
// Changes from Lovable:
//   - AI analysis: Lovable Gateway → Gemini direct (GOOGLE_API_KEY)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const GOOGLE_TEXT_MODEL = 'gemini-2.5-flash';

async function callGeminiText(apiKey: string, systemPrompt: string, userPrompt: string, maxTokens = 8192): Promise<string | null> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GOOGLE_TEXT_MODEL}:generateContent?key=${apiKey}`;
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { maxOutputTokens: maxTokens, responseMimeType: 'application/json' },
  };
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    console.error(`Gemini error ${res.status}:`, (await res.text()).substring(0, 300));
    return null;
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const FIRECRAWL_API_KEY = Deno.env.get('FIRECRAWL_API_KEY');
    const GOOGLE_API_KEY = Deno.env.get('GOOGLE_API_KEY');

    if (!FIRECRAWL_API_KEY) {
      return new Response(JSON.stringify({ error: 'FIRECRAWL_API_KEY not configured' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (!GOOGLE_API_KEY) {
      return new Response(JSON.stringify({ error: 'GOOGLE_API_KEY not configured' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json().catch(() => ({}));
    const contentType = body.content_type || 'social';
    const count = body.count || (contentType === 'blog' ? 15 : 30);

    // Step 1: Firecrawl search for trending keywords
    const searchQueries = [
      'kitchen remodel cost Kansas City 2026',
      'bathroom remodeling contractor Overland Park',
      'basement finishing ideas Lenexa KS',
      'home remodeling trends 2026',
      'how to choose a remodeling contractor',
      'kitchen remodel ROI',
      'walk-in shower ideas modern',
      'outdoor living space cost',
      'whole home renovation timeline',
      'kitchen island designs 2026',
    ];

    const searchResults: string[] = [];

    for (const query of searchQueries.slice(0, 5)) {
      try {
        const response = await fetch('https://api.firecrawl.dev/v1/search', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${FIRECRAWL_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query, limit: 5, tbs: 'qdr:m' }),
        });

        if (response.ok) {
          const data = await response.json();
          if (data.data) {
            for (const result of data.data) {
              searchResults.push(`${result.title || ''} - ${result.description || ''}`);
            }
          }
        }
      } catch (e) {
        console.error(`Search failed for "${query}":`, e);
      }
    }

    console.log(`Collected ${searchResults.length} search results for keyword analysis`);

    // Step 2: Gemini analyzes trends → generates optimized topics
    const userPrompt = contentType === 'blog'
      ? `Based on these current search trends for homeowners looking to remodel their home, generate ${count} unique blog article topics that would attract organic search traffic for Uprise Remodeling & Design (Kansas City metro, KS).

SEARCH TREND DATA:
${searchResults.join('\n')}

Requirements:
- Each topic must target a specific long-tail keyword homeowners are actively searching
- Topics should cover: kitchen remodels, bathroom remodels, basement finishes, outdoor living, cost/ROI, timelines, design trends, contractor selection, permits, materials
- Include the primary target keyword for each topic
- Topics should be educational, 800+ word article worthy
- Focus on KC metro homeowners — weave in city names (Lenexa, Overland Park, Olathe, Shawnee, Lee's Summit, Blue Springs) where natural
- Mix evergreen content with seasonal topics (spring outdoor projects, fall prep, winter interior work)
- Topics should sound like genuine guidance from a trusted local contractor, NOT marketing fluff
- Avoid salesy or clickbait titles — use conversational, helpful language

Return JSON: { "topics": [{ "title": "Blog Title Here", "target_keyword": "primary keyword", "category": "kitchen|bathroom|basement|outdoor|cost-guide|design-trends|contractor-tips|local", "search_intent": "informational|transactional|comparison", "estimated_search_volume": "high|medium|low" }] }`
      : `Based on these current search trends for homeowners looking to remodel, generate ${count} unique social media post topics that would drive engagement and website traffic for Uprise Remodeling & Design.

SEARCH TREND DATA:
${searchResults.join('\n')}

Requirements:
- Each topic should address what KC metro homeowners are actively searching for
- Topics should be varied: educational tips, before/after reveals, design inspiration, behind-the-scenes, client stories, engagement questions
- Include the primary keyword/theme for each
- Focus on kitchen, bathroom, basement, and outdoor projects
- Mix content types: quick tips, transformation reveals, material spotlights, process explanations
- Topics should feel like what a trusted local contractor would naturally share — NOT like ad copy
- Avoid salesy or pushy tones — no "Buy now" or "Don't miss out" energy

Return JSON: { "topics": [{ "topic": "Specific post topic description", "target_keyword": "primary keyword", "category": "kitchen|bathroom|basement|outdoor|before_after|design_inspiration|behind_scenes|client_story|engagement|local", "keywords": ["keyword1", "keyword2", "keyword3"] }] }`;

    const systemPrompt = 'You are a content strategy expert who helps local home remodeling contractors create genuine, helpful content. You understand SEO but prioritize authenticity over marketing speak. Always return valid JSON.';

    const rawContent = await callGeminiText(GOOGLE_API_KEY, systemPrompt, userPrompt, 8192);
    if (!rawContent) {
      return new Response(JSON.stringify({ error: 'Gemini analysis failed' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let parsed: any;
    try {
      const jsonMatch = rawContent.match(/```(?:json)?\s*([\s\S]*?)```/);
      const jsonStr = jsonMatch ? jsonMatch[1].trim() : rawContent.trim();
      parsed = JSON.parse(jsonStr);
    } catch {
      console.error('Failed to parse AI keyword response:', rawContent.substring(0, 500));
      return new Response(JSON.stringify({ error: 'Failed to parse keyword research results' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      success: true,
      content_type: contentType,
      topics: parsed.topics || [],
      search_data_count: searchResults.length,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('Keyword research error:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
