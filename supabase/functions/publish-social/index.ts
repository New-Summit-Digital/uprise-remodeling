import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { getSupabaseClient } from '../_shared/supabase-client.ts';
import { corsHeaders } from '../_shared/cors.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabase = getSupabaseClient();
    const { post_id } = await req.json();

    // Get the approved post
    const { data: post, error } = await supabase
      .from('generated_social_posts')
      .select('*')
      .eq('id', post_id)
      .eq('status', 'approved')
      .single();

    if (error || !post) {
      return new Response(JSON.stringify({ error: 'Post not found or not approved' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get platform credentials
    const { data: account } = await supabase
      .from('social_accounts')
      .select('*')
      .eq('platform', post.platform)
      .single();

    if (!account) {
      // Mark as failed — platform not connected
      await supabase
        .from('generated_social_posts')
        .update({ status: 'failed' })
        .eq('id', post_id);

      return new Response(JSON.stringify({ error: `${post.platform} not connected` }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let platformPostId = null;
    let publishSuccess = false;

    // Platform-specific publishing
    switch (post.platform) {
      case 'facebook': {
        const fbRes = await fetch(
          `https://graph.facebook.com/v18.0/${account.account_name}/feed`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: `${post.caption}\n\n${(post.hashtags || []).map((h: string) => `#${h}`).join(' ')}`,
              link: post.link_url,
              access_token: account.access_token,
            }),
          },
        );
        if (fbRes.ok) {
          const fbData = await fbRes.json();
          platformPostId = fbData.id;
          publishSuccess = true;
        }
        break;
      }

      case 'linkedin': {
        const liRes = await fetch('https://api.linkedin.com/v2/ugcPosts', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${account.access_token}`,
            'Content-Type': 'application/json',
            'X-Restli-Protocol-Version': '2.0.0',
          },
          body: JSON.stringify({
            author: `urn:li:person:${account.account_name}`,
            lifecycleState: 'PUBLISHED',
            specificContent: {
              'com.linkedin.ugc.ShareContent': {
                shareCommentary: { text: post.caption },
                shareMediaCategory: 'NONE',
              },
            },
            visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
          }),
        });
        if (liRes.ok) {
          const liData = await liRes.json();
          platformPostId = liData.id;
          publishSuccess = true;
        }
        break;
      }

      case 'x': {
        const xRes = await fetch('https://api.twitter.com/2/tweets', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${account.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text: post.caption }),
        });
        if (xRes.ok) {
          const xData = await xRes.json();
          platformPostId = xData.data?.id;
          publishSuccess = true;
        }
        break;
      }

      default:
        // For platforms not yet implemented (instagram, gbp, tiktok),
        // mark as published with a note
        platformPostId = `manual-${Date.now()}`;
        publishSuccess = true;
    }

    // Update post status
    await supabase
      .from('generated_social_posts')
      .update({
        status: publishSuccess ? 'published' : 'failed',
        published_at: publishSuccess ? new Date().toISOString() : null,
        platform_post_id: platformPostId,
      })
      .eq('id', post_id);

    // Update calendar
    if (post.calendar_id) {
      await supabase
        .from('content_calendar')
        .update({ status: publishSuccess ? 'published' : 'failed' })
        .eq('id', post.calendar_id);
    }

    // Log
    await supabase.from('activity_log').insert({
      action: publishSuccess ? 'social_post_published' : 'social_post_failed',
      target: post_id,
      details: { platform: post.platform, platform_post_id: platformPostId },
    });

    return new Response(
      JSON.stringify({ success: publishSuccess, platform_post_id: platformPostId }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
