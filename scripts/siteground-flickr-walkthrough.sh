#!/usr/bin/env bash
# Exercises a release's Flickr photo handling end to end against a deployed stack running in
# fake-Flickr mode (automatic whenever no real Flickr key is configured -- see docs/deploy/
# siteground.md "Flickr"): creates, sets a fake Flickr photo as the media asset, approves and
# schedules a release for "now", then polls once per cron tick (the stack's background work only
# runs when something calls /stack/tick -- see "Background work scheduler" in the same doc) for
# up to 5 minutes until it is published with the photo public, and prints the public page URL.
#
# A second mode, --outage, first flips the fake's refuse-auth switch, waits for the release to go
# out *without* the photo with an alert raised (the up-to-2-minute grace period and alert from
# C28 in docs/parity/changes-from-legacy.md), clears the switch, then waits for the automatic
# correction that republishes it with the photo.
#
# Usage: scripts/siteground-flickr-walkthrough.sh https://boxs.ca [--outage]
#
# Never run this against a stack configured with a real Flickr key: --outage drives a fake-only
# control endpoint, and the photo it uses is a fake id that only exists on the fake.
#
# Signs in as the break-glass admin using exactly the pattern (and the same secrecy rules) as
# scripts/siteground-seed-users.sh: the password is read with getpass, never put on a command
# line or built into a JSON body from argv -- every secret flows only from a bash variable into
# the stdin of the python3 process that builds the login body, then into curl's stdin via `-d
# @-`. The session cookie lives in a private temp file, created only after the cleanup trap is
# set, and deleted on exit.
set -euo pipefail

BASE="${1:?usage: $0 https://<domain> [--outage]}"
BASE="${BASE%/}"
OUTAGE=0
if [ "${2:-}" = "--outage" ]; then OUTAGE=1; fi

umask 077
JAR=""
trap '[ -n "$JAR" ] && rm -f "$JAR"' EXIT
JAR="$(mktemp)"

hidden() { python3 -c 'import getpass,sys; print(getpass.getpass(sys.argv[1]))' "$1"; }
curl_api() { curl -sS -b "$JAR" -c "$JAR" -H 'x-gcpe-request: 1' -H 'content-type: application/json' "$@"; }
login_body() { python3 -c 'import json,sys; print(json.dumps({"username":sys.argv[1],"password":sys.stdin.readline().rstrip("\n")}))' "$1"; }
# Non-secret fields only -- safe to appear in `ps` via argv.
json_body() { python3 -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1])))' "$1"; }
jfield() { python3 -c 'import json,sys; v=json.load(sys.stdin).get(sys.argv[1]); print(v if v is not None else "")' "$1"; }

ADMIN_PASS="$(hidden 'Break-glass admin password: ')"
STATUS="$(printf '%s\n' "$ADMIN_PASS" | login_body admin | curl_api -o /dev/null -w '%{http_code}' -X POST "$BASE/core/auth/login" -d @-)"
unset ADMIN_PASS
[ "$STATUS" = "200" ] || { echo "admin sign-in failed (HTTP $STATUS)"; exit 1; }

PHOTO_URL="https://www.flickr.com/photos/bcgovphotos/53000000001/"

if [ "$OUTAGE" = "1" ]; then
  echo "outage: telling the fake Flickr to refuse auth"
  curl_api -o /dev/null -X POST "$BASE/fake-flickr/__fake/state" -d '{"refuseAuth":true}'
fi

echo "creating the release..."
CREATE_RES="$(curl_api -X POST "$BASE/nrms/api/releases" -d "$(json_body '{"type":"release","pageTitle":"Flickr walkthrough","layout":"formal","organizations":"Ministry of Health","headline":"Flickr walkthrough","bodyHtml":"<p>Flickr walkthrough.</p>","location":"Victoria","contacts":["Media Relations\n250-555-0100"],"ministries":["health"],"leadMinistryKey":"health","sectors":["services"]}')")"
ID="$(echo "$CREATE_RES" | jfield id)"
VERSION="$(echo "$CREATE_RES" | jfield version)"
[ -n "$ID" ] || { echo "create failed: $CREATE_RES"; exit 1; }
echo "release $ID created (version $VERSION)"

