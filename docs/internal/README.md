# Internal records

Engineering history and test evidence, kept for review and audit. These documents describe how Vectory was built and verified; they are not user documentation and may describe earlier states of the product. User documentation lives in [docs/user](../user/getting-started.md).

| Document | What it records |
| --- | --- |
| [REQUIREMENTS.md](REQUIREMENTS.md) | The requirements-to-tests checklist: each requirement of the specification, its status and the test or CI step behind it. CI checks it. |
| [ACCEPTANCE.md](ACCEPTANCE.md) | Historical acceptance record of 2026-09-26 to 2026-09-28. Most evidence files it names were not committed. |
| [CI.md](CI.md) | What each CI job proves and does not, and the checks CI leaves out. |
| [CONTINUATION.md](CONTINUATION.md) | Where the work stands and how to pick it up: what landed since the last handoff, how to verify, what is unstable, the definition of done. Start here. |
| [WORK-QUEUE.md](WORK-QUEUE.md) | What to build or fix next, in order, with scope and acceptance. |
| [AUTHORING-GAPS.md](AUTHORING-GAPS.md) | What an operator still cannot do with Vector from Vectory, and the defects found while authoring pipelines. |
| [REVIEW-PLAYBOOK.md](REVIEW-PLAYBOOK.md) | How to review a batch of changes with fresh eyes, by area. |
| [docs/security/OPEN-FINDINGS.md](../security/OPEN-FINDINGS.md) | Open findings from an independent security review, each with its fix and test. |
| [HANDOFF.md](HANDOFF.md) | The current handoff: what works and what proves it, tested platforms, capacity, open defects and release prerequisites. |
| [HANDOFF-2026-09-27.md](HANDOFF-2026-09-27.md) | The earlier narrative handoff, kept as a historical record. Most evidence files it names were not committed. |
| [CAPACITY.md](CAPACITY.md) | Protocol load and fleet-read measurements, and their limits. |
| [DEPENDENCY-AUDIT.md](DEPENDENCY-AUDIT.md) | Dependency vulnerability scans. |
| [TAP-IMPLEMENTATION-PLAN.md](TAP-IMPLEMENTATION-PLAN.md) | The plan for opt-in event sampling: work packages, tests, wire changes and what stays unbuilt until each is proven. The decision is [ADR 0011](../adr/0011-opt-in-event-sampling.md). |
| [CAPABILITY-IMPLEMENTATION-PLAN.md](CAPABILITY-IMPLEMENTATION-PLAN.md) | The plan for graduated capability tiers, the service sandbox and managed assets: work packages, wire and storage changes, tests and what an independent reviewer must attack. The decisions are [ADR 0012](../adr/0012-graduated-capability-tiers.md) and [ADR 0013](../adr/0013-managed-assets.md). |
| [TYPE-SYSTEM-REVIEW.md](TYPE-SYSTEM-REVIEW.md) | Historical review of the Vector reference and configuration types. |
| [HELP-CENTER-EVIDENCE.md](HELP-CENTER-EVIDENCE.md) | Historical Help center verification of 2026-09-26. |
| [WORKSTREAMS.md](WORKSTREAMS.md) | The original work breakdown. |

[docs/evidence](../evidence/) holds the 19 evidence files that were committed. Each is a snapshot of one earlier run: the ones that record a date are from 2026-09-26 to 2026-09-29, most of them on a Windows development host. They do not describe later builds.
