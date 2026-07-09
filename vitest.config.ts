import { defineConfig } from "vitest/config";

// Scope vitest to the unit/integration suite only. The Playwright e2e specs
// under e2e/*.spec.ts are run by `npm run e2e`, not vitest.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Lifecycle tests fold events on embedded Postgres and render Office
    // deliverables in the §9.6 gate — comfortably slower under parallel load.
    testTimeout: 20_000,
  },
});
