# Device secrets in headers and URLs: implementation plan

Status: proposed, 2026-10-02, for the release after the current one. Nothing here is built. The decision is [ADR 0014](../adr/0014-device-secrets-in-headers-and-urls.md); the attacker table is in the [threat model](../security/THREAT-MODEL.md#device-secrets-in-headers-and-urls). This plan orders the work, names the files each step changes, states every wire and storage change, lists the tests each step needs and what an independent review must attack. A route or wire change updates `contracts/CONTRACT.md` first.

## Start here (for the independent review)

Each question has a one-line answer in the ADR and a test below.

1. Can anything a server sends make the agent substitute a secret at a use the host didn't bind? (Step 3; ADR sections 2 and 3.)
2. Can a name bound with `send_to` fill a credential field, or a plain binding fill a header or URL? (Step 3.)
3. Can a template trick the destination check: a templated path, `..`, an encoded slash, a missing destination field, a proxy? (Steps 3 and 6.)
4. Can a substituted value reach the server, a diagnostic, a log summary or the local Vector log? (Step 4.)
5. Does a refused import stay in its dialog with the field named, and does an uncertain one still ask for review? (Step 5.)
6. Do the server and the dashboard give the same detector answer for every fixture? (Step 1, run in Steps 2 and 5.)
7. Can a restricted pipeline read a bound secret file through a file root? (Step 3.)

## Prerequisites and ordering

| Order | Step | Depends on | Ships |
| --- | --- | --- | --- |
| 0 | Native probe of Vector's URL and header exposure | nothing | first; its result can change Steps 3 and 4 |
| 1 | Contract, generated site table, detector fixtures | 0 agreed | before code in 2 to 5 |
| 2 | Server: sites, detector, structured refusals, report | 1 | with 3 |
| 3 | Agent: bindings, use check, file-root rule | 1 | with 2 and 4 |
| 4 | Agent: redaction by value | 3 | with 3 |
| 5 | Dashboard: insert secret, binding steps, detector, import dialog | 1, 2 | with 2 to 4 |
| 6 | Docs, operations, CI | each step | with each step |
| 7 | Integration tests and independent review | all | gate |

**Release gates, all required:** the generator's `--check` and completeness green; the detector fixtures pass in Rust and TypeScript; the native probe green on Linux; the adversarial tests of Steps 3 and 7 green; the independent review finished with its findings resolved; documentation matches behavior.

**A smaller first step.** The detector, the structured refusal and the import dialog (Step 1 fixtures, the detector half of Steps 2 and 5's import and Apply scan) don't depend on the agent and can ship alone. They close authoring findings 4 (the four plaintext cases) and 5 without opening any new place a secret can go.

## Wire and storage changes

Every change is additive. Old agents and old servers keep their shapes (ADR section 11).

**Bindings file** (`configure-secrets --secret-files`, `install --secret-files`): a value is a path string or `{file: string, send_to?: [{url: string, as: "header"|"query"|"path"|"url", name?: string}]}`. At most 64 names and 8 uses per name. Unknown keys, `null`, duplicates, an empty `send_to` and `name` where `as` doesn't take one are refused before anything changes.

**Settings** (`settings.json`): `secret_files` keeps `{NAME: path}`; a new `secret_uses: {NAME: [{url, as, name?}]}` holds the uses, so a settings reader that predates it ignores it and the old agent refuses open-site references anyway. A name in `secret_uses` must be in `secret_files`.

**Generated table** (`scripts/generate-secret-fields.mjs` writes `agent/internal/agent/secret_fields_generated.go`, `server/src/secret_fields.rs` and `dashboard/src/generated/secret-fields.json`): beside `SECRET_FIELDS`, `SECRET_SITES: (section, type, path, kind)` with kind `header`, `url` or `query_map`, and `SECRET_DESTINATIONS: (section, type, header_path, destination_path)`.

**Manifest** (signed): `features` gains `secret_uses`. No other field.

**Heartbeat**, sent only after a verified manifest lists the feature (`addHeartbeatFeatures`):

```json
"secret_uses": [
  {"name": "HONEYCOMB_KEY", "uses": [{"origin": "https://api.honeycomb.io:443", "as": "header", "name": "X-Honeycomb-Team"}]}
]
```

The server rejects unknown keys and enforces: at most 64 entries with names matching `is_secret_name` and unique; at most 8 uses each; `origin` a lowercase `scheme://host:port` of at most 300 printable bytes with no path; `as` one of the four; `name` at most 128 bytes of HTTP token characters. The device record keeps the latest report beside `secret_names`; a heartbeat without the field removes it.

**Dashboard API.**

- Device: read-only `secret_uses` (the stored report). List rows keep only `secret_names`.
- `PUT /configurations/{id}/draft` and `POST /configurations` refusals: `400 INVALID_INPUT` with `reason: "plaintext_credential"`, `problems: [{code, path, component, field, message, fix}]` (at most 20) and `truncated`. The message stays readable by older clients.
- Preview: blocker `DEVICE_SECRET_SITES_UNSUPPORTED` for a device that reports no `secret_uses` while the version has open-site references; `secret_needs` per device group: `[{name, use, bound: true|false|null}]`.

**Agent diagnostics:** `SECRET_USE_NOT_BOUND`, `SECRET_DESTINATION_DENIED`, `SECRET_FILE_EXPOSED`, and new reasons for `SECRET_VALUE_REJECTED` and `SECRET_REFERENCE_REFUSED`, each with a fixed hint in `codeHints` and a sentence in the server's per-code rendering.

**Private agent state:** `secret-spans-<sha>.json` beside each retained effective file: `[{pointer, start, end}]`, never values; removed with its file.

**No migration.** The report rides the device record's JSON.

## Step 0: native probe

`agent/tests/native-secret-exposure-probe.py`, run against `VECTOR_TEST_BINARY` with a closed port and a local HTTP listener in a private network namespace: does Vector 0.58 quote the request URL (path and query) or a header value in error lines, health-check failures, `vector validate` output or internal metric labels; does its HTTP client follow a redirect, and does it forward custom headers when it does. Record the answers in ADR 0014 as an appendix. A followed redirect makes Step 3 refuse open-site secrets on components that follow it; a quoted URL is covered by Step 4 either way.

## Step 1: contract, table, fixtures

| File | Work |
| --- | --- |
| `contracts/CONTRACT.md`, `contracts/generate.mjs`, generated `openapi.json` and `protocol.schema.json` | Everything in [Wire and storage changes](#wire-and-storage-changes), including the "Local secrets and signing continuity" section's new sites and uses. `node contracts/generate.mjs` leaves no diff. |
| `scripts/generate-vector-catalog.mjs`, `scripts/generate-secret-fields.mjs` | The site and destination tables from the pinned schema; a completeness check that fails on an unclassified string map named `headers` or a URL-like field (`uri`, `url`, `endpoint`, `endpoints`); `--check`. |
| `vector-catalog/fixtures/credentials/` (new) | Detector fixtures: a configuration and its expected findings by path. At least: the four cases of authoring finding 4; every rule and list entry of ADR section 9; each false-positive exclusion; references of every form at every site; tests input events (never flagged). |
| `vector-catalog/fixtures/secret-uses/` (new) | Use fixtures for Step 3: a template, bindings and the expected outcome per reference. |

**Tests.** The generator's `--check` and completeness in CI; a schema with one new header map fails the completeness check naming it.

## Step 2: server

| Files | Work |
| --- | --- |
| `server/src/validation.rs` | `local_secret_scan` over `SECRET_SITES` with the shape rules; `credential_findings` (ADR section 9) replacing the key list in `validate`, each finding with its path; `replace_local_secrets` for embedded references; `structural_diagnostics` maps the new messages to codes and fields. |
| `server/src/api.rs` | `validate_draft` returns the structured refusal with `with_extra`. |
| `server/src/device.rs` | `HEARTBEAT_FEATURES` gains `secret_uses`; strict parsing before the writer transaction; the Device projection. |
| `server/src/rollout.rs` | `DEVICE_SECRET_SITES_UNSUPPORTED` in `compatibility_problems`, rechecked at scheduled activation, later waves and group expansion; `secret_needs` in the preview. |
| `server/src/variables.rs` | `safe_value` refuses `${vectory-secret:`; `declarations` refuses a path inside a value that holds one. |

**Tests.** Every detector fixture through the Rust detector. Every site and shape: accepted forms, `${vectory-secret:NAME}` as a whole value refused with its fix, two references in one value, references in scheme, host, port, userinfo, fragment, header names and parameter names refused. The draft, create, duplicate, restore and publish paths refuse plain text with `reason` and `problems` and store nothing (assert the plain value is absent from every table, the WAL and an export). An older client's view: the message alone. Report parsing: unknown keys, bounds, a path in `origin`, control characters reject the heartbeat atomically. The preview blocker for an older agent, including later waves. `uses_local_secrets` for open-site references.

## Step 3: agent bindings and the use check

| Files | Work |
| --- | --- |
| `secret_bindings_input.go` | `ReadSecretBindings` accepts the object form with the same strictness; validates each use (URL form, ASCII host, no wildcard, `as` and `name` rules, at most 8). |
| `secrets.go`, `types.go` | `Settings.SecretUses`; `resolveSecretReferences` with the site table, the shape rules, the use check on the effective destination and placement, the value rules, the TLS and proxy rules (ADR section 3), returning the substituted values and spans. |
| `install_options.go`, `agent/cmd/vectory/commands.go`, `help.go` | Both directions of the file-root rule for restricted mode; `configure-secrets` prints what each name may reach and warns for `http` uses. |
| `diagnose.go` | `secretDiagnostic` texts and hints for the new codes, naming the secret, component, field and destination, never the value. |
| `heartbeat_features.go` | The `secret_uses` report: origins only. |
| `validation_check.go`, `diagnostics.go`, `reconcile.go` | The same check for device validation, local diagnostics and recovery content. |

**Tests (adversarial ones first).** Every use fixture. A compromised-server suite feeding signed manifests whose templates try, against bindings for `HONEYCOMB_KEY` (header at `api.honeycomb.io`) and a plain `DD_API_KEY`: another host; another port or scheme; `http` for an `https` use; another header name; the same header at another destination; a query tag (`?ddtags=${...}`) and a path segment at the bound host; a whole-URL use with a lookalike host (`api.honeycomb.io.evil.example`, a trailing dot, uppercase, an IDN); `..` and `%2e%2e` and `%2f` against a path prefix; a templated path whose static prefix leaves the prefix; a missing destination field; a second destination in `endpoints`; a proxy for an `http` destination; `verify_certificate: false`; `HONEYCOMB_KEY` in a credential field; `DD_API_KEY` in a header. Each refuses with the right code, writes nothing, keeps last-known-good, and the managed file's bytes are unchanged. Settings bytes are identical after every hostile manifest. Values with `#`, `?`, `&`, spaces and fewer than 8 bytes refused per site. A file root covering a bound file refused by `allow`, `install` and `configure-secrets`, and resolution refused with `SECRET_FILE_EXPOSED` when settings overlap by hand. An older settings file and a newer one read by a build that predates uses. Native, with the pinned Vector: a header secret and a query secret reach a local collector (the collector sees the value; the managed file holds it; nothing else does).

## Step 4: redaction by value

| Files | Work |
| --- | --- |
| `diagnose.go` | `redactorFor` adds substituted values and their percent-encoded and JSON-escaped forms; `containsSecret` covers refusal resources. |
| `reconcile.go`, `storage.go` | Write and remove `secret-spans-<sha>.json` with each retained effective file; read values back at startup. |
| `vectorlog.go` | Redact known values in `persist` and the ring before anything is stored. |

**Tests.** A canary value substituted into a path, a query and a header, then forced into: a validation failure, a start failure, a policy refusal for an invalid destination, a Vector error line quoting the URL, a log summary, a device validation result, `vectory status`, `vectory doctor` and `vectory logs`; the canary and its encoded forms appear in none, before and after an agent restart, and after a rotation whose new value failed to apply.

## Step 5: dashboard

| Files | Work |
| --- | --- |
| `dashboard/src/secretFields.ts` | Site table reader; `secretReferences` covers sites and embedded forms; `secretFindings` implements ADR section 9; `holdsPlainCredential` uses it; `bindingInstructions` writes object bindings with uses derived from the version. |
| `SecretReferenceField.tsx`, `SchemaValueEditor.tsx`, the header-map and URL editors | **Insert device secret** at the caret, the canonical form, the placement sentence, refused positions greyed with the reason. |
| `PipelineLibrary.tsx`, `configurationSource.ts`, the import dialog and Code view Apply | Scan before sending with line numbers; definitive refusals (ADR section 9) clear the reminder and keep the form with problems inline; uncertain outcomes unchanged. |
| `DeviceSecrets.tsx`, `TargetDialog.tsx`, `api.ts` | Bound, Not bound, "Bound, but not for this use", Not reported; the `DEVICE_SECRET_SITES_UNSUPPORTED` blocker copy. |

**Tests.** Vitest: every detector fixture through the TypeScript detector (the same files Step 2 runs); the insertion model for each site; the bindings file for each use; the definitive-or-uncertain decision for each status and code. Playwright, with the shared fleet replies (`dashboard/tests/fleet-replies.mjs`): importing a file with a token stays in the dialog, names the field and needs no recovery step; a lost response still asks for review; inserting a secret into a header and a URL; the device card states. Axe; screenshots in light, dark and 390 px.

## Step 6: docs, operations, CI

- `docs/user/resources.md` (sites, uses, the bindings file, both modes, what full mode doesn't protect), `pipelines.md`, `cli.md` (`configure-secrets`), `security.md`, `troubleshooting.md` (a row per new code), `glossary.md`, `whats-new.md`, `CHANGELOG.md` (the file-root tightening).
- `docs/product-specification.md` section 4: the binding-file sentence, with the maintainer's agreement.
- `docs/security/OPEN-FINDINGS.md`: record the file-root gap until Step 3 closes it.
- `.github/workflows/ci.yml` and `docs/internal/CI.md`: the probe on Linux, the fixture runs, the new harness (`timeout-minutes: 10`).

## Step 7: integration tests and independent review

`tests/security/protocol_test.go` gains a subtest per hostile template of Step 3 through the real server and agent; `tests/contracts.mjs` validates the new bodies. On a live preview with the demo fleet: bind a header secret on one device and not another, deploy, see one apply and one refuse with the exact binding; rotate the file and see the materialization counter rise; import a configuration with a token and see it refused in the dialog. The independent review starts from a build that has passed every test above.

## What an independent review must attack in the finished code

1. **Where uses come from.** Every path from network-decoded data to `settings.json`, by search and by test; whether a heartbeat report can become a grant.
2. **URL parsing.** The agent's URL parser against Vector's (IPv6 literals, userinfo, percent-encoding, `@` and `\` in paths, empty and default ports, uppercase schemes, trailing dots, IDN), so the destination checked is the one Vector connects to.
3. **The placement rules.** A reference that escapes its position: multiple references, references in names, values that add `&`, `?` or `#`, headers whose names differ only in case, duplicate headers and parameters.
4. **Destination fields.** Every component type with a header site: does the table list every field that decides where the request goes (alternate endpoints, `path` options, health-check URLs, discovery)?
5. **Redirects, proxies and TLS.** Measured redirect behavior, environment proxies in full mode, `no_proxy`, a pipeline CA.
6. **Redaction.** Encodings beyond percent and JSON escaping (base64 of `user:pass`, Unicode normalization), values split across log lines, the spans after a crash between writing a file and its record.
7. **The detector.** False negatives (field names in other languages, values in arrays) and false positives that block ordinary pipelines; that the two implementations agree.
8. **Recovery UX.** That a definitive refusal is never shown for an outcome that could have committed.
9. **Old agents and servers.** Every combination in ADR section 11.
10. **Documentation against behavior.** Every claim in `resources.md` and `security.md`, especially what full mode doesn't protect.
