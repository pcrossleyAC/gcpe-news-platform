#!/usr/bin/env bash
# Smoke test for a SiteGround deployment of apps/stack (docs/deploy/siteground.md, "Smoke test").
# Prompts (hidden) for the local admin password and the TICK_TOKEN, then: logs in, adds a test
# subscriber, creates, approves and schedules a release for immediate publishing, ticks the
# stack, and prints what happened. Secrets are never printed or written to disk.
#
# Needs Core's `health` ministry (abbreviation HLTH) and `health` sector to have reached NRMS
# (docs/deploy/siteground.md, "Smoke test").
#
# Usage: scripts/siteground-smoke.sh https://boxs.ca
set -euo pipefail

BASE="${1:?usage: $0 https://<domain>}"
BASE="${BASE%/}"
STAMP="$(date -u +%Y%m%d%H%M%S)"

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

# POSTs JSON from stdin to an NRMS release endpoint; prints the response body, or the body and
# a failure message (then exits) when the HTTP status isn't 2xx.
nrms_post() {
  local out status
  out="$(curl -sS -X POST "$BASE/nrms/api/releases$1" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d @- -w '\n%{http_code}')"
  status="${out##*$'\n'}"
  out="${out%$'\n'*}"
  case "$status" in 2??) printf '%s' "$out" ;; *) echo "POST /nrms/api/releases$1 failed ($status): $out" >&2; exit 1 ;; esac
}

echo "== create release"
CREATED="$(python3 - <<'PY' | nrms_post ""
import json
print(json.dumps({
  "type": "release", "pageTitle": "News Release", "layout": "formal", "organizations": "Ministry of Health",
  "headline": "Smoke test: weekend clinics open across B.C.",
  "bodyHtml": "<p>This is a smoke test from scripts/siteground-smoke.sh.</p>",
  "location": "Victoria", "contacts": ["Media Relations\nAlex Example\n250-555-0100"],
  "ministries": ["health"], "leadMinistryKey": "health", "sectors": ["health"],
}))
PY
)"
ID="$(printf '%s' "$CREATED" | json_get id)"
VERSION="$(printf '%s' "$CREATED" | json_get version)"
echo "id $ID (version $VERSION)"

echo "== approve"
APPROVED="$(printf '{"version":%s}' "$VERSION" | nrms_post "/$ID/approve")"
KEY="$(printf '%s' "$APPROVED" | json_get key)"
VERSION="$(printf '%s' "$APPROVED" | json_get version)"
[ -n "$KEY" ] || { echo "approve returned no key: $APPROVED"; exit 1; }
echo "key $KEY (version $VERSION)"

echo "== schedule for immediate release"
SCHEDULED="$(printf '{"version":%s,"publishAt":"now"}' "$VERSION" | nrms_post "/$ID/schedule")"
printf '%s' "$SCHEDULED" | python3 -c 'import json,sys; d=json.load(sys.stdin); print({k: d.get(k) for k in ("key","status","statusText","publishAt")})'

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
curl -sS "$BASE/nrms/api/releases/$ID" -H "Authorization: Bearer $TOKEN" | python3 -c 'import json,sys; d=json.load(sys.stdin); print({k: d.get(k) for k in ("key","status","statusText","releasedAt","lastError")})'
echo "== News API post"
curl -sS -o /dev/null -w "%{http_code} %{size_download} bytes\n" "$BASE/api/Posts/$KEY?api-version=1.0"
echo "== static page"
curl -sS -o /dev/null -w "%{http_code}\n" "$BASE/site/releases/$KEY/"
echo "== recent errors"
curl -sS "$BASE/stack/errors" -H "Authorization: Bearer $TOKEN" | python3 -m json.tool | head -40
unset TOKEN
echo "== done: release key $KEY (check the redirect inbox for the email)"
