# ADR 0014: Device secrets in headers and URLs go only where the host binds them

Proposed 2026-10-02; partially implemented. The smaller detector and authoring-refusal step has shared Rust and TypeScript fixtures, field-specific server errors, and dashboard import and Code preflight. Host-bound secret uses in headers and URLs are not built. The implementation references below describe the earlier code at commit `bf2bf11` unless stated otherwise. The order of work, the files and the tests are in the [implementation plan](../internal/SECRETS-IMPLEMENTATION-PLAN.md), and the attacker table in the [threat model](../security/THREAT-MODEL.md#device-secrets-in-headers-and-urls). It extends [ADR 0008](0008-device-secret-field-table.md) and fits [ADR 0012](0012-graduated-capability-tiers.md) and [ADR 0013](0013-managed-assets.md).

## Verdict

1. **A device secret may fill a header value, a URL query value, a URL path or a whole URL, but only for a use the host bound.** The host lists each use in the bindings file: the destination (scheme, host, port, optional path prefix) and the placement (`header NAME`, `query NAME`, `path`, `url`). The agent checks every use from its own settings and the rendered configuration, in restricted and full mode. A server can't add, widen or skip a use.
2. **Placement is bound, not only the destination.** A secret bound to a multi-tenant service by destination alone could be moved into a query tag or a dataset name under the attacker's own account at that same service. Binding the header or parameter name closes that.
3. **Bindings stay backward compatible.** A plain path binding keeps today's meaning: credential fields only. A binding with uses is exhaustive: it never fills a credential field and goes nowhere its uses don't name.
4. **The plaintext detector becomes a precise, shared specification** with golden fixtures for the server and the dashboard: credential-like header names, query parameter names, known webhook path shapes and token shapes. Every refusal names the field and the fix, and a refused import stays in its dialog.
5. **The agent redacts what it substituted, wherever it appears**, not only at known field positions: diagnostics, log summaries, policy refusals and the local Vector log.
6. **The server still never sees a resolved value.** History, versions, diffs and exports hold references only.

## Context

**What exists.** `vectory-secret:NAME` is accepted only as the whole value of a field in the generated table (251 fields in 85 component types; ADR 0008). The agent substitutes in `resolveSecretReferences` (`agent/internal/agent/secrets.go`) and refuses any other occurrence with `SECRET_REFERENCE_REFUSED`; the server refuses it in `local_secret_scan` (`server/src/validation.rs`). Bindings map a name to a private file (`Settings.SecretFiles`, written by `ConfigureSecretFiles` after `ReadSecretBindings` in `secret_bindings_input.go`, through `vectory configure-secrets --secret-files PATH` with the agent stopped). Substitution runs before `CapabilityPolicy.Check` in `Reconcile` (`reconcile.go`), so restricted mode checks the effective configuration.

**The gap** ([authoring finding 4](../internal/AUTHORING-GAPS.md#p1)). HTTP-style sinks need credentials in headers (`Authorization`, `X-Api-Key`, `X-Honeycomb-Team`), query parameters (`?api_key=`) and webhook paths. The preview now refuses likely plaintext in these positions at import and save, but `vectory-secret:NAME` references there are still refused because current host bindings cannot constrain their destination and placement. A full-mode device can use a native Vector secret or environment reference where Vector supports one; restricted mode does not provide an equivalent for every sink. The host-bound use design below is needed to make device secrets work safely in these positions.

**Why the table exists.** A credential field has fixed meaning: Vector sends it as authentication to the component's destination. A header or URL has whatever meaning the destination gives it. If a server could choose where a secret goes, it could send it to a host it controls, or to a service where it reads the value back as data.

**What a compromised server can already do.** Threat model decision 7: it can point a credential-bearing component at another destination; restricted devices bound that with network allowances, full-mode devices don't. In full mode a publisher can also read the secret file with an `exec` source, since Vector runs as the agent's account (ADR 0012, section 6). In restricted mode a `file` source can read a secret file if a file root covers it: `validateInstallPolicy` (`install_options.go`) doesn't check roots against bound files. That is an open gap today, closed here (section 3).

**Redaction today learns by position.** `learnConfiguration` (`diagnose.go`) treats table fields and sink `auth` fields as secrets and marks every other string safe to echo. A value interpolated into a URL would be marked safe. `policyDiagnostics` echoes a refusal's `Resource`, which for an invalid destination is the whole URL. The local `vector.log` (`vectorlog.go`) is unredacted by design.

## Decision

- **Sites** (section 1): header values, URL query values, URL paths and whole URLs, listed per component type by a generated table, with the destination fields each header travels with.
- **Uses** (section 2): an object binding with `send_to` lists exact uses; a plain path binding keeps credential fields only.
- **The agent decides** (section 3), in both modes, after substitution and before the policy check, and fails closed.
- **The server** checks syntax and placement, stores references only and explains bindings it can't see (section 5).
- **Redaction** follows substituted values (section 6).
- **The detector** is specified once and fixture-tested in Rust and TypeScript (section 9).

## 1. Where a reference may stand

| Site | Example | Written as |
| --- | --- | --- |
| Header value | `request.headers.X-Honeycomb-Team` | `vectory-secret:NAME`, or `WORD ${vectory-secret:NAME}` / `WORD=${vectory-secret:NAME}` (`Bearer`, `Basic`, `Token`, a cookie name) |
| URL query value | `uri: https://ingest.example.com/v1?api_key=${vectory-secret:NAME}` | `${vectory-secret:NAME}` as the entire value of one parameter |
| URL path | `uri: https://hooks.slack.com/services/${vectory-secret:NAME}` | `${vectory-secret:NAME}` starting right after a `/` and ending at a `/` or the end of the path |
| Whole URL | `uri: vectory-secret:NAME` | the exact whole value |
| Structured query map | `http_client` `query.api_key[0]` | `vectory-secret:NAME` |

- **One canonical form per shape.** `vectory-secret:NAME` is the whole value; `${vectory-secret:NAME}` sits inside text. `${vectory-secret:NAME}` alone is refused with "This is the whole value: write vectory-secret:NAME". Credential fields keep ADR 0008's exact form.
- **One reference per value.** Never in a URL's scheme, userinfo, host, port or fragment, in a header name, or in a query parameter name.
- **The sites come from a generated table.** `scripts/generate-secret-fields.mjs` adds, per section and component type, the header maps (`request.headers.*` and the other string-valued header maps of the pinned schema), the URL fields (`uri`, `endpoint`, `endpoints[]`, `url`, `protocol.uri` where typed as a URI or so named) and the structured query maps, and for each header map the destination fields it travels with. It writes the same three copies as today; `--check` fails when one is stale, and a schema field that looks like a header map or URL but is unclassified fails the generator, as ADR 0012's completeness check does. When ADR 0012's capability table exists, the destination fields come from its `url` resource fields and a test keeps the two equal.
- **Vector's own syntax.** `${vectory-secret:NAME}` reads in Vector's interpolation as a variable `vectory` with the default `secret:NAME`. It never reaches Vector: the agent substitutes or refuses every occurrence, and the server's `static_candidate` replaces references with placeholders (`replace_local_secrets`) before `substitute_references` runs.

## 2. The binding

The bindings file keeps its shape. A value is either a path (today) or an object:

```json
{
  "DD_API_KEY": "/etc/vectory/secrets/DD_API_KEY",
  "HONEYCOMB_KEY": {
    "file": "/etc/vectory/secrets/HONEYCOMB_KEY",
    "send_to": [{"url": "https://api.honeycomb.io", "as": "header", "name": "X-Honeycomb-Team"}]
  },
  "SLACK_ALERTS": {
    "file": "/etc/vectory/secrets/SLACK_ALERTS",
    "send_to": [{"url": "https://hooks.slack.com/services/", "as": "url"}]
  },
  "INGEST_KEY": {
    "file": "/etc/vectory/secrets/INGEST_KEY",
    "send_to": [{"url": "https://ingest.example.com/v1/", "as": "query", "name": "api_key"}]
  }
}
```

**Meaning.**

- A path, or an object without `send_to`, fills credential fields only, exactly as today.
- An object with `send_to` fills only the listed uses. It never fills a credential field: a server could otherwise point that field at any destination. To use one file both ways, bind two names to it.
- `as` is `header`, `query`, `path` or `url`; `name` is required for `header` (an HTTP token, compared without case) and `query` (compared exactly), and refused otherwise. At most 8 uses per name.

**Matching a destination.** `url` is an absolute `http` or `https` URL with a host and no userinfo, query or fragment; the host is ASCII (an IDN in its `xn--` form), lowercase, without a trailing dot; no wildcards. Scheme, host and port match exactly, with the scheme's default port. A path prefix ending in `/` matches that directory and below; otherwise the whole path or the path followed by `/`. A URL that carries a secret and is checked against a path prefix may not hold `.` or `..` segments or an encoded `/` or `\`, literally or percent-encoded.

**Matching a placement.**

- `header`: the value sits in the named header of a component whose every destination field matches `url`. A destination field that is missing (a vendor default) can't be proven and refuses. A templated path is checked by its static prefix before the first `{{`; Vector 0.58 keeps scheme, host and port literal (ADR 0012, Appendix A).
- `query`: the reference is the whole value of that parameter in a URL that matches `url`, or the value of that key in a structured query map of a component whose destination matches.
- `path`: `url` ends in `/` and the reference starts exactly where that prefix ends.
- `url`: the reference is the whole URL value, and the resolved URL matches `url`.

**Values.** A value substituted into a URL is used as written, never re-encoded, and is refused when it would change the URL's structure: control characters or spaces anywhere, `#` anywhere, `?` in a path, `&` or `=` in a query value. A value for an open site must be at least 8 bytes, so redaction can find it (section 6). A resolved whole URL must parse, use `http` or `https` and carry no userinfo.

**The command.** `vectory configure-secrets --secret-files PATH` stays the one command that binds, with the same strict reader (`ReadSecretBindings`): it now accepts the object form, still refuses unknown keys, `null`, duplicates and trailing data, and validates every use before anything changes. It prints what each name may reach ("HONEYCOMB_KEY: header X-Honeycomb-Team to https://api.honeycomb.io:443") and warns for each `http` use that the value travels in clear text. Restricted mode keeps needing the network allowance as well: a use never implies an allowance, and an allowance never implies a use. When ADR 0012's restart helper exists, `configure-secrets` uses it; until then it keeps today's stopped-agent rule.

## 3. What the agent checks

In `Reconcile`, `resolveSecretReferences` keeps its place after `loadTemplate` (and after managed assets, ADR 0013) and before `CapabilityPolicy.Check`. For each reference it finds, in a fixed order:

1. Locate the site with the agent's own table; refuse anything else (`SECRET_REFERENCE_REFUSED`, as today).
2. Check the shape rules of section 1 on the template (`SECRET_REFERENCE_REFUSED`).
3. Find the binding (`SECRET_BINDING_MISSING`) and read the file (`SECRET_FILE_UNREADABLE`).
4. For an open site, require a binding with `send_to` (`SECRET_USE_NOT_BOUND`), then substitute every reference of the component and check the effective destination and placement against the uses (`SECRET_DESTINATION_DENIED`, naming the secret, the component, the field and the destination it would reach). For a credential field, require a binding without `send_to`.
5. Check the value rules (`SECRET_VALUE_REJECTED`, with the reason and never the value).
6. For a component that carries an open-site secret: refuse turning off `verify_certificate` or `verify_hostname` (any mode), and refuse a pipeline proxy (component or global `proxy`) for an `http` destination, since the proxy would read the request (`SECRET_DESTINATION_DENIED` with the reason).

The same check runs for a device validation (`validation_check.go`), on recovery content and in local diagnostics, as substitution does today. A refusal holds the version back like a policy refusal: last-known-good keeps running, and the hint is the host change that would allow it.

**Both modes.** The check is the same in restricted and full mode. In restricted mode it is a boundary. In full mode it prevents mistakes, not a malicious publisher, who can read the secret file with `exec`; the docs say so.

**Secret files outside file roots.** In restricted mode a bound secret file may not lie under an allowed file root. `configure-secrets` refuses such a binding, `vectory allow --file-root` (and `install --capability-policy`) refuses such a root, and the agent refuses resolution with `SECRET_FILE_EXPOSED` if settings edited by hand overlap. This also protects today's credential fields.

## 4. Alternatives

| Option | Stops | Misses |
| --- | --- | --- |
| **Uses bound by destination and placement** (chosen) | A secret sent to any destination the host didn't bind, in both modes; one secret sent to another's destination; a secret moved into a data position (tag, dataset name, index, another header) at its own destination; a secret in a credential field pointed elsewhere, for names with uses | A bound destination that is itself compromised or forwards what it receives; proxies and CAs the host chose; a full-mode publisher reading the file |
| Destination only (scheme, host, port) | Arbitrary destinations; cross-destination confusion | The placement attack: at a multi-tenant service a server authenticates with its own account (plain text in the pipeline, which the agent doesn't police) and puts the victim's secret into a query tag or dataset name it then reads in that account |
| Header-name and parameter allow-list, no host step | Moving a secret into an arbitrary header or data position | Any destination: as today's credential fields, bounded only by restricted-mode allowances and not at all in full mode. Paths have no name to allow |
| Never (keep refusing; better detector and messages only) | Everything new | Restricted devices then have no safe way to send header, query or path credentials at all, which pushes hosts to full mode; plain text keeps slipping past any detector |

## 5. The server

- **Validation.** `local_secret_scan` learns the open sites from the generated table and the shape rules of section 1, and keeps its three codes (`plaintext_credential`, `secret_reference_refused`, `secret_reference_invalid`). It can't see bindings: whether a use is bound is the device's answer. `replace_local_secrets` replaces an embedded reference with `vectory-placeholder` (a whole URL with `http://127.0.0.1:9`, as `placeholder_value` does), so the isolated worker still checks the rest; `deferred_reasons` keeps `device secrets`.
- **Stored and shown: references only.** Drafts, revisions, versions, artifacts, diffs, exports, the effective configuration view and audit details hold `vectory-secret:NAME` and `${vectory-secret:NAME}` as written. `uses_local_secrets` marks a version with any reference. Variables can't hold or move a reference (`safe_value` and `declarations` in `variables.rs`, as today).
- **Explaining bindings.** The agent reports each bound name with its uses, never files, paths or values: `secret_uses: [{name, uses: [{origin: "https://api.honeycomb.io:443", as, name?}]}]`, at most 64 names and 8 uses each, behind the manifest feature `secret_uses`. The origin omits the path prefix, which could hold part of a webhook token. The deploy review and the device page compare it with each version's references ("HONEYCOMB_KEY is bound on edge-2, but not as header X-Honeycomb-Team for api.honeycomb.io"); like ADR 0012's capability report, it explains and never grants.

## 6. Redaction

- **Learn values, not positions.** `resolveSecretReferences` returns the values it substituted, held in memory only. `redactorFor` adds each one, its percent-encoded forms (path segment and query component) and its JSON-escaped form, before it marks configuration text safe. `containsSecret` therefore covers a refusal's `Resource`, and `policyDiagnostics` stops echoing a URL that carries a value.
- **After a restart.** The values of the running configuration must still be known. The agent keeps, next to each retained effective file (`good-<sha>.json`, `pre-attempt.json` and the managed file), a private record of where substituted values sit: the JSON pointer and byte span of each, never the value. `redactorFor` reads the values back from the effective file it already holds. Removal follows the file it describes.
- **Short values.** Open sites need 8 bytes (section 2). Credential fields keep today's whole-word rule for shorter values.
- **The local Vector log.** `vectorLog.persist` and the in-memory ring replace the known values (and their encoded forms) before anything is written, because Vector's HTTP errors can quote a request URL. `vectory logs --raw` stays unchanged otherwise.
- **Telemetry.** `componentLabels` (`telemetry_parse.go`) already reads only component labels, so URL labels never leave the host. The loopback monitoring exporter serves Vector's raw metrics on the host itself; whether Vector 0.58 puts a full URL in a metric label is not measured, so the docs warn that any local user who can read that port can read what Vector exposes there.

## 7. Rotation

Unchanged in kind. The host replaces the file; at the next check-in the effective digest changes, the materialization counter (`secret_revision`) rises, and a tracked, journaled attempt applies and is verified, as today. Old and new values both stay in the redaction set until the old one leaves every retained file. Changing a binding's uses is a settings change through `configure-secrets` and takes effect at the agent's next start.

## 8. In the dashboard

- **Picker inside headers and URLs.** Header-value fields and URL fields of components that have sites get **Insert device secret**, which writes the canonical form at the caret (`Bearer ${vectory-secret:NAME}`, `?api_key=${vectory-secret:NAME}`, or the whole value) and shows the placement it creates: "Sent as header X-Honeycomb-Team to api.honeycomb.io". A position the rules refuse is greyed with the reason.
- **Binding steps.** `bindingInstructions` (`secretFields.ts`) writes object bindings with `send_to` derived from the version's references, so the host copies one file. A page can't run it; the host reviews it.
- **Truthful states.** The device page and deploy review show Bound, Not bound, "Bound, but not for this use" and Not reported (older agent), from the agent's report, never inferred.

## 9. The plaintext detector

One specification is implemented in `server/src/validation.rs` (`credential_findings`) and `dashboard/src/credentialFields.ts` (`findPlainCredential` and `credentialFindings`), with shared golden fixtures in `vector-catalog/fixtures/credentials/` that both test suites run. A server finding is `{code: "plaintext_credential", path, field, component?, message, fix}`, where `path` is the full display path (`sinks.h.request.headers.Authorization`).

**What counts as a credential.** A non-empty string that isn't a reference (device, `SECRET[...]`, `${VAR}`, `$VAR`) and:

1. sits at a device-secret field or a sink `auth.user`, `auth.password` or `auth.token` (today);
2. sits under a key whose normalized name (lowercase, `-` and `.` as `_`) is one of today's names or ends with `_token`, `_key`, `_secret`, `_password`, `_signature`, or is `authorization`, `proxy_authorization`, `cookie`, `set_cookie`, `x_honeycomb_team`, `dd_api_key`, `x_api_key`, `api_key`, `apikey`, `x_auth_token`, `private_token`, `x_insert_key`, `x_license_key`, `signature`, `sig`;
3. is a header value under a header map (a site of section 1, or any `headers` map) whose name contains `token`, `key`, `secret`, `auth`, `cookie`, `signature` or `session`, or whose name is the known credential header `X-Honeycomb-Team`; ordinary team-label headers are not credentials;
4. is a URL (any string containing `://`) with nonempty userinfo (today), or with a nonempty query parameter named `api_key`, `apikey`, `key`, `token`, `access_token`, `auth`, `sig`, `signature`, `secret`, `client_secret`, `password`, or whose path matches a known webhook shape with a final secret-like segment of at least 8 characters: `hooks.slack.com/services/…`, `discord.com/api/webhooks/…`, `discordapp.com/api/webhooks/…`, `*.webhook.office.com/…`, `outlook.office.com/webhook/…`, `chat.googleapis.com/…?key=`;
5. in configuration, graph, pipeline metadata or a public variable value (not `tests` input events), matches a token shape: a JWT (three base64url parts, the first decoding to JSON with `alg`), an AWS access key id (`AKIA` or `ASIA` and 16 uppercase letters or digits), a PEM private key block, or a well-known prefix (`xox[abeprs]-`, `ghp_`, `github_pat_`, `glpat-`, `sk-`).

**False positives and short credentials.** A refusal must be actionable. The placeholder words `changeme`, `example`, `redacted`, `xxxxxxxx` are excluded. A known credential field, credential-like key or header, URL userinfo, or named credential query parameter refuses even a one-character literal: a short credential is still a credential and must not enter history. Only the more ambiguous webhook path shape requires a final segment of at least 8 characters. Rule 5 needs the full shape, not a prefix alone. Every message names the field and a safe fix. Today a generated credential field can use `vectory-secret:NAME`; a header or URL must remove the plaintext or use a supported native Vector secret or environment reference on a full-mode device. Host-bound `vectory-secret:` use in headers and URLs is future work in this ADR. There is no override: plain text never enters history when the detector recognizes it, and a false positive is fixed in the fixtures and both implementations.

Credential context follows descendants of a credential-named field or header. A draft may be saved before its Vector schema is valid, so an array or object supplied where a string belongs must not hide a short credential in a nested string. Test input event payloads remain data and are excluded from this rule.

**What the server returns.** Create and draft save keep `400 INVALID_INPUT` (older clients read the safe message) and add `error.reason: "plaintext_credential"`, `error.problems: [...]` (at most 20), and `error.truncated` through `ApiError::with_fields`. Strong token and credential-URL shapes in pipeline metadata, including variable declarations and revision or publication notes, receive the same 400 refusal. A refused request writes no configuration, revision, version or request mapping. Other publish validation failures retain their existing `422 VALIDATION_FAILED` behavior.

**The import dialog and Code view.** The dashboard runs the detector on import and on Apply, before sending, and names the line when it has the source ("Line 12: `request.headers.Authorization` holds what looks like a credential."). It also checks metadata, graph, public variable values and publication notes before writing a recoverable browser request or draft copy. A sent keyed creation's `400 INVALID_INPUT` with `reason:"plaintext_credential"` is deterministic for the exact immutable payload: the dialog clears that reminder, keeps the form and shows the problems inline. A generic `400`, `403`, `413`, `422`, `409`, `5xx` or lost response remains uncertain because another tab could have sent the same key before this attempt refused. A refusal proves only that attempt did not write; a broader definitive cleanup needs a server-side terminal fence or equivalent request ownership.

## 10. Wire and storage

All additive. The [plan](../internal/SECRETS-IMPLEMENTATION-PLAN.md#wire-and-storage-changes) lists them exactly: the bindings file's object form and `settings.json` `secret_uses`; the manifest feature `secret_uses` and the heartbeat `secret_uses`; the Device projection; the `validate_draft` error members; agent codes `SECRET_USE_NOT_BOUND`, `SECRET_DESTINATION_DENIED`, `SECRET_FILE_EXPOSED`; the generated table's new sections. No migration: the report lives in the device record's existing JSON beside `secret_names`. No manifest field changes; the agent decides from its own settings.

## 11. Old agents and old servers

- **Old agent, new server.** Its table has no open sites, so it refuses a reference in a header or URL (`SECRET_REFERENCE_REFUSED`) and keeps its last verified configuration. The server sees no `secret_uses` report and blocks such a version for that device in the deploy preview with `DEVICE_SECRET_SITES_UNSUPPORTED`, like `MANAGED_ASSETS_UNSUPPORTED` in ADR 0013.
- **New agent, old server.** The old server refuses the references at save, so nothing reaches the agent.
- **A downgraded agent.** Its `ReadSecretBindings` refuses a bindings file with object values, so nothing changes. It ignores `secret_uses` in `settings.json` (`secret_files` keeps plain paths, see the plan) and, with no open sites in its table, refuses every header or URL reference: stricter, never wider.

## Consequences

- HTTP-style sinks work on restricted devices without plain text, and authoring finding 4's four cases are refused with their field named.
- The host does one more thing per secret: name where it goes. The dashboard writes it for them.
- In restricted mode, a file root can no longer cover a bound secret file, which can refuse a version that relied on it.
- The specification's sentence on binding files (section 4: names map to path strings) needs a matching change.

## Left undecided

- Whether `as: credential` uses (a credential field bound to a destination) ship later, which needs each component's destination from ADR 0012's table and would close threat model decision 7 for names that opt in.
- Whether `http` uses are allowed at all, or only to private addresses.
- The minimum length for open-site values (8 bytes proposed).
- Whether `configure-secrets` gains incremental flags (`--name`, `--file`, `--to`, `--as`) beside `--secret-files`; the specification requires the file option today.

## Open risks

- **A bound destination is trusted.** If it redirects, forwards headers or is compromised, the secret goes with it. Whether Vector 0.58's HTTP client follows redirects is not measured here; the native probe in the plan measures it, and if it does, the agent refuses open-site secrets for components that follow redirects.
- **Proxies and CAs.** An https request through a proxy the host allowed is opaque to it unless the pipeline trusts the proxy's CA; in restricted mode a pipeline CA needs ADR 0013's `managed-ca`. Full mode trusts the publisher.
- **The detector can't be complete.** A secret in a field named `notes` passes unless its value has a strong token or credential-URL shape. Object keys and component IDs are not scanned as values; user-authored synthetic test event payloads are deliberately excluded. The fixtures grow with every miss reported.
- **Not measured:** where Vector 0.58 quotes a URL or header (error lines, health checks, metric labels), redirects, and `vector validate` output for a malformed URI. The plan's native probe records them before the release.
