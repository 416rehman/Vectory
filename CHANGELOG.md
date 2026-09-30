# Changelog

All notable changes to Vectory. The project is a developer preview and has no public release yet.

## 0.1.0-dev (unreleased)

The first self-hosted Vectory: a Rust and SQLite control plane, a React dashboard, an outbound-only Go agent, and a bundled Help center. See [What's new](docs/user/whats-new.md) for a tour.

### Highlights

- Visual pipeline editor for the 128 component types of Vector 0.58.0, with YAML, TOML and JSON import and export, VRL and pipeline tests, and immutable history with diffs.
- Publishing checked by an isolated Vector validator that fails closed; checks that need the device run on the device.
- Deployments to devices and groups with previews, priorities, canaries, schedules, pause, cancel and rollback.
- Outbound-only agents with mutual TLS, per-device signed manifests, protection against older configurations, drift repair and automatic restore of the last working configuration.
- Restricted and full modes, local allowances and device-local secret bindings, all controlled on the host.
- Device secrets in every credential field: a pipeline stores `vectory-secret:NAME`, each device fills in the value from its own file, and the device page shows which names each device has bound.
- Device metrics, issues, and an exportable audit log.
- Alerts in Slack, any webhook or email when an issue opens, a rollout fails or a device goes offline, with quiet hours, a delivery log with retries, and editable detection thresholds.
- Roles, two-factor sign-in with recovery codes, and administrator-issued reset links.
- A Help center bundled with the server, searchable offline, with every page available as Markdown and an `llms.txt` index.

### Dashboard

- **Faster first paint.** The sign-in page ships 25% less script, the pipeline list 54% less, and pages that are not open (the editor, the deploy dialog, notifications) load when you open them.
- **Copy buttons tell the truth.** **Copy YAML**, install commands and tokens say **Copied** only when the browser accepted the copy; when it refuses, a dialog shows the text to select.
- **Failures read as sentences.** A server that does not answer reads "Vectory didn't answer. It may be restarting, or the network is down." (and, for a change, says it isn't known whether it was saved), never a raw browser error such as "Failed to fetch". A check that failed is never shown as an all-clear.
- **Filters live in the address.** Issues filters and a rollout's device filter survive a reload, Back and a shared link.
- **Keyboard and screen readers.** Focus moves to the new page's heading on navigation and a polite announcer names the page. Single-key shortcuts can be turned off in the account menu.
- **One vocabulary.** "Applied" and "Not delivering" everywhere a device state is named; every status badge says what it means in plain words.
- Pipelines and Issues share one list pattern, with cards on a phone.

### Fixed during development

Agents built before these fixes behave differently. Rebuild agents from this revision.

- **Enrollment preflight:** an unreadable CA file or invalid local option is rejected before connection settings are saved or an enrollment request is created. Earlier builds could save the connection settings first.
- **Combined `install` options** are validated together before anything is saved. Earlier builds could save one option and then reject the next.
- **Credential fields:** plain text in any field Vector marks as a credential is refused at save and publish, with the fix. Earlier builds took `vectory-secret:NAME` only in the `auth` fields of `http`, `loki` and `elasticsearch` sinks, so other credentials were stored in the pipeline. Published versions are unchanged.
- **Secret-binding maps** are parsed strictly: `null`, lists, duplicate names and trailing content are rejected. Earlier builds could treat `null` as "remove all bindings" or keep the last duplicate silently.
- **Capability-policy files** with malformed UTF-8 or unpaired Unicode escapes are rejected instead of being repaired with replacement characters.
- **Metrics endpoint:** `vectory configure-metrics` and `--clear-metrics-url` were added. Earlier builds could only set a URL with `install --metrics-url`.
- **Replaced Vector binaries** can be approved with `vectory re-adopt --expected-sha256`. Earlier builds had no approval path.

- **Restricted mode matches VRL calls, not substrings.** A metric named `http_requests_total`, a filter on `"http_request"` or a step called `http_requests` no longer needs Full Vector mode. The agent, the server and the dashboard decide from one list, and it now includes the functions that read a file (`validate_json_schema`, `parse_proto`, `encode_proto`).
- **`remap.file` is refused in restricted mode** like `files`, and an HTTP route's `path` is no longer judged as a file path. A refusal never suggests `/` as a file root.
- **Delivery health no longer fails an assignment.** A device that stops delivering pauses a persistent assignment (reason "data plane") instead of failing it, so the assignment keeps following its group and resumes when you do.
- **Tests Vector refuses to run are failures.** A misspelled test setting, an unknown step or a test with no expected output shows Vector's reason, and the tests it did not run are marked **Not run**, instead of "0 of 0 tests passed".
- **The documentation page's recovery screen** shows **Reload page** at once for a signed-out visitor; it used to appear after five seconds.
- **The installer's dry run** plans for the directory you chose with `--install-dir`.
- **A listener below port 1024** (syslog on 514, for example) now gets a `PRIVILEGED_PORT` diagnostic that says how to allow it, instead of a hint about a path.
- **Setup never leaves a stopped service behind.** It checks the service registration before it stops anything and starts the service again on every failure path; launchd stop and restart survive a long drain. The installer stays an upgrade command.
- **Agent changes to know about:** `vectory logs --json` prints one JSON object per line (use `--raw` for the raw lines), setup exits 130 when interrupted while it waits for the check-in, the packaged launchd plist is `io.vectory.agent.plist`, and a pre-release Vector such as 0.58.1-rc1 is refused up front.
- **Add device never locks itself.** A command the page showed no longer blocks **Create install command** after a reload: its token is resolved against the token list (used, revoked or expired ones are forgotten, and the timeline says what they enrolled; unused ones join "wasn't used · Revoke it"). Only a creation whose reply never arrived still asks to be checked. **Start over** revokes the command on screen.
- **Hosts without a service manager** (containers, WSL, Alpine with OpenRC) get an honest setup: `[!!] Service` with the reason and the exact `run` command, exit code 3 (0 with `--service none`), and Add device says the device checked in once but nothing keeps its agent running. The dry run plans the same **Service** row with the installed agent path, and the installer's dry run checks that `--install-dir` is writable. Agents report `service_manager` and `vector_running` to servers that list those features.
- **A first version that can't start** leaves nothing claiming to run: the agent withdraws it, reports Vector stopped, and says to deploy a corrected version or retry, never to recover the host. The device page reads "Nothing running: Vector stopped after v1 failed to start.", its issue "<device> couldn't start <pipeline> v1", and a new device reads "Nothing yet" instead of an adopted workload that "may still be running".
- **Delivery without metrics** is judged from Vector's log: a sink failing requests two check-ins in a row opens the sink-errors issue, "measured from Vector's log (no metrics)". Pages say "Delivery health: not measured" instead of implying health, `vectory status` shows the failing sink, and restricted mode runs Vectory's loopback monitoring exporter without a listener allowance. The synthetic example ships with it.
- **The step after Applying is "Loading in Vector"**, not "Restarting Vector": Linux and macOS reload Vector in place (restarting only if the reload fails) and Windows restarts it. `vectory help` now lists exit code 78, and the Compose file makes the server wait for the validator's health check.

- **Device lists are lighter.** `GET /devices` and the Overview return list rows without the host runtime, the Vector log summary or per-component telemetry (about 80% smaller for a busy device); the device page still reads the full record.
- **Fleet reads that don't grow with the fleet.** `GET /devices/inventory` pages, filters, sorts and counts devices on the server; `GET /devices/{id}` reads only that device; groups add `member_count`, `slim=1` and a paged `GET /groups/{id}/members`; `GET /overview?slim=1` returns the fleet's counts, the devices that need attention, the busiest devices and what runs where, without a row per device; rollouts count `degraded` devices. At 5,000 devices a device read went from 2.1 s to 6 ms and the Devices page's first read from 11 MB to 111 KB (debug builds; see `docs/internal/CAPACITY.md`). Earlier requests answer as before.
- **The scheduler's cost no longer grows with history.** With two live rollouts on 20 devices a tick runs 17 queries whether none, 500 or 5,000 rollouts have finished (it used to run 965 at 500), and it rewrites nothing when nothing changed.
- **The anonymous rate limiter never refuses a new client because it is full.** It evicts the entry that expires soonest; installer, download, enrollment and invite traffic have their own partition and global per-minute caps, so it cannot crowd out sign-in.
- **Membership previews no longer queue behind heartbeats.** A busy server answers "Preview busy, retrying" and the dashboard retries quietly.
- **The install command never turns certificate checks off.** Add device used to generate `curl -fsSLk` for a private CA. The command now writes the server's CA certificate (public, like its fingerprint) to `vectory-ca.pem` and runs `curl --cacert vectory-ca.pem`; curl's `--pinnedpubkey` can't replace the CA check. **Advanced → How the host checks this server** offers the pinned CA (the default for a private CA), a CA file on the host (`--ca-file PATH`, `curl --cacert PATH`) or the host's trusted certificates (`--ca-file=`), and the installer honors the same choice for its download. The checksum line is split at the pipe so no part hides under **Copy**.
- **A command made for a typed name enrolls only that name** (`DEVICE_NAME_MISMATCH` otherwise), and a token pasted short or mangled is refused on the host before anything is sent.
- **Fingerprints are compared in full.** A pin mismatch prints both fingerprints with the first byte that differs; an untrusted CA prints the received fingerprint in Add device's rows of eight pairs, never as one value to paste as a pin.
- **Commands that need the agent stopped name what holds it** (the service, `vectory run` with its pid, or another command) and how to stop it. `vectory retry` works while the agent runs: it is queued and taken within seconds. With nothing failed, it says so and changes nothing.
- **`vectory allow --network/--listener/--file-root`** adds restricted-mode allowances and keeps the rest; refusal fixes and the deploy review's host commands use it, with the host's own `--state-dir` and service (or `vectory run`). `install --capability-policy` says what the host allows afterwards.
- **The agent's log says what changed, once:** the version it applied, a refusal in the words of its diagnostic, "Reconnected to … after 1 min 12 s", and how Vector stopped. `run --verbose` keeps a line per check-in. **Recent Vector errors** show only what Vector logged since it last loaded a configuration.
- **Upgrade agent** says when a device already runs this server's build (agents report their SHA-256) and otherwise gives the one installer command, without a token; the manual steps moved behind **By hand**. Setup run beside an older `vectory run` says to restart it.
- **Setup and status wording:** "Vector 0.58.0 binary pinned (SHA-256 …)", the absolute agent path in **Next**, a revoked device's status says the server no longer accepts the agent, a short Vector test run on a shared host no longer blocks setup (it re-checks after 6 s), and `service-stop` without systemd says so plainly. Setup ends with "Connected" only when it saw a check-in, and otherwise just links the device.
- **Smaller dashboard fixes:** the pipeline chooser is styled on a device page; the setup screen and every sign-in screen fit a 320 px phone; a pipeline only this device follows is replaced by default when deploying from its page; refusals read "because this host's restricted mode doesn't allow it"; a revoked device reads "Revoked · last verified running v1"; recovery codes are grouped for typing, and a recovery-code sign-in says how many are left.
- **Revoking a device resolves its open issues** as revoked, so the Overview stops counting them.
- **Data-plane checks ignore a sample whose clock runs more than five minutes ahead**, instead of freezing evaluation until real time catches up.
- **The administrator's two-factor reset authenticates before it reads the request body**, and a rollout's device timeline shows each device's latest changes instead of the oldest 5,000 rows.
- **A live canary rolls back in one reviewed step.** **Roll back** used to be refused for an active, paused or completed rollout that hadn't reached every device. The review now works out, with the real resolver, what each device it never reached runs once the rollout stops; confirming cancels the rollout and returns the devices it reached in one transaction. Only a device that would switch to an unreviewed version or lose its pipeline blocks, by name, and the review offers **Cancel rollout, then review rollback**.
- **Rollback wording names both sides.** Lineage, the rollout header, the list, Recent changes and the rollback receipt say "Rolled back to Edge syslog processing v1" instead of a bare "v1" from another pipeline, "1 reviewed device" in the singular, and the rollback review and **Remove assignment** show device names and "Keeps Edge syslog processing v1 (no change)" instead of UUIDs.
- **Redeploying a fix after a rollback takes one review.** The deploy preview suggests the pipeline's rolled-back rollout and its rollback at the rollback's priority and returns every assignment in the way at any tier, so one **Replace existing** resolves it. **Current winner** names what the device follows today, and when a device still keeps its current assignment the button reads **Deploy to 2 of 3 devices** and asks you to confirm what stays behind.
- **Needs you clears and ranks.** A rolled-back rollout leaves it; a device problem and the rollout it stopped read as one item; devices that aren't delivering come first, with **Roll back** when the server can review it; a stopped rollout can be dismissed per person and comes back if it fails again.
- **The rollout page leads with one action.** A delivery stop shows which device still runs the version, where it can't deliver and how full that buffer is, with **Roll back edge-nyc-02** first; a failure only the pipeline can fix (a port in use, a VRL error) leads with **Fix in pipeline**; Pause, Cancel, Roll back and Remove assignment moved into a **Stop rollout** menu with one line each; the device timeline has the device page's six steps and marks a reload failure at **Vector reloaded**; each failure reason prints once; the redundant copy-link row is gone because the page's address is its link.
- **Deployments reach a connected device in seconds, not at its next check-in.** Between check-ins the agent holds one request open (`GET /agent/v1/wait`, feature `wake`), and the server answers `{"changed":true}` once a change to the device's version, agent settings or access has committed; the agent then checks in as usual. The answer is an unsigned hint that carries no configuration, so the signed manifest stays the only authority, and the agent still opens every connection. On the preview, Deploy to the first apply report took 3.4 s (median of five runs; 37 to 61 s with wake-ups off). `VECTORY_AGENT_WAKE_LIMIT` bounds the waits (default 20,000; `0` turns wake-ups off), large releases are paced (100 at once, then 50 a second, never past a device's own check-in), and `vectory setup`/`install --no-wake` or `run --no-wake` keeps a host on its schedule. Device pages and rollout rows add `wake.listening` and say "connected, usually a few seconds" only while the agent holds the request. Agents and servers without `wake` keep polling as before.
- **On SIGTERM, as on Ctrl-C, the server answers parked agent waits before it exits**, so after `docker stop` or a service manager's stop, a waiting agent gets an answer instead of a reset connection. An apply's follow-up check-in now goes out one second after activation instead of two.
- **The Compose quickstart starts its TLS proxy.** The proxy container dropped every capability, and the Caddy image's binary carries a file capability that the kernel then refuses to run (`exec /usr/bin/caddy: operation not permitted`, a restart loop, and nothing listening on port 443). It keeps `NET_BIND_SERVICE` and nothing else, and CI now starts the stack and requests the dashboard through the proxy.
- **Upgrading:** migrations only go forward. An older server refuses a migrated database, so a downgrade means restoring a backup, and the first start after this release builds the telemetry index (slower on a large table).

### Documentation

- The Help center was reorganized around tasks: a quickstart, installing the server, connecting a device and deploying a first pipeline come first, followed by a security model and references for the agent CLI, server configuration, `vectory-admin` and ports.
- Repository copies of the guides became short pointers into the Help center, and internal evidence moved to `docs/internal/`.
- On phones, wide Help center tables stack into one labelled block per row.
- The API reference groups operations by resource and explains session authentication.
- `scripts/capture-screenshots.mjs` captures the product screenshots from the demo fleet.
