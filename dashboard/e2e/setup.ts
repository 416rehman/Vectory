import { request, type FullConfig } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
export default async function setup(config: FullConfig) {
  const root = path.resolve(import.meta.dirname, "../.."),
    storage = path.join(root, ".local/preview/browser-auth.json");
  const api = await request.newContext({
    baseURL: config.projects[0].use.baseURL,
    storageState: fs.existsSync(storage) ? storage : undefined,
  });
  try {
    if (!(await api.get("/api/v1/session")).ok()) {
      const credentials = JSON.parse(
        fs.readFileSync(
          path.join(root, ".local/preview/credentials.json"),
          "utf8",
        ),
      );
      const result = await api.post("/api/v1/login", { data: credentials });
      if (!result.ok())
        throw Error(
          `Preview login failed (HTTP ${result.status()}). Login throttling is deliberate; reuse the saved test session or wait for its documented window.`,
        );
    }
    await api.storageState({ path: storage });
    fs.chmodSync(storage, 0o600);
  } finally {
    await api.dispose();
  }
}
