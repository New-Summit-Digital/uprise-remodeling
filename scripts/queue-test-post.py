#!/usr/bin/env python3
"""
Queue a single test social_media_post scheduled for ~1 min ago so the next
publish-social-posts cron run picks it up and publishes to FB + IG + GBP.
"""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
import urllib.request
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


def rest(method: str, url: str, key: str, body: dict | None = None):
    req = urllib.request.Request(
        url,
        method=method,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
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
        raise RuntimeError(f"REST {method} {url} → {e.code}: {e.read().decode()}")


def main() -> int:
    env = load_env(Path(__file__).resolve().parent.parent / ".env.local")
    supabase_url = env["SUPABASE_URL"]
    service_key = env["SUPABASE_SERVICE_ROLE_KEY"]

    # 1. Pick an existing image from media_library (prefer recently uploaded)
    imgs = rest(
        "GET",
        f"{supabase_url}/rest/v1/media_library?select=id,file_name,file_url&order=created_at.desc&limit=5",
        service_key,
    )
    if not imgs:
        print("ERROR: media_library is empty", file=sys.stderr)
        return 1

    # Pick the first one that has a URL
    media = next((m for m in imgs if m.get("file_url")), None)
    if not media:
        print("ERROR: no media_library row has a file_url", file=sys.stderr)
        return 1
    print(f"→ Attaching media: {media['file_name']} (id={media['id']})")

    # 2. Insert the scheduled post, due ~1 min ago
    scheduled_at = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    post = {
        "content": "Happy spring from all of us at Blessed Day Doodles! 🌸🐾",
        "platforms": ["facebook", "instagram", "google_business"],
        "status": "scheduled",
        "scheduled_at": scheduled_at,
        "media_ids": [media["id"]],
        "category": "general",
        "hashtags": [],
        "ai_generated": False,
        "notes": "Multi-platform publish test after BDD migration",
    }
    result = rest(
        "POST",
        f"{supabase_url}/rest/v1/social_media_posts",
        service_key,
        body=post,
    )
    row = result[0] if isinstance(result, list) else result
    print(f"✓ Queued post id={row['id']}")
    print(f"  scheduled_at={row['scheduled_at']}")
    print(f"  platforms={row['platforms']}")
    print(f"  Next cron fires within 15 min (schedule: */15 * * * *).")
    print(f"  To check results after cron run:")
    print(f"    SELECT status, published_at, platforms, notes")
    print(f"    FROM social_media_posts WHERE id = '{row['id']}';")
    return 0


if __name__ == "__main__":
    sys.exit(main())
