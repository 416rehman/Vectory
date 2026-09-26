import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, ".."),
  require = createRequire(path.join(root, "dashboard/package.json"));
const Ajv = require("ajv/dist/2020").default,
  formats = require("ajv-formats");
const schema = JSON.parse(
  await fs.readFile(path.join(root, "contracts/protocol.schema.json"), "utf8"),
);
const ajv = new Ajv({ strict: false, allErrors: true });
formats(ajv);
ajv.addSchema(schema);
const credentials = JSON.parse(
  await fs.readFile(path.join(root, ".local/preview/credentials.json"), "utf8"),
);
const base = "http://127.0.0.1:8080/api/v1";
const login = await fetch(base + "/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(credentials),
});
if (!login.ok) throw Error("Login failed");
const session = await login.json(),
  cookie = login.headers.get("set-cookie").split(";")[0];
let checks = 0;
function validate(name, value) {
  const fn = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  if (!fn(value)) throw Error(`${name}: ${JSON.stringify(fn.errors)}`);
  checks++;
}
validate("Session", session);
async function get(endpoint) {
  const r = await fetch(base + endpoint, { headers: { Cookie: cookie } });
  if (!r.ok) throw Error(`${endpoint}: ${r.status}`);
  return r.json();
}
validate("Status", await get("/status"));
for (const [endpoint, name] of [
  ["/devices", "Device"],
  ["/configurations", "Configuration"],
  ["/groups", "Group"],
  ["/deployments", "Deployment"],
  ["/tokens", "Token"],
  ["/releases", "Release"],
  ["/users", "User"],
]) {
  const values = await get(endpoint);
  if (!Array.isArray(values)) throw Error(`${endpoint}: expected array`);
  for (const v of values) validate(name, v);
}
const configs = await get("/configurations");
for (const c of configs) {
  for (const v of await get(`/configurations/${c.id}/versions`))
    validate("Version", v);
}
for (const d of await get("/devices"))
  validate("TelemetryHistory", await get(`/devices/${d.id}/telemetry`));
await fs.writeFile(
  path.join(root, "docs/evidence/contract-tests.json"),
  JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      checks,
      schemas: "contracts/protocol.schema.json",
      result: "passed",
    },
    null,
    2,
  ),
);
console.log(
  `PASS ${checks} actual persisted API responses match shared JSON schemas.`,
);
