GCPE News Platform — SiteGround artifact

This directory is a prebuilt, fully self-contained build of apps/stack (the whole
platform in one Node process). Nothing here needs `npm install` to resolve — every
dependency is bundled into stack.js.

Run: node stack.js
Check config without starting anything: node stack.js --check

Deploy steps, required environment variables, and the operator runbook are at:
docs/deploy/siteground.md (in the main repository, not in this artifact).

This directory's only job is to be the deploy/siteground branch's tree, committed there
by scripts/deploy-siteground.sh — it is not meant to be edited by hand.
