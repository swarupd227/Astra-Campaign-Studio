import { defineConfig } from "vitest/config";

// Scope vitest to the unit/integration suite only. The Playwright e2e specs
// under e2e/*.spec.ts are run by `npm run e2e`, not vitest.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
