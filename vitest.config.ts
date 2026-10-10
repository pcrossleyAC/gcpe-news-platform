import { defineConfig } from "vitest/config";

// Two projects share one `vitest run` invocation: the Node suite (every app and package) and a
// jsdom project for apps/staff-web's React component tests. Kept apart by file extension, not a
// path exclude list: every staff-web test file is named *.test.tsx (even the ones with no JSX),
// so the Node project's *.test.ts glob leaves them alone.
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 30_000,
    env: { TZ: "UTC" },
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "apps/*/test/**/*.test.ts", "tests/**/*.test.ts"],
          testTimeout: 20_000,
          hookTimeout: 30_000,
          env: { TZ: "UTC" },
        },
      },
      {
        test: {
          name: "staff-web",
          environment: "jsdom",
          include: ["apps/staff-web/src/**/*.test.tsx"],
          setupFiles: ["apps/staff-web/test/setup.ts"],
          testTimeout: 20_000,
          hookTimeout: 30_000,
          env: { TZ: "UTC" },
        },
      },
    ],
  },
});
