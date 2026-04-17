// supabase/functions/meta-token-exchange/index.ts
//
// Meta (Facebook/Instagram) token exchange + refresh + diagnostics.
// Actions: exchange-token, get-credentials, refresh-token, token-health,
//          diagnose, validate-token.
//
// No Lovable dependencies — ported verbatim. Uses CRON_SECRET env var for
// cron-triggered refresh (unchanged from original).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function jsonRes(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function fetchJson(url: string) {
  const res = await fetch(url);
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`Invalid JSON response from Meta: ${text.substring(0, 200)}`); }
}

async function getPagesFromMeAccounts(accessToken: string) {
  const data = await fetchJson(`https://graph.facebook.com/v21.0/me/accounts?access_token=${accessToken}`);
  if (data.error) return { pages: [] as any[], error: data.error.message as string };
  return { pages: (data.data || []) as any[], error: null as string | null };
}

async function getBusinessPagesWithTokens(accessToken: string) {
  const businessesData = await fetchJson(
    `https://graph.facebook.com/v21.0/me/businesses?fields=id,name,owned_pages.limit(100){id,name},client_pages.limit(100){id,name}&access_token=${accessToken}`
  );

  if (businessesData.error) {
    return { pages: [] as any[], businessPagesFound: 0, businessPageNames: [] as string[], error: businessesData.error.message as string };
  }

  const uniquePages = new Map<string, { id: string; name: string }>();
  const businesses = businessesData.data || [];

  for (const business of businesses) {
    const ownedPages = business?.owned_pages?.data || [];
    const clientPages = business?.client_pages?.data || [];
    for (const page of [...ownedPages, ...clientPages]) {
      if (page?.id && !uniquePages.has(page.id)) {
        uniquePages.set(page.id, { id: page.id, name: page.name || "Unknown Page" });
      }
    }
  }

  const businessPageNames = Array.from(uniquePages.values()).map((p) => p.name);
  const pagesWithTokens: any[] = [];

  for (const page of uniquePages.values()) {
    try {
      const pageData = await fetchJson(
        `https://graph.facebook.com/v21.0/${page.id}?fields=id,name,access_token&access_token=${accessToken}`
      );
      if (!pageData.error && pageData.access_token) {
        pagesWithTokens.push({
          id: pageData.id || page.id,
          name: pageData.name || page.name,
          access_token: pageData.access_token,
        });
      }
    } catch { /* continue */ }
  }

  return { pages: pagesWithTokens, businessPagesFound: uniquePages.size, businessPageNames, error: null as string | null };
}

async function discoverPublishablePages(longLivedUserToken: string, shortLivedToken: string) {
  const publishablePagesById = new Map<string, any>();
  let businessPagesFound = 0;
  const businessPageNamesSet = new Set<string>();

  for (const tokenSource of [
    { label: "long-lived", token: longLivedUserToken },
    { label: "short-lived", token: shortLivedToken },
  ]) {
    const accountResult = await getPagesFromMeAccounts(tokenSource.token);
    for (const page of accountResult.pages) {
      if (page?.id && page?.access_token) publishablePagesById.set(page.id, page);
    }
  }

  for (const tokenSource of [
    { label: "long-lived", token: longLivedUserToken },
    { label: "short-lived", token: shortLivedToken },
  ]) {
    const businessResult = await getBusinessPagesWithTokens(tokenSource.token);
    businessPagesFound = Math.max(businessPagesFound, businessResult.businessPagesFound || 0);
    for (const name of businessResult.businessPageNames || []) businessPageNamesSet.add(name);

    for (const page of businessResult.pages) {
      if (page?.id && page?.access_token) publishablePagesById.set(page.id, page);
    }
  }

  return {
    pages: Array.from(publishablePagesById.values()),
    source: "combined",
    businessPagesFound,
    businessPageNames: Array.from(businessPageNamesSet.values()),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const body = await req.json();
    const { action } = body;

    const cronSecret = Deno.env.get("CRON_SECRET");
    const cronHeader = req.headers.get("x-cron-secret") || "";
    const isCron = cronSecret && (body.cron_secret === cronSecret || cronHeader === cronSecret);

    if (action === "refresh-token" && isCron) {
      const adminClient = createClient(supabaseUrl, supabaseServiceKey);
      return await handleRefreshToken(adminClient);
    }

    if (action === "token-health" && isCron) {
      const adminClient = createClient(supabaseUrl, supabaseServiceKey);
      return await handleTokenHealth(adminClient);
    }

    const authHeader = req.headers.get("authorization");
    if (!authHeader) return jsonRes({ error: "Unauthorized" }, 401);

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) return jsonRes({ error: "Unauthorized" }, 401);

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);
    const { data: roleData } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle();

    if (!roleData) return jsonRes({ error: "Admin access required" }, 403);

    if (action === "exchange-token") return await handleTokenExchange(body, adminClient);
    if (action === "get-credentials") return await handleGetCredentials(adminClient);
    if (action === "refresh-token") return await handleRefreshToken(adminClient);
    if (action === "token-health") return await handleTokenHealth(adminClient);
    if (action === "diagnose") return await handleDiagnose(body);
    if (action === "validate-token") return await handleValidateToken(body);

    return jsonRes({ error: "Unknown action" }, 400);
  } catch (error: any) {
    console.error("Meta token exchange error:", error);
    return jsonRes({ error: error.message || "Internal error" }, 500);
  }
});

