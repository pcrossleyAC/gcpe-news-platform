#!/usr/bin/env bash
# Smoke test for a SiteGround deployment of apps/stack (docs/deploy/siteground.md, "Smoke test").
# Prompts (hidden) for the local admin password and the TICK_TOKEN, then: logs in, adds a test
# subscriber, creates a release scheduled one minute in the past, ticks the stack twice, and
# prints what happened. Secrets are never printed or written to disk.
#
# Usage: scripts/siteground-smoke.sh https://boxs.ca
set -euo pipefail

BASE="${1:?usage: $0 https://<domain>}"
BASE="${BASE%/}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
KEY="SMOKE-${STAMP}"

json_get() { python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get(sys.argv[1], ""))' "$1"; }

ADMIN_JSON="$(python3 -c 'import json,getpass; print(json.dumps({"username":"admin","password":getpass.getpass("Admin password: ")}))')"
TICK_TOKEN="$(python3 -c 'import getpass; print(getpass.getpass("TICK_TOKEN (Enter to rely on the cron job instead): "))')"

echo "== login"
TOKEN="$(printf '%s' "$ADMIN_JSON" | curl -fsS -X POST "$BASE/nrms/auth/local/token" -H 'content-type: application/json' -d @- | json_get access_token)"
unset ADMIN_JSON
[ -n "$TOKEN" ] || { echo "login failed"; exit 1; }
echo "ok"

echo "== health"
curl -sS "$BASE/stack/health"; echo

echo "== add subscriber smoke+${STAMP}@example.test on ministries:health"
curl -sS -X POST "$BASE/nod/api/subscribers" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"email\":\"smoke+${STAMP}@example.test\",\"lists\":[\"ministries:health\"]}"; echo

echo "== create release $KEY"
python3 - "$KEY" <<'PY' | curl -sS -X POST "$BASE/nrms/api/releases" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d @-
import json, sys
key = sys.argv[1]
print(json.dumps({
  "key": key, "kind": "releases", "reference": None, "leadMinistryKey": "health",
  "summary": "Smoke test release from scripts/siteground-smoke.sh.",
  "socialMediaSummary": None, "socialMediaHeadline": None, "keywords": None, "location": "VICTORIA",
  "hasMediaAssets": False, "hasTranslations": False, "isNewsOnDemand": True, "assetUrl": None, "redirectUri": None,
  "documents": [{"pageTitle": "Smoke test", "languageId": 4105, "headline": "Smoke test: weekend clinics open across B.C.",
                 "subheadline": None, "detailsHtml": "<p>This is a smoke test.</p>", "byline": None,
                 "contacts": [{"title": "Media Relations", "details": "Alex Example\n250-555-0100"}]}],
  "ministryKeys": ["health"], "sectorKeys": [], "tagKeys": [], "themeKeys": [],
  "assets": None, "translations": None,
  "publishFlags": {"toWeb": True, "toSubscribers": True, "toMediaLists": False}, "mediaListKeys": [],
}))
PY
echo

echo "== schedule one minute in the past"
PUBLISH_AT="$(date -u -v-1M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '-1 minute' +%Y-%m-%dT%H:%M:%SZ)"
curl -sS -X POST "$BASE/nrms/api/releases/$KEY/schedule" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"publishAt\":\"$PUBLISH_AT\"}"; echo

if [ -n "$TICK_TOKEN" ]; then
  for i in 1 2 3; do
    echo "== tick $i"
    curl -sS -X POST "$BASE/stack/tick" -H "Authorization: Bearer $TICK_TOKEN"; echo
    sleep 2
  done
else
  echo "== waiting for the cron job to tick (up to 4 minutes)"
  for i in $(seq 1 24); do
    STATUS="$(curl -sS "$BASE/api/Posts/$KEY?api-version=1.0" -o /dev/null -w '%{size_download}')"
    PAGE="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/site/releases/$KEY/")"
    echo "  $(date +%H:%M:%S) news-api bytes=$STATUS page=$PAGE"
    [ "$PAGE" = "200" ] && break
    sleep 10
  done
fi
unset TICK_TOKEN

echo "== release status"
curl -sS "$BASE/nrms/api/releases/$KEY" -H "Authorization: Bearer $TOKEN" | python3 -c 'import json,sys; d=json.load(sys.stdin); print({k: d.get(k) for k in ("key","status","publishedAt","lastError")})'
echo "== News API post"
curl -sS -o /dev/null -w "%{http_code} %{size_download} bytes\n" "$BASE/api/Posts/$KEY?api-version=1.0"
echo "== static page"
curl -sS -o /dev/null -w "%{http_code}\n" "$BASE/site/releases/$KEY/"
echo "== recent errors"
curl -sS "$BASE/stack/errors" -H "Authorization: Bearer $TOKEN" | python3 -m json.tool | head -40
unset TOKEN
echo "== done: release key $KEY (check the redirect inbox for the email)"
