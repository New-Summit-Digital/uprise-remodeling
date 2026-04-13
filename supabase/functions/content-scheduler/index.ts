import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { getSupabaseClient } from '../_shared/supabase-client.ts';
import { corsHeaders } from '../_shared/cors.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabase = getSupabaseClient();
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const currentHour = now.getUTCHours();

    // Find scheduled content that's due
    const { data: dueContent, error } = await supabase
      .from('content_calendar')
      .select('*')
      .eq('status', 'scheduled')
      .lte('target_date', today);

    if (error) throw error;
    if (!dueContent || dueContent.length === 0) {
      return new Response(JSON.stringify({ message: 'No content due' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const results = [];

    for (const item of dueContent) {
      // Mark as generating
      await supabase
        .from('content_calendar')
        .update({ status: 'generating' })
        .eq('id', item.id);

      if (item.content_type === 'blog') {
        // Trigger blog generation
        const genRes = await fetch(
          `${Deno.env.get('SUPABASE_URL')}/functions/v1/generate-blog`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ calendar_id: item.id, keyword: item.keyword_target, title: item.title }),
          },
        );
        results.push({ id: item.id, type: 'blog', status: genRes.ok ? 'triggered' : 'failed' });
      } else if (item.content_type === 'social') {
        // Trigger social post generation
        const genRes = await fetch(
          `${Deno.env.get('SUPABASE_URL')}/functions/v1/generate-social`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ calendar_id: item.id, platform: item.platform, title: item.title }),
          },
        );
        results.push({ id: item.id, type: 'social', status: genRes.ok ? 'triggered' : 'failed' });
      }
    }

    // Log activity
    await supabase.from('activity_log').insert({
      action: 'content_scheduler_run',
      target: 'content_calendar',
      details: { processed: results.length, results },
    });

    return new Response(JSON.stringify({ processed: results.length, results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
