#!/usr/bin/env python3
"""
Trigger Instagram account auto-discovery and persist the IG business account
ID + username into platform_credentials.credentials.

Runs the same Graph API call that publish-social-posts runs inline, but
ahead of any scheduled post — so the first IG publish doesn't fail waiting
for the discovery to happen.
"""
import os
import sys
import json
from pathlib import Path
import urllib.request
import urllib.parse
import urllib.error


def load_env(path: Path) -> dict:
    env = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def supabase_rest(method: str, url: str, service_key: str, body: dict | None = None) -> dict | list:
    req = urllib.request.Request(
        url,
        method=method,
        headers={
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        },
        data=json.dumps(body).encode() if body else None,
    )
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        raise RuntimeError(f"Supabase REST {method} {url} → {e.code}: {body}")


def graph_get(path: str, token: str, fields: str | None = None) -> dict:
    qs = {"access_token": token}
    if fields:
        qs["fields"] = fields
    url = f"https://graph.facebook.com/v21.0/{path}?{urllib.parse.urlencode(qs)}"
    try:
        with urllib.request.urlopen(url) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        raise RuntimeError(f"Graph API {e.code}: {body}")


def main() -> int:
    env_path = Path(__file__).resolve().parent.parent / ".env.local"
    if not env_path.exists():
        print(f"ERROR: missing {env_path}", file=sys.stderr)
        return 1

    env = load_env(env_path)
    supabase_url = env.get("SUPABASE_URL")
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        print("ERROR: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in .env.local", file=sys.stderr)
        return 1

    # 1. Fetch the Meta row from platform_credentials
    rows = supabase_rest(
        "GET",
        f"{supabase_url}/rest/v1/platform_credentials?platform=eq.meta&select=id,credentials",
        service_key,
    )
    if not rows:
        print("ERROR: no platform_credentials row for platform=meta", file=sys.stderr)
        return 1

    row = rows[0]
    credentials = row.get("credentials") or {}
    page_id = credentials.get("page_id")
    page_token = credentials.get("page_access_token")

    if not page_id or not page_token:
        print("ERROR: credentials row missing page_id or page_access_token", file=sys.stderr)
        print(f"  page_id: {bool(page_id)}, page_access_token: {bool(page_token)}", file=sys.stderr)
        return 1

    print(f"→ Found Meta row. page_id={page_id}, already_has_ig={bool(credentials.get('instagram_account_id'))}")

    # 2. Call Graph API to resolve the IG business account linked to this page
    print("→ Calling Graph API: instagram_business_account{id,username,name}")
    page_data = graph_get(
        page_id,
        page_token,
        fields="instagram_business_account{id,username,name}",
    )

    ig = page_data.get("instagram_business_account")
    if not ig:
        print("ERROR: Graph API returned no instagram_business_account.", file=sys.stderr)
        print(f"  Raw response: {json.dumps(page_data)}", file=sys.stderr)
        print("  → Check: (1) IG is linked to this Page in Meta Business Suite", file=sys.stderr)
        print("    (2) Token has instagram_basic + instagram_content_publish scopes", file=sys.stderr)
        print("    (3) IG account is a Business or Creator account", file=sys.stderr)
        return 2

    ig_id = ig["id"]
    ig_username = ig.get("username")
    print(f"✓ Found IG account: @{ig_username} (id={ig_id})")

    # 3. Patch platform_credentials.credentials with the IG info
    updated_credentials = {
        **credentials,
        "instagram_account_id": ig_id,
        "instagram_username": ig_username,
    }
    from datetime import datetime, timezone
    supabase_rest(
        "PATCH",
        f"{supabase_url}/rest/v1/platform_credentials?id=eq.{row['id']}",
        service_key,
        body={
            "credentials": updated_credentials,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        },
    )
    print(f"✓ Saved instagram_account_id + instagram_username to platform_credentials.")
    print(f"  You can now publish to Instagram.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