echo "setting the media asset to the fake photo..."
ASSET_BODY="$(python3 -c 'import json,sys; print(json.dumps({"version":int(sys.argv[1]),"assetUrl":sys.argv[2],"assetAltText":"Fake Flickr photo","hasMediaAssets":False}))' "$VERSION" "$PHOTO_URL")"
ASSET_RES="$(curl_api -X PUT "$BASE/nrms/api/releases/$ID/asset" -d "$ASSET_BODY")"
VERSION="$(echo "$ASSET_RES" | jfield version)"
[ -n "$VERSION" ] || { echo "setting the asset failed: $ASSET_RES"; exit 1; }

echo "approving..."
APPROVE_RES="$(curl_api -X POST "$BASE/nrms/api/releases/$ID/approve" -d "$(python3 -c 'import json,sys; print(json.dumps({"version":int(sys.argv[1])}))' "$VERSION")")"
KEY="$(echo "$APPROVE_RES" | jfield key)"
VERSION="$(echo "$APPROVE_RES" | jfield version)"
[ -n "$KEY" ] || { echo "approve failed: $APPROVE_RES"; exit 1; }
echo "approved: key=$KEY version=$VERSION"

echo "scheduling for now..."
SCHEDULE_BODY="$(python3 -c 'import json,sys; print(json.dumps({"version":int(sys.argv[1]),"publishAt":"now"}))' "$VERSION")"
curl_api -o /dev/null -X POST "$BASE/nrms/api/releases/$ID/schedule" -d "$SCHEDULE_BODY"
echo "scheduled."

POLL_INTERVAL="${POLL_INTERVAL:-60}"
MAX_POLLS="${MAX_POLLS:-5}"

# Polls up to MAX_POLLS times (once per cron tick), printing status/alert/asset state each time,
# until $1 (a function name) reports success against the globals it sets.
wait_for() {
  local label="$1" check="$2" i
  for i in $(seq 1 "$MAX_POLLS"); do
    REL="$(curl_api "$BASE/nrms/api/releases/$ID")"
    AST="$(curl_api "$BASE/nrms/api/releases/$ID/asset-status")"
    REL_STATUS="$(echo "$REL" | jfield status)"
    REL_ALERT="$(echo "$REL" | jfield flickrAlert)"
    AST_KIND="$(echo "$AST" | jfield kind)"
    AST_STATE="$(echo "$AST" | jfield state)"
    echo "[$label] release status=$REL_STATUS alert=${REL_ALERT:-(none)} asset=${AST_KIND}/${AST_STATE:-(n/a)}"
    if "$check"; then return 0; fi
    [ "$i" -lt "$MAX_POLLS" ] && sleep "$POLL_INTERVAL"
  done
  return 1
}

is_published_with_public_photo() { [ "$REL_STATUS" = "published" ] && [ "$AST_STATE" = "public" ] && [ -z "$REL_ALERT" ]; }
is_published_without_photo_alerted() { [ "$REL_STATUS" = "published" ] && [ -n "$REL_ALERT" ]; }

if [ "$OUTAGE" = "1" ]; then
  wait_for "outage" is_published_without_photo_alerted || { echo "FAILED: never published without the photo with an alert"; exit 1; }
  echo "clearing the outage..."
  curl_api -o /dev/null -X POST "$BASE/fake-flickr/__fake/state" -d '{"refuseAuth":false}'
  wait_for "recovery" is_published_with_public_photo || { echo "FAILED: never republished with the photo"; exit 1; }
else
  wait_for "publish" is_published_with_public_photo || { echo "FAILED: never published with the photo public"; exit 1; }
fi

echo "Public page: $BASE/site/releases/$KEY/"
curl_api -o /dev/null -X POST "$BASE/core/auth/logout" || true
