// One-time Flickr OAuth sign-in. Run locally (never on SiteGround) with FLICKR_API_KEY and
// FLICKR_API_SECRET in the environment; prints the long-lived access token/secret so the
// operator can paste them into Site Tools' Environment Variables (see docs/deploy/siteground.md
// "Flickr", and C30 in docs/parity/changes-from-legacy.md). The access token/secret are secrets
// printed to the operator's own terminal on purpose -- this command writes them nowhere else.
import { createInterface } from "node:readline/promises";
import { authorizeFlow } from "../media/flickr-authorize-flow";

const apiKey = process.env.FLICKR_API_KEY;
const apiSecret = process.env.FLICKR_API_SECRET;
const oauthUrl = process.env.FLICKR_OAUTH_URL ?? "https://www.flickr.com/services/oauth";

if (!apiKey || !apiSecret) {
  console.error("Set FLICKR_API_KEY and FLICKR_API_SECRET in the environment before running this.");
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
try {
  const result = await authorizeFlow({
    oauthUrl,
    apiKey,
    apiSecret,
    prompt: (q) => rl.question(q),
    print: (line) => console.log(line),
  });
  console.log(`Signed in to Flickr as ${result.username}. Add these to the environment (Site Tools > Environment Variables):`);
  console.log(`NRMS_FLICKR_ACCESS_TOKEN=${result.accessToken}`);
  console.log(`NRMS_FLICKR_ACCESS_SECRET=${result.accessSecret}`);
} catch (err) {
  // authorizeFlow's own errors never carry a secret, token or signature -- see flickr-authorize-flow.ts.
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  rl.close();
}
