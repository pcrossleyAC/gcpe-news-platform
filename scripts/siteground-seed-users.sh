#!/usr/bin/env bash
# Creates (or resets) the three Phase 3 test users on a deployed stack, through Core's users
# API, signed in as the break-glass admin. Prompts (hidden) for every password; nothing secret
# is printed or kept — the session cookie lives in a private temp file deleted on exit.
#
# Usage: scripts/siteground-seed-users.sh https://boxs.ca
set -euo pipefail

BASE="${1:?usage: $0 https://<domain>}"
BASE="${BASE%/}"
umask 077
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

hidden() { python3 -c 'import getpass,sys; print(getpass.getpass(sys.argv[1]))' "$1"; }
json() { python3 -c 'import json,sys; print(json.dumps(dict(zip(sys.argv[1::2], sys.argv[2::2]))))' "$@"; }
curl_api() { curl -sS -b "$JAR" -c "$JAR" -H 'x-gcpe-request: 1' -H 'content-type: application/json' "$@"; }

ADMIN_PASS="$(hidden 'Break-glass admin password: ')"
STATUS="$(json username admin password "$ADMIN_PASS" | curl_api -o /dev/null -w '%{http_code}' -X POST "$BASE/core/auth/login" -d @-)"
unset ADMIN_PASS
[ "$STATUS" = "200" ] || { echo "admin sign-in failed (HTTP $STATUS)"; exit 1; }

seed() {
  local email="$1" name="$2" role="$3" pass id status
  pass="$(hidden "Password for $email ($role): ")"
  status="$(python3 -c 'import json,sys; print(json.dumps({"email":sys.argv[1],"displayName":sys.argv[2],"roles":[sys.argv[3]],"password":sys.argv[4]}))' "$email" "$name" "$role" "$pass" \
    | curl_api -o /dev/null -w '%{http_code}' -X POST "$BASE/core/api/users" -d @-)"
  if [ "$status" = "201" ]; then
    echo "created  $email"
  elif [ "$status" = "409" ]; then
    id="$(curl_api "$BASE/core/api/users" | python3 -c 'import json,sys; e=sys.argv[1]; print(next(u["id"] for u in json.load(sys.stdin) if u["email"]==e))' "$email")"
    python3 -c 'import json,sys; print(json.dumps({"roles":[sys.argv[1]]}))' "$role" | curl_api -o /dev/null -X PUT "$BASE/core/api/users/$id/roles" -d @-
    json password "$pass" | curl_api -o /dev/null -X POST "$BASE/core/api/users/$id/password" -d @-
    python3 -c 'import json,sys; print(json.dumps({"isActive":True,"displayName":sys.argv[1]}))' "$name" | curl_api -o /dev/null -X PATCH "$BASE/core/api/users/$id" -d @-
    echo "updated  $email"
  else
    echo "failed   $email (HTTP $status)"
  fi
  unset pass
}

seed editor@example.test "Test Editor" NRMS.Editor
seed site-editor@example.test "Test Site Editor" NRMS.SiteEditor
seed viewer@example.test "Test Viewer" NRMS.Viewer
curl_api -o /dev/null -X POST "$BASE/core/auth/logout"
