import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  globalSetup:'./e2e/setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  use: {
    storageState:'../.local/preview/browser-auth.json',
    baseURL: process.env.VECTORY_UI_URL || "http://127.0.0.1:5173",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  reporter: [
    ["list"],
    ["json", { outputFile: "../docs/evidence/browser-tests.json" }],
  ],
});