async function handleTokenExchange(
  body: { shortLivedToken: string; appId?: string; appSecret?: string; selectedPageId?: string },
  adminClient: any,
) {
  const shortLivedToken = typeof body.shortLivedToken === "string" ? body.shortLivedToken.slice(0, 1000) : "";
  const appId = typeof body.appId === "string" ? body.appId.slice(0, 200) : "";
  const appSecret = typeof body.appSecret === "string" ? body.appSecret.slice(0, 200) : "";
  const selectedPageId = typeof body.selectedPageId === "string" ? body.selectedPageId.slice(0, 100) : "";

  if (!shortLivedToken) return jsonRes({ error: "Missing shortLivedToken" }, 400);

  const hasAppCredentials = !!(appId && appSecret);
  let longLivedUserToken: string | null = null;
  let userTokenExpiresAt: string | null = null;
  let tokenForPageDiscovery = shortLivedToken;

  if (hasAppCredentials) {
    console.log("Exchanging short-lived token for long-lived token...");
    const exchangeUrl = `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortLivedToken}`;
    const exchangeRes = await fetch(exchangeUrl);
    const exchangeText = await exchangeRes.text();

    let exchangeData;
    try { exchangeData = JSON.parse(exchangeText); }
    catch { return jsonRes({ error: `Token exchange returned invalid response: ${exchangeText.substring(0, 200)}` }, 400); }

    if (exchangeData.error) {
      console.error("Token exchange Meta error:", JSON.stringify(exchangeData.error));
      return jsonRes({
        error: `Token exchange failed: ${exchangeData.error.message}`,
        meta_error: exchangeData.error,
        step: "exchange",
      }, 400);
    }

    longLivedUserToken = exchangeData.access_token;
    const userTokenExpiresIn = exchangeData.expires_in || 5184000;
    userTokenExpiresAt = new Date(Date.now() + userTokenExpiresIn * 1000).toISOString();
    tokenForPageDiscovery = longLivedUserToken;
  } else {
    console.log("No App ID/Secret. Token-only mode (manual reconnect on expiry).");
  }

  const pageDiscovery = await discoverPublishablePages(tokenForPageDiscovery, shortLivedToken);
  const pages = pageDiscovery.pages;

  if (pages.length === 0) {
    if (pageDiscovery.businessPagesFound > 0) {
      const businessPagePreview = pageDiscovery.businessPageNames?.slice(0, 10).join(", ") || "(names unavailable)";
      return jsonRes({
        error: `We found ${pageDiscovery.businessPagesFound} page(s) in your Business Suite (${businessPagePreview}), but Meta did not return a publishable Page Access Token. Grant direct Facebook Page access with content/posting tasks.`,
        step: "pages",
      }, 400);
    }
    return jsonRes({
      error: "No Facebook Pages found. Ensure you selected your Page in the Meta popup, token includes pages_show_list, and you have direct Page access.",
      step: "pages",
    }, 400);
  }

  const selectedPage = selectedPageId ? pages.find((p: any) => p.id === selectedPageId) : null;
  if (selectedPageId && !selectedPage) {
    return jsonRes({
      error: `Selected page (${selectedPageId}) is not publishable. Choose one of: ${pages.map((p: any) => p.name).join(", ")}`,
      step: "pages",
    }, 400);
  }

  const page = selectedPage || pages[0];
  console.log(`Using page: ${page.name} (${page.id})`);

  let instagramAccountId: string | null = null;
  let instagramUsername: string | null = null;

  try {
    const igRes = await fetch(
      `https://graph.facebook.com/v21.0/${page.id}?fields=instagram_business_account&access_token=${page.access_token}`
    );
    const igData = await igRes.json();
    if (igData.instagram_business_account) {
      instagramAccountId = igData.instagram_business_account.id;
      const igProfileRes = await fetch(
        `https://graph.facebook.com/v21.0/${instagramAccountId}?fields=username&access_token=${page.access_token}`
      );
      const igProfileData = await igProfileRes.json();
      instagramUsername = igProfileData.username || null;
    }
  } catch (igError) {
    console.log("Instagram lookup failed (not critical):", igError);
  }

  const credentials = {
    page_access_token: page.access_token,
    page_id: page.id,
    page_name: page.name,
    instagram_account_id: instagramAccountId,
    instagram_username: instagramUsername,
    app_id: appId || null,
    app_secret: appSecret || null,
    long_lived_user_token: longLivedUserToken,
    user_token_expires_at: userTokenExpiresAt,
    exchanged_at: new Date().toISOString(),
    last_refreshed_at: new Date().toISOString(),
    all_pages: pages.map((p: any) => ({ id: p.id, name: p.name })),
    connection_mode: hasAppCredentials ? "refreshable" : "token_only",
  };

  const { error: upsertError } = await adminClient
    .from("platform_credentials")
    .upsert({ platform: "meta", credentials }, { onConflict: "platform" });

  if (upsertError) {
    return jsonRes({ error: `Failed to store credentials: ${upsertError.message}`, step: "storage" }, 500);
  }

  return jsonRes({
    success: true,
    page_name: page.name,
    page_id: page.id,
    instagram_account_id: instagramAccountId,
    instagram_username: instagramUsername,
    user_token_expires_at: userTokenExpiresAt,
    has_refresh_capability: hasAppCredentials,
    connection_mode: hasAppCredentials ? "refreshable" : "token_only",
    all_pages: pages.map((p: any) => ({ id: p.id, name: p.name })),
  });
}

