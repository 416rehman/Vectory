# Release 0.1 (developer preview)

The checklist for the first release. [CONTINUATION.md](CONTINUATION.md) says how to build and verify; this file says what ships, what does not, and what must be true before the tag. Update the status column in the same change that closes a gate.

## What the release is

A **developer preview**, as the [roadmap](../ROADMAP.md) and the README already say: the full loop (build, publish, canary, apply, roll back) against real Vector 0.58.0 agents, a self-hosted server on Docker Compose, outbound-only agents for Linux, macOS and Windows. It is **unsigned**: no signing identity, package namespace, APT repository or container registry exists for it. The release attaches the unsigned release candidate that `.github/workflows/release-candidate.yml` builds (agent archives and `catalog.json`, `.deb` and `.rpm` packages, the MSI, the server and validator images as `docker save` archives, SBOMs, the license inventory, `SHA256SUMS` and `CANDIDATE.json`) and says so on its page.

## Scope under review

The pre-release review can still land fixes to core workflows and directly requested authoring improvements when they have tests and matching documentation. This branch includes operator-issued agent updates ([ADR 0015](../adr/0015-operator-issued-agent-updates.md)), which are off by default, opt-in on each host and accepted only as signed builds, and multi-file configuration import. Release plumbing and documentation continue until the gates below pass. The larger capabilities in the table remain planned for later releases.

Designed and recorded for the next release, not built now:

| Work | Where it is written down |
| --- | --- |
| Graduated capability tiers, the service sandbox that follows the host's allowances, managed assets | [ADR 0012](../adr/0012-graduated-capability-tiers.md), [ADR 0013](../adr/0013-managed-assets.md), [CAPABILITY-IMPLEMENTATION-PLAN.md](CAPABILITY-IMPLEMENTATION-PLAN.md) |
| Opt-in event sampling | [ADR 0011](../adr/0011-opt-in-event-sampling.md), [TAP-IMPLEMENTATION-PLAN.md](TAP-IMPLEMENTATION-PLAN.md) |
| Server capacity (writer profiling, group commit, smaller telemetry) | [WORK-QUEUE.md](WORK-QUEUE.md) item 2, [CAPACITY.md](CAPACITY.md) |
| Authoring gaps (secrets in headers and URLs, configuration-directory import, separate-pipeline recovery) | [AUTHORING-GAPS.md](AUTHORING-GAPS.md), [WORK-QUEUE.md](WORK-QUEUE.md) item 8 |
| Step-up authentication, labels and selectors, single sign-on, Kubernetes | [WORK-QUEUE.md](WORK-QUEUE.md) item 11 |
| Signed releases, published images and packages | [packaging/README.md](../../packaging/README.md), [HANDOFF.md](HANDOFF.md) |

## Gates

Every gate is a command or a check anyone can repeat. A gate is **Done** only with the evidence named. Gates 1, 2, 3 and 8 qualify the last pre-publication commit on the release branch. Publication makes a new commit on `main`; its checks and tag candidate are repeated in the maintainer steps below.

| # | Gate | How it is verified | Status |
| --- | --- | --- | --- |
| 1 | CI is green on the release-branch head: all nine jobs, including `dashboard-browsers` and the account lifecycle step | The `checks` workflow on the last pre-publication branch commit | Done |
| 2 | The unsigned branch candidate builds and verifies | The whole `release-candidate.yml` workflow succeeds on the last pre-publication branch commit; download `unsigned-release-candidate` into `candidate`, run `(cd candidate && sha256sum -c SHA256SUMS)` and `python3 packaging/verify-release.py candidate` from the repository root. A partial artifact retained after a failed job is marked `incomplete-diagnostic` and fails the final verifier. | Done |
| 3 | The pre-release review finds nothing open at P0 or P1 | [Review report](RELEASE-REVIEW-0.1.md) per area on the runnable code of the final branch candidate; every P2 is fixed or listed under Known limits | Done |
| 4 | The open security findings are fixed or listed | [OPEN-FINDINGS.md](../security/OPEN-FINDINGS.md) has nothing without a fix, an owner or a line in the user-facing known limits and [SECURITY.md](../../SECURITY.md) | Done |
| 5 | One version everywhere | `node scripts/check-versions.mjs` (it runs in CI) finds `0.1.0` in `agent/internal/agent/types.go`, `server/Cargo.toml` and its lock file, the dashboard and Help center packages and their lock files, `contracts/openapi.json` and the newest changelog heading; the Help center reads its package; `packaging/build-release.py` refuses a mismatch with the agent | Done |
| 6 | Documentation matches behavior | `node scripts/check-doc-links.mjs`, `check-requirements.mjs`, `check-ci-table.mjs`, the Help center build and its tests; README, `CHANGELOG.md`, `docs/user/whats-new.md` and the known limits say the same thing | Done |
| 7 | No private details in the tree or the history | `node scripts/check-writing-rules.mjs` passes; a scan of the final tree and of every commit message for personal paths, links to private pages and internal identifiers; one squashed release commit on `main` | Open |
| 8 | Agent updates are proven and reviewed | `platforms.yml` runs the native phase `tests/platform/agent-update.mjs` in each service job: a real agent service takes the next build with the consent flags Add device generates, takes back a build that fails to start and one that never checks in, never takes a build whose store file was cut short, and refuses a release it already tried without stopping Vector again; the same service then meets a hostile server (offers signed by another key, with a flipped byte, with a replayed counter, expired, for the wrong platform, naming another digest, forking a key, and to a host that did not consent), and its executable, policy, pins and counter floors stay unchanged byte for byte. An operating system whose phase is not green ships saying its hosts update by hand, with its switch (`macosUpdatesInRelease`, `windowsUpdatesInRelease`) set to false in `agent/internal/agent/update_gate.go` (Linux must ship). The `windows` job builds its agents with the Windows line opened in a copy of the source, so a green run proves the step as it ships; `windowsUpdatesInRelease` is true because that job was green. An independent review of the update path finds nothing open at P0 or P1 | Done |

## Publication (maintainer steps)

These change the public repository and need the maintainer's explicit go-ahead; they are not done by routine work.

1. Decide how to handle local home paths in the three existing `main` commits (`2f18fb7`, `d1dd1d3`, and `c88758e`) and private session URLs in 376 published branch-only commit messages, including any copies already made: the repository is already public. The current tree has neither detail. A squash makes the new `main` history smaller but does not erase the three old `main` commits or already published branch history. Then squash the release branch into one commit on `main` only with the maintainer's explicit approval.
2. Compare the new `main` tree with the reviewed release-branch tree: only the release-record update that closes gate 7 may differ. A runnable change restarts the review. Confirm all nine `checks` jobs pass on the new commit.
3. Tag `v0.1.0` on that commit.
4. Run `release-candidate.yml` on the tag, download `unsigned-release-candidate`, verify `SHA256SUMS` and `packaging/verify-release.py`.
5. Create the GitHub release from the tag with the candidate's files. Lead the notes with the highlights from the `0.1.0` changelog section, link the full [changelog](../../CHANGELOG.md), [What's new](../user/whats-new.md), [quickstart](../user/quickstart.md) and [known limits](../user/compatibility.md), and state plainly that the downloads are unsigned.
6. Check the release page's downloads against `SHA256SUMS`, and run the quickstart from the README on a clean machine.

## After the release

Signing, notarization, the APT repository, a container registry and the package namespaces ([HANDOFF.md](HANDOFF.md) lists what only the maintainer can provide); then the next-release work in the table above, in the order of [WORK-QUEUE.md](WORK-QUEUE.md).
