import { defineConfig, devices } from "@playwright/test";

/**
 * Demo-video recording config (npm run demo:video). Runs the single captioned
 * walkthrough in e2e/demo.video.ts against a fresh server and records 720p video;
 * scripts/make-demo.ps1 converts the .webm to MP4 (H.264) afterwards.
 */
const PORT = 4655;
const RUN_DIR = `.data-demo/run-${process.pid}/pg`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /demo\.video\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  timeout: 420_000, // the walkthrough is deliberately slow-paced (~3.5 min)
  outputDir: "test-results-demo",
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 720 },
    video: { mode: "on", size: { width: 1280, height: 720 } },
    colorScheme: "light",
    // Headless Chromium's auto-dark inverts the app's light background — keep the
    // recording true to the real product.
    launchOptions: { args: ["--disable-features=WebContentsForceDark"] },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } } }],
  webServer: {
    command: "npm run serve",
    port: PORT,
    timeout: 120_000,
    reuseExistingServer: false,
    env: { PORT: String(PORT), ASTRA_PG_DIR: RUN_DIR },
  },
});
