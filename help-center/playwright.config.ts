import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(
  new URL("../dashboard/package.json", import.meta.url),
);
const { defineConfig } = require("@playwright/test");
const origin = process.env.VECTORY_UI_URL;
const storage = process.env.VECTORY_HELP_STORAGE_STATE;
const output = process.env.VECTORY_HELP_TEST_OUTPUT;
if (!origin || !storage || !output) {
  throw new Error(
    "Use node help-center/tests/ci.mjs to provision the isolated help fixture.",
  );
}
const url = new URL(origin);
if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
  throw new Error("Help CI requires its own loopback development server.");
}

export default defineConfig({
  testDir: "../dashboard/e2e",
  testMatch:
    process.env.VECTORY_HELP_ACCOUNT_TESTS === "true"
      ? ["help-center.spec.ts", "account-lifecycle.spec.ts"]
      : "help-center.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  outputDir: path.join(output, "contextual-artifacts"),
  use: {
    baseURL: origin,
    storageState: storage,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  reporter: [
    ["list"],
    ["json", { outputFile: path.join(output, "contextual-tests.json") }],
  ],
});
