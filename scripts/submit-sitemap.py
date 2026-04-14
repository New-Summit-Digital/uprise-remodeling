"""Submit sitemap.xml to Google Search Console via Webmasters API."""
import json
import os
import sys
import urllib.parse

import requests
from google.auth.transport.requests import Request
from google.oauth2 import service_account

SCOPES = ["https://www.googleapis.com/auth/webmasters"]


def main():
    sa_json = os.environ["GSC_SERVICE_ACCOUNT_JSON"]
    site_url = os.environ["SITE_URL"]
    sitemap_url = os.environ["SITEMAP_URL"]

    creds = service_account.Credentials.from_service_account_info(
        json.loads(sa_json), scopes=SCOPES
    )
    creds.refresh(Request())

    encoded_site = urllib.parse.quote(site_url, safe="")
    encoded_sitemap = urllib.parse.quote(sitemap_url, safe="")
    api = f"https://www.googleapis.com/webmasters/v3/sites/{encoded_site}/sitemaps/{encoded_sitemap}"

    r = requests.put(api, headers={"Authorization": f"Bearer {creds.token}"})
    if r.status_code not in (200, 204):
        print(f"FAIL {r.status_code}: {r.text}", file=sys.stderr)
        sys.exit(1)
    print(f"Submitted sitemap: {sitemap_url}")


if __name__ == "__main__":
    main()