async function handleRefreshToken(adminClient: any) {
  console.log("Starting Meta token refresh...");
  const { data, error } = await adminClient
    .from("platform_credentials")
    .select("*")
    .eq("platform", "meta")
    .maybeSingle();

  if (error || !data) return jsonRes({ refreshed: false, reason: "No credentials configured" });

  const creds = data.credentials as any;
  const { long_lived_user_token, app_id, app_secret, user_token_expires_at } = creds;

  if (!long_lived_user_token || !app_id || !app_secret) {
    return jsonRes({ refreshed: false, reason: "Missing long-lived user token or app credentials. Re-run Meta Setup." });
  }

  const expiresAt = user_token_expires_at ? new Date(user_token_expires_at) : null;
  const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  let activeUserToken = long_lived_user_token;
  let activeExpiresAt = user_token_expires_at;
  let userTokenWasRefreshed = false;

  if (!expiresAt || expiresAt <= sevenDaysFromNow) {
    console.log("User token expiring soon, refreshing...");
    const refreshUrl = `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${app_id}&client_secret=${app_secret}&fb_exchange_token=${long_lived_user_token}`;
    const refreshRes = await fetch(refreshUrl);
    const refreshData = await refreshRes.json();

    if (refreshData.error) {
      return jsonRes({
        refreshed: false,
        error: refreshData.error.message,
        meta_error: refreshData.error,
        reason: "Token refresh failed. Token may be revoked. Re-run Meta Setup.",
      });
    }

    activeUserToken = refreshData.access_token;
    const newExpiresIn = refreshData.expires_in || 5184000;
    activeExpiresAt = new Date(Date.now() + newExpiresIn * 1000).toISOString();
    userTokenWasRefreshed = true;
  }

  const accountsRes = await fetch(`https://graph.facebook.com/v21.0/me/accounts?access_token=${activeUserToken}`);
  const accountsData = await accountsRes.json();

  if (accountsData.error || !accountsData.data?.length) {
    creds.long_lived_user_token = activeUserToken;
    creds.user_token_expires_at = activeExpiresAt;
    creds.last_refreshed_at = new Date().toISOString();
    creds.last_refresh_error = accountsData.error?.message || "No pages found";
    await adminClient.from("platform_credentials").upsert({ platform: "meta", credentials: creds }, { onConflict: "platform" });
    return jsonRes({ refreshed: userTokenWasRefreshed, warning: "User token stored but page token update failed", expires_at: activeExpiresAt });
  }

  const targetPage = accountsData.data.find((p: any) => p.id === creds.page_id) || accountsData.data[0];

  creds.long_lived_user_token = activeUserToken;
  creds.user_token_expires_at = activeExpiresAt;
  creds.page_access_token = targetPage.access_token;
  creds.page_id = targetPage.id;
  creds.page_name = targetPage.name;
  creds.last_refreshed_at = new Date().toISOString();
  delete creds.last_refresh_error;
  creds.all_pages = accountsData.data.map((p: any) => ({ id: p.id, name: p.name }));

  if (creds.instagram_account_id) {
    try {
      const igRes = await fetch(
        `https://graph.facebook.com/v21.0/${targetPage.id}?fields=instagram_business_account&access_token=${targetPage.access_token}`
      );
      const igData = await igRes.json();
      if (igData.instagram_business_account) {
        creds.instagram_account_id = igData.instagram_business_account.id;
      }
    } catch { /* keep existing */ }
  }

  const { error: upsertError } = await adminClient
    .from("platform_credentials")
    .upsert({ platform: "meta", credentials: creds }, { onConflict: "platform" });

  if (upsertError) return jsonRes({ refreshed: false, error: upsertError.message }, 500);

  const newExpiryDate = activeExpiresAt ? new Date(activeExpiresAt) : null;
  const daysUntilExpiry = newExpiryDate ? Math.max(0, Math.round((newExpiryDate.getTime() - Date.now()) / 86400000)) : null;

  return jsonRes({
    refreshed: true,
    page_name: targetPage.name,
    expires_at: activeExpiresAt,
    days_until_expiry: daysUntilExpiry,
    user_token_refreshed: userTokenWasRefreshed,
  });
}

