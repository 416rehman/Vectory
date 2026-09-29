// Validate unmodified private native HTTP bodies against the generated API.
// This script never contacts a live instance or creates an account.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(resolve(root, "dashboard/package.json"));
const Ajv = require("ajv").default;
const addFormats = require("ajv-formats").default;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const contractPath = resolve(root, "contracts/openapi.json");
const bodyRoot = resolve(root, ".local/user-request-native-bodies");
const manifestPath = resolve(bodyRoot, "manifest.json");
const contractBytes = await readFile(contractPath);
const manifestBytes = await readFile(manifestPath);
const contract = JSON.parse(contractBytes);
const manifest = JSON.parse(manifestBytes);
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const schemas = contract.components.schemas;
const checks = [];
for (const entry of manifest) {
  const raw = await readFile(resolve(bodyRoot, entry.file));
  const candidate = JSON.parse(raw);
  const validate = ajv.compile({
    $ref: `#/components/schemas/${entry.schema}`,
    components: { schemas },
  });
  if (!validate(candidate))
    throw Error(`${entry.file}: ${ajv.errorsText(validate.errors)}`);
  checks.push({
    file: entry.file,
    schema: entry.schema,
    sha256: hash(raw),
    valid: true,
  });
}
for (const route of [
  "/api/v1/users/requests/{request_id}",
  "/api/v1/users/requests/{request_id}/cancel",
])
  if (!contract.paths[route]) throw Error(`Missing ${route}`);
const status = ajv.compile({
  $ref: "#/components/schemas/UserRequestStatus",
  components: { schemas },
});
const receipt = ajv.compile({
  $ref: "#/components/schemas/UserCreateReceipt",
  components: { schemas },
});
const created = JSON.parse(
  await readFile(resolve(bodyRoot, "native_created_status.json")),
);
const direct = JSON.parse(
  await readFile(resolve(bodyRoot, "native_receipt.json")),
);
const invalid = [
  [
    "created without user",
    status,
    { request_id: created.request_id, status: "created" },
  ],
  [
    "not_found with user",
    status,
    { request_id: created.request_id, status: "not_found", user: created.user },
  ],
  ["receipt without request ID", receipt, { user: direct.user }],
];
for (const [name, validate, sample] of invalid)
  if (validate(sample)) throw Error(`Unexpectedly accepted ${name}`);
const report = {
  passed: true,
  classification: "private_native_http_body_contract_bridge",
  scope:
    "Unmodified private TCP fixture responses only; no live account or server activity.",
  openapi_sha256: hash(contractBytes),
  manifest_sha256: hash(manifestBytes),
  bodies: checks,
  rejected_controls: invalid.map(([name]) => name),
};
await writeFile(
  resolve(root, "docs/evidence/user-create-contract.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  `PASS ${checks.length} native bodies; ${invalid.length} negative schema controls`,
);
