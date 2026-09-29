# Archived review scripts

These scripts were written to produce evidence for `docs/internal/ACCEPTANCE.md` and `docs/internal/HANDOFF.md` while the first version of each feature was reviewed. **None of them runs from a clean checkout today, none is run by CI, and none is maintained.** They stay in the repository, with their history, so a reviewer can see exactly what was checked and how. The evidence files they wrote into `docs/evidence/` are no longer in the tree, which is why the two internal documents link to files that do not exist.

Do not copy one back just to make a check pass. If a guarantee below matters again, extend the maintained check named in the last column, or revive the script properly (the notes say which ones are worth it).

Every script finds the repository root two folders above its own location, so to run one, move it back to `tests/security/` first.

"CI" below means a step of `.github/workflows/ci.yml` runs it. Checks marked "not in CI" exist and are maintained but are run by hand.

## Need a private build or captured input that a clean checkout does not have

| Script | What it checked | What it needs that is gone | Maintained check for the same guarantee |
| --- | --- | --- | --- |
| `access-edit-before-review.mjs` | The pre-fix production dashboard's handling of role, name and enabled edits on People (the "before" half of a before/after pair). | A copy of the old source and build under `.local/access-edit-before*`. | `dashboard/e2e/account-lifecycle.spec.ts` (admin access changes; CI), `tests/security/account-review.mjs` (server authorization and revisions; CI), `dashboard/src/roleAccess.test.ts` (CI). |
| `admin-reset-before-review.mjs` | The same for the administrator's password reset and its one-time code. | `.local/password-reset-before*`. | `account-lifecycle.spec.ts` (a reset link works once; two-factor stays required), `account-review.mjs` (reset races). |
| `access-edit-lifecycle-review.mjs` | The "after" half: keyed access edits (same-tick submits send one `PUT`, held, lost or malformed replies, stale revisions) in a private production build. | `.local/access-edit-after-build`, and `dashboard/src/AccountPasswordFields.tsx`, which the account rewrite deleted. The People page it drives has been replaced. | The checks above cover stale revisions and the server side (`server/tests/access_edit_native.py`, not in CI). Held or lost replies of an access edit have no UI check today. |
| `admin-reset-lifecycle-review.mjs` | The "after" half for password reset. | `.local/password-reset-after-build` and the deleted `AccountPasswordFields.tsx`. | As above, plus `server/tests/password_reset_request_native.py` (not in CI). The unknown-outcome review of a reset request has no UI check today. |
| `mfa-lifecycle-review.mjs` | Two-factor setup, confirm and disable when a reply is held, lost or malformed, in a production build (`VECTORY_MFA_PHASE=before` reproduced the old defects). | `.local/mfa-lifecycle-build`. Pointed at `dashboard/dist`, all ten groups stop at their first step, because setup moved into the account menu. | `dashboard/tests/authenticator-setup-browser.mjs` (CI), `dashboard/tests/mfa-recovery-browser.mjs` (not in CI), `account-lifecycle.spec.ts` (admin two-factor reset), `dashboard/src/mfaActionModel.test.ts` (CI). |
| `user-creation-lifecycle-review.mjs` | Keyed account creation before its recovery flow existed (a "before" capture). | `.local/mfa-lifecycle-build`, hard-coded. | `dashboard/tests/role-picker-browser.mjs` drives the Add person form (not in CI). Nothing checks the keyed creation flow end to end in the browser. |
| `user-creation-recovery-review.mjs` | Recovery of a keyed account creation whose reply is held, lost or wrong (ten groups). | `.local/user-creation-recovery-build`, and the Add person dialog it drives has been rewritten. | None in the browser. `AddPersonActions.tsx` and `keyedRequest.ts` still implement lost-reply recovery, so this is the first script worth reviving: it serves a static build, so `VECTORY_USER_CREATION_BUILD=dashboard/dist` replaces the private build. Server side: `server/tests/user_request_native.py` (not in CI). |
| `user-creation-contract-review.mjs` | Native HTTP bodies of the create-account calls against the generated API contract. | `.local/user-request-native-bodies`, captured from a Windows native run. | `contracts/CONTRACT.md` is the reference; `server/tests/user_request_native.py` (not in CI) exercises the routes. |
| `user-creation-integration-review.mjs` | A final gate that checks the hashes of the evidence files and of a candidate server binary. | Seven `docs/evidence/user-*` files and `.local/user-create-candidate/vectory-server.exe`. | Nothing to replace: it only aggregated the scripts above. |
| `account-ux.mjs` | Responsive layout and accessibility of the People and account pages in a running preview. | A preview at `http://127.0.0.1:8080` and a saved sign-in in `.local/preview/browser-auth.json`. | `dashboard/tests/account-metrics-tables-browser.mjs` (CI), `dashboard/e2e/accessibility.spec.ts` (not in CI). |
| `user-create-help-review.mjs` | The help pages for creating people, checked without copying the help build into the dashboard. | Its link check fails against the current help build (`Help link check failed`). | `node --test help-center/scripts/*.test.mjs` and `help-center/tests/ci.mjs` (both CI). |

## Bundled with esbuild against modules that changed

`enrollment-review.mjs`, `pause-review.mjs` and `target-review.mjs` bundle the Enrollment, Fleet, `TargetDialog` and `DeploymentReview` components with esbuild and drive them with synthetic transport. They fail before running any check:

