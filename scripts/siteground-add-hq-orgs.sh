#!/usr/bin/env bash
# Creates the two HQ organizations (GCPE Headquarters, GCPE Media Relations) on a deployed stack through
# Core's organizations API, signed in as the break-glass admin. Same values as the Core seed's
# HQ_SEED_ORGANIZATIONS. The password is read hidden and never printed or put on a command line.
# For when the Core seed (core:seed-from-public-api, which needs an admin bearer token) can't be
# run. Run it in a real terminal: the password prompt needs one.
#
# Usage: scripts/siteground-add-hq-orgs.sh https://boxs.ca
set -euo pipefail
BASE="${1:?usage: $0 https://<domain>}"; BASE="${BASE%/}"
umask 077
JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT
curl_api() { curl -sS -b "$JAR" -c "$JAR" -H 'x-gcpe-request: 1' -H 'content-type: application/json' "$@"; }

ADMIN_PASS="$(python3 -c 'import getpass; print(getpass.getpass("Break-glass admin password: "))')"
STATUS="$(printf '%s\n' "$ADMIN_PASS" | python3 -c 'import json,sys; print(json.dumps({"username":"admin","password":sys.stdin.readline().rstrip("\n")}))' | curl_api -o /dev/null -w '%{http_code}' -X POST "$BASE/core/auth/login" -d @-)"
unset ADMIN_PASS
[ "$STATUS" = "200" ] || { echo "sign-in failed ($STATUS)"; exit 1; }

org() {
  python3 -c 'import json,sys; k,n,a=sys.argv[1:4]; print(json.dumps({"key":k,"displayName":n,"abbreviation":a,"sortOrder":0,"isActive":True,"parentKey":None,"url":None,"displayAdditionalName":None,"minister":{"name":None,"summary":None,"detailsHtml":None,"email":None,"photoUrl":None,"address":None},"contact":None,"secondContact":None,"weekendContactNumber":None,"social":{"twitterUsername":None,"flickrUrl":None,"youtubeUrl":None,"audioUrl":None},"topicLinks":[],"serviceLinks":[],"sectorKeys":[],"isHq":True,"isPublic":False}))' "$1" "$2" "$3"
}
for spec in "gcpe-headquarters|GCPE Headquarters|GCPEHQ" "gcpe-media-relations|GCPE Media Relations|GCPEMEDIA"; do
  IFS='|' read -r key name abbr <<<"$spec"
  code="$(org "$key" "$name" "$abbr" | curl_api -o /dev/null -w '%{http_code}' -X PUT "$BASE/core/api/organizations/$key" -d @-)"
  echo "$name: HTTP $code"
done
