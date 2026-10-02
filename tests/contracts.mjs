import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
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
// Defaults read the local preview; the variables point it at another instance.
const credentials = JSON.parse(
  await fs.readFile(
    process.env.VECTORY_CONTRACT_CREDENTIALS ||
      path.join(root, ".local/preview/credentials.json"),
    "utf8",
  ),
);
// The preview's port, as scripts/preview.sh chooses it; a full URL overrides it.
const base =
  process.env.VECTORY_CONTRACT_BASE ||
  `http://127.0.0.1:${process.env.VECTORY_PREVIEW_WEB_PORT || 8080}/api/v1`;
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
try {
  validate("Session", session);
  async function get(endpoint) {
    const r = await fetch(base + endpoint, { headers: { Cookie: cookie } });
    if (!r.ok) throw Error(`${endpoint}: ${r.status}`);
    return r.json();
  }
  validate("Status", await get("/status"));
  // Needs you, Rollouts and Recent changes, with rollback lineage.
  validate("Overview", await get("/overview"));
  const prepared = await get("/audit/exports");
  if (!Array.isArray(prepared) || prepared.length > 2)
    throw Error("Unexpected prepared export list");
  for (const file of prepared) validate("AuditExport", file);
  for (const suffix of [
    "",
    "&family=device",
    "&outcome=success",
    "&search=configuration",
    "&from=2020-01-01T00%3A00%3A00.000Z",
  ]) {
    const history = await get(`/audit/history?page_size=12${suffix}`);
    validate("AuditHistoryPage", history);
    for (const event of history.items) {
      validate("AuditSummary", event);
      validate("AuditDetail", await get(`/audit/${event.id}`));
    }
  }
  for (const state of ["open", "acknowledged", "resolved", "all"]) {
    const history = await get(`/issues/history?state=${state}&page_size=12`);
    validate("IssueHistoryPage", history);
    for (const issue of history.items)
      validate("Issue", await get(`/issues/${issue.id}`));
  }
  for (const suffix of [
    "",
    "&scheduled=true",
    "&scheduled=false",
    "&status=active",
  ]) {
    const history = await get(`/deployments/history?page_size=12${suffix}`);
    validate("DeploymentHistoryPage", history);
    for (const deployment of history.items) {
      const summary = await get(`/deployments/${deployment.id}/summary`);
      validate("DeploymentSummary", summary);
      validate(
        "DeploymentTargetPage",
        await get(`/deployments/${deployment.id}/targets?page_size=12`),
      );
      validate(
        "RolloutLanes",
        await get(`/deployments/${deployment.id}/rollout`),
      );
      // What a rollback would do, for every rollout that can still take one.
      if (
        summary.rollback_review === true &&
        summary.version_id &&
        !summary.rolled_back_by &&
        ["active", "paused", "completed", "cancelled", "failed"].includes(
          summary.status,
        )
      )
        validate(
          "RollbackPreview",
          await get(`/deployments/${deployment.id}/rollback-preview`),
        );
    }
  }
  for (const state of ["active", "archived", "all"])
    for (const sort of ["name", "updated"])
      validate(
        "ConfigurationLibraryPage",
        await get(
          `/configurations/library?state=${state}&sort=${sort}&page=1&page_size=50`,
        ),
      );
  for (const [endpoint, name] of [
    ["/devices", "Device"],
    ["/configurations", "Configuration"],
    ["/groups", "Group"],
    ["/deployments", "Deployment"],
    ["/tokens", "Token"],
    ["/releases", "Release"],
    ["/users", "User"],
    ["/issues", "Issue"],
  ]) {
    const values = await get(endpoint);
    if (!Array.isArray(values)) throw Error(`${endpoint}: expected array`);
    for (const v of values) validate(name, v);
  }
  const configs = await get("/configurations");
  for (const c of configs) {
    for (const v of await get(`/configurations/${c.id}/versions`))
      validate("Version", v);
    for (const kind of ["versions", "revisions"]) {
      const page = await get(
        `/configurations/${c.id}/history?kind=${kind}&page=1&page_size=2`,
      );
      validate("HistoryPage", page);
      if (kind === "revisions" && page.items[0])
        validate(
          "Revision",
          await get(`/configurations/${c.id}/revisions/${page.items[0].id}`),
        );
    }
  }
  for (const d of await get("/devices"))
    validate("TelemetryHistory", await get(`/devices/${d.id}/telemetry`));
  // What each device was offered, read back: the text is the bytes its digest
  // and size describe, earlier generations read the same way, and the
  // comparison with the previous offer is bounded.
  for (const d of await get("/devices")) {
    const configuration = await get(`/devices/${d.id}/configuration`);
    validate("DeviceConfiguration", configuration);
    if (configuration.device_id !== d.id)
      throw Error(`/devices/${d.id}/configuration answered another device`);
    for (const offered of configuration.generations.items.slice(0, 3)) {
      const read = await get(
        `/devices/${d.id}/configuration?generation=${offered.generation}`,
      );
      validate("DeviceConfiguration", read);
      if (read.sha256 !== offered.sha256)
        throw Error(`${d.id} generation ${offered.generation}: digest differs`);
    }
    if (configuration.content === null) continue;
    const bytes = Buffer.from(configuration.content, "utf8");
    if (
      bytes.length !== configuration.size ||
      createHash("sha256").update(bytes).digest("hex") !== configuration.sha256
    )
      throw Error(`${d.id}: content is not the bytes its digest describes`);
    const diff = await get(`/devices/${d.id}/configuration/diff`);
    validate("DeviceConfigurationDiff", diff);
    if (diff.unified.split("\n").length - 1 > 2000)
      throw Error(`${d.id}: diff is longer than 2,000 lines`);
  }
  // Fleet-scale reads.
  for (const query of ["", "?slim=1"]) {
    const overview = await get(`/overview${query}`);
    validate("Overview", overview);
    if (query && "devices" in overview)
      throw Error("/overview?slim=1: devices must be left out");
  }
  for (const query of [
    "",
    "?page_size=100&sort=status",
    "?status=applied&sort=events_in",
    "?view=no_telemetry&dir=desc",
    "?status=revoked",
    "?q=a",
  ]) {
    const page = await get(`/devices/inventory${query}`);
    validate("DeviceInventoryPage", page);
    for (const device of page.items)
      validate("Device", await get(`/devices/${device.id}?include=groups`));
  }
  validate("DeviceInventoryIds", await get("/devices/inventory/ids"));
  for (const group of await get("/groups?slim=1")) {
    validate("GroupSummary", group);
    validate(
      "GroupMemberPage",
      await get(`/groups/${group.id}/members?page_size=100`),
    );
  }
  for (const group of await get("/groups?include=members"))
    validate("Group", group);
  await fs.writeFile(
    process.env.VECTORY_CONTRACT_EVIDENCE ||
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
} finally {
  await fetch(base + "/logout", {
    method: "POST",
    headers: { Cookie: cookie, "X-CSRF-Token": session.csrf_token },
  });
}