- esbuild resolves `import "./deploymentReview"` to `DeploymentReview.tsx` (the component) instead of `deploymentReview.ts` (the helpers), because it tries `.tsx` first and matches file names without regard to case. Vite and TypeScript try `.ts` first, so the app itself is unaffected. The helpers are now `deploymentReviewModel.ts`, so the trap is gone.
- `target-review.mjs` then fails on exports (`assignmentName`, `localInputValue`) that moved.
- The screens themselves were redesigned (the deploy dialog, Add device, the pause review).

| Script | What it checked | Maintained check for the same guarantee |
| --- | --- | --- |
| `enrollment-review.mjs` | Four enrollment probes: mode instructions and reporting, token reuse, preview identity and generation. | `dashboard/tests/enrollment-browser.mjs` and `enrollment-connection-browser.mjs` (both CI), `dashboard/src/enrollmentCommands.test.ts` (CI). |
| `pause-review.mjs` | Three pause-policy probes: what a pause preview says and the preserved effective policy. | `tests/security/device-retry-context-review.mjs` opens the pause review from the device page; `dashboard/tests/deployments-browser.mjs` (CI), `device-assignment-browser.mjs` (not in CI), `dashboard/src/deploymentReviewModel.test.ts` (CI). |
| `target-review.mjs` | Six target-review probes: exclusions, restricted and full boundaries, variable handling. | `dashboard/tests/deployments-browser.mjs` (CI), `target-handoff-browser.mjs` (not in CI), `dashboard/src/deploymentVariables.test.ts` (CI). |
| `enrollment-request-review.mjs` | Sixteen groups on creating an enrollment token when the reply is slow, lost or wrong: reminders that survive a reload, exact cancellation, no token shown twice. | The Add device flow it drives (a wizard with a Continue button) was replaced by one verified command that the operator watches connect, so every group stops at its first step. Coverage today: `enrollment-browser.mjs` and `enrollment-connection-browser.mjs` (CI), `dashboard/src/enrollmentTokenRequests.test.ts` (CI). Worth reviving once the Add device redesign settles. |

## Drive screens that were rewritten, so they need rewriting rather than updating

These three run the actual App under Vite with synthetic transport and a fake clock. Sixteen groups each check what happens when a sign-in, sign-out or account request is held, lost or answered wrongly: no automatic replay of a one-time code, no late result, no unlocking of a second submit. The screens were rebuilt since (sign-in and setup in `AuthScreen.tsx`, a re-sign-in dialog that keeps the work underneath, keyed account requests), so every group stops at its first step. Run one group with its `VECTORY_*_ONLY` variable to see where. Reviving them means writing the expectations again against the new screens, not adjusting copy; the properties they protect are worth keeping and have unit tests but only partial browser coverage.

| Script | Where it stops today | Maintained check for the same guarantee |
| --- | --- | --- |
| `auth-wait-review.mjs` | Waits for a `Sign in` heading (now `Sign in to <instance>`) and a `Try again` button on the startup error. | `dashboard/src/authFlows.test.ts`, `authRequests.test.ts`, `sessionLifecycle.test.ts` (all CI), `dashboard/tests/staged-login-browser.mjs` (CI), `account-lifecycle.spec.ts` (sign-in dialog, MFA login, reset link). |
| `signout-wait-review.mjs` | Written for a confirmation dialog. `SignOutDialog.tsx` has no confirmation step now: Sign out starts at once and a dialog appears only when the request is slow or fails (Signing out…, Couldn't sign out, We couldn't reach Vectory, You're signed out, Your sign-in changed; Keep working or Stop waiting, Try again, Check again, Go to sign in, Reload). The old groups on confirmation, focus and read-first recovery no longer describe it. | `dashboard/src/signOutSession.test.ts` (CI). No browser check drives the current dialog; `account-lifecycle.spec.ts` covers signing out other browsers. |
| `account-actions-wait-review.mjs` | Fails on start: hashes `dashboard/src/AccountPasswordFields.tsx`, which was deleted. Its password-change and sign-out-others reviews were replaced by the dialogs in `AccountActions.tsx`. | `account-lifecycle.spec.ts` (password change, rejected password, sign out one or all other browsers, victim tab recovery), `dashboard/src/accountActionSession.test.ts` (CI). |

## Windows-only agent checks

These drive the Windows build of the agent (`vectory.exe`) against private synthetic state. Each asserts `os.name == "nt"` and most call Win32 APIs for file access control. Most take `--phase before|after` to compare a pre-fix and a post-fix binary, plus `--agent <vectory.exe>`, `--vector <vector.exe>` and `--output <folder under .local>`. They never enroll, start a service or run a workload.

| Script | What it checked |
| --- | --- |
| `capability-policy-input-review.py` | How the agent's CLI treats hostile capability-policy input. |
| `enrollment-preflight-review.py` | The stopped CLI's enrollment preflight and how it keeps an intent, against a synthetic TLS peer. |
| `install-options-review.py` | A combined install with its options. |
| `metrics-endpoint-review.py` | The metrics endpoint's lifecycle on a stopped installation. |
| `secret-bindings-input-review.py` | Standalone secret-binding input handling. |
| `settings-access-observation.py` | An observation that local settings updates may drop provisioned access entries. |
| `settings-update-access-review.py` | That settings updates keep the provisioned access. |
| `vector-readoption-review.py` | Re-adopting a copied native Vector, with a private CLI. |

Cross-platform coverage of the agent runs on Linux, Windows and macOS in CI (`go test ./...` and `go vet ./...` in `agent/`). The Windows-specific checks that are still maintained are `tests/native-outage.ps1` and the native Vector tests described in `docs/dev/DEVELOPMENT.md`.
