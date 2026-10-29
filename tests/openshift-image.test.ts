// The OpenShift image (deploy/openshift/Dockerfile) is built and run by its own CI workflow
// (.github/workflows/openshift-image.yml), but only on GitHub. These cheap text checks fail in the
// ordinary test run when the recipe, the manifests or the smoke test drift from the code they
// describe — the things a build would not catch until someone deploys.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_PREFIXES } from "../apps/stack/src/env";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const dockerfile = read("deploy/openshift/Dockerfile");
const deployment = read("deploy/openshift/manifests/deployment.yaml");
const job = read("deploy/openshift/manifests/migrate-job.yaml");
const secret = read("deploy/openshift/manifests/secret.example.yaml");
const smoke = read("deploy/openshift/smoke-test.sh");
const workflow = read(".github/workflows/openshift-image.yml");
const ci = read(".github/workflows/ci.yml");

const envValue = (name: string) => new RegExp(`\\b${name}=(\\S+)`).exec(dockerfile)?.[1];

describe("deploy/openshift/Dockerfile", () => {
  it("pins its base image by exact version and digest, on the Node major in .nvmrc", () => {
    const m = /^ARG NODE_IMAGE=node:(\d+)\.\d+\.\d+-[a-z0-9.-]+@sha256:[0-9a-f]{64}$/m.exec(dockerfile);
    expect(m, "ARG NODE_IMAGE=node:<x.y.z>-<variant>@sha256:<digest>").not.toBeNull();
    expect(m![1]).toBe(read(".nvmrc").trim());
    for (const from of dockerfile.match(/^FROM .*/gm)!) expect(from).toMatch(/^FROM \$\{NODE_IMAGE\}( AS \w+)?$/);
  });

  it("assembles the app with the same build as SiteGround and Windows, and ships its output whole", () => {
    expect(dockerfile).toMatch(/^RUN node scripts\/build-siteground\.mjs$/m);
    const fromBuild = dockerfile.match(/^COPY --from=build .*/gm) ?? [];
    expect(fromBuild).toEqual(["COPY --from=build --chown=0:0 /opt/gcpe-build/dist/siteground/ ./"]);
  });

  it("installs dependencies from manifests covering every workspace in package.json", () => {
    const workspaces = (JSON.parse(read("package.json")) as { workspaces: string[] }).workspaces;
    const line = /for f in (.*); do/.exec(dockerfile)?.[1]?.split(/\s+/) ?? [];
    expect(line.sort()).toEqual(["package-lock.json", "package.json", ...workspaces.map((w) => `${w}/package.json`)].sort());
  });

  it("runs as UID 1001 in group 0 on port 8080 with DATA_DIR=/data, and starts stack.js", () => {
    expect(dockerfile).toMatch(/^USER 1001$/m);
    expect(dockerfile).toMatch(/chown 1001:0 \/data && chmod 0775 \/data/);
    expect(envValue("PORT")).toBe("8080");
    expect(envValue("DATA_DIR")).toBe("/data");
    expect(dockerfile).toMatch(/^EXPOSE 8080$/m);
    expect(dockerfile).toMatch(/^CMD \["node", "stack\.js"\]$/m);
  });
});

describe("deploy/openshift/manifests", () => {
  it("the Deployment matches the image: port, DATA_DIR mount, probes on routes the stack serves", () => {
    expect(deployment).toMatch(/containerPort: 8080/);
    expect(deployment).toMatch(/mountPath: \/data$/m);
    const paths = [...deployment.matchAll(/path: (\S+)/g)].map((m) => m[1]);
    // Readiness is liveness, not /stack/health: with one replica a single app's database blip would
    // otherwise take the whole site (public pages included) out of the Service.
    expect(paths).toEqual(["/core/health/live", "/core/health/live", "/core/health/live"]);
    expect(read("apps/stack/src/stack.ts")).toMatch(/r\.get\("\/health"/);
    expect(read("packages/http-kit/src/health.ts")).toMatch(/r\.get\("\/health\/live"/);
  });

  it("the Deployment and the migrate Job run locked down: non-root, read-only root, no privilege escalation, no capabilities, RuntimeDefault seccomp", () => {
    for (const doc of [deployment, job]) {
      expect(doc).toMatch(/runAsNonRoot: true/);
      expect(doc).toMatch(/readOnlyRootFilesystem: true/);
      expect(doc).toMatch(/allowPrivilegeEscalation: false/);
      expect(doc).toMatch(/drop: \["ALL"\]/);
      expect(doc).toMatch(/type: RuntimeDefault/);
      expect(doc, "OpenShift assigns the UID").not.toMatch(/runAsUser:/);
    }
  });

  it("the migrate Job runs the --migrate command main.ts implements", () => {
    expect(job).toMatch(/command: \["node", "stack\.js", "--migrate"\]/);
    expect(read("apps/stack/src/main.ts")).toMatch(/process\.argv\.includes\("--migrate"\)/);
  });

  it("the Secret template and the smoke test give every app its database", () => {
    for (const prefix of APP_PREFIXES) {
      expect.soft(secret, `${prefix}_DATABASE_URL in secret.example.yaml`).toMatch(new RegExp(`^  ${prefix}_DATABASE_URL: "postgres://<user>:<password>@`, "m"));
      expect.soft(smoke, `${prefix}_DATABASE_URL in smoke-test.sh`).toMatch(new RegExp(`^${prefix}_DATABASE_URL=\\$\\(db_url \\w+\\)$`, "m"));
    }
    const dbs = /^DBS="([^"]+)"/m.exec(smoke)![1]!.split(" ");
    const used = [...smoke.matchAll(/_DATABASE_URL=\$\(db_url (\w+)\)/g)].map((m) => m[1]);
    expect(dbs.sort()).toEqual([...new Set(used)].sort());
  });

  it("the Secret template holds placeholders only", () => {
    const values = [...secret.matchAll(/^  [A-Z_]+: "(.*)"$/gm)].map((m) => m[1]!);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) expect.soft(v, v).toMatch(/<[^>]+>/);
  });
});

describe(".github/workflows/openshift-image.yml", () => {
  it("builds this Dockerfile, never pushes, and smoke-tests the result", () => {
    expect(workflow).toMatch(/file: deploy\/openshift\/Dockerfile/);
    expect(workflow).toMatch(/push: false/);
    expect(workflow).not.toMatch(/docker push|registry-1|ghcr\.io|login-action/);
    expect(workflow).toMatch(/deploy\/openshift\/smoke-test\.sh gcpe-stack:ci/);
    expect(existsSync(join(root, "deploy/openshift/smoke-test.sh"))).toBe(true);
  });

  it("smoke-tests against the same Postgres image as ci.yml", () => {
    const ciImage = /image: (pgvector\/pgvector:\S+)/.exec(ci)![1];
    expect(/PG_IMAGE="\$\{PG_IMAGE:-([^}]+)\}"/.exec(smoke)![1]).toBe(ciImage);
  });

  it("runs the stack the way OpenShift does: arbitrary UID in group 0, read-only root, /data volume", () => {
    expect(smoke).toMatch(/--user "\$APP_UID:0" --read-only/);
    expect(smoke).toMatch(/dst=\/data/);
  });
});
