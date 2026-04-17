#!/usr/bin/env python3
"""
Pre-deploy guardrail. Run before `supabase functions deploy`.

Validates that every edge function called by pg_cron is declared with
`verify_jwt = false` in supabase/config.toml. If not, pg_cron's net.http_post
calls (which don't send Authorization headers) will be 401-rejected by the
Supabase gateway, posts pile up as `status='scheduled'` forever, and nothing
publishes. This is EXACTLY the bug that broke BDD after the Lovable migration.

Usage:
    python3 scripts/predeploy-check.py

Exits 0 if everything is consistent. Non-zero with a list of missing declarations
if something would silently break at runtime.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CRON_SQL = ROOT / "supabase" / "migrations-manual" / "01-create-cron-jobs.sql"
CONFIG = ROOT / "supabase" / "config.toml"


def fail(msg: str) -> None:
    print(f"❌ {msg}", file=sys.stderr)
    sys.exit(1)


def main() -> int:
    if not CRON_SQL.exists():
        fail(f"missing {CRON_SQL}")
    if not CONFIG.exists():
        fail(f"missing {CONFIG}")

    cron_sql = CRON_SQL.read_text()
    config = CONFIG.read_text()

    # 1. Extract every function name called by cron.schedule
    #    Pattern in cron-jobs.sql: url := '%s' || 'function-name',
    cron_fns = sorted(set(re.findall(r"url\s*:=\s*'%s'\s*\|\|\s*'([a-z0-9_-]+)'", cron_sql)))
    if not cron_fns:
        fail("no cron-called functions found in cron-jobs.sql — regex may need updating")

    print(f"→ Found {len(cron_fns)} cron-called function(s):")
    for f in cron_fns:
        print(f"    • {f}")

    # 2. For each, check the config.toml has [functions.<name>] verify_jwt = false
    missing: list[str] = []
    for fn in cron_fns:
        # Look for the block [functions.<fn>] followed by verify_jwt = false
        # We allow flexible whitespace/comments between block header and setting
        pattern = rf"\[functions\.{re.escape(fn)}\][^\[]*verify_jwt\s*=\s*false"
        if not re.search(pattern, config):
            missing.append(fn)

    if missing:
        print(file=sys.stderr)
        print("❌ Pre-deploy check FAILED", file=sys.stderr)
        print(file=sys.stderr)
        print(
            "The following cron-called edge functions are missing `verify_jwt = false`",
            file=sys.stderr,
        )
        print(
            "in supabase/config.toml. pg_cron cannot reach them; posts will stay stuck",
            file=sys.stderr,
        )
        print("in status='scheduled' forever.\n", file=sys.stderr)
        print("Add the following to supabase/config.toml before deploying:\n", file=sys.stderr)
        for fn in missing:
            print(f"[functions.{fn}]", file=sys.stderr)
            print("verify_jwt = false\n", file=sys.stderr)
        print(
            "See SKILL.md learning #7 for context. Also run the curl probe after",
            file=sys.stderr,
        )
        print(
            "deploy to confirm the gateway lets cron calls through:\n"
            "  curl -i -X POST https://<project>.supabase.co/functions/v1/<fn>\n"
            "Expect app-level error (e.g. {\"error\":\"Unauthorized\"}), NOT",
            file=sys.stderr,
        )
        print("UNAUTHORIZED_NO_AUTH_HEADER.", file=sys.stderr)
        return 2

    print(f"\n✅ All {len(cron_fns)} cron-called function(s) have verify_jwt = false. Safe to deploy.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
