import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "apps/*/test/**/*.test.ts", "tests/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    env: { TZ: "UTC" },
  },
});