async function handleTokenHealth(adminClient: any) {
  const { data, error } = await adminClient
    .from("platform_credentials")
    .select("*")
    .eq("platform", "meta")
    .maybeSingle();

  if (error || !data) return jsonRes({ configured: false });

  const creds = data.credentials as any;
  const result: any = {
    configured: true,
    page_name: creds.page_name,
    page_id: creds.page_id,
    instagram_account_id: creds.instagram_account_id,
    instagram_username: creds.instagram_username,
    exchanged_at: creds.exchanged_at,
    last_refreshed_at: creds.last_refreshed_at,
    user_token_expires_at: creds.user_token_expires_at,
    has_refresh_capability: !!(creds.long_lived_user_token && creds.app_id && creds.app_secret),
  };

  if (creds.user_token_expires_at) {
    const expiresAt = new Date(creds.user_token_expires_at);
    const daysLeft = Math.round((expiresAt.getTime() - Date.now()) / 86400000);
    result.days_until_expiry = daysLeft;
    result.token_status = daysLeft <= 0 ? "expired" : daysLeft <= 7 ? "expiring_soon" : "healthy";
  } else {
    result.token_status = "unknown";
  }

  if (creds.page_access_token && creds.page_id) {
    try {
      const testRes = await fetch(
        `https://graph.facebook.com/v21.0/${creds.page_id}?fields=name&access_token=${creds.page_access_token}`
      );
      const testData = await testRes.json();
      if (testData.error) {
        result.page_token_valid = false;
        result.page_token_error = testData.error.message;
        result.token_status = "invalid";
      } else {
        result.page_token_valid = true;
      }
    } catch (e: any) {
      result.page_token_valid = false;
      result.page_token_error = e.message;
    }
  }

  return jsonRes(result);
}

