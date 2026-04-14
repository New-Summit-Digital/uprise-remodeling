# GSC Sitemap Auto-Submit — One-time Setup

Runs on every push to `master` that touches `sitemap.xml` or any `.html` file. Re-submits `https://www.upriseremodeling.com/sitemap.xml` to Google Search Console.

## Setup (15 min, do once)

### 1. Verify property in Google Search Console
- Go to https://search.google.com/search-console
- Add property: `https://www.upriseremodeling.com/` (URL-prefix, include trailing slash)
- Verify via DNS TXT record in Cloudflare DNS dashboard

### 2. Create a Google Cloud service account
- https://console.cloud.google.com → create/select a project
- Enable **Search Console API** (`searchconsole.googleapis.com`)
- IAM & Admin → Service Accounts → Create
  - Name: `gsc-sitemap-submit`
  - Skip role assignment
- Click the new account → Keys → Add Key → JSON → download

### 3. Grant service account access to the GSC property
- Copy the service account email (looks like `gsc-sitemap-submit@<project>.iam.gserviceaccount.com`)
- GSC → Settings → Users and permissions → Add user
  - Paste the email, permission: **Owner**

### 4. Add the key as a GitHub secret
- GitHub repo → Settings → Secrets and variables → Actions → New repository secret
  - Name: `GSC_SERVICE_ACCOUNT_JSON`
  - Value: paste the entire contents of the JSON key file

### 5. Test
- GitHub → Actions → "Submit sitemap to Google Search Console" → Run workflow
- Should complete in ~10s with `Submitted sitemap: ...`

## Done

From now on, every push that changes HTML or the sitemap auto-submits it. No more manual GSC visits.
