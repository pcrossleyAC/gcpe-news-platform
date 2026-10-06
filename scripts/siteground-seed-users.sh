#!/usr/bin/env bash
# Creates (or resets) the three Phase 3 test users on a deployed stack, through Core's users
# API, signed in as the break-glass admin. Prompts (hidden) for every password; nothing secret
# is printed, kept, or ever passed as a command-line argument to another process (argv is
# visible to other local users via `ps`/`/proc/<pid>/cmdline` for as long as that process
# runs) — every secret flows only: getpass -> a bash variable -> stdin of the python3 process
# that builds the JSON body -> curl's stdin via `-d @-`. The session cookie lives in a private
# temp file deleted on exit.
#
# Usage: scripts/siteground-seed-users.sh https://boxs.ca
set -euo pipefail

BASE="${1:?usage: $0 https://<domain>}"
BASE="${BASE%/}"
umask 077
JAR=""
trap '[ -n "$JAR" ] && rm -f "$JAR"' EXIT
JAR="$(mktemp)"

hidden() { python3 -c 'import getpass,sys; print(getpass.getpass(sys.argv[1]))' "$1"; }
curl_api() { curl -sS -b "$JAR" -c "$JAR" -H 'x-gcpe-request: 1' -H 'content-type: application/json' "$@"; }
# These build a JSON body from non-secret argv (safe to appear in `ps`) plus exactly one
# secret value read from stdin (never from argv). Call as: printf '%s\n' "$secret" | fn ...
login_body() { python3 -c 'import json,sys; print(json.dumps({"username":sys.argv[1],"password":sys.stdin.readline().rstrip("\n")}))' "$1"; }
create_body() { python3 -c 'import json,sys; print(json.dumps({"email":sys.argv[1],"displayName":sys.argv[2],"roles":[sys.argv[3]],"password":sys.stdin.readline().rstrip("\n")}))' "$1" "$2" "$3"; }
password_body() { python3 -c 'import json,sys; print(json.dumps({"password":sys.stdin.readline().rstrip("\n")}))'; }

ADMIN_PASS="$(hidden 'Break-glass admin password: ')"
STATUS="$(printf '%s\n' "$ADMIN_PASS" | login_body admin | curl_api -o /dev/null -w '%{http_code}' -X POST "$BASE/core/auth/login" -d @-)"
unset ADMIN_PASS
[ "$STATUS" = "200" ] || { echo "admin sign-in failed (HTTP $STATUS)"; exit 1; }

seed() {
  local email="$1" name="$2" role="$3" pass id status
  pass="$(hidden "Password for $email ($role): ")"
  status="$(printf '%s\n' "$pass" | create_body "$email" "$name" "$role" | curl_api -o /dev/null -w '%{http_code}' -X POST "$BASE/core/api/users" -d @-)"
  if [ "$status" = "201" ]; then
    echo "created  $email"
  elif [ "$status" = "409" ]; then
    id="$(curl_api "$BASE/core/api/users" | python3 -c 'import json,sys; e=sys.argv[1]; print(next(u["id"] for u in json.load(sys.stdin) if u["email"]==e))' "$email")"
    local all_ok=1 rstatus pstatus astatus
    rstatus="$(python3 -c 'import json,sys; print(json.dumps({"roles":[sys.argv[1]]}))' "$role" | curl_api -o /dev/null -w '%{http_code}' -X PUT "$BASE/core/api/users/$id/roles" -d @-)"
    case "$rstatus" in 2??) ;; *) echo "failed   $email (roles HTTP $rstatus)"; all_ok=0 ;; esac
    pstatus="$(printf '%s\n' "$pass" | password_body | curl_api -o /dev/null -w '%{http_code}' -X POST "$BASE/core/api/users/$id/password" -d @-)"
    case "$pstatus" in 2??) ;; *) echo "failed   $email (password HTTP $pstatus)"; all_ok=0 ;; esac
    astatus="$(python3 -c 'import json,sys; print(json.dumps({"isActive":True,"displayName":sys.argv[1]}))' "$name" | curl_api -o /dev/null -w '%{http_code}' -X PATCH "$BASE/core/api/users/$id" -d @-)"
    case "$astatus" in 2??) ;; *) echo "failed   $email (reactivate HTTP $astatus)"; all_ok=0 ;; esac
    [ "$all_ok" = "1" ] && echo "updated  $email"
  else
    echo "failed   $email (HTTP $status)"
  fi
  unset pass
}

seed editor@example.test "Test Editor" NRMS.Editor
seed site-editor@example.test "Test Site Editor" NRMS.SiteEditor
seed viewer@example.test "Test Viewer" NRMS.Viewer
curl_api -o /dev/null -X POST "$BASE/core/auth/logout"
