#!/usr/bin/env bash
# Exercises the website section (plan 3d) end to end against a deployed stack: creates a next
# carousel two minutes ahead with one slide, saves and pins the primary emergency slide, turns
# the Live Feed on with test URLs, saves two resource links, uploads a small generated PDF as a
# general file, then turns Project Blue Bridge ON (the mourning banner) -- confirming the phrase
# and the IGRS acknowledgement -- and polls the public News API (mounted at the site root; see
# "Website section" in docs/deploy/siteground.md) once per minute, up to 6 times, until the
# carousel has switched, the primary pin sorts first (sortIndex -2 -- toSlideDto doesn't expose
# the column, so "first in the list" is how it's actually observed), the Live Feed URLs and
# granville all show up on `Home`/`Slides`. It then checks the public site shows the TEST banner
# and stays noindex, and fetches the uploaded file back from /files.
#
# Usage: scripts/siteground-website-walkthrough.sh https://boxs.ca
#
# This turns Project Blue Bridge ON, which (on a test site) shows a "TEST -- " mourning banner
# on every public page until it's turned off again -- never run this against a real production
# deployment. The script refuses to run at all unless `BASE/site/` already carries
# `<meta name="robots" content="noindex, nofollow">` (constraints.md's test-site rule), checked
# before anything else is touched. Its cleanup trap turns Project Blue Bridge back OFF and
# unpins the primary emergency slide on the way out -- on success *and* on failure -- so a
# half-finished run never leaves the banner showing or the pin up.
#
# Signs in as the break-glass admin using exactly the pattern (and the same secrecy rules) as
# scripts/siteground-flickr-walkthrough.sh: the password is read with getpass, never put on a
# command line or built into a JSON body from argv -- it flows only from a bash variable into
# the stdin of the python3 process that builds the login body, then into curl's stdin via
# `-d @-`. The session cookie lives in a private temp file, created only after the cleanup trap
# is set, and deleted on exit.
set -euo pipefail

BASE="${1:?usage: $0 https://<domain>}"
BASE="${BASE%/}"

# Refuses to run at all against anything that doesn't already look like a test site -- checked
# first, before the password prompt or any other call, since this script turns on a banner that
# must never be mistaken for a real announcement.
SITE_HOME="$(curl -sS -f "$BASE/site/")" || { echo "FAILED: couldn't fetch $BASE/site/ -- check the URL"; exit 1; }
case "$SITE_HOME" in
  *noindex*) : ;;
  *) echo "FAILED: $BASE/site/ has no noindex meta -- refusing to run against what looks like a real production site. This script turns Project Blue Bridge ON, which shows a public mourning banner."; exit 1 ;;
esac
echo "PASS: $BASE/site/ is a test site (noindex present)"

umask 077
JAR=""
PDF_FILE=""
BB_ON=0
PIN_ON=0

hidden() { python3 -c 'import getpass,sys; print(getpass.getpass(sys.argv[1]))' "$1"; }
curl_api() { curl -sS -b "$JAR" -c "$JAR" -H 'x-gcpe-request: 1' -H 'content-type: application/json' "$@"; }
curl_bin() { curl -sS -b "$JAR" -c "$JAR" -H 'x-gcpe-request: 1' "$@"; }
login_body() { python3 -c 'import json,sys; print(json.dumps({"username":sys.argv[1],"password":sys.stdin.readline().rstrip("\n")}))' "$1"; }
jfield() { python3 -c 'import json,sys; v=json.load(sys.stdin).get(sys.argv[1]); print(v if v is not None else "")' "$1"; }

