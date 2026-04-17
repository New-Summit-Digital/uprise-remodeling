// supabase/functions/google-business-setup/index.ts
//
// GBP setup wizard: test connection, get status, health check.
// Used by the admin dashboard to verify Google Business Profile credentials.
//
// No Lovable dependencies — ported verbatim.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return jsonResponse({ error: "Unauthorized" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

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

    if (action === "test-connection") return await handleTestConnection(body);
    if (action === "get-status") return await handleGetStatus();
    if (action === "health-check") return await handleHealthCheck();

    return jsonResponse({ error: "Unknown action" }, 400);
  } catch (error: any) {
    console.error("Google Business setup error:", error);
    return jsonResponse({ error: error.message || "Internal error" }, 500);
  }
});

async function handleTestConnection(body: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  locationName: string;
}) {
  const clientId = typeof body.clientId === "string" ? body.clientId.slice(0, 200) : "";
  const clientSecret = typeof body.clientSecret === "string" ? body.clientSecret.slice(0, 200) : "";
  const refreshToken = typeof body.refreshToken === "string" ? body.refreshToken.slice(0, 1000) : "";
  const locationName = typeof body.locationName === "string" ? body.locationName.slice(0, 300) : "";

  if (!clientId || !clientSecret || !refreshToken || !locationName) {
    return jsonResponse({ error: "All four fields are required" }, 400);
  }

  console.log("Testing Google OAuth refresh token...");
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const tokenData = await tokenRes.json();

  if (!tokenData.access_token) {
    return jsonResponse({
      error: `Token refresh failed: ${tokenData.error_description || tokenData.error || "Unknown error"}`,
      step: "token_refresh",
    }, 400);
  }

  console.log("Token refresh successful");
  console.log("Testing location access:", locationName);
  const locationRes = await fetch(
    `https://mybusiness.googleapis.com/v4/${locationName}`,
    {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "Content-Type": "application/json",
      },
    }
  );

  let locationValid = false;
  let locationInfo: any = null;

  if (locationRes.ok) {
    locationInfo = await locationRes.json();
    locationValid = true;
    console.log("Location found:", locationInfo.locationName || locationInfo.name);
  } else {
    const errData = await locationRes.json().catch(() => ({}));
    console.log("Location lookup response:", locationRes.status, JSON.stringify(errData));
    if (locationRes.status === 403 || locationRes.status === 404) {
      locationInfo = { warning: "Could not verify location — the API may require additional permissions. Posting may still work." };
    } else {
      return jsonResponse({
        error: `Location verification failed (${locationRes.status}): ${errData?.error?.message || "Unknown error"}`,
        step: "location_verify",
      }, 400);
    }
  }

  return jsonResponse({
    success: true,
    token_valid: true,
    location_valid: locationValid,
    location_info: locationInfo,
    message: locationValid
      ? "All credentials verified successfully!"
      : "Token is valid. Location could not be fully verified but may still work for posting.",
  });
}

async function handleGetStatus() {
  let hasClientId = !!Deno.env.get("GOOGLE_CLIENT_ID");
  let hasClientSecret = !!Deno.env.get("GOOGLE_CLIENT_SECRET");
  let hasRefreshToken = !!Deno.env.get("GOOGLE_REFRESH_TOKEN");
  let hasLocationName = !!Deno.env.get("GOOGLE_LOCATION_NAME");

  if (!hasRefreshToken) {
    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const adminClient = createClient(supabaseUrl, supabaseServiceKey);
      const { data } = await adminClient
        .from("platform_credentials")
        .select("credentials")
        .eq("platform", "google_business")
        .maybeSingle();

      if (data?.credentials) {
        const c = data.credentials as any;
        hasClientId = hasClientId || !!c.client_id;
        hasClientSecret = hasClientSecret || !!c.client_secret;
        hasRefreshToken = hasRefreshToken || !!c.refresh_token;
        hasLocationName = hasLocationName || !!c.location_name;
      }
    } catch (e) {
      console.log("Could not check platform_credentials:", e);
    }
  }

  return jsonResponse({
    configured: hasClientId && hasClientSecret && hasRefreshToken && hasLocationName,
    secrets: {
      client_id: hasClientId,
      client_secret: hasClientSecret,
      refresh_token: hasRefreshToken,
      location_name: hasLocationName,
    },
  });
}

async function getCredentialsFromAnySource() {
  let clientId = Deno.env.get("GOOGLE_CLIENT_ID") || "";
  let clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET") || "";
  let refreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN") || "";
  let locationName = Deno.env.get("GOOGLE_LOCATION_NAME") || "";

  if (!refreshToken) {
    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const adminClient = createClient(supabaseUrl, supabaseServiceKey);
      const { data } = await adminClient
        .from("platform_credentials")
        .select("credentials")
        .eq("platform", "google_business")
        .maybeSingle();

      if (data?.credentials) {
        const c = data.credentials as any;
        clientId = c.client_id || clientId;
        clientSecret = c.client_secret || clientSecret;
        refreshToken = c.refresh_token || refreshToken;
        locationName = c.location_name || locationName;
      }
    } catch (e) {
      console.log("Could not read platform_credentials:", e);
    }
  }

  return { clientId, clientSecret, refreshToken, locationName };
}

async function handleHealthCheck() {
  const { clientId, clientSecret, refreshToken, locationName } = await getCredentialsFromAnySource();

  if (!clientId || !clientSecret || !refreshToken || !locationName) {
    return jsonResponse({
      healthy: false,
      error: "Missing credentials",
      details: {
        client_id: !!clientId,
        client_secret: !!clientSecret,
        refresh_token: !!refreshToken,
        location_name: !!locationName,
      },
      checked_at: new Date().toISOString(),
    });
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      const errorMsg = tokenData.error_description || tokenData.error || "Unknown error";
      console.error("Google health check: token refresh failed:", errorMsg);
      return jsonResponse({
        healthy: false,
        error: `Token refresh failed: ${errorMsg}`,
        revoked: tokenData.error === "invalid_grant",
        checked_at: new Date().toISOString(),
      });
    }

    let locationHealthy = true;
    let locationWarning: string | null = null;

    const locationRes = await fetch(
      `https://mybusiness.googleapis.com/v4/${locationName}`,
      {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!locationRes.ok) {
      const errBody = await locationRes.text();
      locationHealthy = false;
      locationWarning = `Location check returned ${locationRes.status}`;
      console.log("Google health check: location warning:", locationRes.status, errBody);
    } else {
      await locationRes.text();
    }

    return jsonResponse({
      healthy: true,
      token_valid: true,
      location_valid: locationHealthy,
      location_warning: locationWarning,
      checked_at: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("Google health check error:", err);
    return jsonResponse({
      healthy: false,
      error: err.message,
      checked_at: new Date().toISOString(),
    });
  }
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
