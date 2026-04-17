// supabase/functions/google-discover-locations/index.ts
//
// Walks Google Business Profile API to list all accounts + locations
// the authorized user has access to. Used by the admin setup wizard.
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

    const { data: creds } = await adminClient
      .from("platform_credentials")
      .select("credentials")
      .eq("platform", "google_business")
      .maybeSingle();

    if (!creds?.credentials) {
      return jsonResponse({ error: "Google Business not connected. Complete the OAuth flow first." }, 400);
    }

    const { client_id, client_secret, refresh_token } = creds.credentials as any;
    if (!refresh_token) {
      return jsonResponse({ error: "No refresh token. Please connect your Google account first." }, 400);
    }

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id, client_secret, refresh_token,
        grant_type: "refresh_token",
      }),
    });
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      return jsonResponse({
        error: `Token refresh failed: ${tokenData.error_description || tokenData.error || "Unknown error"}`,
        token_expired: tokenData.error === "invalid_grant",
      }, 400);
    }

    const accessToken = tokenData.access_token;

    console.log("Discovering Google Business accounts...");
    const accountsRes = await fetch(
      "https://mybusinessaccountmanagement.googleapis.com/v1/accounts",
      { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
    );

    if (!accountsRes.ok) {
      const errBody = await accountsRes.json().catch(() => ({}));
      const errMsg = errBody?.error?.message || `HTTP ${accountsRes.status}`;

      if (accountsRes.status === 429 || errBody?.error?.status === "RESOURCE_EXHAUSTED") {
        return jsonResponse({
          error: "API quota exceeded. Google requires you to request API access first.",
          quota_exceeded: true,
          help_url: "https://developers.google.com/my-business/content/prereqs",
          help_text: "You need to submit a GBP API access request form. This typically takes 1-3 business days.",
        }, 429);
      }

      return jsonResponse({ error: `Failed to list accounts: ${errMsg}` }, accountsRes.status);
    }

    const accountsData = await accountsRes.json();
    const accounts = accountsData.accounts || [];

    if (accounts.length === 0) {
      return jsonResponse({
        error: "No Google Business accounts found for this Google account.",
        accounts: [], locations: [],
      }, 200);
    }

    const allLocations: any[] = [];

    for (const account of accounts) {
      const accountName = account.name;
      console.log(`Fetching locations for ${accountName}...`);

      const locationsRes = await fetch(
        `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations?readMask=name,title,storefrontAddress`,
        { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
      );

      if (locationsRes.ok) {
        const locData = await locationsRes.json();
        const locations = locData.locations || [];
        for (const loc of locations) {
          allLocations.push({
            name: loc.name,
            full_name: `${accountName}/${loc.name}`,
            title: loc.title || "Unnamed Location",
            address: loc.storefrontAddress
              ? [
                  loc.storefrontAddress.addressLines?.join(", "),
                  loc.storefrontAddress.locality,
                  loc.storefrontAddress.administrativeArea,
                ].filter(Boolean).join(", ")
              : null,
            account_name: accountName,
            account_display: account.accountName || account.name,
          });
        }
      } else {
        const errBody = await locationsRes.json().catch(() => ({}));
        console.log(`Location fetch for ${accountName} failed:`, locationsRes.status, JSON.stringify(errBody));

        if (locationsRes.status === 429 || errBody?.error?.status === "RESOURCE_EXHAUSTED") {
          return jsonResponse({
            error: "API quota exceeded when fetching locations.",
            quota_exceeded: true,
            help_url: "https://developers.google.com/my-business/content/prereqs",
          }, 429);
        }
      }
    }

    return jsonResponse({
      success: true,
      accounts: accounts.map((a: any) => ({
        name: a.name,
        display_name: a.accountName || a.name,
        type: a.type,
      })),
      locations: allLocations,
    });

  } catch (err: any) {
    console.error("Location discovery error:", err);
    return jsonResponse({ error: err.message || "Internal error" }, 500);
  }
});

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