# Cleanup: turns Project Blue Bridge back off and unpins the primary emergency slide, re-reading
# each one's current version rather than trusting a value captured earlier in the run (a failed
# step may have left it stale). Every lookup/call here is best-effort -- a failure is a loud
# warning, never a second crash on the way out -- and the original exit status is preserved.
cleanup() {
  local status=$?
  set +e
  if [ "${BB_ON:-0}" = "1" ]; then
    echo "cleanup: turning Project Blue Bridge off..."
    CUR="$(curl_api "$BASE/nrms/api/site/blue-bridge" 2>/dev/null)"
    CUR_V="$(printf '%s' "$CUR" | jfield version 2>/dev/null)"
    if [ -n "$CUR_V" ]; then
      OFF_BODY="$(python3 -c 'import json,sys; print(json.dumps({"version":int(sys.argv[1]),"on":False,"confirmation":"KING CHARLES III","acknowledgeIgrs":True}))' "$CUR_V" 2>/dev/null)"
      curl_api -o /dev/null -X PUT "$BASE/nrms/api/site/blue-bridge" -d "$OFF_BODY" || echo "cleanup: WARNING -- failed to turn Project Blue Bridge off; turn it off by hand."
    else
      echo "cleanup: WARNING -- couldn't read Project Blue Bridge's current version; turn it off by hand."
    fi
  fi
  if [ "${PIN_ON:-0}" = "1" ]; then
    echo "cleanup: unpinning the primary emergency slide..."
    PINS="$(curl_api "$BASE/nrms/api/site/pins" 2>/dev/null)"
    PV="$(printf '%s' "$PINS" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
    print(next((p["version"] for p in d if p["slot"] == "primary"), ""))
except Exception:
    print("")' 2>/dev/null)"
    if [ -n "$PV" ]; then
      UNPIN_BODY="$(python3 -c 'import json,sys; print(json.dumps({"version":int(sys.argv[1]),"pinned":False}))' "$PV" 2>/dev/null)"
      curl_api -o /dev/null -X POST "$BASE/nrms/api/site/pins/primary/pinned" -d "$UNPIN_BODY" || echo "cleanup: WARNING -- failed to unpin the primary emergency slide; unpin it by hand."
    else
      echo "cleanup: WARNING -- couldn't read the primary pin's current version; unpin it by hand."
    fi
  fi
  curl_api -o /dev/null -X POST "$BASE/core/auth/logout" >/dev/null 2>&1 || true
  [ -n "$PDF_FILE" ] && rm -f "$PDF_FILE"
  [ -n "$JAR" ] && rm -f "$JAR"
  exit "$status"
}
trap cleanup EXIT
JAR="$(mktemp)"

ADMIN_PASS="$(hidden 'Break-glass admin password: ')"
STATUS="$(printf '%s\n' "$ADMIN_PASS" | login_body admin | curl_api -o /dev/null -w '%{http_code}' -X POST "$BASE/core/auth/login" -d @-)"
unset ADMIN_PASS
[ "$STATUS" = "200" ] || { echo "FAILED: admin sign-in failed (HTTP $STATUS)"; exit 1; }
echo "PASS: signed in as the break-glass admin"

SLIDE_HEADLINE="Website walkthrough slide $$"
PIN_HEADLINE="Website walkthrough pin $$"
MANIFEST_URL="https://example.test/website-walkthrough/manifest.xml"
M3U_URL="https://example.test/website-walkthrough/live.m3u8"

echo "creating the next carousel, 2 minutes ahead..."
GO_LIVE_AT="$(python3 -c 'from datetime import datetime, timezone, timedelta; print((datetime.now(timezone.utc) + timedelta(minutes=2)).isoformat())')"
CREATE_BODY="$(python3 -c 'import json,sys; print(json.dumps({"goLiveAt":sys.argv[1]}))' "$GO_LIVE_AT")"
CREATE_RES="$(curl_api -f -X POST "$BASE/nrms/api/site/carousels/next" -d "$CREATE_BODY")"
CAROUSEL_ID="$(printf '%s' "$CREATE_RES" | jfield id)"
CAROUSEL_VERSION="$(printf '%s' "$CREATE_RES" | jfield version)"
[ -n "$CAROUSEL_ID" ] || { echo "FAILED: creating the next carousel failed: $CREATE_RES"; exit 1; }
echo "PASS: created the next carousel (id=$CAROUSEL_ID, goLiveAt=$GO_LIVE_AT)"

echo "adding a slide to the next carousel..."
SLIDE_BODY="$(python3 -c 'import json,sys; print(json.dumps({"version":int(sys.argv[1]),"slides":[{"headline":sys.argv[2],"summary":"Website walkthrough slide.","actionUrl":"","facebookPostUrl":"","justify":"left"}]}))' "$CAROUSEL_VERSION" "$SLIDE_HEADLINE")"
SAVE_CAROUSEL_RES="$(curl_api -f -X PUT "$BASE/nrms/api/site/carousels/$CAROUSEL_ID" -d "$SLIDE_BODY")"
[ -n "$(printf '%s' "$SAVE_CAROUSEL_RES" | jfield version)" ] || { echo "FAILED: adding the slide failed: $SAVE_CAROUSEL_RES"; exit 1; }
echo "PASS: added the slide"

