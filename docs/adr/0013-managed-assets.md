# ADR 0013: Managed assets are pinned by digest in each version and delivered over the device's own channel

Proposed 2026-10-02. Nothing described here is built. Existing behavior is cited by file and symbol as read at commit `021e303`, and the Vector 0.58.0 behaviors it relies on were measured for [ADR 0012](0012-graduated-capability-tiers.md#appendix-a-measurements) ([what validation loads](0012-graduated-capability-tiers.md#what-validation-loads) and [what the schema shows](0012-graduated-capability-tiers.md#from-the-schema-alone)). ADR 0012 decides where restricted mode allows an asset and what `managed-ca` means. The order of work, files and tests are in the [implementation plan](../internal/CAPABILITY-IMPLEMENTATION-PLAN.md), and the attacker table in the [threat model](../security/THREAT-MODEL.md#managed-assets).

## Verdict

1. **A published version pins every asset it uses by SHA-256, inside its own bytes.** Drafts name an asset; publishing writes the exact revision into the configuration and the artifact. A rollback deploys an older version, so the device gets exactly the bytes that version had.
2. **The device fetches assets over its own mutual-TLS channel, only those its current version pins.** The signed manifest lists each with its size and kind. The agent verifies size and digest, places the file under its own name in a directory it owns, and never overwrites a file a running Vector may hold.
3. **Restricted mode allows exactly the asset files the agent placed, in the fields its own table lists.** A CA certificate also needs the host's `managed-ca` approval.
4. **Assets are configuration, not secrets.** Every role sees their names and digests, editors and above read the bytes, and backups hold them. Uploads that contain a private key are refused: TLS keys stay device secrets.
5. **Everything is bounded:** 10 MiB per asset, 16 assets and 64 MiB per version, 1 GiB per server by default, 192 MiB on a device. The first kinds are CSV lookup tables, MaxMind databases and PEM certificates. A city-level GeoIP database is larger than 10 MiB and stays outside the limit until a measured decision raises it (below).
6. **An asset that can't be fetched fails the apply at its download step.** Nothing is written, the last verified configuration keeps running, and the agent tries again at its next check-in.

## Context

**What operators do today.** Every file Vector reads has to be on each host before a version applies: a CSV for a `file` enrichment table, a MaxMind database for a `geoip` or `mmdb` table, a CA bundle or certificate for a TLS block. Restricted mode refuses enrichment tables outright and accepts a TLS file only under an allowed file root ([AUTHORING-GAPS.md](../internal/AUTHORING-GAPS.md), rows 13, 14 and 27). It also refuses inline PEM in a TLS file field, although Vector accepts it: `walkIn` in `agent/internal/agent/policy.go` checks every `*_file` value as an absolute path.

**What already exists to build on.**

- Artifact bytes are content-addressed and immutable on the server: `artifact_blobs` and `desired_artifacts` (`server/migrations/0027_variable_artifacts.sql`), written by `variables::snapshot` and read by `variables::current`.
- The signed manifest names the artifact by digest and size, and `VerifyEnvelope` (`protocol.go`) accepts only the path `/agent/v1/artifacts/{sha256}`. The artifact route (`artifact` in `server/src/device.rs`) serves only the device's current desired artifact; knowing a digest grants nothing.
- The agent downloads a template into memory, bounded by `MaxArtifact` (1 MiB), and writes nothing until size and digest match (`loadTemplate` in `reconcile.go`).
- Device secrets show the pattern for values substituted on the device: references only at fields of the agent's own generated table, checked on the effective configuration ([ADR 0008](0008-device-secret-field-table.md), `resolveLocalSecrets` in `secrets.go`).
- The agent listener gives each request 15 seconds (`bounded_request` in `device.rs`); agent binary downloads stream outside it with their own limits: 32 transfers at once, a 20-second stall limit and a 5-minute deadline (`DOWNLOADS` in `server/src/install.rs`).
- `deploy/backup.py` copies the database with SQLite's backup API, plus `keys/` and `artifacts/`.

**What Vector 0.58.0 does.** `tls.ca_file`, `crt_file` and `key_file` take a path or inline PEM. Enrichment tables come in four types: `file` (CSV), `geoip` and `mmdb` (MaxMind databases) and `memory`. The isolated worker's `vector validate --no-environment` loads neither tables nor TLS files; the device's plain `vector validate` loads both and refuses a missing or malformed one ([measured](0012-graduated-capability-tiers.md#what-validation-loads)).

**What the specification requires.** Hash exact artifact bytes, and keep the template, delivered and actual digests distinct; versions are immutable and a rollback is a newer generation with older content (section 5). The manifest binds digest and size, a device reaches only its currently authorized artifacts, and a known digest grants nothing (section 7). The agent recomputes the digest of what it manages before each reconciliation and repairs drift (section 8). Credentials stay out of history and exports; device-local secrets are preferred (section 10). Backups include artifact state (section 12).

## Decision

- **An asset is a named file with immutable, content-addressed revisions** of one kind (section 1).
- **Drafts reference a name; publishing pins the revision** into the version's configuration and artifact as `vectory-asset:NAME@sha256:HEX` (section 2).
- **The server stores revisions in SQLite**, within a quota, keeps every revision a version pins, and collects the rest (section 3).
- **Editors and above upload; operators and administrators delete; everyone sees metadata** (section 4).
- **The signed manifest lists the version's assets; the device fetches each from a route that authorizes only those** (section 5).
- **The agent places each file at `<state-dir>/assets/sha256/<hex>`**, substitutes that path only at asset fields of its own table, keeps every file a retained configuration names, and verifies again before each apply (section 6).
- **CA certificates need `managed-ca` in restricted mode; private keys are never assets** (section 7).

## 1. What an asset is

A name, unique ignoring case and matching `^[A-Za-z][A-Za-z0-9_.-]{0,63}$` like a device-secret name, with a description, a kind fixed at creation and a sequence of revisions. A revision is immutable: its bytes, size and SHA-256 never change, and two names may share the same bytes.

| Kind | Holds | Where a pipeline may use it | Checked at upload |
| --- | --- | --- | --- |
| `csv` | A lookup table | `enrichment_tables.*.file.path` of a `file` table | Valid UTF-8, no NUL byte, a first line |
| `mmdb` | A MaxMind database | `enrichment_tables.*.path` of a `geoip` or `mmdb` table | The MaxMind metadata marker in the last 128 KiB |
| `pem_certificates` | One or more PEM certificates | `tls.ca_file` and `tls.crt_file` of any component | Only `CERTIFICATE` blocks, each a parseable X.509 certificate |

**Every kind refuses a private key.** An upload with any PEM block whose label ends in `PRIVATE KEY` is refused, whatever its kind. So is any value in a draft that holds one (section 7).

**Assets are not secrets.** Pipelines, versions and exports already hold configuration every role can read; assets are part of it. They may hold data you consider internal, such as a customer lookup table. The upload dialog says so: "Every signed-in person can see this asset's name and size, editors can download it, and backups keep it."

| Bound | Value |
| --- | --- |
| Asset size | 1 byte to 10 MiB |
| Assets per server | 256 names |
| Stored bytes per server | 1 GiB by default (`VECTORY_ASSET_STORAGE_BYTES`), counting every stored revision |
| Assets per version | 16, at most 64 MiB together |
| Assets on a device | 192 MiB (three versions' worth: running, last verified, candidate) |
| Uploads | 10 MiB a request, 2 at a time per server, 60 an hour per person |
| Device downloads | one at a time per device, 30 a minute per device, 32 at a time per server; a 20-second stall limit and a 5-minute deadline |

## 2. How a version references an asset

**In a draft**, an author writes `vectory-asset:NAME` at an asset field, or chooses it with the field's **Use an asset** action. The reference follows the asset: whichever revision is current when the version is published. An author may also write the pinned form, `vectory-asset:NAME@sha256:HEX`, to keep an older revision; restoring a draft from a version brings its pins with it. A reference anywhere else is refused at draft save, as a device secret is ("Assets go only in fields Vector reads as a file: enrichment table paths and TLS certificate files. `sinks.out.uri` isn't one.").

**Publishing pins.** Inside the publish transaction (the `("configurations", "publish")` action in `server/src/api.rs`), the server resolves each reference to its current revision, or checks that a pinned one exists, and writes the pinned form into the version's configuration before `validation::render` produces the artifact. The version records `assets: [{name, sha256, size, kind}]` and `uses_managed_assets: true`, and `version_assets` holds the same pins as rows. An unknown or deleted name, a kind that doesn't fit its field, more than 16 references or more than 64 MiB refuses the publish with `422 VALIDATION_FAILED`, naming the field and the fix.

**Why a name in drafts and a digest in versions.** An author thinks in names, and "use the newest lookup table" is the common intent. A version must never change, and a device must be able to prove what it runs. Pinning at publish gives both: replacing an asset changes nothing on any device until someone publishes and deploys a version that pins the new revision, through the ordinary review, canary and rollback.

**Rollback pins the exact bytes.** A rollback deploys an older version as a newer generation (specification section 5). Its configuration and artifact carry their own pins, the server keeps every revision a version pins (section 3), and the device either still has those files or downloads them again.

**The artifact digest covers the assets.** The pins are inside the artifact bytes, so the digest the manifest signs commits to every asset's digest, and a changed asset is a changed artifact. The manifest's `desired.assets` repeats the pins with sizes and kinds so the agent can bound its downloads before it has the artifact; the agent refuses a manifest whose list and artifact disagree. Both sit inside `desired`, so the same-generation identity check in `VerifyEnvelope` refuses a changed asset under an unchanged generation.

**Variables can't move assets.** A variable value can't be a `vectory-asset:` reference (`safe_value` in `variables.rs` refuses it like `vectory-secret:`), and a variable can't be declared at a field that holds one (`declarations`). Every device of a version gets the same pins, so the manifest list and the artifact always agree.

## 3. Server storage, quota and retention

**Tables** (migrations `0151_managed_assets.sql` and `0152_managed_asset_indexes.sql`; the [plan](../internal/CAPABILITY-IMPLEMENTATION-PLAN.md#wp7-managed-assets-on-the-server-backend-agent) has the sketch):

- `asset_blobs(sha256, size, bytes, created_at)`: immutable; a trigger refuses an update, and refuses a delete while a version pins the blob or an asset's current revision is it. A blob has no kind, since two names of different kinds may hold the same bytes.
- `assets(name, kind, current_sha256, revision, description, created_by, created_at, updated_by, updated_at, deleted_at)`: the mutable pointer. Deleting a name leaves a tombstone, so revision numbers keep counting if the name returns.
- `asset_revisions(name, revision, sha256, size, uploaded_by, uploaded_at)`: the history, kept after a blob is collected.
- `version_assets(version_id, name, sha256)`: immutable, like the version record it belongs to.

**Why SQLite.** One online backup holds versions and their pinned bytes together, consistently (`deploy/backup.py` needs no change), and a publish pins and checks in one transaction. The cost is a write of up to 10 MiB under the single writer for each upload, which the plan measures before it ships; uploads are rare operator actions, not part of the heartbeat path. Device downloads never take the writer: they read through a bounded, shared in-memory cache (64 MiB by default, one load per blob however many devices ask at once), so an all-at-once rollout reads each asset from the database once.

**Retention.** The server keeps the current revision of each asset and every revision any version pins, for as long as the version exists, which today is always. A revision that is neither, and older than 7 days, is collected by a bounded background step and audited (`asset.collect`). The quota counts every stored revision. When it's full, an upload is refused with `507 ASSET_STORAGE_FULL` and the page lists the largest assets and the versions that keep them.

**Backups and restore.** Assets are in the database, so a backup has them and a restore brings back versions and their pins together. The restore fence for device generations is unchanged.

## 4. Roles, routes and audit

| Action | Roles |
| --- | --- |
| See names, kinds, sizes, digests, revisions and usage | Every signed-in role |
| Download an asset's bytes | Editor, Operator, Administrator |
| Upload an asset or a new revision; edit its description | Editor, Operator, Administrator |
| Delete an asset name | Operator, Administrator |
| Pin assets into a version | Operator, Administrator (publishing, unchanged) |

Editors upload because an upload is like a draft edit: it affects the next publish and no device. The publish review shows every asset that changed since the pipeline's previous version ("geo-country: r3 → r4, uploaded by Ana 2 hours ago"), so a publisher sees a replaced file the way they see a changed component.

**Upload.** `PUT /api/v1/assets/{name}/content` takes the raw file (at most 10 MiB, `Content-Length` required) with the kind on creation, the SHA-256 the browser computed (`X-Asset-SHA256`), and `If-None-Match: *` to create or `If-Match: "<current sha256>"` to replace, CSRF as usual. The server streams the body to a private temporary file under its data directory while hashing, refuses a digest that differs from the header, runs the kind's checks, then inserts the blob and the revision in one write transaction. The same bytes as the current revision answer `200` with no new revision. Content addressing makes recovery exact without a request ledger: after an unknown outcome the dashboard reads the asset and compares digests.

**Other routes**, all under `/api/v1`: a paged list with the storage use, one asset with its revisions, its usage (drafts, versions and the number of devices running them), a description edit and a delete with the expected revision. The exact shapes are in the [plan](../internal/CAPABILITY-IMPLEMENTATION-PLAN.md#wire-and-storage-changes).

**Audit.** `asset.create`, `asset.revise`, `asset.describe`, `asset.delete` and `asset.collect`, with names, revisions, digests, sizes and kinds, never bytes. `configuration.publish` details gain the version's pins. Reads aren't audited, as for pipelines.

## 5. Delivery

**The manifest.** `desired` gains `assets: [{name, sha256, size, kind, path}]` when the version pins any, `path` being `/agent/v1/assets/{sha256}`. `VerifyEnvelope` accepts at most 16 entries, lowercase 64-hex digests, sizes from 1 byte to 10 MiB and 64 MiB together, known kinds, valid unique names and exactly that path. The manifest's `features` gains `assets`.

**Who may receive it.** An agent that supports assets says so: once a manifest lists `assets`, its heartbeat carries an `assets` array, empty when nothing is in use. A version that pins assets is never released to a device whose last report lacks it: deployment preview and creation return the blocker `MANAGED_ASSETS_UNSUPPORTED`, and later release waves and new group members recheck it, like `FULL_VECTOR_MODE_REQUIRED` (`compatibility_problems` in `server/src/rollout.rs`). An older agent would treat a pinned reference as a literal path and refuse it, but it would also compute the manifest's identity without the list, so it must never see one.

**The route.** `GET /agent/v1/assets/{sha256}` (mutual TLS) authenticates like `artifact` and answers only when the digest is pinned by the device's current desired version, with the same snapshot checks, or by an unexpired device validation addressed to that device ([work queue item 6](../internal/WORK-QUEUE.md#6-check-on-devices-validate-on-the-real-hosts-before-deploying)). Anything else is `403`, as for artifacts. It streams the bytes with `Content-Length` and `Cache-Control: no-store` after the 15-second handler step, within the transfer limits of section 1, and never redirects.

## 6. On the device

### Where assets live

In `<state-dir>/assets/sha256/<hex>`, one file per revision, named by its digest. The directory is private to the service account (`0700`, the protected ACL on Windows) and each file read-only (`0400`). The agent chooses the path; the server never sends one, so a reference can't name a path at all.

The state directory is the right home: the agent owns it, the service sandbox already lets it write there (ADR 0012), `vectory uninstall --purge` removes it with everything else, and the managed configuration's directory must hold only the managed file (`checkManagedDirectory` in `storage.go` refuses subdirectories). If Vector later runs as an account of its own, the assets directory is the one the agent would open to it.

### Fetch, verify, place

During `Reconcile`, after the template is verified and before anything else: the agent reads the asset references from the template with its own table and requires them to equal the manifest's list. For each asset it doesn't have, it streams the download into a temporary file in the assets directory, counting and hashing as it goes, and stops at the signed size. Only when size and digest match does it sync the file, make it read-only and rename it to its final name. A cut-off, oversized or altered download leaves no file under a final name, as `loadTemplate` guarantees for artifacts today.

### Substitution and restricted mode

The agent substitutes before device secrets and before the policy check, so the policy sees the effective configuration (specification section 10):

- It replaces a whole value `vectory-asset:NAME@sha256:HEX` at an asset field of the matching kind, from its own generated table, with that file's absolute path. Any other occurrence of `vectory-asset:` is refused with `ASSET_REFERENCE_REFUSED`, naming the field. A draft-style reference without a digest never reaches a device; if it does, it is refused the same way.
- The policy check receives the exact set of paths it substituted and accepts a file field equal to one of them. A literal path into the assets directory is refused, because a file root can't cover the state directory (ADR 0012). That is how restricted mode allows only the asset directory, and within it only the files this configuration was given.
- In restricted mode, a `pem_certificates` asset in `tls.ca_file` also needs `managed-ca` (section 7).

### Digests and verification evidence

The managed file holds absolute paths that depend on the device's state directory, so for a version with assets the managed file's digest differs from the template's, as it does for device secrets. The same evidence applies. The agent reports `applied_template_sha256` and raises its materialization counter (the wire field `secret_revision`) whenever it writes a different effective configuration for a template it materialized, with secrets or assets. The server treats `uses_local_secrets` or `uses_managed_assets` as materialized wherever it checks verification today: the heartbeat's `local_secret_evidence` and the attempt matching in `device.rs`, `verified_current` in `rollout.rs`, `canary_gate.rs` and `configuration_attempt::was_verified`. Template identity, delivered artifact digest and actual managed-file digest keep their meanings ([ADR 0006](0006-artifact-hash.md)).

### Replacing and removing an asset

Nothing is replaced in place. A new revision is a new file under a new name, and a version change moves Vector to it by the ordinary reload or restart, so a running Vector never sees a file change under it, and a database it maps stays valid until it lets go. Old files are removed only when no retained configuration names them: the managed file, the last verified copy (`good-<sha>.json`), the pre-attempt backup, the current template and an open device validation. Removal runs after a completed apply (`cleanupGood`) and at startup (`removeStaleLeftovers`), skips temporary files younger than ten minutes, and on Windows leaves a file Vector still holds open for the next pass. That retention is what lets a local rollback (`restoreLastGood`) run without the server.

### Drift

The managed file's digest doesn't change when an asset file does, so the agent checks assets too. Before each apply and at startup it hashes every asset the configuration names. At every check-in it compares each file's size, modification time, file identity and mode with what it recorded when it placed it, and hashes the file again when any differ. A file that no longer matches is reported as `drifted`, set aside, fetched again if the current version still pins it, and Vector reloads through the normal apply path, at the same generation, as for a drifted managed file. While the device is paused, it is only reported (specification section 8).

### When an asset can't be fetched

The attempt fails at the `download` stage, like an artifact download: `ASSET_DOWNLOAD_FAILED` (a connection problem, a cut-off transfer, a `403` or `404` from the server), `ASSET_MISMATCH` (wrong size or digest, or a list that disagrees with the artifact) or `ASSET_STORAGE_FULL` (the 192 MiB cap or a full disk). Each names the asset and the fix. Nothing is staged or activated, the last verified configuration keeps running, and the version is not held back: the agent tries again at its next check-in, within its usual backoff (`checkInSeconds`). The device page and Issues show which asset failed on which device.

### Pause, crashes and limits

A paused agent downloads nothing; the device page says "Not downloaded while this device is paused." A crash during a download leaves a temporary file that startup removes. A crash after placement leaves a complete, verified, unused file that the next removal pass deletes. Assets are placed before the apply journal starts, so the journal and its recovery are unchanged. The device cap counts every retained asset before a download starts; removal runs first, and the cap refuses only what still doesn't fit.

## 7. CA certificates and private keys

**A CA certificate decides whom a pipeline trusts.** In restricted mode, a `pem_certificates` asset in `tls.ca_file` needs the host's `managed-ca` approval (ADR 0012). Without it, pipelines trust the host's certificate store and CA files under allowed roots, as today. A `pem_certificates` asset in `tls.crt_file` is built in: a certificate is public, and it is useless without a key the host provides.

**Private keys never become assets.** The server would hold a credential, put it in backups and show it to editors. Instead, `tls.key_file` joins the device-secret table's reviewed plain-string credentials (`scripts/generate-vector-catalog.mjs`, regenerated by `scripts/generate-secret-fields.mjs`), so `key_file: vectory-secret:edge-tls-key` makes the agent substitute the PEM from a private file on the host, which Vector accepts inline. An RSA 4096 key in PKCS#8 PEM is about 3.3 KB, well inside the 16 KiB limit of a device secret (`MaxSecret` in `secrets.go`). A private key pasted into any field of a draft is refused at save, with that fix.

## 8. In the product

- **Pipelines → Assets**: a list with name, kind, size, revision, last upload and usage, the storage gauge, and **Upload asset**. The description reads "Files your pipelines read, delivered with each version that uses them." The upload dialog detects the kind, computes the SHA-256 in the browser, shows the server's checks, and explains refusals: "This file contains a private key. Keep private keys on the device: bind it as a device secret and use `vectory-secret:NAME` in `tls.key_file`." An asset's page shows its revisions, which versions pin each, and **Replace** and **Delete** with their usage.
- **The editor**: asset fields get **Use an asset**, listing assets of the right kind. The field shows "geo-country · latest (r4) · 5.9 MB" or "geo-country · pinned to r3", with **Use latest**. Code view shows the reference as written.
- **The publish review** lists the pins the version will carry and what changed since the previous version.
- **The deploy review** shows what each device downloads ("Each device downloads 6.1 MB: geo-country 5.9 MB, corp-ca 2 KB") and the `MANAGED_ASSETS_UNSUPPORTED` blocker: "edge-4 runs agent 0.1.0, which can't receive assets. Upgrade the agent."
- **The device page** lists the assets of the running and desired versions as the agent last reported them: "geo-country · r4 · 5.9 MB · Present, checked 2 min ago", "Downloading", "Couldn't download: the server closed the connection. The agent tries again at its next check-in." It never infers presence from the server's own records.

## Wire and storage

Every change is additive; the [plan](../internal/CAPABILITY-IMPLEMENTATION-PLAN.md#wire-and-storage-changes) lists the exact fields.

- **Manifest:** `features` gains `assets`; `desired` gains `assets`.
- **Heartbeat:** `assets: [{name, sha256, state, code?, checked_at}]`, at most 64 entries, states `present`, `missing`, `downloading`, `failed` and `drifted`; an empty array means "supported, nothing in use".
- **Agent route:** `GET /agent/v1/assets/{sha256}`.
- **Dashboard routes:** `/api/v1/assets`, `/api/v1/assets/{name}`, `/content`, `/usage`.
- **Version:** `assets`, `uses_managed_assets`. **Device:** `assets`. **Preview:** the `MANAGED_ASSETS_UNSUPPORTED` blocker and download sizes in `host_requirements`.
- **Codes:** `ASSET_STORAGE_FULL` (507) on the dashboard API; `ASSET_DOWNLOAD_FAILED`, `ASSET_MISMATCH`, `ASSET_STORAGE_FULL`, `ASSET_REFERENCE_REFUSED` and `ASSET_DRIFT` in agent diagnostics.
- **Migrations:** `0151_managed_assets.sql`, `0152_managed_asset_indexes.sql`, and the asset report's columns in `device_reports` (ADR 0012).

## Old agents and old servers

- **Old agent, new server:** it never reports `assets`, so no version with assets is released to it, and the review says why. Versions without assets are unchanged.
- **New agent, old server:** no `assets` feature, no field, nothing to fetch.
- **Downgrading the agent while a version with assets is desired:** the older agent receives the manifest without understanding the list, so its policy check or Vector's validation refuses the unresolved references, and it keeps its last verified configuration. After upgrading again, the same generation's identity no longer matches what the older build recorded, so the device needs a new generation from a new deployment. The upgrade guide says so.

## Alternatives considered and rejected

- **Assets inline in the artifact** (base64). The artifact is capped at 1 MiB, every version would copy the bytes, two versions couldn't share them, and diffs would be unreadable.
- **References by name only, resolved when a device applies.** Replacing an asset would change running devices without a deployment, and a rollback couldn't restore the old bytes.
- **References by digest only, also in drafts.** Exact but unreadable and unpleasant to edit; the pinned form is still available when an author wants it.
- **Asset files on the server's disk.** Streaming is simpler, but a backup would have to keep the database and the files consistent; `deploy/backup.py` can only detect a change during the copy and fail. One database keeps versions and their pins in one transaction and one backup.
- **Reading blobs in chunks** with SQL `substr`. SQLite walks a large blob's overflow pages from the start for every chunk; one read into a shared cache is simpler and faster.
- **A path chosen by the server or the author.** That would hand the server a write location on the host. A content-addressed name the agent chooses can't traverse anywhere.
- **Encrypted assets, so private keys could be assets too.** The server would hold host credentials and the master key problem of section 10 of the specification would follow. Device secrets keep credentials on the host.
- **Fetching assets from a URL** (an object store, a vendor download). It breaks the signed, outbound-only channel and would make devices depend on another service.

## Consequences

- **Pipelines with lookup tables, GeoIP and private CAs deploy like any other version**, on restricted devices too, with no file placed by hand.
- **Server storage grows with every pinned revision and never shrinks while versions exist.** The quota makes it visible and bounded; a policy for retiring old versions' bytes is unbuilt (below).
- **A rollout transfers each asset to every device that lacks it.** A 10 MiB asset sent all at once to 10,000 devices is about 100 GiB from the server, spread by the 32-transfer limit; canary and batched rollouts spread it further. The deploy review states the size per device.
- **Verification treats asset versions like secret versions**, so `uses_managed_assets` joins `uses_local_secrets` everywhere evidence is checked, and the contract describes `secret_revision` as a materialization counter.
- **A device validation ([work queue item 6](../internal/WORK-QUEUE.md#6-check-on-devices-validate-on-the-real-hosts-before-deploying)) must also authorize and fetch the candidate's assets**, and the [effective configuration view](../internal/WORK-QUEUE.md#5-effective-configuration-per-device) shows the pins.

## What stays unbuilt until proven

- **Assets larger than 10 MiB.** MaxMind's city-level databases are tens of megabytes; the country and ASN databases fit. The transfer streams to disk and the limit is one constant, so raising it is a measured decision, not a redesign. Until then a city database still has to be placed on the host under an allowed root.
- **More kinds:** DER certificates, Lua modules (useful only in full mode, since Lua runs programs), VRL files for `remap.file`, protobuf descriptors and JSON schemas for the VRL functions that read files. Each needs its fields in the table and its own upload checks.
- **Per-device assets** chosen by variables.
- **Checking asset content on the server with Vector.** The isolated worker would need a separate, environment-checked validation of a minimal configuration around each asset, with the bytes in its sandbox. Until then the server checks the format and each device's Vector checks the content.
- **Retiring the bytes of old versions** that no device has been offered for a long time, as an explicit, audited administrator operation that makes those versions undeployable.
- **Peer or delta distribution** for large fleets.

## Open risks

- **A compromised server can deliver any bytes a version pins.** The agent proves the bytes are what the signed manifest names, not that they are benign: a poisoned lookup table, a hostile MaxMind file for Vector's parser, or, with `managed-ca` granted, a CA certificate that makes a pipeline trust an attacker's endpoint.
- **A replaced asset is easy to miss in review.** The publish review lists it; a publisher can still approve it without looking.
- **Slow links.** At less than about 35 KB/s a 10 MiB asset can't finish within 5 minutes, and the device keeps failing that version.
- **Not measured:** the writer time of a 10 MiB insert on a slow disk, the shared cache under an all-at-once rollout, Windows deleting a file Vector maps, and MaxMind files near the limit.
