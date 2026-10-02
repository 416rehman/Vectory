# Review playbook

How to review a batch of changes with fresh eyes. Run it at the end of every batch of work, on the merged result, before declaring the batch done. The authors of a change are the worst people to find what is wrong with it, so each area below goes to a reviewer who did not write the code.

## Ground rules

- **Read-only.** A reviewer reports; it does not edit repository files. Fixes are a separate step by someone else, and are then re-checked by the reviewer's method, not by trust.
- **Own instance, own ports.** Review on a fresh instance (`scripts/preview.sh`) and, for fleet behavior, on the demo fleet (`node scripts/demo.mjs --agents 4`). Prefix every object you create with the reviewer's tag, never delete or pause someone else's devices, never touch a real installation.
- **Evidence over opinion.** Every finding says what you did, what happened (a screenshot path, command output, `file:line`), why it matters, the exact fix (code location and approach) and proposed wording where text is involved. Reproduce each finding a second time before reporting it, and label anything you could not run as a hypothesis.
- **Real data only.** Never accept fabricated fleet data or a claimed success as a pass; a file write or a download is never evidence of activation.
- **Do not re-report what is fixed**, and do check that the previous round's findings in your area are really fixed.

## Areas, one reviewer each

1. **Authoring and Vector coverage.** Can an operator manage every aspect of Vector from here? Build pipelines from templates and from imported YAML, TOML and JSON; use every canvas tool; the VRL studio with samples, timestamps and route conditions; unit tests; publish diff; deploy. Compare against the specification, `vector-catalog/` and the Vector documentation, and rank what an operator still cannot do by how often a real operator would hit it. The last full pass is [AUTHORING-GAPS.md](AUTHORING-GAPS.md); run the same coverage matrix again and update it.
2. **Visual and interaction polish, and documentation truth.** Every route and dialog, in light, dark and 390 px (768 px for tables and the editor): alignment and spacing rhythm, inconsistent radii, borders, shadows and icons, truncation and overlap, controls that jump, two kinds of table or empty state or confirmation, contrast, focus rings, hover, disabled and loading states, reduced motion, keyboard order, screen-reader names, performance you can feel, microcopy (tone, jargon, "Something went wrong", raw error strings, one concept named two ways, dates that read differently, numbers without units, "1 devices"), and what happens the instant after a click. Then execute the quickstart and every command in the docs on a fresh instance with a stopwatch: every step, label, flag, path, port, exit code, screenshot and number must match what the product does today; compare the CLI reference with `vectory help` and each `--help`, the server-config reference with what the server reads, and check the in-product help links land on the right section.
3. **First run, sign-in, install and agent lifecycle.** As a brand-new self-hoster: bootstrap the first administrator, sign in, invite a second user, enable two-factor, use a recovery code, then Add device and connect the machine with the exact command the UI gives you (scratch state directory, `--service none`). Run the installer with `--dry-run --install-dir <dir>` and judge the plan. Break things on purpose (wrong token, wrong CA pin, stopped server, bad VRL, unreachable sink, missing data directory, port below 1024) and judge every message on the CLI and in the UI. Judge `vectory --help`, `help <cmd>`, `status`, `doctor` and `logs`, and time each step.
4. **The daily operator journey.** With only real data on the demo fleet: Overview, Devices, a device, Pipelines, build a pipeline from a template, test it (including a test Vector refuses, so "Not run" shows), review and publish, deploy as a canary to one device, watch the rollout page, roll back, Issues, Audit, the command palette; at phone width for Overview, Devices and the rollout. Is "what is running where, is it healthy, what changed, what needs me" obvious in five seconds? Note every point that broke, felt slow (time it), looked unfinished or needed an explanation.
5. **Security, adversarial.** Attack the whole surface independently of the authors: authentication and rate limits, the agent listener and its resource limits, the install endpoint and its trust chain, enrollment tokens and scope, device certificates and CA rotation, wake-ups, the notification destination policy, restricted-mode containment, secrets handling, CSRF, role boundaries, the validator worker, and the generated commands the dashboard hands to operators. The last pass and its open findings are in [docs/security/OPEN-FINDINGS.md](../security/OPEN-FINDINGS.md); `docs/security/THREAT-MODEL.md` says what is meant to hold.
6. **Specification conformance and evidence hygiene.** Walk [REQUIREMENTS.md](REQUIREMENTS.md) against the code and CI: every claim has a test that runs, no evidence file is cited that is not committed, and no status over-claims.
7. **Code review.** The dashboard (effects, races, stale closures, StrictMode double effects, cleanup, focus management, accessibility semantics, state duplicated between pages, dead code and CSS, inconsistent use of the shared primitives, bundle size and re-renders on 5,000-device and 500-component data, API error handling, test coverage of new logic), and the same for the server and the agent (error paths, locking and the single writer, durability, input bounds). Prefer simplifications that delete code.

## Environment for a review

```sh
# a fresh instance on your own port block and state directory
VECTORY_PREVIEW_DIR=<dir>/preview VECTORY_PREVIEW_WEB_PORT=<p> \
VECTORY_PREVIEW_AGENT_PORT=<p+3> VECTORY_PREVIEW_VALIDATOR_PORT=<p+1> \
VECTORY_PREVIEW_VECTOR=<path to vector 0.58.0> scripts/preview.sh start    # and `stop`
```

- Use prebuilt binaries; builds on a shared machine are slow. Capture screenshots with Playwright in light, dark (`colorScheme: 'dark'`) and 390 px, and look at them, not just at the assertions.
- Never run `playwright install` in a locked-down container; launch an installed Chromium by `executablePath` (see "Playwright in a constrained container" in [CONTINUATION.md](CONTINUATION.md)).
- `ss` may not be installed; `cat /proc/net/tcp` lists listening ports. Never kill a process you did not start.

## Report format

A five-line verdict (what looks finished, what looks like a prototype, the three most embarrassing things), then findings ordered **P0** (broken, blocking, insecure or a data risk), **P1** (major UX problem or a missing core capability), **P2** (notable polish), **P3** (nits), then the ten changes that would most improve the product, scoped as pieces of work, and a short list of what is genuinely excellent so it is not regressed. Be specific and terse; generic advice is noise.

## After the review

Fix every P0 and P1 before the batch is called done, and record P2 and P3 in the relevant document ([WORK-QUEUE.md](WORK-QUEUE.md), [AUTHORING-GAPS.md](AUTHORING-GAPS.md) or the security findings). Then run the review again on what changed: a fix that was not re-checked is not a fix.
