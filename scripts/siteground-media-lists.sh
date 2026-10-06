#!/usr/bin/env bash
# One-time Phase 4c step after deploying to a SiteGround stack, plus a live check of the media
# contact count (docs/deploy/siteground.md, Phase 4 hand-check):
#   1. POST /nrms/api/media-lists/republish so NoD receives the media lists the legacy importer
#      already put in NRMS (the import CLI has no event subscribers, so NoD never heard of them);
#   2. waits for NoD to mirror them (event delivery runs on the stack's cron tick);
#   3. asks NoD's count endpoint for one media list key -- the same call NRMS makes when an editor
#      schedules a media release -- and prints the answer;
#   4. prints the Media Hub sync status.
#
# Usage: scripts/siteground-media-lists.sh https://boxs.ca
#
# Signs in as the break-glass admin with the same secrecy rules as
# scripts/siteground-flickr-walkthrough.sh: the password is read with getpass, flows only through
# stdin, and the session cookie lives in a private temp file deleted on exit.
set -euo pipefail

BASE="${1:?usage: $0 https://<domain>}"
BASE="${BASE%/}"

umask 077
JAR=""
trap '[ -n "$JAR" ] && rm -f "$JAR"' EXIT
JAR="$(mktemp)"

hidden() { python3 -c 'import getpass,sys; print(getpass.getpass(sys.argv[1]))' "$1"; }
curl_api() { curl -sS -b "$JAR" -c "$JAR" -H 'x-gcpe-request: 1' -H 'content-type: application/json' "$@"; }
login_body() { python3 -c 'import json,sys; print(json.dumps({"username":sys.argv[1],"password":sys.stdin.readline().rstrip("\n")}))' "$1"; }

ADMIN_PASS="$(hidden 'Break-glass admin password: ')"
STATUS="$(printf '%s\n' "$ADMIN_PASS" | login_body admin | curl_api -o /dev/null -w '%{http_code}' -X POST "$BASE/core/auth/login" -d @-)"
unset ADMIN_PASS
[ "$STATUS" = "200" ] || { echo "admin sign-in failed (HTTP $STATUS)"; exit 1; }

echo "republishing NRMS media lists to NoD..."
REPUBLISH="$(curl_api -X POST "$BASE/nrms/api/media-lists/republish" -d '{}')"
SENT="$(echo "$REPUBLISH" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("count",""))')"
[ -n "$SENT" ] || { echo "republish failed: $REPUBLISH"; exit 1; }
echo "NRMS emitted $SENT media_list.updated events"

echo "waiting for NoD to mirror them (up to 5 minutes, checking every 20 s)..."
MIRRORED=0
FIRST_KEY=""
for _ in $(seq 1 15); do
  LISTS="$(curl_api "$BASE/nod/api/media-lists")"
  read -r MIRRORED FIRST_KEY < <(echo "$LISTS" | python3 -c 'import json,sys; l=json.load(sys.stdin); a=[x for x in l if x.get("active")]; print(len(l), a[0]["key"] if a else "")')
  [ "$MIRRORED" -ge "$SENT" ] && [ "$SENT" -gt 0 ] && break
  sleep 20
done
echo "NoD has $MIRRORED media lists"
[ "$MIRRORED" -gt 0 ] || { echo "FAILED: NoD has no media lists yet -- check /stack/health and the cron tick"; exit 1; }

echo "checking NoD's media contact count for media-distribution-lists:$FIRST_KEY..."
COUNT_STATUS="$(curl_api -o /dev/null -w '%{http_code}' "$BASE/nod/api/subscribers/count?lists=media-distribution-lists:$FIRST_KEY")"
COUNT="$(curl_api "$BASE/nod/api/subscribers/count?lists=media-distribution-lists:$FIRST_KEY")"
echo "count endpoint: HTTP $COUNT_STATUS $COUNT"
[ "$COUNT_STATUS" = "200" ] || { echo "FAILED: the count endpoint rejected a media list key"; exit 1; }

echo "Media Hub sync status:"
curl_api "$BASE/nod/api/media-hub/sync"
echo
echo "done"
