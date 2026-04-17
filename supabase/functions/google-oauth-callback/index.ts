// supabase/functions/google-oauth-callback/index.ts
//
// Google OAuth flow for connecting a Google Business Profile account.
// GET  = callback from Google after user consents, exchanges code for refresh token
// POST = start flow / check connection / save location
//
// No Lovable dependencies — ported verbatim from production.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "GET") {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    let userId = "";
    try {
      const stateData = JSON.parse(atob(state || ""));
      userId = stateData.userId || "";
    } catch {
      return htmlResponse("Invalid state parameter. Please try again from the admin panel.", true);
    }

    if (error) return htmlResponse(`Google authorization failed: ${error}. Please try again.`, true);
    if (!code) return htmlResponse("No authorization code received. Please try again.", true);

    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const adminClient = createClient(supabaseUrl, supabaseServiceKey);

      const { data: roleData } = await adminClient
        .from("user_roles")
        .select("role")
        .eq("user_id", userId)
        .eq("role", "admin")
        .maybeSingle();

      if (!roleData) return htmlResponse("Admin access required.", true);

      const { data: creds } = await adminClient
        .from("platform_credentials")
        .select("credentials")
        .eq("platform", "google_business")
        .maybeSingle();

      if (!creds?.credentials) {
        return htmlResponse("Client ID and Secret not found. Please start the setup again.", true);
      }

      const { client_id, client_secret } = creds.credentials as { client_id: string; client_secret: string };
      const redirectUri = `${supabaseUrl}/functions/v1/google-oauth-callback`;

      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code, client_id, client_secret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });

      const tokenData = await tokenRes.json();

      if (!tokenData.refresh_token) {
        console.error("Token exchange failed:", tokenData);
        return htmlResponse(
          `Token exchange failed: ${tokenData.error_description || tokenData.error || "No refresh token returned. Make sure you included access_type=offline."}`,
          true
        );
      }

      await adminClient
        .from("platform_credentials")
        .update({
          credentials: {
            client_id, client_secret,
            refresh_token: tokenData.refresh_token,
            connected_at: new Date().toISOString(),
          },
          updated_at: new Date().toISOString(),
        })
        .eq("platform", "google_business");

      return htmlResponse("✅ Google account connected successfully! You can close this window.", false);

    } catch (err: any) {
      console.error("OAuth callback error:", err);
      return htmlResponse(`Error: ${err.message}`, true);
    }
  }

  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  if (req.method === "POST") {
    try {
      const authHeader = req.headers.get("authorization");
      if (!authHeader) return jsonResponse({ error: "Unauthorized" }, 401);

      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
      const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

      const userClient = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user }, error: userError } = await userClient.auth.getUser();
      if (userError || !user) return jsonResponse({ error: "Unauthorized" }, 401);

      const adminClient = createClient(supabaseUrl, supabaseServiceKey);
      const { data: roleData } = await adminClient
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .eq("role", "admin")
        .maybeSingle();

      if (!roleData) return jsonResponse({ error: "Admin access required" }, 403);

      const body = await req.json();
      const { action } = body;

      if (action === "save-credentials") {
        const { clientId, clientSecret } = body;
        if (!clientId || !clientSecret) {
          return jsonResponse({ error: "Client ID and Secret are required" }, 400);
        }

        await adminClient
          .from("platform_credentials")
          .upsert({
            platform: "google_business",
            credentials: { client_id: clientId, client_secret: clientSecret },
            updated_at: new Date().toISOString(),
          }, { onConflict: "platform" });

        const redirectUri = `${supabaseUrl}/functions/v1/google-oauth-callback`;
        const state = btoa(JSON.stringify({
          returnUrl: body.returnUrl || "",
          userId: user.id,
        }));

        const oauthUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        oauthUrl.searchParams.set("client_id", clientId);
        oauthUrl.searchParams.set("redirect_uri", redirectUri);
        oauthUrl.searchParams.set("response_type", "code");
        oauthUrl.searchParams.set("scope", "https://www.googleapis.com/auth/business.manage");
        oauthUrl.searchParams.set("access_type", "offline");
        oauthUrl.searchParams.set("prompt", "consent");
        oauthUrl.searchParams.set("state", state);

        return jsonResponse({
          success: true,
          oauth_url: oauthUrl.toString(),
          redirect_uri: redirectUri,
        });
      }

      if (action === "check-connection") {
        const { data: creds } = await adminClient
          .from("platform_credentials")
          .select("credentials, updated_at")
          .eq("platform", "google_business")
          .maybeSingle();

        if (!creds?.credentials) return jsonResponse({ connected: false });

        const c = creds.credentials as any;
        return jsonResponse({
          connected: !!c.refresh_token,
          has_client_id: !!c.client_id,
          has_client_secret: !!c.client_secret,
          has_refresh_token: !!c.refresh_token,
          has_location: !!c.location_name,
          location_name: c.location_name || null,
          connected_at: c.connected_at || null,
        });
      }

      if (action === "save-location") {
        let { locationName, accountName } = body;
        if (!locationName) {
          return jsonResponse({ error: "Business Profile ID is required." }, 400);
        }

        locationName = locationName.trim();
        if (/^\d{5,}$/.test(locationName)) {
          locationName = `locations/${locationName}`;
        }
        const fullPathMatch = locationName.match(/^(accounts\/\d+)\/locations\/\d+$/);
        if (fullPathMatch && !accountName) {
          accountName = fullPathMatch[1];
        }
        if (!/^(accounts\/\d+\/)?locations\/\d+$/.test(locationName)) {
          return jsonResponse({ error: "Invalid format. Enter a numeric Business Profile ID, locations/ID, or accounts/ID/locations/ID." }, 400);
        }

        const { data: creds } = await adminClient
          .from("platform_credentials")
          .select("credentials")
          .eq("platform", "google_business")
          .maybeSingle();

        if (!creds?.credentials) return jsonResponse({ error: "Not connected yet" }, 400);

        const currentCreds = creds.credentials as any;
        await adminClient
          .from("platform_credentials")
          .update({
            credentials: {
              ...currentCreds,
              location_name: locationName,
              account_name: accountName || null,
            },
            updated_at: new Date().toISOString(),
          })
          .eq("platform", "google_business");

        return jsonResponse({ success: true });
      }

      return jsonResponse({ error: "Unknown action" }, 400);

    } catch (err: any) {
      console.error("Google OAuth error:", err);
      return jsonResponse({ error: err.message || "Internal error" }, 500);
    }
  }

  return jsonResponse({ error: "Method not allowed" }, 405);
});

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function htmlResponse(message: string, isError: boolean) {
  const color = isError ? "#dc2626" : "#16a34a";
  const icon = isError ? "❌" : "✅";
  const html = `<!DOCTYPE html>
<html>
<head><title>Google Business Setup</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f9fafb; }
  .card { background: white; border-radius: 12px; padding: 40px; text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,0.1); max-width: 420px; }
  .icon { font-size: 48px; margin-bottom: 16px; }
  .message { color: ${color}; font-size: 16px; line-height: 1.5; }
  .close-btn { margin-top: 24px; padding: 10px 24px; background: ${color}; color: white; border: none; border-radius: 8px; font-size: 14px; cursor: pointer; }
  .close-btn:hover { opacity: 0.9; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <p class="message">${message}</p>
    <button class="close-btn" onclick="window.close(); if(!window.closed) window.opener?.postMessage('google-oauth-${isError ? "error" : "success"}', '*');">
      Close Window
    </button>
  </div>
  <script>
    if (window.opener) {
      window.opener.postMessage('google-oauth-${isError ? "error" : "success"}', '*');
    }
  </script>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html" } });
}
