# SiteGround probe

Answers, from inside SiteGround's Node.js hosting, whether gcpe-news-platform can run there.

1. Site Tools → create a **Node.js Project** (GrowBig/GoGeek/Cloud). Upload this folder as a ZIP
   (without `node_modules`), install command `npm install`, start command `npm start`, and pick the
   newest Node version offered (24+ is required).
2. Site Tools → create a **PostgreSQL** database + user. Set env var `DATABASE_URL` to
   `postgres://USER:PASSWORD@HOST:5432/DBNAME` (from the database page).
3. Open `https://<project-domain>/` (twice — LISTEN/NOTIFY reports on the second load), then
   `https://<project-domain>/ws-test`.
4. Re-open `/` after 15 minutes and after a few hours idle. If `process.started` changed, the
   process was restarted; if `backgroundTicks.count` is far below `expectedTicks`, the process
   was paused while idle.

Send back the JSON from `/` (it contains no secrets) and what `/ws-test` printed.

**This probe is unauthenticated and runs database checks** (it connects to `DATABASE_URL` and
exercises LISTEN/NOTIFY) — delete the Node project in Site Tools once you're done with it.
