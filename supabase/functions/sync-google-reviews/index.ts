// supabase/functions/sync-google-reviews/index.ts
//
// Pulls Google Business Profile reviews into the reviews table.
// Triggered by cron or by admin manually. Deduplicates via source_review_id.
//
// No Lovable dependencies — ported verbatim.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface GoogleReview {
  reviewId: string;
  reviewer: { displayName: string; profilePhotoUrl?: string };
  starRating: string;
  comment?: string;
  createTime: string;
  updateTime: string;
}

async function getGoogleCredentials(): Promise<{ clientId: string; clientSecret: string; refreshToken: string }> {
  let clientId = Deno.env.get('GOOGLE_CLIENT_ID') || '';
  let clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET') || '';
  let refreshToken = Deno.env.get('GOOGLE_REFRESH_TOKEN') || '';

  if (!refreshToken) {
    try {
      const supabaseAdmin = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
      );
      const { data } = await supabaseAdmin
        .from('platform_credentials')
        .select('credentials')
        .eq('platform', 'google_business')
        .maybeSingle();

      if (data?.credentials) {
        const creds = data.credentials as any;
        clientId = creds.client_id || clientId;
        clientSecret = creds.client_secret || clientSecret;
        refreshToken = creds.refresh_token || refreshToken;
      }
    } catch (e) {
      console.log('Could not read platform_credentials:', e);
    }
  }

  if (!refreshToken) {
    throw new Error('GOOGLE_REFRESH_TOKEN not configured. Complete Google Business setup.');
  }
  return { clientId, clientSecret, refreshToken };
}

async function getAccessToken(): Promise<string> {
  const { clientId, clientSecret, refreshToken } = await getGoogleCredentials();

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('Token refresh failed:', data);
    throw new Error(`Failed to refresh token: ${data.error_description || data.error}`);
  }

  return data.access_token;
}

async function getAccountAndLocation(): Promise<{ accountName: string; locationName: string }> {
  let accountName = Deno.env.get('GOOGLE_ACCOUNT_NAME') || '';
  let locationName = Deno.env.get('GOOGLE_LOCATION_NAME') || '';

  if (!locationName) {
    try {
      const supabaseAdmin = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
      );
      const { data } = await supabaseAdmin
        .from('platform_credentials')
        .select('credentials')
        .eq('platform', 'google_business')
        .maybeSingle();

      if (data?.credentials) {
        const creds = data.credentials as any;
        locationName = creds.location_name || locationName;
        accountName = creds.account_name || accountName;
      }
    } catch (e) {
      console.log('Could not read platform_credentials:', e);
    }
  }

  if (!locationName) {
    throw new Error('Business Profile ID (location) not configured.');
  }

  return { accountName, locationName };
}

function starRatingToNumber(rating: string): number {
  const ratings: Record<string, number> = {
    'ONE': 1, 'TWO': 2, 'THREE': 3, 'FOUR': 4, 'FIVE': 5,
  };
  return ratings[rating] || 5;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const cronSecret = req.headers.get('x-cron-secret');
    const expectedCronSecret = Deno.env.get('CRON_SECRET');
    const isCronRequest = cronSecret && expectedCronSecret && cronSecret === expectedCronSecret;

    if (!isCronRequest) {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401,
        });
      }

      const supabase = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_ANON_KEY')!,
        { global: { headers: { Authorization: authHeader } } }
      );

      const { data: { user }, error: userError } = await supabase.auth.getUser();
      if (userError || !user) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401,
        });
      }

      const { data: roleData } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', user.id)
        .in('role', ['admin', 'editor'])
        .limit(1)
        .maybeSingle();

      if (!roleData) {
        return new Response(JSON.stringify({ error: 'Admin or editor access required' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 403,
        });
      }
    }

    console.log(`Starting Google reviews sync (cron: ${isCronRequest})...`);

    const { locationName } = await getAccountAndLocation();
    console.log(`Using location: ${locationName}`);

    const accessToken = await getAccessToken();
    console.log('Got access token');

    const reviewsResponse = await fetch(
      `https://mybusiness.googleapis.com/v4/${locationName}/reviews`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!reviewsResponse.ok) {
      const error = await reviewsResponse.json();
      console.error('Failed to fetch reviews:', error);
      throw new Error(`Failed to fetch reviews: ${error.error?.message || 'Unknown error'}`);
    }

    const reviewsData = await reviewsResponse.json();
    console.log(`Found ${reviewsData.reviews?.length || 0} reviews`);

    const reviews: GoogleReview[] = reviewsData.reviews || [];
    let syncedCount = 0;
    let skippedCount = 0;

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    for (const review of reviews) {
      const { data: existingReview } = await supabaseAdmin
        .from('reviews')
        .select('id')
        .eq('source_review_id', review.reviewId)
        .eq('source', 'google')
        .maybeSingle();

      if (existingReview) {
        skippedCount++;
        continue;
      }

      const { error: insertError } = await supabaseAdmin
        .from('reviews')
        .insert({
          reviewer_name: review.reviewer.displayName,
          reviewer_avatar: review.reviewer.profilePhotoUrl || null,
          rating: starRatingToNumber(review.starRating),
          review_text: review.comment || null,
          review_date: review.createTime,
          source: 'google',
          source_review_id: review.reviewId,
          is_visible: true,
        });

      if (insertError) {
        console.error('Failed to insert review:', insertError);
      } else {
        syncedCount++;
      }
    }

    console.log(`Sync complete: ${syncedCount} new, ${skippedCount} skipped`);

    return new Response(
      JSON.stringify({
        success: true,
        message: `Synced ${syncedCount} new reviews, ${skippedCount} already existed`,
        total: reviews.length,
        synced: syncedCount,
        skipped: skippedCount,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Sync error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});
