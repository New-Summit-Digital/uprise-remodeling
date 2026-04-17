// supabase/functions/google-reviews-callback/index.ts
//
// Simpler alternative OAuth flow for Google Business Profile reviews.
// Initiates OAuth if no code present, exchanges code for tokens, displays
// the refresh token so user can add it as a secret manually.
//
// No Lovable dependencies — ported verbatim from production.
// Messaging updated to reference Supabase instead of Lovable.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      console.error('OAuth error:', error);
      return new Response(
        `<html><body><h1>Authorization Failed</h1><p>${error}</p></body></html>`,
        { headers: { ...corsHeaders, 'Content-Type': 'text/html' }, status: 400 }
      );
    }

    if (!code) {
      const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
      const redirectUri = `${Deno.env.get('SUPABASE_URL')}/functions/v1/google-reviews-callback`;

      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', clientId!);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/business.manage');
      authUrl.searchParams.set('access_type', 'offline');
      authUrl.searchParams.set('prompt', 'consent');

      return Response.redirect(authUrl.toString(), 302);
    }

    const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
    const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET');
    const redirectUri = `${Deno.env.get('SUPABASE_URL')}/functions/v1/google-reviews-callback`;

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId!,
        client_secret: clientSecret!,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    const tokens = await tokenResponse.json();
    console.log('Token exchange response status:', tokenResponse.status);

    if (!tokenResponse.ok) {
      console.error('Token exchange failed:', tokens);
      return new Response(
        `<html><body><h1>Token Exchange Failed</h1><pre>${JSON.stringify(tokens, null, 2)}</pre></body></html>`,
        { headers: { ...corsHeaders, 'Content-Type': 'text/html' }, status: 400 }
      );
    }

    const { refresh_token } = tokens;
    console.log('Successfully obtained tokens');

    return new Response(
      `<html>
        <head>
          <style>
            body { font-family: system-ui, sans-serif; padding: 40px; max-width: 800px; margin: 0 auto; }
            h1 { color: #16a34a; }
            .token-box { background: #f3f4f6; padding: 20px; border-radius: 8px; word-break: break-all; margin: 20px 0; }
            .warning { background: #fef3c7; padding: 15px; border-radius: 8px; margin: 20px 0; }
            code { background: #e5e7eb; padding: 2px 6px; border-radius: 4px; }
          </style>
        </head>
        <body>
          <h1>✓ Authorization Successful!</h1>
          <p>Your Google Business Profile is now connected.</p>

          <div class="warning">
            <strong>Important:</strong> Copy the refresh token below and add it as a secret named <code>GOOGLE_REFRESH_TOKEN</code> in your Supabase project (Settings → Edge Functions → Secrets).
          </div>

          <h3>Refresh Token:</h3>
          <div class="token-box">
            <code>${refresh_token || 'No refresh token received — you may need to revoke access and try again'}</code>
          </div>

          <p>After adding the secret, you can close this window and trigger a review sync from your admin panel.</p>
        </body>
      </html>`,
      { headers: { ...corsHeaders, 'Content-Type': 'text/html' } }
    );

  } catch (error) {
    console.error('Callback error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});