async function handleGetCredentials(adminClient: any) {
  const { data, error } = await adminClient
    .from("platform_credentials")
    .select("*")
    .eq("platform", "meta")
    .maybeSingle();

  if (error) return jsonRes({ error: error.message }, 500);
  if (!data) return jsonRes({ configured: false });

  const creds = data.credentials as any;
  return jsonRes({
    configured: true,
    page_name: creds.page_name,
    page_id: creds.page_id,
    instagram_account_id: creds.instagram_account_id,
    instagram_username: creds.instagram_username,
    exchanged_at: creds.exchanged_at,
    last_refreshed_at: creds.last_refreshed_at,
    user_token_expires_at: creds.user_token_expires_at,
    has_refresh_capability: !!(creds.long_lived_user_token && creds.app_id && creds.app_secret),
    all_pages: creds.all_pages,
  });
}

async function handleDiagnose(body: { appId?: string; appSecret?: string; shortLivedToken?: string }) {
  const results: Array<{ step: string; status: "pass" | "fail" | "skip"; detail: string }> = [];
  results.push({ step: "Edge function reachable", status: "pass", detail: "Function responded successfully." });

  const { appId, appSecret, shortLivedToken } = body;

  if (!appId) results.push({ step: "App ID format", status: "skip", detail: "No App ID provided." });
  else if (!/^\d{10,20}$/.test(appId)) results.push({ step: "App ID format", status: "fail", detail: `"${appId}" doesn't look valid. Should be 10-20 digits.` });
  else results.push({ step: "App ID format", status: "pass", detail: `App ID ${appId} format is valid.` });

  if (!appSecret) results.push({ step: "App Secret format", status: "skip", detail: "No App Secret provided." });
  else if (!/^[a-f0-9]{20,40}$/.test(appSecret)) results.push({ step: "App Secret format", status: "fail", detail: "App Secret format invalid. Should be 32-char hex." });
  else results.push({ step: "App Secret format", status: "pass", detail: "App Secret format is valid." });

  if (!shortLivedToken) results.push({ step: "Token validation", status: "skip", detail: "No token provided." });
  else if (appId && appSecret) {
    try {
      const debugUrl = `https://graph.facebook.com/debug_token?input_token=${shortLivedToken}&access_token=${appId}|${appSecret}`;
      const debugRes = await fetch(debugUrl);
      const debugData = await debugRes.json();

      if (debugData.error) results.push({ step: "Token validation", status: "fail", detail: `Meta API error: ${debugData.error.message}` });
      else if (debugData.data) {
        const d = debugData.data;
        if (!d.is_valid) results.push({ step: "Token validation", status: "fail", detail: d.error?.message || "Token invalid or expired." });
        else {
          const scopes = d.scopes || [];
          results.push({ step: "Token validation", status: "pass", detail: `Valid. Expires: ${d.expires_at ? new Date(d.expires_at * 1000).toLocaleString() : "never"}. App: ${d.app_id}.` });

          const required = ["pages_manage_posts", "pages_read_engagement", "pages_show_list"];
          const missing = required.filter(s => !scopes.includes(s));
          if (missing.length > 0) results.push({ step: "Required permissions", status: "fail", detail: `Missing scopes: ${missing.join(", ")}` });
          else results.push({ step: "Required permissions", status: "pass", detail: `All required scopes present.` });

          if (d.app_id && d.app_id !== appId) {
            results.push({ step: "App ID match", status: "fail", detail: `Token belongs to app ${d.app_id} but you entered ${appId}.` });
          }
        }
      }
    } catch (e: any) {
      results.push({ step: "Token validation", status: "fail", detail: `Could not reach Meta: ${e.message}` });
    }
  } else {
    results.push({ step: "Token validation", status: "skip", detail: "Need App ID and Secret to validate." });
  }

  if (shortLivedToken && appId && appSecret) {
    try {
      const exchangeUrl = `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortLivedToken}`;
      const exchangeRes = await fetch(exchangeUrl);
      const exchangeData = await exchangeRes.json();
      if (exchangeData.error) results.push({ step: "Token exchange", status: "fail", detail: `Failed: ${exchangeData.error.message}` });
      else if (exchangeData.access_token) results.push({ step: "Token exchange", status: "pass", detail: `Succeeded (expires in ${Math.round((exchangeData.expires_in || 0) / 86400)} days).` });
    } catch (e: any) {
      results.push({ step: "Token exchange", status: "fail", detail: `Request failed: ${e.message}` });
    }
  }

  return jsonRes({ results });
}