echo "saving the primary emergency slide..."
PINS_RES="$(curl_api "$BASE/nrms/api/site/pins")"
PRIMARY_VERSION="$(printf '%s' "$PINS_RES" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next((p["version"] for p in d if p["slot"] == "primary"), ""))')"
[ -n "$PRIMARY_VERSION" ] || { echo "FAILED: couldn't read the primary pin's version: $PINS_RES"; exit 1; }
PIN_BODY="$(python3 -c 'import json,sys; print(json.dumps({"version":int(sys.argv[1]),"headline":sys.argv[2],"summary":"Website walkthrough pin.","actionUrl":"","facebookPostUrl":"","justify":"left"}))' "$PRIMARY_VERSION" "$PIN_HEADLINE")"
SAVE_PIN_RES="$(curl_api -f -X PUT "$BASE/nrms/api/site/pins/primary" -d "$PIN_BODY")"
PIN_VERSION="$(printf '%s' "$SAVE_PIN_RES" | jfield version)"
[ -n "$PIN_VERSION" ] || { echo "FAILED: saving the primary pin failed: $SAVE_PIN_RES"; exit 1; }
echo "PASS: saved the primary emergency slide"

echo "pinning it..."
PINNED_BODY="$(python3 -c 'import json,sys; print(json.dumps({"version":int(sys.argv[1]),"pinned":True}))' "$PIN_VERSION")"
curl_api -f -o /dev/null -X POST "$BASE/nrms/api/site/pins/primary/pinned" -d "$PINNED_BODY"
PIN_ON=1
echo "PASS: pinned the primary emergency slide"

echo "turning the Live Feed on with test URLs..."
LIVE_FEED_RES="$(curl_api "$BASE/nrms/api/site/live-feed")"
LIVE_FEED_VERSION="$(printf '%s' "$LIVE_FEED_RES" | jfield version)"
[ -n "$LIVE_FEED_VERSION" ] || { echo "FAILED: couldn't read the Live Feed's version: $LIVE_FEED_RES"; exit 1; }
LIVE_FEED_BODY="$(python3 -c 'import json,sys; print(json.dumps({"version":int(sys.argv[1]),"enabled":True,"manifestUrl":sys.argv[2],"m3uUrl":sys.argv[3]}))' "$LIVE_FEED_VERSION" "$MANIFEST_URL" "$M3U_URL")"
SAVE_LIVE_FEED_RES="$(curl_api -f -X PUT "$BASE/nrms/api/site/live-feed" -d "$LIVE_FEED_BODY")"
[ "$(printf '%s' "$SAVE_LIVE_FEED_RES" | jfield enabled)" = "True" ] || { echo "FAILED: turning the Live Feed on failed: $SAVE_LIVE_FEED_RES"; exit 1; }
echo "PASS: turned the Live Feed on"

echo "saving two resource links..."
LINKS_RES="$(curl_api "$BASE/nrms/api/site/links")"
LINKS_VERSION="$(printf '%s' "$LINKS_RES" | jfield version)"
[ -n "$LINKS_VERSION" ] || { echo "FAILED: couldn't read the resource links' version: $LINKS_RES"; exit 1; }
NEW_LINKS_BODY="$(printf '%s' "$LINKS_RES" | python3 -c '
import json, sys
d = json.load(sys.stdin)
links = [{"id": l["id"], "text": l["text"], "url": l["url"]} for l in d["links"]]
links.append({"text": "Website walkthrough link 1", "url": "https://example.test/website-walkthrough/1"})
links.append({"text": "Website walkthrough link 2", "url": "https://example.test/website-walkthrough/2"})
print(json.dumps({"version": d["version"], "links": links}))
')"
SAVE_LINKS_RES="$(curl_api -f -X PUT "$BASE/nrms/api/site/links" -d "$NEW_LINKS_BODY")"
[ -n "$(printf '%s' "$SAVE_LINKS_RES" | jfield version)" ] || { echo "FAILED: saving the resource links failed: $SAVE_LINKS_RES"; exit 1; }
echo "PASS: saved two resource links, keeping whatever was already there"

echo "uploading a small generated PDF as a general file..."
PDF_FILE="$(mktemp)"
python3 -c "import sys; open(sys.argv[1], 'wb').write(b'%PDF-1.4\n%%EOF\n')" "$PDF_FILE"
UPLOAD_RES="$(curl_bin -f -X POST "$BASE/nrms/api/site/files?name=website-walkthrough.pdf&replace=true" -H 'content-type: application/pdf' --data-binary "@$PDF_FILE")"
FILE_NAME="$(printf '%s' "$UPLOAD_RES" | jfield name)"
[ -n "$FILE_NAME" ] || { echo "FAILED: uploading the test PDF failed: $UPLOAD_RES"; exit 1; }
echo "PASS: uploaded $FILE_NAME"

