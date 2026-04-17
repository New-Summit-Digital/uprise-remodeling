#!/usr/bin/env python3
"""
Check results of a queued social_media_posts row across FB, IG, GBP.

Usage:
    python3 check-test-post.py <post-uuid>
"""
import json
import sys
from pathlib import Path
import urllib.request
import urllib.error

if len(sys.argv) < 2:
    print("Usage: check-test-post.py <post-uuid>", file=sys.stderr)
    sys.exit(1)
POST_ID = sys.argv[1]


def load_env(path):
    env = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def rest_get(url, key):
    req = urllib.request.Request(
        url,
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"GET {url} → {e.code}: {e.read().decode()}")


def main():
    env = load_env(Path(__file__).resolve().parent.parent / ".env.local")
    url = env["SUPABASE_URL"]
    key = env["SUPABASE_SERVICE_ROLE_KEY"]

    rows = rest_get(
        f"{url}/rest/v1/social_media_posts?id=eq.{POST_ID}&select=id,status,published_at,platforms,notes,updated_at",
        key,
    )
    if not rows:
        print(f"ERROR: post {POST_ID} not found", file=sys.stderr)
        return 1

    row = rows[0]
    print(f"Post: {row['id']}")
    print(f"  status:       {row['status']}")
    print(f"  published_at: {row.get('published_at')}")
    print(f"  updated_at:   {row['updated_at']}")
    print(f"  platforms:    {row['platforms']}")
    print(f"  notes:        {row.get('notes')}")

    # Pull any publish_results rows (if that table exists in this schema)
    try:
        logs = rest_get(
            f"{url}/rest/v1/social_publish_results?post_id=eq.{POST_ID}&select=*",
            key,
        )
        if logs:
            print(f"\nPublish results ({len(logs)}):")
            for l in logs:
                print(f"  • {l.get('platform')}: {l.get('success')} — {json.dumps(l.get('response') or {})[:200]}")
    except RuntimeError:
        pass  # table may not exist

    return 0


if __name__ == "__main__":
    sys.exit(main())