async function handleValidateToken(body: { shortLivedToken?: string; appId?: string; appSecret?: string }) {
  const { shortLivedToken, appId, appSecret } = body;
  if (!shortLivedToken) return jsonRes({ error: "Short-lived token is required" }, 400);

  const hasAppCredentials = !!(appId && appSecret);
  const result: any = {
    valid: false,
    validation_mode: hasAppCredentials ? "full" : "token_only",
    scopes: [], missing_scopes: [], app_id_match: true,
    expires_at: null, pages_found: 0, page_names: [], pages: [],
    business_pages_found: 0, business_page_names: [],
    errors: [], warnings: [],
  };

  if (hasAppCredentials) {
    try {
      const debugUrl = `https://graph.facebook.com/debug_token?input_token=${shortLivedToken}&access_token=${appId}|${appSecret}`;
      const debugRes = await fetch(debugUrl);
      const debugData = await debugRes.json();

      if (debugData.error) { result.errors.push(`Token debug failed: ${debugData.error.message}`); return jsonRes(result); }

      const d = debugData.data;
      if (!d.is_valid) { result.errors.push(d.error?.message || "Token invalid."); return jsonRes(result); }

      result.scopes = d.scopes || [];
      result.expires_at = d.expires_at ? new Date(d.expires_at * 1000).toISOString() : null;

      if (d.app_id && d.app_id !== appId) {
        result.app_id_match = false;
        result.errors.push(`Token belongs to app ${d.app_id}, not ${appId}.`);
      }

      const required = ["pages_manage_posts", "pages_read_engagement", "pages_show_list"];
      result.missing_scopes = required.filter(s => !result.scopes.includes(s));
      if (result.missing_scopes.length > 0) {
        result.errors.push(`Missing required permissions: ${result.missing_scopes.join(", ")}`);
      }
    } catch (e: any) {
      result.errors.push(`Meta debug error: ${e.message}`);
      return jsonRes(result);
    }
  } else {
    result.warnings.push("App ID/Secret not provided. Running token-only checks.");
  }

  try {
    const publishablePages = new Map<string, { id: string; name: string }>();
    const accountResult = await getPagesFromMeAccounts(shortLivedToken);
    if (accountResult.error) result.warnings.push(`Pages API error: ${accountResult.error}`);
    for (const page of accountResult.pages) {
      if (page?.id) publishablePages.set(page.id, { id: page.id, name: page.name || "Unknown" });
    }

    const businessResult = await getBusinessPagesWithTokens(shortLivedToken);
    result.business_pages_found = businessResult.businessPagesFound || 0;
    result.business_page_names = businessResult.businessPageNames || [];
    for (const page of businessResult.pages) {
      if (page?.id) publishablePages.set(page.id, { id: page.id, name: page.name || "Unknown" });
    }

    result.pages = Array.from(publishablePages.values());
    result.pages_found = result.pages.length;
    result.page_names = result.pages.map((p: any) => p.name);

    if (result.pages_found === 0 && result.business_pages_found > 0) {
      result.errors.push(
        `Business Suite shows ${result.business_pages_found} page(s), but no publishable Page Access Token. Grant direct Facebook Page access.`
      );
    } else if (result.pages_found === 0) {
      result.errors.push("Token returned 0 publishable Pages. Check Page selection + permissions.");
    }
  } catch (e: any) {
    result.warnings.push(`Could not check pages: ${e.message}`);
  }

  result.valid = result.errors.length === 0;
  return jsonRes(result);
}