echo "turning Project Blue Bridge ON..."
BB_RES="$(curl_api "$BASE/nrms/api/site/blue-bridge")"
BB_VERSION="$(printf '%s' "$BB_RES" | jfield version)"
[ -n "$BB_VERSION" ] || { echo "FAILED: couldn't read Project Blue Bridge's version: $BB_RES"; exit 1; }
BB_ON_BODY="$(python3 -c 'import json,sys; print(json.dumps({"version":int(sys.argv[1]),"on":True,"confirmation":"KING CHARLES III","acknowledgeIgrs":True}))' "$BB_VERSION")"
BB_ON_RES="$(curl_api -f -X PUT "$BASE/nrms/api/site/blue-bridge" -d "$BB_ON_BODY")"
[ "$(printf '%s' "$BB_ON_RES" | jfield on)" = "True" ] || { echo "FAILED: turning Project Blue Bridge on failed: $BB_ON_RES"; exit 1; }
BB_ON=1
echo "PASS: turned Project Blue Bridge ON"

POLL_INTERVAL="${POLL_INTERVAL:-60}"
MAX_POLLS="${MAX_POLLS:-6}"

# Polls the public News API (mounted at the site root -- NRMS/NewsAPI events already route
# `types: ["*"]`, apps/stack/src/env.ts:176) until the carousel has switched, the primary pin
# sorts first, the Live Feed URLs and granville all show up -- once per minute, up to 6 times.
ready=0
for i in $(seq 1 "$MAX_POLLS"); do
  HOME_JSON="$(curl -sS "$BASE/api/Home?api-version=1.0")"
  SLIDES_JSON="$(curl -sS "$BASE/api/Slides?api-version=1.0")"
  STATE="$(python3 -c '
import json, sys
home = json.loads(sys.argv[1])
slides = json.loads(sys.argv[2])
slide_headline, pin_headline, manifest_url, m3u_url = sys.argv[3:7]
switched = any(s.get("headline") == slide_headline for s in slides)
pinned = len(slides) > 0 and slides[0].get("headline") == pin_headline
urls = home.get("liveWebcastFlashMediaManifestUrl") == manifest_url and home.get("liveWebcastM3uPlaylist") == m3u_url
granville = home.get("granville") == "true"
print(int(switched), int(pinned), int(urls), int(granville))
' "$HOME_JSON" "$SLIDES_JSON" "$SLIDE_HEADLINE" "$PIN_HEADLINE" "$MANIFEST_URL" "$M3U_URL")"
  read -r SWITCHED PINNED URLS GRANVILLE <<< "$STATE"
  echo "[poll $i/$MAX_POLLS] switched=$SWITCHED pin-first=$PINNED urls=$URLS granville=$GRANVILLE"
  if [ "$SWITCHED" = "1" ] && [ "$PINNED" = "1" ] && [ "$URLS" = "1" ] && [ "$GRANVILLE" = "1" ]; then
    ready=1
    break
  fi
  [ "$i" -lt "$MAX_POLLS" ] && sleep "$POLL_INTERVAL"
done
[ "$ready" = "1" ] || { echo "FAILED: never reached the expected state (carousel switched / primary pin first / Live Feed URLs / granville) within $MAX_POLLS polls"; exit 1; }
echo "PASS: carousel switched, primary pin sorts first, Live Feed URLs present, granville set"

echo "checking the public site shows the TEST banner and stays noindex..."
SITE_HOME2="$(curl -sS -f "$BASE/site/")" || { echo "FAILED: couldn't re-fetch $BASE/site/"; exit 1; }
case "$SITE_HOME2" in
  *"TEST — ALERT:"*) : ;;
  *) echo "FAILED: $BASE/site/ doesn't show the TEST Blue Bridge banner"; exit 1 ;;
esac
case "$SITE_HOME2" in
  *noindex*) : ;;
  *) echo "FAILED: $BASE/site/ lost its noindex meta"; exit 1 ;;
esac
echo "PASS: $BASE/site/ shows the TEST Blue Bridge banner and stays noindex"

echo "fetching the uploaded file back..."
FILE_RES="$(curl -sS -f "$BASE/files/$FILE_NAME")" || { echo "FAILED: couldn't fetch $BASE/files/$FILE_NAME"; exit 1; }
case "$FILE_RES" in
  '%PDF-'*) : ;;
  *) echo "FAILED: $BASE/files/$FILE_NAME doesn't look like a PDF"; exit 1 ;;
esac
echo "PASS: fetched $BASE/files/$FILE_NAME"

echo "Public site: $BASE/site/"
echo "PASS: website walkthrough complete -- Project Blue Bridge and the pin will be turned off/unpinned on exit."
