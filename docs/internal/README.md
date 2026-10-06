# Internal records

Engineering records and test evidence, kept for review and audit. They describe how Vectory is built and verified; they are not user documentation and may describe earlier states of the product. User documentation lives in [docs/user](../user/getting-started.md).

| Document | What it records |
| --- | --- |
| [REQUIREMENTS.md](REQUIREMENTS.md) | The requirements-to-tests checklist: each requirement of the specification, its status and the test or CI step behind it. CI checks it. |
| [CI.md](CI.md) | What each CI job proves and does not, and the checks CI leaves out. |
| [CONTINUATION.md](CONTINUATION.md) | Where the project stands and how to continue it: what landed since the last status report, how to verify, what is unstable, the definition of done. Start here. |
| [HANDOFF.md](HANDOFF.md) | The status report: what works and what proves it, tested platforms, capacity, open defects and release prerequisites. |
| [RELEASE-0.1.md](RELEASE-0.1.md) | The first release: what ships, what is deferred, the gates and their status, the maintainer's publication steps. |
| [WORK-QUEUE.md](WORK-QUEUE.md) | What to build or fix next, in order, with scope and acceptance. |
| [AUTHORING-GAPS.md](AUTHORING-GAPS.md) | What an operator still cannot do with Vector from Vectory, and the defects found while authoring pipelines. |
| [REVIEW-PLAYBOOK.md](REVIEW-PLAYBOOK.md) | A checklist for reviewing a batch of changes, by area. |
| [docs/security/OPEN-FINDINGS.md](../security/OPEN-FINDINGS.md) | Open findings from an independent security review, each with its fix and test. |
| [CAPACITY.md](CAPACITY.md) | Protocol load and fleet-read measurements, and their limits. |
| [DEPENDENCY-AUDIT.md](DEPENDENCY-AUDIT.md) | Dependency vulnerability scans. |
| [TAP-IMPLEMENTATION-PLAN.md](TAP-IMPLEMENTATION-PLAN.md) | The plan for opt-in event sampling: steps, tests, wire changes and what stays unbuilt until each is proven. The decision is [ADR 0011](../adr/0011-opt-in-event-sampling.md). |
| [CAPABILITY-IMPLEMENTATION-PLAN.md](CAPABILITY-IMPLEMENTATION-PLAN.md) | The plan for graduated capability tiers, the service sandbox and managed assets: steps, wire and storage changes, tests and what an independent review must attack. The decisions are [ADR 0012](../adr/0012-graduated-capability-tiers.md) and [ADR 0013](../adr/0013-managed-assets.md). |
| [SECRETS-IMPLEMENTATION-PLAN.md](SECRETS-IMPLEMENTATION-PLAN.md) | The plan for device secrets in headers and URLs: steps, wire changes, tests and what an independent review must attack. The decision is [ADR 0014](../adr/0014-device-secrets-in-headers-and-urls.md). |
| [TYPE-SYSTEM-REVIEW.md](TYPE-SYSTEM-REVIEW.md) | Historical review of the Vector reference and configuration types. |
| [HELP-CENTER-EVIDENCE.md](HELP-CENTER-EVIDENCE.md) | Historical Help center verification of 2026-09-26. |

[docs/evidence](../evidence/) holds snapshots of earlier runs, mostly from 2026-09-26 to 2026-09-30 on a Windows development host or a shared Linux VM. They do not describe later builds. The ones other records cite are the capacity and load runs ([CAPACITY.md](CAPACITY.md)), the Rust dependency audit ([DEPENDENCY-AUDIT.md](DEPENDENCY-AUDIT.md)) and one native outage run ([REQUIREMENTS.md](REQUIREMENTS.md)).
