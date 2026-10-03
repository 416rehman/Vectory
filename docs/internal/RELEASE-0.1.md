# Release 0.1 (developer preview)

The checklist for the first release. [CONTINUATION.md](CONTINUATION.md) says how to build and verify; this file says what ships, what does not, and what must be true before the tag. Update the status column in the same change that closes a gate.

## What the release is

A **developer preview**, as the [roadmap](../ROADMAP.md) and the README already say: the full loop (build, publish, canary, apply, roll back) against real Vector 0.58.0 agents, a self-hosted server on Docker Compose, outbound-only agents for Linux, macOS and Windows. It is **unsigned**: no signing identity, package namespace, APT repository or container registry exists for it. The release attaches the unsigned release candidate that `.github/workflows/release-candidate.yml` builds (agent archives and `catalog.json`, `.deb` and `.rpm` packages, the MSI, the server and validator images as `docker save` archives, SBOMs, the license inventory, `SHA256SUMS` and `CANDIDATE.json`) and says so on its page.

## Scope is frozen

Only these may change before the tag: fixes for defects the pre-release review finds, documentation, release plumbing (versions, changelog, notes), and one feature: operator-issued agent updates ([ADR 0015](../adr/0015-operator-issued-agent-updates.md)), which are off by default, opt-in on each host and accepted only as signed builds. No other new features.

Designed and recorded for the next release, not built now:

| Work | Where it is written down |
| --- | --- |
| Graduated capability tiers, the service sandbox that follows the host's allowances, managed assets | [ADR 0012](../adr/0012-graduated-capability-tiers.md), [ADR 0013](../adr/0013-managed-assets.md), [CAPABILITY-IMPLEMENTATION-PLAN.md](CAPABILITY-IMPLEMENTATION-PLAN.md) |
| Opt-in event sampling | [ADR 0011](../adr/0011-opt-in-event-sampling.md), [TAP-IMPLEMENTATION-PLAN.md](TAP-IMPLEMENTATION-PLAN.md) |
| Server capacity (writer profiling, group commit, smaller telemetry) | [WORK-QUEUE.md](WORK-QUEUE.md) item 2, [CAPACITY.md](CAPACITY.md) |
| Authoring gaps (secrets in headers and URLs, merge-aware conflicts, Vector warnings as problems) | [AUTHORING-GAPS.md](AUTHORING-GAPS.md), [WORK-QUEUE.md](WORK-QUEUE.md) item 8 |
| Step-up authentication, labels and selectors, single sign-on, Kubernetes | [WORK-QUEUE.md](WORK-QUEUE.md) item 11 |
| Signed releases, published images and packages | [packaging/README.md](../../packaging/README.md), [HANDOFF.md](HANDOFF.md) |

## Gates

Every gate is a command or a check anyone can repeat. A gate is **Done** only with the evidence named.

| # | Gate | How it is verified | Status |
| --- | --- | --- | --- |
| 1 | CI is green on the head: all nine jobs, including `dashboard-browsers` and the account lifecycle step | The `checks` workflow on the final commit | Open |
| 2 | The release candidate builds and verifies | `release-candidate.yml` on the final commit; download `unsigned-release-candidate`, `sha256sum -c SHA256SUMS`, `python3 packaging/verify-release.py` | Open |
| 3 | The pre-release review finds nothing open at P0 or P1 | Review reports per area (shell and navigation, sign-in and accounts, agent install and deploy, the editor, documentation, security) on the final binaries; every P2 is fixed or listed under Known limits | Open |
| 4 | The open security findings are fixed or listed | [OPEN-FINDINGS.md](../security/OPEN-FINDINGS.md) has nothing without a fix, an owner or a line in the user-facing known limits and [SECURITY.md](../../SECURITY.md) | Open |
| 5 | One version everywhere | `node scripts/check-versions.mjs` (it runs in CI) finds `0.1.0` in `agent/internal/agent/types.go`, `server/Cargo.toml` and its lock file, the dashboard and Help center packages and their lock files, `contracts/openapi.json` and the newest changelog heading; the Help center reads its package; `packaging/build-release.py` refuses a mismatch with the agent | Open |
| 6 | Documentation matches behavior | `node scripts/check-doc-links.mjs`, `check-requirements.mjs`, `check-ci-table.mjs`, the Help center build and its tests; README, `CHANGELOG.md`, `docs/user/whats-new.md` and the known limits say the same thing | Open |
| 7 | No private details in the tree or the history | `node scripts/check-writing-rules.mjs` passes; a scan of the final tree and of every commit message for personal paths, links to private pages and internal identifiers; one squashed commit with a single `Co-Authored-By` trailer | Open |
| 8 | Agent updates are proven and reviewed | `platforms.yml` runs the native phase `tests/platform/agent-update.mjs` in each service job: a real agent service takes the next build with the consent flags Add device generates, takes back a build that fails to start and one that never checks in, never takes a build whose store file was cut short, and refuses a release it already tried without stopping Vector again; the same service then meets a hostile server (offers signed by another key, with a flipped byte, with a replayed counter, expired, for the wrong platform, naming another digest, forking a key, and to a host that did not consent), and its executable, policy, pins and counter floors stay unchanged byte for byte. An operating system whose phase is not green ships saying its hosts update by hand, with its switch (`macosUpdatesInRelease`, `windowsUpdatesInRelease`) set to false in `agent/internal/agent/update_gate.go` (Linux must ship). The `windows` job builds its agents with the Windows line opened in a copy of the source, so a green run proves the step as it ships, and the commit that sets `windowsUpdatesInRelease` to true cites that run. An independent review of the update path finds nothing open at P0 or P1 | Open |

## Publication (maintainer steps)

These change the public repository and need the maintainer's explicit go-ahead; they are not done by routine work.

1. Squash the branch into one commit on `main`. The two earliest commits on `main` need a history rewrite before the project is made public; decide that first.
2. Tag `v0.1.0` on that commit.
3. Run `release-candidate.yml` on the tag, download `unsigned-release-candidate`, verify `SHA256SUMS`.
4. Create the GitHub release from the tag with the candidate's files, the changelog section as the notes, and the sentence that nothing in it is signed.
5. Check the release page's downloads against `SHA256SUMS`, and run the quickstart from the README on a clean machine.

## After the release

Signing, notarization, the APT repository, a container registry and the package namespaces ([HANDOFF.md](HANDOFF.md) lists what only the maintainer can provide); then the next-release work in the table above, in the order of [WORK-QUEUE.md](WORK-QUEUE.md).
