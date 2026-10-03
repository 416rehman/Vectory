# ADR 0015: Agent updates are turned on by the team, consented to on each host when it is enrolled, and accepted only as signed builds that the host verifies, stages and can undo

Accepted 2026-10-03; ships in 0.1.0. It replaces the proposal of 2026-10-02 in this file, whose order of work ("after signed releases") no longer holds: the release signature this feature needs is its own, made by a key the team holds or by this server, and does not wait for project-wide release signing. Existing behavior is cited by file and symbol as read at commit `8735411`. The wire shapes are in the [contract](../../contracts/CONTRACT.md#agent-updates) and the attacker table in the [threat model](../security/THREAT-MODEL.md#agent-updates).

## Verdict

What a team gets: **a host is visited once, when it is enrolled or first upgraded, and never again for an agent update.**

1. **The team turns updates on, once, in Settings → Agent updates.** Off by default. While it is off, nothing changes anywhere: no heartbeat offers a build, Add device never mentions updates, and every new route answers as if the feature did not exist.
2. **Each host consents when it is enrolled or upgraded, in the command the dashboard generates.** The command carries the level (`auto` or `ask`), the version track (patch releases, or minor ones too), an optional maintenance window and the fingerprint of the release key to pin. `vectory setup` (which the installer already runs as root) writes them to a root-owned file outside the agent's state directory. A host installed without them never updates remotely, whatever the server says. A server can narrow what a host allowed, never widen it. On the host, `vectory update pause`, `resume` and `off` stay available.
3. **A build is accepted only with a valid signature from a key the host pinned.** Ed25519 over the exact bytes of one release manifest. The team chooses, when it turns updates on, who holds the private key: **this server** (it generates, seals and uses the key) or **a key kept offline** (the server builds the manifest from its own agent catalog, someone signs those bytes on another machine and uploads the detached signature). Same manifest, same pin, same agent verification. A key rotates within its custody through a rollover statement signed by the key it replaces, so hosts follow without a login. A host never tries the same release twice: it keeps the highest release counter it attempted.
4. **Updates roll out like pipelines, as their own object.** Devices or groups, a canary first, then batches, an observation period, a failure threshold that stops the rollout, pause, resume and cancel. A review before the start names every device that will not update and why. Administrators have the server switch; Operators and Administrators have **Stop all updates**.
5. **A small privileged step applies a build, never the agent's service account.** The service account downloads and stages; a root (SYSTEM on Windows) step, sandboxed to the paths it changes, copies the staged file into a directory only it can write, verifies signature, digest, platform, counter and the host's policy again, swaps the executable atomically through handles it opened and checked, keeps the previous one, and watches the new build. The step runs from a copy of the last build that was proven on this host, so the rollback never depends on the new build.
6. **A device is updated only when the server saw it.** A download, a staged file or a swap is never reported as an update. The rollout counts a device as updated when a check-in after the restart carries the new build's SHA-256 and version, a new process identity, and the host's report that the build passed its health check.

## 1. Goals, non-goals, invariants and threats

**Goals.** Update the agent on many hosts from the dashboard without a login per host; keep every guarantee of restricted mode; recover by itself from a build that does not start or cannot check in; tell the truth about each device.

**Non-goals.** Updating Vector (the agent still pins the Vector binary it adopted; replacing it stays `vectory re-adopt` on the host). Updating hosts whose agent belongs to a package manager. Remote downgrades. A remote command channel of any kind: the server still only answers the agent's own requests.

**Invariants.**

- **I1.** A host whose root-owned update policy does not say `auto` or `ask` never downloads or installs an agent build. No manifest, policy, response or file the service account can write changes that.
- **I2.** An agent build is installed only when the privileged step itself verified, from bytes in a directory only it can write, a signature over the exact release manifest by a key in the host's root-owned pin set, the artifact's size and SHA-256 against that manifest, the host's platform, the host's counter floor and version track. A restricted host never runs agent code its pinned keys did not authorize.
- **I3.** The rollback is performed by a build that already ran and checked in on this host, never by the build being tried.
- **I4.** Updating the agent never changes the device's identity, mode, allowances, secret bindings, pauses, counters or managed configuration.
- **I5.** The server reports a device as updated only from its own observation of the new build checking in after the restart.

**What pinning a key means.** The installed agent runs as the service account, but root runs the same executable (`sudo vectory status`, setup, and the privileged step itself, which runs the last committed build). A key a host pins can therefore authorize code that runs as root on that host. The docs say so where the key is pinned. A newer agent can also widen what restricted mode accepts (a newer capability table, [ADR 0012](0012-graduated-capability-tiers.md)); the key holder decides that too.

### Who can do what

| Attacker | Can | Cannot |
| --- | --- | --- |
| **Compromised server**, custody *a key kept offline* | Offer any release the offline key signed to any device whose host policy accepts it (track, counter floor, expiry), at any pace; withhold updates; show operators false states; withhold rollover statements from hosts | Make a host accept a build no pinned key signed; change a host's consent, track, window or pins; widen a host's pins to a key of its own (that needs a rollover signed by a pinned key); make a host downgrade; make a host try a release again after it rolled back, under any rollout (the host's counter floor is the highest counter it attempted); install on a host that did not consent |
| **Compromised server**, custody *this server signs* | Everything above, and sign any build: every host that pinned this server's key runs it, as root | Reach hosts that did not consent or that pin another key |
| **Administrator session stolen** | Turn updates on and choose custody (password required); rotate the server's own key; upload a rollover the offline key signed; with custody *this server signs*, prepare, and so sign, any build in this server's catalog and roll it out (the session and its CSRF token are enough; the password is not asked for these, and nothing writes the catalog, so these are builds already on the server); start, pause, cancel rollouts; Stop all updates and clear it; turn updates off and on again with the other custody, which only hosts enrolled or upgraded afterwards pin | Make hosts already enrolled trust a new key without a rollover signed by a key they pin |
| **Operator session stolen** | Start, pause, resume and cancel update rollouts of releases that are already signed; Stop all updates | Prepare or sign a release, turn updates on or off, clear the stop; skip the canary (update rollouts always have one) |
| **Network attacker** | Delay or drop check-ins and downloads; the agent retries at its next check-in | Read or alter an offer (mutual TLS and the signed manifest) or a build (signed digest) |
| **Local unprivileged user** | Read the update policy and status (public facts, no secrets) | Write the policy, the privileged step's directory, the install path (all refused when not root-owned: `UNTRUSTED_LOCATION`) or the agent's state |
| **The service account, compromised** (for example through a full-mode pipeline) | Write anything in the agent's state: forge a staged build, a request or a health record; lie in its reports; make the privileged step roll back a good build or keep a broken one (denial of service to itself) | Pin a key, change consent, approve an `ask` update, or make the privileged step install bytes that no pinned key signed: the step copies, re-verifies and refuses |
| **Hostile build artifact** | Be offered | Be installed when its bytes, size, platform or signature differ; unpack into anything (the artifact is the bare executable, never an archive); exceed 128 MiB |
| **Replayed old release** | Be offered by a compromised server while it is unexpired and newer than the running version | Be installed when its counter is at or below the highest this host attempted from that key, when its version is not newer than the running one, or after it expires |
| **Stolen release key** | Sign builds and rollover statements; with a compromised server or an Administrator session, reach hosts that pin it | Reach hosts through an uncompromised server that never offers its builds. Recovery is manual for hosts that pin only that key ([section 2](#compromised-keys)) |

## 2. Keys and signatures

### Algorithm and signed bytes

Ed25519 (RFC 8032), the algorithm the manifest signing key already uses (`ed25519-dalek` in the server, `crypto/ed25519` in the agent). A release is one file, `release.json`. Its signature is over exactly these bytes:

```text
"vectory-agent-release-v1\n" || <the bytes of release.json, as stored and delivered>
```

The prefix keeps a release signature from ever validating as anything else, and anything else as a release. Nobody re-serializes the manifest: the server stores the bytes it built, the offline signer signs the bytes it downloaded, and the agent verifies the bytes it received, then parses them. The Rust server and the Go agent can't disagree about canonical forms because neither computes one.

### The manifest

```json
{"schema":"vectory.agent-release.v1","version":"0.1.1","counter":7,"issued_at":"2026-10-03T12:00:00Z","expires_at":"2027-04-01T12:00:00Z","min_from":"0.1.0","service_definition":1,"artifacts":[{"os":"linux","arch":"amd64","format":"executable","file":"vectory-0.1.1-linux-amd64","size":15204352,"sha256":"<64 hex>"}]}
```

| Field | Rule |
| --- | --- |
| `schema` | Exactly `vectory.agent-release.v1`. A future schema is refused by this agent (`AGENT_TOO_OLD` in the review), never half-read. |
| `version` | `major.minor.patch`, three decimal numbers without leading zeros, at most 64 bytes. Pre-releases (`-rc.1`) and build metadata are refused in v1. |
| `counter` | 1 to 2^53−1. Strictly greater than every counter this host attempted from the signing key ([below](#counters-and-replay)). |
| `issued_at`, `expires_at` | RFC 3339 UTC with `Z` and whole seconds. `expires_at` after `issued_at`, at most 400 days later. The server writes 180 days. A host refuses, by its own clock, a manifest that has expired and one whose `issued_at` is more than 24 hours ahead (`MANIFEST_INVALID`), the direction the signed envelope already guards for manifests (`VerifyEnvelope`). |
| `min_from` | Optional. A host whose running version is older refuses (`AGENT_TOO_OLD`): the release needs a step it can't take from there. |
| `service_definition` | The generation of the unit, plist or service definition the build needs. 0.1 builds say `1`. A host with an older definition refuses (`SERVICE_DEFINITION_OUTDATED`; [section 6](#service-definitions)). |
| `artifacts` | 1 to 8 entries, unique by `os` and `arch`. `os` is `linux`, `darwin` or `windows`; `arch` is `amd64` or `arm64`; `format` is `executable` (the only format); `file` is `vectory-<version>-<os>-<arch>`, plus `.exe` on Windows; `size` 1 byte to 128 MiB; `sha256` 64 lowercase hex. |

The file is at most 16 KiB of printable ASCII (every field's rules keep it ASCII, and any other byte is refused outright): one JSON object, no leading whitespace, at most one trailing line feed. Every key appears once, no other key is allowed, and numbers are written `0` or a digit 1 to 9 followed by digits, nothing else (no sign, fraction, exponent or leading zero). Both parsers refuse duplicate keys, unknown keys, escaped or unpaired surrogates in a value, and anything after the object: the shared vectors pin each refusal, so a byte string one side accepts and the other refuses fails CI.

The artifact is the agent executable itself, byte for byte the file in the server's catalog. No archive is unpacked as root.

### The detached signature

`release.json.sig`, at most 4 KiB:

```json
{"schema":"vectory.agent-release-signatures.v1","signatures":[{"key":"<64-hex fingerprint>","signature":"<base64 of 64 bytes>"}]}
```

1 to 4 entries with distinct keys. The release is valid on a host when at least one entry names a pinned key and verifies; entries for keys the host doesn't pin are ignored. The `key` field only selects which pinned key to try: verification always uses the pinned key's own bytes. This is what lets a project-wide release key be added later as one more pinned key, or a release carry two signatures during a rollover, without changing the agent.

Verification is strict and the same in both languages: `S` must be canonical (less than the group order), and `R` and the public key must be canonical encodings of points that are not of small order. Rust uses `verify_strict` (`ed25519-dalek`); Go uses `ed25519.Verify`, which refuses a non-canonical `S`, and checks `R` against the same encodings the key rule below refuses. The shared vectors hold a signature with a non-canonical `S` and one whose `R` is the identity point, made from the test key's own scalar so that it satisfies the verification equation; both must be refused.

### Keys, fingerprints and files

- **Public key**, one line: `vectory-release-key ed25519 <base64 of the 32 raw bytes> <name>`. The name is display text, at most 64 printable characters. A key is refused (`RELEASE_KEY_INVALID`) unless its 32 bytes are the canonical encoding of a curve point (the `y` coordinate below 2^255−19, the sign bit clear when `x` is 0) that is not one of the eight points of order 1, 2, 4 or 8. The vectors list those eight encodings and the non-canonical encodings of the same points (`y` equal to the field prime or one more, and the sign bit set on a point whose `x` is 0).
- **Fingerprint:** the lowercase hex SHA-256 of the 32 raw bytes, always computed from the key itself, never taken from a field beside it. Shown in groups of eight; its first 16 characters are the short key ID the dashboard and `vectory update status` print. Hosts compare whole fingerprints.
- **Private key file** (offline custody), mode `0600`: `vectory-release-private-key ed25519 <base64 of the 32-byte seed>`.

### Custody: who holds the private key

Chosen by an Administrator when turning updates on, as two descriptive options with nothing preselected. It stays fixed while updates are on; the key rotates within its custody by a rollover. Changing the custody kind is turning updates off and on again with the other kind, then re-pinning each host with one run of the Upgrade agent command: a known limit of this release.

| | This server signs | A key kept offline |
| --- | --- | --- |
| Who can authorize a build every opted-in host runs | Anyone who administers this server, or controls its host or a backup of it | Whoever holds the offline key |
| Private key | Generated by the server, sealed with the instance's AES-256-GCM key (associated data `agent-release-key:<fingerprint>`) in `keys/agent-release-<fingerprint>.sealed`, used only to sign releases and rollovers | Never on the server. `vectory release keygen` on another machine |
| Signing a release | Automatic when an Administrator prepares it | The key holder downloads the manifest, runs `vectory release sign` on the machine that holds the key, and an Administrator uploads the signature |
| Backups | Contain the sealed key and the sealing key: a stolen backup can sign releases | Contain only the public key |

The dashboard states the trade-off in those words. Turning updates on, and every key change, asks for the Administrator's password and is audited. The server refuses to register a release key equal to its manifest signing key or one already used. Turning updates off keeps the key, so turning them on again with the same custody needs no re-pinning.

### The signing tool

`vectory release` in the agent binary, which already runs on every platform and holds the one verification path:

- `vectory release keygen --out team.key` writes the private key (`0600`, refuses an existing file) and prints the public key line and fingerprint.
- `vectory release sign --key team.key --checksums SHA256SUMS release.json` refuses unless every artifact's `file` and `sha256` in the manifest appear identically in `SHA256SUMS`, a checksum file the signer obtained independently (from the project's release page, or from their own build). It prints version, counter, expiry and each platform, asks for confirmation on a terminal (`--yes` otherwise), and writes `release.json.sig`. Without the checksum comparison an offline signature would only repeat what the server put in its catalog.
- `vectory release rollover --key old.key --to new.pub` writes a rollover statement for an offline key's successor ([below](#rotation-by-rollover)).
- `vectory release verify --key KEY.pub release.json` checks a manifest and signature the way a host does.

### Counters and replay

A host keeps, in its root-owned state, a counter floor per pinned key: the highest counter of a release signed by that key that the privileged step **attempted** on this host. The step raises it, and syncs it to disk, when it journals `swapping`, before it stops the service ([section 6](#the-steps)); a rollback never lowers it. A release is checked against, and raises, the floor of every pinned key whose signature on it verifies. A release at or below the floor is refused: `RELEASE_ALREADY_TRIED` when the host's last result names that manifest's SHA-256 as rolled back ("This build was tried here and rolled back; publish a new release to try again"), `COUNTER_REPLAYED` otherwise. A server, compromised or not, therefore can't make a host try a release twice under fresh rollouts, which would stop and start Vector each time; and two different manifests with one counter can't both be tried. The agent doesn't download or stage an offer whose manifest SHA-256 its last result reports as rolled back. A rollover carries the old key's floor to its successor. Versions only move forward on a host (`DOWNGRADE_REFUSED`), and a release expires.

The server assigns each release the next counter of one sequence: the larger of its stored sequence and one more than the highest attempted counter any device reports (`highest_counter`). A restored server backup can only produce counters that hosts refuse until the sequence passes them, which the reported floors make happen at the next release: fail closed, then recover without a host login.

### Rotation by rollover

A rollover statement replaces one key with another:

```json
{"schema":"vectory.release-key-rollover.v1","from":"<64-hex fingerprint>","to":"vectory-release-key ed25519 <base64> <name>","issued_at":"2026-10-03T12:00:00Z"}
```

signed by the `from` key over `"vectory-release-key-rollover-v1\n" || <statement bytes>`, and delivered as `{"statement":"<base64>","signature":"<base64>"}`.

- A host accepts a statement only when `from` is a key it pins now. It then pins `to`, removes `from` and carries the counter floor over. A chain of at most 8 statements is followed in order. The successor's fingerprint is computed from the `to` key's bytes, by the agent and by the privileged step when it writes the pin, and the `to` key must pass the key rule above.
- A key can be replaced once. A conflict is a genuine fork: two statements from one currently pinned key naming **different** `to` keys, neither followed yet. That is evidence that someone else holds the key: the host stops accepting updates (`KEY_ROLLOVER_CONFLICT`) until it is re-pinned on the host, reports the two `to` fingerprints, and the review names them. Two statements naming the same `to` key are not a conflict. Once a host has followed `A → B`, `A` is no longer pinned, so any later statement from `A` is ignored, never a conflict: a server that relays old public statements can't freeze a fleet.
- Rotation stays within the custody kind. With *this server signs*, it is one Administrator action: the server generates the successor and signs the statement with the current key. With *a key kept offline*, the key holder runs `vectory release rollover` and an Administrator uploads the statement, which must verify against the current key.
- The server includes the statements a release's signer needs in each offer, and lists all of them in the public key bundle (`GET /agent/v1/release-keys`). Statements are public.

### Compromised keys

- **Before rollover, what stays manual.** A thief of a pinned key can sign builds and can also replace the key with their own on any host that sees their statement first. The team (1) revokes the key on the server, which stops offering anything signed by it and stops distributing its statements; (2) rolls over to a new key, which hosts that see only the team's statement follow, and hosts that also saw the thief's (a fork) refuse until re-pinned; and (3) for every host that pins only the stolen key or froze on the fork, runs the Upgrade agent command again with the new fingerprint, which replaces the pin set. That is one login per such host, and it cannot be avoided: nothing remote may change a host's trust except a key it already trusts. With custody *a key kept offline*, the stolen key reaches hosts only together with a compromised server or an Administrator session, because hosts fetch only from their own server and the server offers only releases built from its own catalog and started by an operator.
- **After rollover.** The old key is no longer pinned anywhere the statement reached; its signatures are refused there.
- **Server side.** Revoking a key marks it revoked, withdraws releases signed only by it, ends the rollouts that offer them, refuses new ones, and removes its statements from the bundle. Hosts that still pin it are listed on the settings page from their reports.

### Shared test vectors

`contracts/fixtures/agent-release/vectors.json`, generated by a reviewed script from fixed seeds and checked in. Each case gives the manifest bytes (base64), the signature file bytes, rollover statements, the host's pins and floors, the host's version and platform, the time, and the expected result: `valid` with the effective signer and new pins, or the refusal code. The Rust server and the Go agent both run every case and must give the same answer. Cases: valid single and double signatures; an unpinned key; a flipped manifest byte; a flipped signature byte; a signature without the prefix; the prefix of the rollover statement used on a manifest; a non-canonical `S`; an `R` that is the identity point; the eight small-order key encodings and the non-canonical ones; a `key` field naming a pinned key whose bytes don't verify the signature; duplicate key; unknown key; trailing data; a byte-order mark; an escaped surrogate; a non-ASCII byte; the numbers `1e2`, `7.0`, `-0`, `07` and 2^53; counter 0, at the floor, at the floor with a last result naming that manifest as rolled back (`RELEASE_ALREADY_TRIED`), and above 2^53−1; a pre-release version; a `major` jump on the `minor` track; expired; `issued_at` 25 hours ahead of the host's clock; `expires_at` before `issued_at`; uppercase hex; size 0 and over 128 MiB; two artifacts for one platform; a file name that doesn't match; a missing platform; a valid chain of two rollovers; a rollover from an unpinned key; a rollover whose `to` key is of small order; two rollovers from one key to the same successor (followed); two to different successors (`KEY_ROLLOVER_CONFLICT`); a statement from a key the host already rolled over from (ignored). Key bundle cases for setup: a `fingerprint` field that disagrees with its key (`RELEASE_KEY_INVALID`, nothing pinned), and an entry found only by its recomputed fingerprint.

## 3. Host consent and the local commands

### Where consent lives, and who can write it

| | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Policy (written by root, read by the agent) | `/etc/vectory/updates/policy.json` | `/Library/Application Support/Vectory/updates/policy.json` | `%ProgramData%\Vectory\updates\policy.json` |
| Privileged step's own state | `/var/lib/vectory-update/` | `/Library/Application Support/Vectory/update-state/` | `%ProgramData%\Vectory\update-state\` |

The policy is not in `settings.json`. `settings.json` belongs to the service account (`vectory allow` and `install` keep its owner and mode), so a compromised Vector process could edit it, which the threat model accepts for allowances. For updates it would turn the service account into root. The policy directory is `root:root 0755` with the file `0644` (Windows: owner Administrators, protected DACL, SYSTEM and Administrators full control, `NT SERVICE\Vectory` read). A missing file means off.

**The path check.** Every reader of the policy, and the privileged step for the install directory and its own directory, uses one primitive, `openRootOwned` (new, in `agent/internal/agent/rootpath_unix.go` and `rootpath_windows.go`). On Linux and macOS it opens `/`, then each component with `openat(O_NOFOLLOW|O_DIRECTORY|O_CLOEXEC)` (the last with `O_NOFOLLOW|O_NONBLOCK` when it is a file), and `fstat`s each handle: every directory must have `st_uid == 0` and `st_mode & 0o022 == 0`, and a final file must be a regular file with the same two properties. It returns the open handles, and every later use goes through them: reads through the file handle, and the swap's `linkat` and `renameat` relative to the opened install directory, never a path resolved again, so no component can change between the check and the use. On Windows it opens each component by handle, refuses a reparse point or an alias (`GetFinalPathNameByHandle` must equal the path asked for), and reads the owner and the DACL from the handle. The directory that holds the file, and the file itself, are refused when any account other than SYSTEM, Administrators or TrustedInstaller holds a right to change them. A directory above that one may let other accounts create new entries, as a default Windows install does in ProgramData and in a drive root, but none may delete, rename or take over what it holds (delete, delete-child, `WRITE_DAC`, `WRITE_OWNER`, generic write and generic all are refused there): a new name cannot replace one that exists, and every name on the path exists and is checked through its own handle. A refusal is `UNTRUSTED_LOCATION`. The existing `openPrivateFile` (`platform_unix.go`) walks without following links but checks only the final file, which is right for private files and not enough here.

```json
{"schema":"vectory.update-policy.v1","consent":"auto","track":"patch","windows":["Mon-Fri 02:00-04:00"],"paused":false,"keys":[{"public_key":"vectory-release-key ed25519 <base64> team","pinned_at":"2026-10-03T12:00:00Z"}],"updated_at":"2026-10-03T12:00:00Z"}
```

Counter floors, the last result and the journal are not in it: they belong to the privileged step's state ([section 6](#paths-accounts-and-what-runs)).

### Consent levels

| Level | What the host does with an offer |
| --- | --- |
| `off` (no policy, or the default of a command without the flags) | Nothing. It doesn't download, stage or report anything but `off`. |
| `auto` (recommended) | Downloads and stages when the rollout reaches the device, then applies, inside its window if it has one. |
| `ask` | Downloads and stages, then waits for someone on the host to run `sudo vectory update apply`. |

`paused: true` keeps the level and stops every download and apply until `vectory update resume`. The local emergency pause (`vectory pause`) also defers updates: it means "change nothing on this host".

**Track.** `patch` (same major and minor as the running build, the default the dashboard writes) or `minor` (same major). A `major` track is refused, by setup and by the policy reader: "This release offers patch and minor tracks. Upgrade to a new major version by hand." A version that is not newer than the running one is always refused: hosts never downgrade remotely. Going back is either the automatic rollback or a local upgrade by hand.

**Window.** `--update-window` takes `DAYS HH:MM-HH:MM [UTC]`, repeatable, at most 7: `DAYS` is `daily`, a day (`Mon`), a range (`Mon-Fri`) or a list (`Sat,Sun`); times are 24-hour, in the host's local time unless `UTC` follows; a window that ends before it starts crosses midnight and belongs to the day it starts. Daylight-saving changes follow the host's time zone. A window gates the start of an apply; a trial that started inside it may finish after it.

### The command carries consent

`vectory setup` gains four flags, which the installer already passes through (`sh vectory-install.sh ... --updates auto`):

```sh
sudo sh vectory-install.sh --name edge-01 --create-user \
  --updates auto --update-key-sha256 3f9a1c0277de9b41…(64 hex) \
  --update-track patch --update-window 'Mon-Fri 02:00-04:00'
```

- `--updates auto|ask|off`. Omitted: the host keeps what it has (nothing, on a fresh install). `off` withdraws consent and removes the privileged step's units.
- `--update-key-sha256 HEX` (required with `auto` or `ask`, repeatable up to 4). Setup fetches the server's public key bundle over the TLS connection it has already verified (`GET /agent/v1/release-keys`, no token, no credential). It ignores the bundle's own `fingerprint` fields for matching: it computes the SHA-256 of each entry's decoded 32-byte key, applies the key rule of section 2, and pins the entry whose computed fingerprint equals the operator's value. An entry whose `fingerprint` field disagrees with its computed value makes the bundle malformed (`RELEASE_KEY_INVALID`, nothing pinned). A fingerprint no entry has fails with the fingerprints the server offers and nothing changed, like `--ca-sha256` today. Passing the flag again replaces the pin set and clears a rollover freeze: that is how a host is re-pinned after a stolen key.
- `--update-track patch|minor` (default `patch`) and `--update-window SPEC` (repeatable; none means any time).

Setup checks every update flag before it changes anything, and refuses consent where updates can't work, with the reason and no other effect: a package-managed agent, `--service none` or no service manager, an install path others can write, a server whose updates are off. With consent, setup writes the policy before the service starts, so the first check-in already reports it, and once the service is registered it copies the running agent into the privileged step's directory and installs its units ([section 6](#what-starts-the-privileged-step)): the step checks the registered service, so it can't be installed before the service exists. Without update flags, setup doesn't touch any of it. On a host that already agreed, `--update-key-sha256`, `--update-track` and `--update-window` given without `--updates` change only the part they name: the level, the parts not named, a pause and the counter floors stay as they are. That is what the dashboard's fix commands carry, so a command never restates a consent that a device's own report claims. The generated Add device and Upgrade agent commands are the only place a team normally sees these flags; a host operator can type the same command.

A host enrolled without consent (or before the team turned updates on) opts in with one run of the Upgrade agent command, which the dashboard generates with the flags. 0.1.0 is the first release with the updater, so there is nothing older to migrate.

### `vectory update`

One command group, run as root (Administrator on Windows), with `--json` on each:

| Command | What it does |
| --- | --- |
| `vectory update status` | Reads only. The level, track, windows (and whether one is open now, and the next), pinned keys by short ID, paused, eligibility with its reason, the staged build, an update in progress, the last result. |
| `vectory update apply` | `ask` hosts: applies the staged build now, in the foreground, through the same privileged step, printing each step. Before it starts it shows what the agent last reported about the offer and how old that is. When that report says the offer was withdrawn (a paused or cancelled rollout, Stop all updates) or is older than five minutes, it refuses unless `--force` is given, and then asks for confirmation on a terminal. This check is advice to the person: the agent's report is a file the service account writes, never evidence of freshness. What authorizes the install is the signed manifest, the pins and the host's policy, checked again by the step. |
| `vectory update pause` / `resume` | Sets or clears `paused` in the policy. Takes effect at the agent's next check-in; no restart. |
| `vectory update off` | Withdraws consent, discards a staged build, removes the privileged step's units. Refused while a trial runs ("an update is being tried; it ends by <time>"). Pins are kept; the Upgrade agent command with `--updates` turns it on again. |

None needs the agent stopped: the policy is read fresh at each check-in and by every run of the privileged step, unlike `settings.json`, which the agent reads at start.

### What status and doctor print

`vectory status` gains one line:

```text
Updates      automatic · patch releases · Mon–Fri 02:00–04:00 (next in 6 h) · key 3f9a1c0277de9b41
Updates      staged 0.1.1, waiting for you: sudo vectory update apply
Updates      0.1.0 → 0.1.1 at 02:14 · first check-in 2.1 s after restart
Updates      rolled back from 0.1.1 at 02:19: it didn't check in within 5 minutes; this host won't try 0.1.1 again
Updates      off on this host
```

`vectory doctor` adds an Updates check: the policy's location and owners, the privileged step's units enabled and its last run under two minutes ago, its copy of the agent equal to the committed build, the install path's owners, the package and service checks, free space for two copies of the agent, and the last result. Every fix it prints goes through `CommandFor` and `ShellQuote` (`status.go`), so a state directory with a space or a quote stays one argument.

### Restricted and full mode

Consent is independent of the capability policy. It never changes the mode, allowances, secret bindings or `settings.json`, and the new build reads the same settings the old one did. Restricted mode keeps refusing every remote way to change a host's policy; update consent is one more host allowance, written only by local commands run as root.

## 4. Protocol

All of it is additive. A server lists the feature `agent_update` in the manifest's `features` only while updates are on; an agent sends the member below only after a verified manifest lists it, and reads offers only from such manifests.

### What the agent reports

Heartbeat member `agent_update`, every check-in while the feature is listed:

```json
{"consent":"auto","paused":false,"track":"patch","windows":["Mon-Fri 02:00-04:00"],"window_open":false,"keys":["<64 hex>"],"highest_counter":6,"eligibility":"eligible","service_definition":1,
 "state":"staged","release":"<manifest sha256>","code":null,"rollover_conflict":null,
 "last":{"release":"<manifest sha256>","outcome":"committed","code":null,"at":"2026-10-03T02:14:09Z","from_version":"0.1.0"}}
```

`state` is `idle`, `downloading`, `staged`, `waiting_for_host`, `waiting_for_window`, `applying`, `trial`, `refused` or `failed`; `release` names what the state is about; `code` is one of the codes below; `highest_counter` is the highest counter the host attempted, from the step's status file; `rollover_conflict` is null or `{"from":"<64 hex>","to":["<64 hex>","<64 hex>"]}`, the two successors of a fork; `last` is the privileged step's latest result, read from its status file. Strings are allowlisted, lists bounded (4 keys, 7 windows of at most 40 printable characters), unknown keys refused. The bounds and a set of accepted and refused members live in one shared fixture, `contracts/fixtures/agent-release/report.json`, which the server's parser test and the agent's report test both read, as `vector-catalog/fixtures/report-bounds.json` is shared today. A malformed member is a `400` that changes nothing. On a `400` the agent leaves `agent_update` out first, before any other optional report (`exchange` in `reconcile.go` drops them one step at a time), and keeps it out for the rest of the process, so this member can never take a device off the control plane.

The heartbeat's existing `agent_version`, `agent_sha256` and `boot_id` (a fresh value for every agent process) are what the server compares.

### What the server offers

Manifest member `agent_update`, only for a device released into a stage of an active rollout:

```json
{"rollout_id":"<uuid>","release_id":"<uuid>","manifest":"<base64 of release.json>","signatures":"<base64 of release.json.sig>","rollovers":[{"statement":"<base64>","signature":"<base64>"}],
 "artifact":{"sha256":"<64 hex>","size":15204352,"path":"/agent/v1/agent-releases/<sha256>"}}
```

The server's manifest signature makes the offer fresh and addressed to this device; it authorizes no code. The agent derives everything it acts on from `manifest` after verifying `signatures` (and `rollovers`) against its own pins, and requires `artifact` to equal the manifest's entry for its own platform and `path` to be exactly `/agent/v1/agent-releases/` followed by that digest. Older agents ignore the member (`Manifest` in `types.go` doesn't decode it), so its presence never affects their generations or identity checks.

### The download

`GET /agent/v1/agent-releases/{sha256}` on the agent listener, mutual TLS, authenticated like `artifact` in `device.rs`. It answers only when updates are on, not stopped, and the device holds a current offer whose artifact has that digest. It streams the store's file with `Content-Length` and `Cache-Control: no-store`, re-hashing as it goes and withholding the last chunk on a mismatch (`stream` in `install.rs`), with a 20-second stall limit and a 5-minute deadline, never a redirect. One transfer per device, 16 per server, 6 requests an hour per device. No `Range` and no resume: a build is at most 128 MiB and usually about 15; a cut-off transfer leaves nothing under a final name and starts over at the next check-in, which keeps the device's only partial state a temporary file. The agent bounds the stream, and the privileged step its copy, by a new constant `MaxAgentBuild` (128 MiB); `MaxArtifact` (1 MiB) keeps bounding pipeline artifacts and the signed manifest that carries the offer.

### The key bundle

`GET /agent/v1/release-keys`, no client certificate, rate-limited like `install.sh`: `{"schema":"vectory.release-keys.v1","keys":[{"public_key","fingerprint","state":"current"|"retired"}],"rollovers":[...]}`. `404` while updates are off. Public keys and statements are public. Custody is not in it: hosts need none to verify, setup pins by the fingerprint it computes, and an unauthenticated peer of the agent listener should not learn whether a server compromise alone would be enough. Custody is shown only on the authenticated `GET /api/v1/agent-release-keys`.

### Codes

What the agent reports (`code`), and what it does:

| Code | Meaning | The agent |
| --- | --- | --- |
| `UPDATES_OFF`, `UPDATES_PAUSED` | Host level `off`, or paused | Ignores offers |
| `KEY_NOT_PINNED`, `SIGNATURE_INVALID`, `MANIFEST_INVALID`, `MANIFEST_EXPIRED` | No pinned key verifies it, or it breaks a manifest rule | Refuses, never downloads |
| `KEY_ROLLOVER_CONFLICT` | Two statements from one pinned key name different successors | Refuses every update until re-pinned; reports both successors |
| `RELEASE_ALREADY_TRIED` | This release was tried here and rolled back; its counter is at or below the host's floor | Refuses, never downloads it again |
| `COUNTER_REPLAYED`, `DOWNGRADE_REFUSED`, `VERSION_NOT_ON_TRACK`, `AGENT_TOO_OLD`, `ALREADY_RUNNING` | Host policy refuses this release | Refuses |
| `PLATFORM_NOT_IN_RELEASE`, `PACKAGE_MANAGED`, `NO_SERVICE`, `UNTRUSTED_LOCATION`, `READ_ONLY`, `HELPER_NOT_RUNNING`, `SERVICE_DEFINITION_OUTDATED` | This host can't take it | Refuses |
| `DOWNLOAD_FAILED`, `ARTIFACT_MISMATCH`, `DISK_FULL` | The transfer failed, or the bytes don't match | Removes the partial file, retries at the next check-in within the usual backoff; after three failures for one release, reports `failed` |
| `PROBE_FAILED` | The staged build, run with `version --json`, didn't report the manifest's version and this platform | The step refuses before stopping anything; reported as `failed` |
| `START_FAILED`, `NO_CHECK_IN`, `UNHEALTHY`, `INTERRUPTED` | The privileged step rolled back ([section 7](#7-rollback)) | Reports the result |
| `BINARY_CHANGED` | The executable was replaced outside the step before it swapped | Reports it; the request is dropped |
| `ROLLBACK_UNHEALTHY` | Rolled back, but the previous build isn't healthy either | Reports it when it can |

Server answers on the download: `403` (no current offer for this device and digest) and `404` drop the staged attempt until the next manifest says otherwise; `429 RATE_LIMITED` and `503 CAPACITY_BUSY` are waited out with `Retry-After`; anything else counts as `DOWNLOAD_FAILED`.

### Old agents and old servers

- **Old agent, new server.** No `agent_update` report: the review says `AGENT_TOO_OLD` and it is never offered anything. (0.1.0 is the first release with the updater, so this concerns development builds only.)
- **New agent, old server.** No feature: nothing reported, nothing offered.
- **New agent, server with updates off.** No feature listed: identical to today.
- **Wake-ups** stay content-free: releasing a stage answers the parked waits of the released devices (`wake::ask`, as device checks do), and the offer arrives in the signed manifest of the check-in that follows.

## 5. Server

### The setting and custody

Settings → Agent updates (Administrators) holds one row, `agent_update_settings`: `enabled` (default 0), `custody` (`server` or `offline`), the current key, `stopped` with who, when and why, the counter sequence, and a revision. Turning updates on requires the custody choice and the Administrator's password; the custody can't change while updates are on (`409 CUSTODY_LOCKED`). Turning them off is refused while a rollout runs (`409 AGENT_UPDATE_ROLLOUTS_ACTIVE`: cancel them, or use Stop all updates) and keeps the key. Turning them on again with the other custody creates or registers a new key, which hosts pin only through the Upgrade agent command; the dialog says so and lists the hosts that pin the old key.

**Stop all updates** (Operators and Administrators) cancels every active or paused update rollout in one transaction, withdraws every offer, makes the download route refuse, answers the parked waits of every device with an offer, and refuses new rollouts until an Administrator clears it. Clearing resumes nothing. A device that already downloaded a build can still start applying it until its next check-in reaches it, seconds for an agent holding a wait, at most a check-in interval and 30 seconds otherwise; the confirmation says so.

### Releases come from the server's own catalog

The unit of release is a build this server ships. After a server upgrade, the bundled catalog (or the operator mirror, `install::catalog`) lists newer agents, and the Agent updates page says "Agent 0.1.1 is in this server's catalog". **Roll out agent 0.1.1** (Administrators) prepares the release:

1. Takes every catalog entry with that version, one per platform, and copies each file, re-hashed, into the release store `artifacts/agent-releases/<sha256>` (so a later server upgrade, which replaces the catalog, never changes what a running rollout serves, and backups keep it: `deploy/backup.py` copies `artifacts/`).
2. Builds `release.json` with the next counter ([section 2](#counters-and-replay)), `issued_at` now and `expires_at` 180 days later, and stores its exact bytes.
3. With *this server signs*, signs it at once. With *a key kept offline*, the release waits for a signature: the page offers the manifest file to download and the exact command (`vectory release sign --key … --checksums SHA256SUMS release.json`), and accepts the uploaded `release.json.sig`, which must verify against the current key.

A release is `awaiting_signature`, `ready` or `withdrawn`. Operators and Administrators start rollouts of ready releases.

### Data model (migrations 0136 to 0138)

- `0136_agent_update_settings.sql`: `agent_update_settings` (the single row above) and `agent_release_keys` (fingerprint, public key line, custody, state `current`/`retired`/`revoked`, created and retired or revoked by and at, the rollover statement that introduced it).
- `0137_agent_releases.sql`: `agent_releases` (id, version, counter unique, the manifest bytes and their SHA-256, the signature file bytes or null, issued and expiry times, state, prepared by and at, withdrawn by and at) and `agent_release_artifacts` (release, os, arch, file, size, sha256).
- `0138_agent_update_rollouts.sql`: `agent_update_rollouts` (id, name, release, the selector as given, `canary_size`, `batch_size`, `observation_seconds`, `failure_threshold`, status `active`/`paused`/`completed`/`cancelled`/`failed`, failure reason, observation start, timestamps and actors, revision) and `agent_update_targets` (rollout, device, the device's name then, stage number, state, code, `from_version`, `from_sha256`, `boot_id_before`, released, updated and verified times), with an index on device and a unique partial index allowing one non-terminal target per device across all rollouts.

Update rollouts are a separate object with separate tables. They never touch `records` deployments, desired generations, policy generations or `deployment_targets`, so a pipeline rollout and an update rollout can't gate, supersede or roll back each other.

### Per-device states

| State | Entered when | Next |
| --- | --- | --- |
| `pending` | Created, or an unstarted offer was withdrawn by a pause | `offered`, `skipped`, `cancelled` |
| `offered` | Released into a stage; the next manifest carries the offer | `downloading`, `staged`, `refused`, `failed` |
| `downloading`, `staged` | Reported by the agent | `waiting_for_host`, `waiting_for_window`, `applying`, `refused`, `failed` |
| `waiting_for_host` | `ask` host staged it | `applying`, `cancelled` |
| `waiting_for_window` | `auto` host staged it outside its window | `applying`, `cancelled` |
| `applying` | The privileged step reported it started | `restarted`, `rolled_back`, `failed` |
| `restarted` | A check-in with the offered SHA-256, the release's version and a `boot_id` other than `boot_id_before` | `verified`, `rolled_back` |
| `verified` | That build reports `last.outcome: committed` for this release in a check-in | terminal |
| `rolled_back`, `refused`, `failed` | Reported, with the code | terminal |
| `cancelled` | Cancel or Stop all updates reached it before it applied | terminal |
| `skipped` | It never became releasable (offline, or no longer eligible) before the rollout finished, or stayed silent for 60 minutes while offered | terminal |

A device silent for 30 minutes after `applying` or `restarted` becomes `failed` with `NO_REPORT`: a build that can't check in would have been rolled back and reported by the previous one by then. Transitions only move forward, a stale report never moves a target back, and a report for another release changes nothing.

### Stages, gates and the threshold

- Every update rollout has a canary: `canary_size` 1 to 100 (default 1), `batch_size` 1 to 50 (default 10), `observation_seconds` 60 to 86,400 (default 300), `failure_threshold` 0 to 100 (default 0), and optional `canary_device_ids` with the rules of pipeline rollouts (`rollout.canary_device_ids`). There is no all-at-once form.
- A stage releases only devices that checked in within three of their intervals, report `eligibility: eligible`, aren't paused on the host, and run no other update. Unless the operator named the canary, it prefers `auto` devices whose window is open or absent, by the readiness order `canary_choice` uses. A device not releasable now stays `pending` for a later stage. The canary's result is what its devices report; the review says so, and naming canary devices the team trusts is the way to rely on it.
- A stage is done when every released device is terminal or waiting on its host (`waiting_for_host`, `waiting_for_window`), and the canary needs at least one `verified` device. Then the observation period runs: every verified device must keep checking in on the new build; a device that falls back or goes silent restarts the observation. An updated device on which a data-plane issue opens during the observation (`DATA_PLANE_*`, [Data-plane health](../../contracts/CONTRACT.md#data-plane-health)) counts as a failure, as `canary_gate::degraded` counts it for pipelines: a build that starts and checks in but stops Vector delivering is caught by the gate, not only by its health check.
- `rolled_back` and `failed` count toward the threshold, with the degraded devices above; `refused`, `skipped` and `cancelled` don't (the review should have caught a refusal, and the page lists them). Above the threshold the rollout is `failed`, its unstarted offers are withdrawn (`cancelled`), and devices already applying finish their trial.
- The rollout completes when no device is pending, every released device is terminal or waiting, and the last observation passed; devices still waiting keep their offer until they apply or the rollout is cancelled.

The scheduler tick that already runs every two seconds under the writer lock (`rollout::tick`) calls an update step after the pipeline step, in the same transaction.

### Pause, resume, cancel

- **Pause** stops releasing and withdraws every offer not yet applying: those targets return to `pending`, and agents discard what they staged. Devices already applying finish.
- **Resume** restarts the observation of the current stage and releases again through the same gates.
- **Cancel** withdraws unstarted offers (`cancelled`) and ends the rollout. A cancelled or failed rollout is never resumed; a new one is reviewed.

### Deferral

The agent, not the server, knows when the host is busy. It doesn't stage or apply while a configuration apply is in progress or journaled, while a device check runs, while the host is paused (`vectory pause` or `vectory update pause`), or while the privileged step reports a trial. The privileged step serializes on its own lock and refuses a second request until the first ends.

### The review

`POST /api/v1/agent-update-rollouts/preview` resolves the selector (devices, groups, exclusions, the shared `rollout::select`) to a fixed set of device IDs and returns, from each device's latest report and the release:

- **Will update:** devices eligible now, with the level and window each applies under.
- **Won't update, with the reason:** updates off on the host (`UPDATES_OFF`: "Run the Upgrade agent command with updates on, once"), the host's track or key refuses this release (`VERSION_NOT_ON_TRACK`, `KEY_NOT_PINNED`, `KEY_ROLLOVER_CONFLICT` with the two successors, `COUNTER_REPLAYED`), this release already rolled back there (`RELEASE_ALREADY_TRIED`: "edge-02 tried 0.1.1 and rolled back; it takes the next release"), already on this build or newer (`ALREADY_RUNNING`, `DOWNGRADE_REFUSED`), installed from a package (`PACKAGE_MANAGED`), runs in the foreground without a service (`NO_SERVICE`), platform not in this release or not supported (`PLATFORM_NOT_IN_RELEASE`), agent too old (`AGENT_TOO_OLD`: no report, or below `min_from`), install path or file system unusable (`UNTRUSTED_LOCATION`, `READ_ONLY`), the privileged step not running (`HELPER_NOT_RUNNING`), an older service definition (`SERVICE_DEFINITION_OUTDATED`), in another update rollout (`IN_ANOTHER_UPDATE`), revoked.
- **Warnings:** offline now (it updates if it checks in while the rollout runs), waits for a person (`ask`), waits for a window (with the next one), paused on the host.

Each reason carries the host command that would change it when one exists, built like the Upgrade agent command for that device. A `review_token` binds the release, the rollout settings and the exact will-update and won't-update sets; creation rechecks it in the writer transaction (`409 UPDATE_REVIEW_CHANGED`). A review with nobody to update is `409 NOTHING_TO_UPDATE`.

### Roles

| Action | Roles |
| --- | --- |
| See the settings, keys, releases, rollouts and every device's update state | Every signed-in role |
| Turn updates on (choosing custody) or off, rotate the server's key, upload a rollover statement for the offline key, revoke a key | Administrator, with password |
| Prepare a release (and with *this server signs*, sign it), upload a signature, withdraw a release | Administrator |
| Preview, start, pause, resume, cancel an update rollout | Operator, Administrator |
| Stop all updates | Operator, Administrator |
| Clear Stop all updates | Administrator |

Every mutation needs CSRF and is authorized again inside the writer transaction. Creation accepts an optional `request_id` with the deployment request ledger's replay rules (`deployment_requests.rs`).

### Audit, notifications and issues

- **Audit:** `agent_update.enable` (with the custody and the key's fingerprint), `agent_update.disable`, `agent_update.stop`, `agent_update.stop_clear`, `agent_release_key.rotate`, `agent_release_key.rollover`, `agent_release_key.revoke`, `agent_release.prepare`, `agent_release.sign`, `agent_release.signature_upload` (outcome `success` or `refused` with the reason), `agent_release.withdraw`, `agent_update_rollout.create`, `.pause`, `.resume`, `.cancel`, `.release` (per stage, the device IDs), `.gate` (`failed` or `completed`), and per device `device.agent_update` for `verified`, `rolled_back`, `failed` and `refused`, under the per-device limit of four rows a minute (`DEVICE_AUDIT_ROWS_PER_MINUTE`). Details hold versions, digests, counters, fingerprints and codes, never key material.
- **Notifications:** new events `agent_update.failed` (a rollout stopped at its threshold), `agent_update.rolled_back` (a device went back to its previous build), `agent_update.stopped` (Stop all updates) and `agent_update.key_changed` (updates turned on or off, a key rotated, rolled over or revoked: what decides which key new hosts pin), read from the audit trail like `rollout.failed` (`notifier.rs`), with the same rules, quiet hours and digests.
- **Issues:** `AGENT_UPDATE_ROLLED_BACK` and `AGENT_UPDATE_FAILED`, stage `agent_update`, keyed by device, release version and code. They resolve as `verified` only when that device verifies a later update, and as `revoked` with the device; verifying a pipeline or removing its assignment doesn't resolve them (`issues::resolve_device` skips `AGENT_UPDATE_*` for every reason but `revoked`, as it skips `DATA_PLANE_*` for `verified`).

### Retention and bounds

At most 20 releases that are not withdrawn and 2 GiB in the store by default (`VECTORY_AGENT_RELEASE_STORAGE_BYTES`); preparing beyond it is `507 RELEASE_STORAGE_FULL`. A withdrawn release's files are deleted once no rollout references them; its row and manifest bytes stay for the audit trail. Update rollouts and targets are kept like deployments. A rollout targets at most 10,000 devices.

### Routes

Under `/api/v1` (exact shapes in the contract): `GET /agent-updates` (settings, custody, current key, stop state, the fleet's agent versions and update levels, builds in the catalog newer than the fleet), `PUT /agent-updates/settings`, `POST /agent-updates/stop`, `POST /agent-updates/stop/clear`, `GET /agent-release-keys`, `POST /agent-release-keys/rotate`, `POST /agent-release-keys/rollover`, `POST /agent-release-keys/{fingerprint}/revoke`, `GET /agent-releases`, `POST /agent-releases` (`{version}`), `GET /agent-releases/{id}`, `GET /agent-releases/{id}/manifest` (the exact bytes), `PUT /agent-releases/{id}/signature`, `POST /agent-releases/{id}/withdraw`, `GET /agent-update-rollouts`, `POST /agent-update-rollouts/preview`, `POST /agent-update-rollouts`, `GET /agent-update-rollouts/{id}`, `GET /agent-update-rollouts/{id}/targets`, `POST /agent-update-rollouts/{id}/pause|resume|cancel`. On the agent listener: `GET /agent/v1/agent-releases/{sha256}` and `GET /agent/v1/release-keys`. The Device projection gains a read-only `agent_update`.

New error codes: `AGENT_UPDATES_OFF`, `AGENT_UPDATES_STOPPED`, `AGENT_UPDATE_ROLLOUTS_ACTIVE`, `CUSTODY_REQUIRED`, `CUSTODY_LOCKED`, `RELEASE_KEY_INVALID`, `RELEASE_KEY_IN_USE`, `RELEASE_SIGNATURE_INVALID`, `RELEASE_NOT_IN_CATALOG`, `RELEASE_EXISTS`, `RELEASE_NOT_READY`, `RELEASE_STORAGE_FULL`, `UPDATE_ROLLOUT_OVERLAP`, `UPDATE_REVIEW_CHANGED`, `NOTHING_TO_UPDATE`.

### Reused and new

Reused as they are: `rollout::select` for selectors, the readiness order of `canary_choice`, the observation and threshold semantics of `rollout::advance_with` (reimplemented over the new tables, not shared), `install::catalog` and `install::stream`, `wake::ask`, the deployment request ledger, `db::audit`, the notifier's audit cursor, the sealing key and `crypto` envelopes. New: the setting, keys, releases and their store, update rollouts and targets, the two agent-listener routes, the heartbeat member and manifest member, the review.

## 6. Apply on the host

### Paths, accounts and what runs

| | Linux (systemd) | macOS (launchd) | Windows (SCM) |
| --- | --- | --- | --- |
| Agent service, account | `vectory.service`, `vectory` | `io.vectory.agent`, `_vectory` | `Vectory`, `NT SERVICE\Vectory` |
| Installed agent | `/usr/local/bin/vectory` (or `--install-dir`), root `0755` | `/usr/local/bin/vectory` | `C:\Program Files\Vectory\vectory.exe` |
| What the service account writes | `<state>/updates/`: the download, the request, `health.json` | same | same |
| Privileged step | `vectory-update.timer` (at boot and every 30 s) starts `vectory-update.service` (`Type=oneshot`, root) | `/Library/LaunchDaemons/io.vectory.update.plist` (`RunAtLoad`, `StartInterval` 30, root) | `VectoryUpdate` service (LocalSystem, automatic delayed start), looping every 30 s |
| It runs | `/var/lib/vectory-update/private/helper/vectory update-helper --state-dir <dir>` | the same under `update-state/private/helper/` | `update-state\private\helper\vectory.exe update-helper` |
| Its directory | `/var/lib/vectory-update/` (root `0755`) holds `status.json` (`0644`, what the agent reads), `probe/` (root `0755`, the one place the service account runs a staged build from) and `private/` (root `0700`: the journal, counter floors, the installed record, staging, the helper copy) | same layout | the same layout; `private\` is SYSTEM and Administrators only, `status.json` also readable by the service SID, `probe\` writable by SYSTEM and Administrators only |

The helper is a copy of the last committed build, placed by setup when the host consents and replaced only after a commit. It reads nothing the service account wrote without copying it first. It does no network I/O.

### What starts the privileged step

A timer and its equivalents, not a file watch: every 30 seconds and at boot, the step runs, finds its journal idle and no request, and exits in milliseconds. Polling needs no inotify or launchd watch semantics, survives any crash between runs, and gives boot-time recovery the same entry point as everything else. An update waits at most 30 seconds for it. On Windows the agent gets no new service right: the helper service polls.

### The privileged step's sandbox

`vectory-update.service` runs as root with a clean environment (no `Environment=`; the step passes `cleanEnvironment` to every process it starts) and these settings: `ProtectSystem=strict`, `ProtectHome=true`, `PrivateTmp=true`, `NoNewPrivileges=true`, `ProtectControlGroups=true`, `RestrictAddressFamilies=AF_UNIX` (it does no network I/O; `systemctl` reaches the service manager over a Unix socket), `SystemCallFilter=@system-service`, `ReadWritePaths=` the host's actual install directory (what `--install-dir` chose), `/var/lib/vectory-update` and the policy directory `/etc/vectory/updates` (for pins after a rollover), each written through `unitArg`, and `CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_CHOWN CAP_FOWNER CAP_DAC_OVERRIDE` (the probe runs as the service account; the step reads the service account's private directory and links files it doesn't own). A capability is added only when the native test shows the step needs it. A strict file system with the install directory writable is what lets the sandbox and the swap coexist: an install directory under `/usr` would be read-only otherwise, and every update would end `READ_ONLY`. The native Linux test proves the swap, the stop and start, and the rollback under exactly this unit, and `systemd-analyze verify` passes on it. The launchd daemon gets a clean environment and uses no network; the Windows service runs as LocalSystem with nothing added.

### The steps

The agent (service account), for an offer it accepts:

1. Verifies the manifest, signatures and rollovers against the root-owned policy's pins and its host policy (section 3), the counter floors and last result in the step's `status.json` (so a release this host already tried and rolled back is refused before any byte is downloaded), and its own eligibility.
2. Streams the artifact into `<state>/updates/incoming/<manifest sha256>/vectory.part`, counting and hashing, stops at the signed size, and renames it only when size and digest match. Writes `release.json`, `release.json.sig` and `rollovers.json` beside it, then `<state>/updates/request.json` naming the manifest and artifact digests.
3. Reports `staged`, then `waiting_for_host` or `waiting_for_window` or, once the helper's status says so, `applying`. When a later manifest no longer offers the release, it deletes the files, unless the helper already started.

The privileged step, for a request, with its journal (`journal.json`, written and synced before each step it names). Files named without a directory are in its `private/` directory:

1. **Lock and read.** Takes its lock. Reads the root-owned policy (path check, section 3). Consent `off` or paused: refuses the request and records why. `ask`: continues only inside `vectory update apply`. `auto` with windows: continues only while one is open.
2. **Copy.** Opens each file in `<state>/updates/` without following links, non-blocking, requires a regular file owned by the service account within its size bound (`MaxAgentBuild` for the build), and copies it into `private/staging/` while hashing. From here on nothing in the state directory is read.
3. **Verify.** The manifest, signatures and rollovers against the pins (the shared library); the counter against the attempted floors in `counters.json` and the last result (`RELEASE_ALREADY_TRIED`, `COUNTER_REPLAYED`); the version against the running build (`installed.json`, or the installed file's digest and its `version --json` when that record is missing or stale); the track, `min_from`, `service_definition`, expiry and `issued_at` by the system clock; the artifact's size and SHA-256 against the manifest entry for this platform.
4. **Probe.** Copies the verified build into `probe/` (root `0755`, the file `0755`, writable by nobody but root), checks its digest there, and runs it from there as the service account (on Windows, as LocalSystem, from the protected `probe\` directory): `version --json`, a 10-second limit, output bounded. It must print the manifest's version and this host's OS and architecture; otherwise `PROBE_FAILED`, and nothing else happens. Never from `private/`, which the service account can't traverse, and never through a descriptor passed to `fexecve`. The probe copy is removed afterwards.
5. **Check the host.** `openRootOwned` ([section 3](#where-consent-lives-and-who-can-write-it)) opens the install directory and the executable and checks every component; the step keeps the directory's handle for the swap. The executable isn't package-managed; the registered service runs exactly this path for this state directory; there is room for two copies in the install directory's file system and in its own. The answer goes into `status.json` as the eligibility the agent reports.
6. **Stage beside the executable.** Creates `.vectory-update-<counter>` relative to the install directory's handle (`openat`), mode `0755` root, writes the build, syncs it, and hashes the file through that handle against the manifest once more.
7. **Journal `swapping`** (from and to digests and versions, the release, the time) and **raise the counter floor**: for each pinned key that signed the release, `counters.json` takes the release's counter, and both files are synced before anything stops. A rollback never lowers it. **Stop the service** through its manager; Vector drains as on any stop (up to its graceful limit).
8. **Swap, keeping the previous build.** On Linux and macOS, relative to the install directory's handle: `linkat` the current executable as `.vectory-previous` (a new link renamed over an older one with `renameat`), `renameat` the new file over the executable, sync the directory. On Windows, where a mapped executable can't be replaced, rename the current file to `vectory.exe.previous` and the new one to `vectory.exe`, both with `MOVEFILE_WRITE_THROUGH`, the journal naming both. Hash the final path once more. The previous build stays in the install directory, on the same file system, so going back is one rename that needs no space.
9. **Journal `trial`** with a deadline 5 minutes after the start, and **start the service**.
10. **Watch** every 2 seconds until healthy (below) or the deadline, or until the service manager reports the unit failed, or restarted it 3 times: then roll back (section 7).
11. **Commit.** Journal `committed`; `installed.json`; the rollovers into the policy's pins (the only write of pins outside setup, and only from statements a pinned key signed); `status.json` with the result; the helper copy replaced by the new build (written as `helper/vectory.next`, then renamed over the old copy, which the running helper keeps using until it exits; on Windows the running copy is renamed aside first; a copy that fails for lack of space is retried at the next run, and the old copy, itself a committed build, keeps serving); staging removed. The previous build stays beside the executable until the next update.

### Healthy

All of these, read by the step every 2 seconds:

- The service manager reports the agent's service active, with no restart since the trial began.
- `<state>/updates/health.json`, which every agent writes after each successful check-in, names the new build's SHA-256, a `boot_id` written after the trial began, and a check-in after the trial began: the server answered with a manifest the new build verified. (It also records what that manifest offered, `offer`: a manifest SHA-256 or null, which `vectory update apply` shows as advice.)
- If Vector was running under the previous build (its last `health.json` said so), the new build reports it running.

The check-in is the test that matters: a build that starts but can't reach the server, or can't verify what it answers, is not healthy. The server's own count requires more ([section 5](#per-device-states)): it marks the device updated only when it receives that build's check-in reporting the commit.

### Failures

| Event | Outcome |
| --- | --- |
| The privileged step crashes, or the host loses power, before `swapping` | Nothing changed and the floor wasn't raised; the next run removes staging and records `INTERRUPTED`; the server may offer again |
| The same release is offered again after it rolled back here, under any rollout | The floor was raised at `swapping`: the agent refuses it before downloading and the step refuses it at verification (`RELEASE_ALREADY_TRIED`); Vector isn't stopped again |
| Power loss during `swapping` | At boot the step reads the installed digest. The new build: continue at `trial`. The old build: remove the temporary file, record `INTERRUPTED`. No file (Windows between its two renames): rename the previous build back, record `INTERRUPTED`. A whole file is always there after a `rename(2)` |
| Power loss or a crash during `trial` | The next run continues the watch with a fresh deadline once (`interruptions` in the journal); a second interruption rolls back |
| The disk fills before the swap | The step stops, removes its temporary files and records `DISK_FULL`; the agent runs on |
| The disk fills during the trial | The new build can't record its check-in, so it isn't healthy, and the rollback (a rename of a file already in place) needs no space |
| The installed executable is neither the old nor the new build | Someone replaced it outside this step (an upgrade by hand while a request waited): the step records `BINARY_CHANGED`, leaves the file alone, takes it as the running build from then on, and drops the request |
| The new build can't start | systemd, launchd and the SCM restart it; three restarts or the deadline roll it back (`START_FAILED`) |
| It starts but never checks in | Rolled back at the deadline (`NO_CHECK_IN`) |
| A second offer during a trial | The server offers nothing to a device with an update in progress; the agent ignores offers while the step's status shows one; the step refuses a second request while its journal isn't idle |

### Who can't be updated, and how the agent knows

| Code | Detected by |
| --- | --- |
| `PACKAGE_MANAGED` | The executable (links resolved) is under `/usr/bin`, `/usr/sbin`, `/bin`, `/sbin`, `/usr/lib`, `/opt/homebrew` or `/usr/local/Cellar`, or `/var/lib/dpkg/info/vectory.list` lists it; on macOS the receipt `/var/db/receipts/com.vectory.agent.bom` exists; on Windows the MSI's upgrade code (`packaging/windows/vectory.wxs`) is registered under `HKLM\SOFTWARE\Classes\Installer\UpgradeCodes` |
| `NO_SERVICE` | `runningServiceManager` says `none`, or the registered unit, plist or service doesn't run this executable for this state directory |
| `UNTRUSTED_LOCATION` | A directory above the executable, the policy or the helper's state isn't root's, or is writable by others (Windows: the holder of the file or the file grants anyone but SYSTEM, Administrators or TrustedInstaller a right to change it, or a directory above grants anyone else delete, rename or ownership rights) |
| `READ_ONLY` | The step can't create a file in the install directory (`EROFS`, or the platform's equivalent) |
| `HELPER_NOT_RUNNING` | The step's `status.json` is more than two minutes old |
| `SERVICE_DEFINITION_OUTDATED` | The release needs a newer definition than this host's (`status.json`) |

### Service definitions

An update never writes a unit, plist or service definition. The executable path, the state directory and the arguments stay the same across releases. A release that needs a different definition says so in `service_definition`; hosts with an older one refuse it, the review shows them, and the Upgrade agent command (whose setup rewrites the definition, `ServiceInstallFor`, and the helper copy) moves them on, once. In 0.1 every definition is generation 1.

**The step's formats are fixed within a generation.** The on-disk formats of the journal, `counters.json`, `installed.json`, `status.json`, `request.json` and `health.json` don't change between builds of one `service_definition` generation. Any committed build of a generation can therefore drive any apply or rollback from any state another build of the same generation left, and a helper copy left one build behind by an interrupted commit stays correct. A format change needs a new generation.

### Platforms

All three use the same steps and the same journal; they differ in the service manager calls, the swap (one `renameat`, or two journaled renames on Windows) and the ACL checks. Linux is built and proven first, and macOS and Windows build on its journal and state. Each operating system ships updates only with its own green native proof ([section 9](#9-tests)) on a real service. One that isn't green when the release is cut reports `PLATFORM_NOT_IN_RELEASE` with "Hosts of this kind update by hand in this release", setup refuses `--updates` there, and the review lists those devices: a refusal, not a weaker mechanism. Linux must ship.

## 7. Rollback

**Triggers.** The trial deadline passes without health; the service manager reports the unit failed or restarted it three times; a second interruption of the same trial.

**Who.** The privileged step, running from the helper copy, which during a trial is still the previous committed build. It needs nothing from the new build: it stops the service, checks the digest of the previous build beside the executable against the journal, renames it back over the executable (on Windows: the new file aside, then the previous one into place, journaled), syncs, starts the service, and watches the previous build for the same health. The journal makes each of those steps repeatable after a crash.

**Report.** `status.json` and the journal record `rolled_back` with `START_FAILED`, `NO_CHECK_IN`, `UNHEALTHY` or `INTERRUPTED`, the versions and the time. The previous build reports it at its next check-in (`last`), the server sets the target `rolled_back`, opens `AGENT_UPDATE_ROLLED_BACK` on the device, counts it toward the threshold and writes `device.agent_update`; the notifier sends `agent_update.rolled_back`. The host never tries that release again, whoever offers it and under whatever rollout: its counter is at or below the floor raised at `swapping` (`RELEASE_ALREADY_TRIED`). A fix ships as a new release, with a higher counter.

**When the previous build is unusable too.** If the restored build isn't healthy within 5 minutes, the step records `ROLLBACK_UNHEALTHY` and stops: it leaves the previous build in place, because it is the last one that ran here, and the problem is likely outside the agent (the network, the server, the disk). It doesn't alternate between builds. The service manager keeps restarting the agent; `vectory update status` and `doctor` say what happened and what to check; the device page shows "Rolled back, and the previous build hasn't checked in either", from the last report it has, until the device checks in.

There is no remote rollback command and no remote downgrade. A build that is healthy but wrong is replaced by a newer release, rolled out the same way.

## 8. Dashboard and documentation

### Screens

- **Settings → Agent updates** (Administrators change; everyone reads). Off: "Agent updates are off. Devices run the agent they have until someone upgrades it on the host." **Turn on agent updates…** opens a dialog with the two custody options as descriptive cards, nothing preselected:
  - **This server signs.** "The server creates and keeps a release key. Anyone who administers this server, or holds a backup of it, can approve builds that every opted-in host installs. Simplest."
  - **A key kept offline.** "You create the key on another machine and sign each release there. The server never holds it. Each release waits for your signature."
  For the offline key: a field for the public key line, with its fingerprint computed and shown as it is pasted, and a refusal for a key that isn't valid. Then the password, and **Turn on agent updates**. On: the custody, "Fixed while updates are on", the current key's fingerprint (copy), "Hosts pin this key when you add or upgrade them", **Rotate key** (server custody) or **Upload rollover** (offline, the statement `vectory release rollover` wrote), the key history, hosts still pinning a retired or revoked key and hosts frozen on a fork, **Turn off**, and the stop state with **Clear the stop** for Administrators. Turning updates on again with the other custody says, before the password: "Hosts enrolled with the current key keep it. Each takes the new key only when you run its Upgrade agent command again."
- **Devices → Agent updates** (a tab beside Devices, Groups and Agent settings, shown while updates are on). Real counts only, from reports: agent versions in the fleet ("0.1.0 · 41 devices", "0.1.1 · 3"), how hosts take updates ("Automatic 30 · Ask 4 · Off 9 · Can't update 3", each opening the device list filtered), builds in the catalog newer than the fleet with **Roll out agent 0.1.1**, releases with their state ("Waiting for your signature" with the download and the command), update rollouts with the deployments list's progress bar, and **Stop all updates** (danger, confirmed with a reason).
- **The review dialog** (from Roll out, or New update rollout): release, targets (the device picker), canary, batch, observation, threshold; then the review: "Will update · 41" with the level and window of each, "Won't update · 9" grouped by reason with each device's name and its fix ("Updates are off on edge-3. Run the Upgrade agent command with updates on, once."), warnings; **Start update rollout**.
- **The rollout page**, in the deployments pages' language (`DeploymentRollout.tsx`: the progress bar, lanes per stage, the observation countdown): segments Updated, Trying the new build, Applying, Waiting for the host, Waiting for its window, Staged, Downloading, Offered, Pending, Rolled back, Failed, Refused, Skipped, Cancelled; the targets table with from and to version and the reason in words; **Pause**, **Resume**, **Cancel rollout**.
- **The device page** gains an Agent panel: version and build; "Updates: Automatic · patch releases · Mon–Fri 02:00–04:00 · key 3f9a1c02", or "Updates: Off on this host. Run the Upgrade agent command with updates on to let the dashboard update it."; the current state ("Staged 0.1.1 · waiting for someone on edge-02: sudo vectory update apply"); the last result ("Updated 0.1.0 → 0.1.1 · 3 Oct 02:14 · first check-in 2.1 s after restart", "Rolled back from 0.1.1: it didn't check in within 5 minutes. This device won't try 0.1.1 again; it takes the next release."); a fork ("Updates stopped on this host: two successors of key 3f9a1c02 were seen, 8b10e4d2 and c7aa9f31. Run the Upgrade agent command with the right key."). Never inferred: "Not reported" when the device sent nothing.
- **Add device**, while updates are on, gains a step "Agent updates" with three descriptive options and nothing preselected: **Automatic (recommended)** "Installs new agent builds when an update rollout reaches this device, inside the window you set", **Ask on the host** "Downloads and checks the build, then waits for someone to run sudo vectory update apply", **Off** "This host updates only by hand". Then the track (Patch releases, or Minor releases too) and an optional window. The command gains `--updates`, `--update-key-sha256`, `--update-track` and `--update-window`; nothing is added until an option is chosen. While updates are off the step doesn't exist.
- **Upgrade agent** shows the same step for a device that reports `off`, so one run opts it in; for an opted-in device it says "This device takes updates from the dashboard" and offers **Roll out to this device**.
- **Notifications** rules gain "An agent update rollout stopped", "A device rolled back an agent update", "All agent updates were stopped" and "The release key changed".
- **The Add device step** shows the key the command pins, its short ID and custody ("Pins key 3f9a1c02 · kept offline"), so the person who runs it sees what the host will trust.
- **Overview → Needs you** gains "Agent update rolled back on 2 devices".

### Documentation

New `docs/user/agent-updates.md` (turn updates on and choose custody; what a host consents to and how; roll out an agent build; sign a release offline; rotate a key; what happens on the host; rollback; pause, apply and turn off on a host; a stolen key). Changes: `agents.md` (Upgrade the agent, Upgrade many devices now point to it), `installation.md` and `cli.md` (the setup flags, `vectory update`, `vectory release`), `security.md` (the guarantee "devices only run agent builds their host's pinned key signed", the trust boundary of release key holders, "pinning a key trusts its holder with root on that host", and "Releases aren't signed yet" reworded: update releases are, catalog downloads still aren't), `troubleshooting.md` (a host refuses an update, an update rolled back, the privileged step isn't running), `notifications.md`, `administer.md` (custody, rotation, backups contain the sealed key with server custody), `glossary.md`, `whats-new.md`, `CHANGELOG.md`. Repository: `docs/security/THREAT-MODEL.md` (an Agent updates section with this record's table), `docs/security/OPEN-FINDINGS.md` (the open risks below), `docs/product-specification.md` (section 8: an agent policy still can't update the agent; agent updates are a separate, host-consented, signed path; Vector is never updated), `docs/ROADMAP.md`, `docs/internal/RELEASE-0.1.md` (gate 8), `docs/internal/CI.md`, `docs/internal/REQUIREMENTS.md`, `packaging/README.md`.

## 9. Tests

- **Shared vectors** (section 2) in a Rust test and a Go test, both reading `contracts/fixtures/agent-release/vectors.json`, plus a generator check that the file is what its script produces.
- **Agent unit tests:** `openRootOwned` (a group-writable directory at each depth, a link at each depth, a file owned by the service account, a directory swapped after the open, which the handles must not see), the policy reader, window evaluation (crossing midnight, a daylight-saving change, `UTC`), tracks (`major` refused), the setup flags with a fake key bundle (match by computed fingerprint, a `fingerprint` field that lies, mismatch, updates off), offer handling (cut-off, oversized and altered downloads leave no final file; a withdrawn offer deletes the stage; a release the last result names as rolled back is never downloaded), the heartbeat member, and a malformed member that the server refuses: the next request leaves it out first and the device keeps checking in.
- **Privileged step tests**, with the service manager and the clock as seams set only in test files (`no_test_hooks_test.go` keeps the shipped binary free of them): a kill at every journal boundary, as `TestKillAtEveryApplyBoundaryRecoversDeterministically` does for applies; each failure row of section 6; the floor on disk before the stop at every boundary after `swapping`; a forged request, a staged file replaced after the copy, a link in place of the staged file, a FIFO, an oversized file; health files written by the wrong build or before the trial; the probe run as the service account from `probe/`, and a build that fails it.
- **Hostile server against a real agent** (Go, in-process server, real engine and step in temporary roots): offers signed by an unpinned key, with a flipped byte, an older counter, an expired manifest, an `issued_at` a day ahead, the wrong platform's artifact, a path to another digest, a manifest that disagrees with `artifact`, a rollover from an unpinned key, a genuine fork, an old statement from a key the host already left, a bundle whose `fingerprint` lies, an offer to a host with consent `off`, and the same bad build offered again under a new rollout after it rolled back. Each leaves the installed file, the policy, the pins and the floors unchanged, byte for byte, and the last one never stops Vector a second time.
- **Native, on a real service on each OS** (`platforms.yml`, a new phase script `tests/platform/agent-update.mjs` in each service job): CI builds four agents from copies of the source with only the version constant or one line changed in the copy (never a hook in the product): `0.1.0`, a good `0.1.1`, a `0.1.2` that exits at start, and a `0.1.3` whose check-in path is wrong. It makes a key with `vectory release keygen`, turns updates on with offline custody through the API, places the builds in the operator mirror, prepares and signs each release with `vectory release sign`, installs `0.1.0` with the consent flags Add device generates, and checks with the real server: on Linux, the step runs under the sandboxed unit of section 6 and `systemd-analyze verify` passes on it; `0.1.0 → 0.1.1` verified on the rollout page and by `vectory version` on the host; `0.1.2` rolled back with `START_FAILED`, then offered again by a new rollout and refused with `RELEASE_ALREADY_TRIED` without a stop; `0.1.3` rolled back with `NO_CHECK_IN`; a truncated store file refused with `ARTIFACT_MISMATCH`; the step killed at `swapping` and at `trial` and run again; a full disk (a small loop-mounted file system for the helper's directory on Linux, a size-capped disk image on macOS, a size-capped virtual disk on Windows) refused with `DISK_FULL`; a host installed without the flags never downloading. Then the same service meets a hostile server: a small Go program in `tests/platform/` that, on CI only, takes over the instance's agent listener with the instance's own TLS and manifest keys and answers the real agent's check-ins with crafted offers: a release signed by another key, a flipped byte, a replayed lower counter, an expired manifest, the wrong platform's file, a path to another digest, a genuine fork, an offer to a host whose consent is `off`. After each, the installed executable, the policy, the pins and the floors are unchanged, byte for byte, and the refusal code is the expected one. Each operating system's proof gates that operating system alone ([section 6](#platforms)).
- **Protocol suite** (`tests/security/protocol_test.go`): the offer is inside the signed manifest and bound to device and nonce; the download answers only the offered device and digest; the key bundle holds public keys only; the heartbeat member's bad values are `400` and change nothing; role checks on every new route; Stop all updates closes the download route.
- **Server tests:** release preparation from the catalog, the signature upload, rollover and revocation; every state transition and the stale-report rule; stages, observation, threshold, pause, resume, cancel and the stop; the review's codes; audit rows, notifications and issue resolution.
- **Browser harness** `dashboard/tests/agent-updates-browser.mjs` with the shared synthetic replies: the settings dialog with nothing preselected, custody and password; the fleet tab; the review's groups; the rollout page's states; the device panel's states; Add device and Upgrade agent commands with and without consent; roles.
- **CI:** `ci.yml` runs the vectors in the `server` and `agent` jobs, the hostile-server tests in `agent`, the harness in `dashboard-browsers`; `platforms.yml` runs the native phase in each service job; `docs/internal/CI.md` lists them.

## 10. Order of work

1. The contract: routes, the heartbeat and manifest members, the manifest, signature, rollover, policy and exchange file formats, the codes, the shared vectors and report bounds, migrations 0136 to 0138.
2. The release format in Go with `vectory release` and the command groups; then, in parallel, the shared Go pieces (locations, `openRootOwned`, the policy, windows, the exchange files, the step's API) and the release format in Rust.
3. In parallel: the server; the agent's consent flags, `vectory update` and offer handling; the privileged step on Linux with its native proof and the hostile server, which takes longest; the dashboard and documentation.
4. The privileged step on macOS and on Windows, each on the Linux step's journal and state once that has landed, each with its own native proof.
5. Integration on `platforms.yml`, then an independent review of the update path, which gate 8 of the release checklist requires.

## 11. What 0.1 leaves out

| Left out | Why |
| --- | --- |
| Remote downgrades, and a remote rollback command | A server must not be able to move a fleet backwards; a bad build is replaced by a newer one, and the automatic rollback covers builds that don't work |
| Pre-release versions | Their ordering is easy to get wrong across two languages; they are refused until a release needs them |
| The `major` track | A major jump is the one most likely to cross a `service_definition` or `min_from` boundary; tracks are `patch` and `minor`, and a major upgrade is done by hand |
| Changing the custody kind while hosts stay pinned | It would need rollovers between kinds in both directions; changing the kind is turning updates off and on again with the other kind and running each host's Upgrade agent command once |
| Package-managed agents, foreground agents, OpenRC and containers | The package manager or the operator owns the file and the process; the review names them |
| Rewriting a unit, plist or service definition through an update | A rollback would have to restore it too; `service_definition` routes those hosts to one run of the Upgrade agent command |
| Persistent group targeting and scheduled update rollouts | A rollout is a reviewed snapshot; hosts' windows give the timing |
| Range requests, resumed downloads, peer or delta distribution | Builds are small; a restart from zero keeps the device's only partial state a temporary file |
| Server-delivered key revocation to hosts | Only a key a host pins may change its trust; revocation on the server stops distribution, and re-pinning is local |
| A project-wide release key | None exists yet; one is added later as another pinned key, with no agent change |
| Updating Vector | The specification keeps Vector's binary the host's decision |
| macOS or Windows, if its native proof is not green at the cut | Section 6: that operating system then reports that its hosts update by hand in this release; Linux must ship |

## Alternatives considered and rejected

- **A per-host opt-in command after installation.** It would need a login per host to turn on the feature whose purpose is to need none; consent rides on the one command every host already runs.
- **Consent and pins in `settings.json`.** The service account owns that file; it would become a path from a compromised pipeline to root.
- **The server's manifest key authorizing builds.** One compromise would reach every host; it stays the authority over pipelines only.
- **The agent installing the build itself.** Its service account can't write the executable, by design, and must not be able to.
- **A file watch to start the privileged step** (systemd path unit, launchd `WatchPaths`). Less reliable than a 30-second poll, and recovery at boot needs the poll's entry point anyway.
- **Rolling back with the new build's own code** (a check at its next start). The build under trial would decide whether it is healthy; a build that can't start decides nothing.
- **A list of releases that rolled back, kept beside the counter floors.** The floor of attempted counters already refuses them, with no state to grow, clear or get wrong.
- **Raising the counter floor at commit.** A rolled-back release would stay acceptable, so a server could offer it again and stop Vector at every offer; two manifests with one counter could both be tried during a trial.
- **Running the probe from the step's private directory, or through a passed descriptor.** The service account can't traverse a root `0700` directory, and a descriptor-based exec is harder to get right on three platforms than a root-owned directory it may read and run from.
- **Signing archives, or a canonical JSON form.** Archives make root unpack untrusted input; a canonical form invites the two languages to disagree.
- **A short-lived signature per offer instead of release counters and expiry.** It would need the signer online for every rollout, which custody *a key kept offline* rules out.
- **Pinning the public key in the command instead of its fingerprint.** It works too; the fingerprint keeps the command short and the same shape as `--ca-sha256`, and the bundle carries the rollover statements a new host needs.

## Consequences

- A team that never turns updates on runs exactly what it runs today.
- Hosts enrolled with consent never need a login again to update the agent, unless a key they pin is stolen before it is rolled over, or a release needs a newer service definition.
- With server custody, the server becomes an authority over code on opted-in hosts; the setting says so and the record of it is in the audit log.
- `vectory setup` writes outside the state directory for the first time (the policy and the helper), only with consent flags, and `service-uninstall` and `vectory update off` remove what it wrote.

## Open risks

- **The key holder is root on opted-in hosts.** Nothing in the agent can tell a malicious signed build from a good one.
- **A service account that is already compromised can deny its own updates** (forged health records, requests and reports) and lie to the dashboard about its update state. It cannot install unsigned code.
- **The first pin is as good as the command that carried it.** A tampered Add device command could pin an attacker's key, as a tampered `--ca-sha256` could pin an attacker's CA.
- **Hosts behind on rollovers.** A host offline through two rotations follows the chain when it returns; a host that saw only a thief's statement is lost to the thief until re-pinned, and one that saw both freezes until re-pinned.
- **A good build that fails on one host is not retried there.** The floor makes a rolled-back release final on that host, whatever caused the failure (an outage during the trial included); the next release reaches it.
- **A compromised server chooses among signed releases.** Within their expiry it can give a lagging host an older signed release that is still newer than what it runs, instead of the newest, and it can always withhold updates. A signed minimum-version statement from the key holder would close the first; nothing closes the second.
- **Clocks.** Expiry uses the host's clock; a host whose clock runs far behind accepts an expired release, one far ahead refuses valid ones.
- **Not measured yet:** renaming a running executable on every supported Windows version, launchd's `StartInterval` under load, the time systemd needs to report three restarts of a failing unit, and the download route with 16 concurrent transfers of 25 MiB on a slow server.
