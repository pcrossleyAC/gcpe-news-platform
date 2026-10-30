#!/usr/bin/env bash
# Smoke-tests the OpenShift image (deploy/openshift/Dockerfile) the way OpenShift runs it: an
# arbitrary non-root UID in group 0, a read-only root filesystem, and one writable volume at
# /data. Starts its own pgvector/pgvector:pg16 (the same Postgres as .github/workflows/ci.yml) on a
# private Docker network, runs `node stack.js --migrate` as a one-off container (what the migration
# Job does), starts the stack, waits for /stack/health, checks /, /hub/ and a manual's Word file answer 200, then stops
# it with SIGTERM and checks it exits 0. Used by .github/workflows/openshift-image.yml; runs the
# same on a developer machine. Everything it creates is removed on exit.
#
#   deploy/openshift/smoke-test.sh [image]        (default image: gcpe-stack:local)
#
# The secrets below are throwaway test values for a container that lives a minute; never reuse them.
set -euo pipefail

IMAGE="${1:-gcpe-stack:local}"
PG_IMAGE="${PG_IMAGE:-pgvector/pgvector:pg16}"
HOST_PORT="${HOST_PORT:-18080}"
RUN_ID="gcpe-smoke-$$"
NET="$RUN_ID-net"
PG="$RUN_ID-pg"
APP="$RUN_ID-app"
VOL="$RUN_ID-data"
# An OpenShift-style UID: high, random, with no passwd entry; group 0.
APP_UID=$((1000650000 + RANDOM))
ENV_FILE="$(mktemp)"

log() { echo "[smoke] $*"; }
cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && docker inspect "$APP" >/dev/null 2>&1; then
    log "stack logs (last 80 lines):"
    docker logs --tail 80 "$APP" 2>&1 || true
  fi
  # KEEP_LOGS=<file>: keep the stack's whole log (CI uploads it).
  if [ -n "${KEEP_LOGS:-}" ]; then docker logs "$APP" >"$KEEP_LOGS" 2>&1 || true; fi
  docker rm -f "$APP" "$PG" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -f "$ENV_FILE"
  exit "$status"
}
trap cleanup EXIT

docker network create "$NET" >/dev/null
docker volume create "$VOL" >/dev/null

log "starting $PG_IMAGE"
docker run -d --name "$PG" --network "$NET" -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres "$PG_IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$PG" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$PG" pg_isready -U postgres -h 127.0.0.1 >/dev/null
DBS="core nrms news_api site nod distribution calendar"
for db in $DBS; do docker exec "$PG" psql -q -U postgres -c "CREATE DATABASE $db" >/dev/null; done

db_url() { echo "postgres://postgres:postgres@$PG:5432/$1"; }
cat >"$ENV_FILE" <<EOF
SITE_ENVIRONMENT=test
TICK_TOKEN=smoke-tick-token-0123456789abcdef0123456789
STACK_EVENT_SECRET=smoke-event-secret-0123456789abcdef012345
LOCAL_ADMIN_ENABLED=true
LOCAL_ADMIN_ALLOW_IN_PRODUCTION=true
LOCAL_ADMIN_PASSWORD_HASH=scrypt\$16384\$8\$1\$AR0_F516SFjYwNcFNR980A\$DE642bMgMzH2Q46b7hoQ2hf-CTYQIrqFSaM7xJNdHjGnXQw-T7aYQgf5Fqghm7p5YL4CEuW_ipSpedzYPPHzIw
LOCAL_AUTH_SECRET=smoke-local-auth-secret-0123456789abcdef
CORE_DATABASE_URL=$(db_url core)
NRMS_DATABASE_URL=$(db_url nrms)
NEWSAPI_DATABASE_URL=$(db_url news_api)
SITE_DATABASE_URL=$(db_url site)
NOD_DATABASE_URL=$(db_url nod)
DIST_DATABASE_URL=$(db_url distribution)
CALENDAR_DATABASE_URL=$(db_url calendar)
SITE_NEWS_API_URL=self:/
SITE_OUTPUT_DIR=./site-output
SITE_PUBLIC_SITE_URL=http://localhost:$HOST_PORT
NOD_DISTRIBUTION_URL=self:/distribution
NOD_PUBLIC_SITE_URL=http://localhost:$HOST_PORT
DIST_SMTP_HOST=127.0.0.1
DIST_SMTP_PORT=1025
DIST_MAIL_FROM=noreply@news.example.invalid
DIST_MAIL_REDIRECT_TO=ops@news.example.invalid
EOF

# How OpenShift runs it (restricted-v2 SCC): arbitrary UID, GID 0, nothing writable but /data.
RUN_AS=(--user "$APP_UID:0" --read-only --cap-drop ALL --security-opt no-new-privileges
  --network "$NET" --env-file "$ENV_FILE" --mount "type=volume,src=$VOL,dst=/data")

log "migrating as UID $APP_UID:0 with a read-only root filesystem (node stack.js --migrate)"
docker run --rm "${RUN_AS[@]}" "$IMAGE" node stack.js --migrate >/dev/null
log "migrate: ok; running it again must also succeed (nothing left to apply)"
docker run --rm "${RUN_AS[@]}" "$IMAGE" node stack.js --migrate >/dev/null

log "starting the stack"
docker run -d --name "$APP" "${RUN_AS[@]}" -p "127.0.0.1:$HOST_PORT:8080" "$IMAGE" >/dev/null

wait_for() { # url expected-status seconds
  local code=""
  for _ in $(seq 1 "$3"); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "$1" || true)"
    [ "$code" = "$2" ] && return 0
    if [ "$(docker inspect -f '{{.State.Running}}' "$APP")" != "true" ]; then
      log "the stack exited while waiting for $1"
      return 1
    fi
    sleep 1
  done
  log "$1 answered $code, not $2, within $3s"
  return 1
}

BASE="http://127.0.0.1:$HOST_PORT"
wait_for "$BASE/stack/health" 200 180
health="$(curl -s "$BASE/stack/health")"
echo "$health" | grep -q '"status":"ok"' || { log "unexpected /stack/health: $health"; exit 1; }
log "/stack/health: $health"
wait_for "$BASE/" 200 120
log "/: 200"
wait_for "$BASE/hub/" 200 30
log "/hub/: 200"
wait_for "$BASE/hub/manuals/core-admin.docx" 200 30
log "/hub/manuals/core-admin.docx: 200"

log "stopping with SIGTERM (graceful shutdown must exit 0)"
docker stop -t 30 "$APP" >/dev/null
exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$APP")"
[ "$exit_code" = "0" ] || { log "the stack exited $exit_code after SIGTERM"; exit 1; }
log "exited 0 after SIGTERM"

log "OK — $IMAGE"
