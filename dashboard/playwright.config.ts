import { defineConfig } from "@playwright/test";
import path from "node:path";

// Chromium is the default: every spec runs in it against a seeded instance.
// VECTORY_E2E_BROWSERS (for example "firefox,webkit") instead runs only the
// cross-browser smoke, e2e/cross-browser.spec.ts, in each named browser against
// a fresh instance that has no administrator yet.
const known = ["chromium", "firefox", "webkit"] as const;
type Browser = (typeof known)[number];
const requested = (process.env.VECTORY_E2E_BROWSERS || "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const unknown = requested.filter((name) => !known.includes(name as Browser));
if (unknown.length)
  throw new Error(
    `VECTORY_E2E_BROWSERS names ${unknown.join(", ")}; choose from ${known.join(", ")}.`,
  );
const smoke = requested.length > 0;
const previewDir = path.resolve(
  import.meta.dirname,
  "..",
  process.env.VECTORY_PREVIEW_DIR || ".local/preview",
);

export default defineConfig({
  testDir: "./e2e",
  ...(smoke
    ? {
        testMatch: "cross-browser.spec.ts",
        projects: (requested as Browser[]).map((name) => ({
          name,
          use: { browserName: name },
        })),
      }
    : { globalSetup: "./e2e/setup.ts", testIgnore: "cross-browser.spec.ts" }),
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  // A browser that starts cold on a hosted machine needs longer than the default
  // five seconds for its first page.
  ...(smoke ? { expect: { timeout: 15000 } } : {}),
  use: {
    ...(smoke
      ? {}
      : { storageState: path.join(previewDir, "browser-auth.json") }),
    baseURL: process.env.VECTORY_UI_URL || "http://127.0.0.1:5173",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile:
          process.env.VECTORY_E2E_REPORT_PATH ||
          "../docs/evidence/browser-tests.json",
      },
    ],
  ],
});
