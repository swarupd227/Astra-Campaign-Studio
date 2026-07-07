import { defineConfig, devices } from "@playwright/test";

/**
 * E2E config for the Astra Campaign Studio Experience layer. Playwright boots the
 * real server (embedded Postgres) against a PRISTINE, unique data dir per run, so
 * scenarios run end to end against the actual runtime — projections, RBAC, evals
 * and all — with a freshly-seeded campaign every time (no delete-vs-boot race).
 */
const PORT = 4599;
const RUN_DIR = `.data-e2e/run-${process.pid}-${new Date().getTime()}/pg`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1, // shared server state → run serially for determinism
  reporter: [["list"]],
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run serve",
    port: PORT,
    timeout: 120_000,
    reuseExistingServer: false,
    env: { PORT: String(PORT), ASTRA_PG_DIR: RUN_DIR },
  },
});
