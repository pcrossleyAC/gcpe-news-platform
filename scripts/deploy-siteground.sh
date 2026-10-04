#!/usr/bin/env bash
# Task 15: builds the SiteGround artifact and commits it to the orphan `deploy/siteground`
# branch, in a throwaway worktree — the current worktree/branch (feat/phase-2 or whatever is
# checked out) is never touched. This script NEVER pushes: it prints the push command for the
# operator to run by hand, since a push to deploy/siteground goes live on SiteGround the
# moment it lands (GitHub deploy, no build step) and needs the owner's own approval each time.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BRANCH="deploy/siteground"
SOURCE_SHA="$(git rev-parse HEAD)"
SOURCE_SHA_SHORT="$(git rev-parse --short HEAD)"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "[deploy-siteground] refusing to deploy with uncommitted changes in the current worktree." >&2
  echo "[deploy-siteground] commit or stash first — the artifact must come from a known commit." >&2
  exit 1
fi

echo "[deploy-siteground] building the artifact from $SOURCE_SHA_SHORT …"
node scripts/build-siteground.mjs

echo "[deploy-siteground] pruning stale worktree entries …"
git worktree prune

WORKTREE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gcpe-deploy-siteground.XXXXXX")"
cleanup() {
  git worktree remove --force "$WORKTREE_DIR" >/dev/null 2>&1 || rm -rf "$WORKTREE_DIR"
}
trap cleanup EXIT

echo "[deploy-siteground] preparing the $BRANCH worktree at $WORKTREE_DIR …"
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  # Branch already exists (a prior deploy) — check it out so its history accumulates instead
  # of being thrown away on every deploy (useful for `git log`/rollback on SiteGround's side
  # too, since it reads this branch directly).
  git worktree add "$WORKTREE_DIR" "$BRANCH"
else
  # First deploy ever: a real orphan branch — no shared history with feat/phase-2 or main, by
  # design (the deploy branch's tree is a build artifact, not source).
  git worktree add --detach "$WORKTREE_DIR" >/dev/null
  (cd "$WORKTREE_DIR" && git checkout --orphan "$BRANCH")
fi

echo "[deploy-siteground] replacing the worktree's contents with dist/siteground/ …"
# The deploy branch's tree is ALWAYS exactly dist/siteground/'s contents, nothing more and
# nothing less — clear everything tracked/untracked except .git, then copy the fresh build in.
find "$WORKTREE_DIR" -mindepth 1 -maxdepth 1 ! -name ".git" -exec rm -rf {} +
cp -R dist/siteground/. "$WORKTREE_DIR/"

(
  cd "$WORKTREE_DIR"
  git add -A
  if git diff --cached --quiet; then
    echo "[deploy-siteground] artifact is byte-identical to the current $BRANCH tip — nothing new to commit."
  else
    git commit -q -m "deploy: siteground artifact built from $SOURCE_SHA"
    echo "[deploy-siteground] committed $(git rev-parse HEAD) on $BRANCH"
  fi
)

REMOTE_URL="$(git remote get-url origin 2>/dev/null || echo '<remote>')"
echo
echo "[deploy-siteground] Done. This script never pushes. To publish to SiteGround, run:"
echo
echo "  git push --force origin ${BRANCH}:${BRANCH}"
echo
echo "  (remote: ${REMOTE_URL})"
echo
echo "SiteGround's GitHub deploy (Site Tools, no build command) watches ${BRANCH} and deploys"
echo "whatever is pushed there — review the diff before pushing if you're not sure what changed."
