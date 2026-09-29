import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "dashboard/package.json"));
const Ajv = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats");
const schema = JSON.parse(
  await fs.readFile(path.join(root, "contracts/protocol.schema.json"), "utf8"),
);
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(schema);
const check = (name) => {
  const validator = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  assert.ok(validator, `missing schema ${name}`);
  return validator;
};
for (const name of [
  "Configuration",
  "Revision",
  "Version",
  "VariableDeclaration",
  "VariableBindings",
  "DeploymentRequest",
  "Preview",
]) check(name);
for (const name of ["Configuration", "Revision", "Version"]) {
  assert.ok(schema.$defs[name].properties.variables);
  assert.ok(schema.$defs[name].required.includes("variables"));
}
assert.ok(schema.$defs.DeploymentRequest.properties.variable_bindings);
assert.ok(schema.$defs.Preview.properties.artifact_previews);
assert.ok(
  schema.$defs.RollbackPreview.properties.eligible_devices.items.required.includes(
    "artifact_sha256",
  ),
);

const declaration = check("VariableDeclaration");
assert.equal(
  declaration({ name: "device_port", path: "/sources/in/port", type: "integer" }),
  true,
);
assert.equal(
  declaration({ name: "invalid-name", path: "/sources/in/port", type: "integer" }),
  false,
);
assert.equal(
  declaration({ name: "device_port", path: "sources/in/port", type: "integer" }),
  false,
);
const bindings = check("VariableBindings");
const deviceId = "dff2c232-53e6-484a-a7cd-cd1dc1d66544";
assert.equal(
  bindings({
    defaults: { device_port: 8686, enabled: true },
    devices: { [deviceId]: { device_port: 9000 } },
  }),
  true,
);
assert.equal(
  bindings({ defaults: { device_port: 9007199254740992 }, devices: {} }),
  false,
);
assert.equal(
  bindings({ defaults: {}, devices: { "not-a-uuid": { enabled: true } } }),
  false,
);
const request = {
  version_id: "16756d24-c0a1-4167-a311-12fb6a3b1e83",
  variable_bindings: {
    defaults: { device_port: 8686 },
    devices: { [deviceId]: { device_port: 9000 } },
  },
  selector: { device_ids: [deviceId], group_ids: [], exclude_ids: [] },
  priority: 0,
  target_mode: "snapshot",
  rollout: {
    kind: "all",
    canary_size: 1,
    batch_size: 1,
    observation_seconds: 0,
    failure_threshold: 0,
  },
};
assert.equal(check("DeploymentRequest")(request), true);
assert.equal(
  check("DeploymentRequest")({ ...request, rollback_artifacts: { [deviceId]: "x" } }),
  false,
);
console.log("Variable wire schemas compile and reject malformed bindings.");
