# Deploy and roll back

Deployment assigns a published pipeline version or agent settings to devices. Publishing freezes a version; deployment chooses who receives it and when. Operator or Admin access is required.

## Deploy a published version

1. Open the pipeline and choose **Review & publish** for the current draft. If it already matches a published version, choose **Choose devices**.
2. Select individual devices, groups, or both. Exclude any group members that should not receive it.
3. Open **Advanced options** if you need a different priority, continuing membership, schedule or canary release.
4. Preview the concrete device list and its **Priority outcome** column. Resolve conflicts, higher-priority assignments and capability problems before confirming.
5. Confirm the deployment, then choose **View deployment** in the confirmation to follow that exact rollout. A scheduled change offers **View schedule**. You can also find it under [**Activity → Deployments**](/#/deployments) and on each device's **Pipeline** view.

Selecting devices does not publish unfinished field edits. Resolve pending edits and [check the pipeline](#/docs/pipelines#validate-test-publish) first.

## Save and recover agent settings

In **Agent settings**, choose **New settings**, name the saved settings, and review the check-in interval, configuration sync and metrics options. **Save settings** saves a template. It does not assign it to devices or verify that an agent has applied it. Use **Apply to devices** separately to review a target set and deployment.

Before sending, the browser saves the exact name, settings and request ID for your signed-in account. If a reply is lost, takes too long or cannot be confirmed, keep that request and use **Review settings requests**. **Check status** looks up its exact identity. A missing result may still be in flight; only **Retry same request** explicitly resends the frozen original contents. Nothing is retried or deployed automatically. Rejected attempts also retain their reminder because another tab may have completed the same request.

Closing or reloading keeps reminders in this browser. **Your settings requests** finds server-saved requests for your account when local reminders are unavailable or you use another device. That history can confirm a result but cannot reconstruct a missing original request for retry. A matching name or equal settings are not proof of the same request.

Review unresolved or unreadable reminders before saving new settings. A readable original request ID permits a status lookup even if its local contents are damaged; it does not permit reconstruction or retry. **Dismiss reminder** removes only the reviewed browser reminder, without cancelling server work or deleting saved settings. A repaired or replaced reminder from another tab is preserved. Working browser storage and a server supporting exact request recovery are required before sending new settings.

**Agent settings saved** remains a known result if the browser cannot clear its reminder; resolve the separate storage warning before starting a new request. To change the original options after an uncertain attempt, check its status and recent requests first, then deliberately dismiss the reminder and review a new save. A timeout ends browser waiting, not server work already received.

## Review the target set

The target set is the union of selected devices and group members, minus exclusions. Re-preview after changing selection. Preview uses concrete device identities, so a name or selected count is not enough to verify the final scope.

| Target membership option              | Behavior                         | Useful for                                               |
| ------------------------------------- | -------------------------------- | -------------------------------------------------------- |
| **Only the selected devices**         | Snapshot membership at creation. | A controlled release to the reviewed list.               |
| **Also include future group members** | Persistent membership rules.     | A group whose new members should inherit the assignment. |

Review persistent target refreshes in Activity. Scheduling uses a snapshot so the waiting deployment's target membership stays fixed.

A full-mode document needs full-mode target devices. The dashboard cannot grant that permission: a host operator must [change the local mode](#/docs/installation#change-an-existing-devices-mode). A device must also report the pinned Vector 0.58.0 version for this release. Preview names affected devices and marks each blocked device in the review table, including both reasons when a device has both problems. Sending is disabled until they are resolved. The server checks again at creation, scheduled activation, group expansion and each canary wave, so a device that changes after preview is not silently admitted. Even a compatible device still needs the correct OS build, files, credentials, ports and service access.

## Review changes to a group

Group membership can change both pipeline and agent-policy assignments that include future group members. If another operator changes the group while you are editing, **This group changed** keeps your local edits and shows the latest saved name, description, and the devices your selection would add or remove.

Choose **Use latest name**, **Use latest description**, or **Use latest members** where appropriate, or deliberately keep your edits. **Continue editing** accepts that reviewed starting point without saving. Check the resulting form, then choose **Save changes** separately. A further concurrent change requires another review. Retired device identities are not replaced automatically by devices with the same name.

If an existing group's save response is lost or takes too long, **Review saved group** reads the current group before another save is allowed. Matching saved values do not prove which request saved them. Stopping the wait does not cancel server work. An older server without group revision support permits viewing but must be updated before existing groups can be edited safely.

New group creation saves the original name, description, device identities and a request ID in this browser before sending. If the response is uncertain, choose **Close and review request**, then **Review group requests** and the saved request. Closing or reloading keeps this reminder. **Check status** reads that exact request; a missing result may still be in flight. Only **Retry same request** resends the saved contents with the same ID. It does not create a second group if the first request already succeeded. No retry happens automatically.

**Group confirmed** shows the current saved group, which another operator may have renamed or edited since creation. **Open group** opens that exact identity. **Your recent group requests** can find server-saved requests for your account after browser reminders are lost or from another device. This list can look up results; it cannot reconstruct missing original contents for a retry. A deleted original group is not recreated by retrying its request.

Review unresolved requests before creating another group. **Dismiss reminder** removes only the browser reminder, without cancelling server work or deleting a group. If a reminder is unreadable, use its status lookup or recent requests before deliberately dismissing it. Recoverable creation requires working browser storage and an updated server; an older server is blocked before sending rather than receiving an unsafe unkeyed request.

Failed checks and rejected attempts also retain the original group request: another tab may have completed it. The form keeps the error visible and offers **Close and review request**. Check its status before retrying or deliberately dismissing the reminder to review a corrected request.

## Check active canaries

If an active canary overlaps the selected devices for the same kind of assignment, the preview links to it and prevents sending. Wait for it to finish or review its pause/cancel controls deliberately. Creation checks again because another operator can start a rollout after your preview.

The same protection applies when adding group members would expand a persistent assignment into another active canary. The group save is rejected without changing its membership or releasing targets. Your local edits remain in the form. **Review active deployments** opens the active list in another tab; it does not pause or cancel anything. After resolving the overlap deliberately, return to the group and choose **Save changes** again. A membership removal or an unrelated resource does not create that overlap.

## Recover a lost deployment response

If a connection drops after you confirm, **Confirm deployment** checks whether the original request was saved. The response must identify that exact request before the dashboard clears its reminder or offers a retry. **Retry same request** resends the frozen reviewed request with the same identity; a supporting server returns the original deployment instead of creating another. A missing result can still be in flight, so do not start a replacement based only on **Check status**.

You can close the dialog or browser tab and reopen recovery from the reminder when you return. Reminders are shared across tabs in this browser and shown only to the account that sent them. If several requests need attention, choose **Review requests** to select one. Confirming or dismissing one reminder leaves the others intact. Browser local storage must be available before sending; it holds target IDs and reviewed options, not login credentials or pipeline content. Clearing browser data removes these reminders, and another browser does not have their original reviewed requests.

If a saved reminder cannot be read, **Review requests → Review unreadable reminder** keeps it visible. When its original request ID is available, **Check status** can confirm the server result. It cannot retry or reconstruct the damaged request. If the ID is unavailable, use deployment history and **Your recent requests**. A missing result, a failed lookup or an incompatible response leaves the reminder unresolved.

Unreadable reminders and unavailable browser storage block new deployments and rollbacks. Resolve the displayed reminders, or deliberately choose **Dismiss reminder** after reviewing history. Dismissal removes only the reminder you reviewed; if another tab has repaired or replaced it, the dashboard preserves that newer record. A confirmed server result remains available even if the browser cannot clear its reminder. **Refresh reminders** checks again when storage becomes available or more reminders remain to be reviewed.

If you no longer have the reminder, open [**Activity → Deployments**](/#/deployments) and choose **Your recent requests** on a supporting server. This lists requests saved for your account across tabs and devices. Filter deployments or rollbacks, then open the exact resulting deployment; a rollback also links to its original rollout. Use **Refresh** to check again. This history confirms that a request was saved, not that devices applied it. Missing entries may still be in flight or may never have reached the server; the list cannot reconstruct the original request for retry.

New deployments and rollbacks require a server that can confirm the original request identity. An older server asks for an update before you send. Existing reminders remain available: update the server and check their status, or use history for requests originally sent without retry support. Missing or mismatched response identity keeps the reminder and prevents another send until a compatible status check succeeds.

Recovery shows the original deployment's current state. Its status or target membership may have changed since creation; that does not turn it into a different request. **Dismiss reminder** only removes the browser reminder; it does not cancel a deployment. Check history before dismissing or creating a replacement. A confirmed deployment still needs device verification.

If a deployment or recovery response takes more than 30 seconds, the dashboard stops waiting and lets you check the original request. This does not cancel work on the server. Use the same recovery flow rather than starting another deployment.

Rejected deployment and rollback attempts keep their saved request too. An error from one tab cannot rule out success from another. Recovery shows the reason and checks the original request. Retry preserves its reviewed targets and options; changing them requires checking history, deliberately dismissing the reminder and reviewing a new request. Nothing is resent automatically.

## Understand priority

The highest-priority candidate assignment wins for its resource. It must still pass rollout admission before changing the device. Different payloads at equal priority produce a conflict rather than an arbitrary winner. Pipeline and agent-policy assignments are separate.

For example, a pipeline assignment at priority 200 takes precedence over one at 100 for a shared device. Creating a different pipeline assignment at the same winning priority 200 produces a conflict. Resolve it by choosing deliberate priorities or unassigning an obsolete assignment; do not repeatedly retry the device.

The same rule applies to agent settings: a pause request at priority 100 cannot replace a sync-enabled policy at priority 200. The preview shows **Higher priority wins (200)** and links to that assignment. **No current priority conflict** means only that current priorities allow the request; it does not mean the device is compatible or that the agent has received or applied it. A higher-priority canary can take precedence even before that device is released. Schedule previews compare current assignments, which can change before the schedule runs.

Use **Back to selection → Advanced options** to deliberately change priority. The dashboard never raises it automatically. If an older server cannot report priority outcomes, the preview says they are unavailable instead of predicting a change.

## Choose a rollout

**All selected devices** releases the assignment to the entire target set. **Start with a canary, then batches** releases an initial subset, observes its reported result for the configured interval, then releases later batches when the gate permits.

For a small trial, select a canary of one device, a batch size appropriate to your fleet, and an observation interval long enough to notice application problems. Inspect the canary's actual pipeline state and destination behavior before relying on rollout progress. A healthy startup does not prove every downstream delivery requirement.

Offline, failed or unverified devices are not successes. [**Activity → Deployments**](/#/deployments) shows release progress, failures and gate decisions. A scheduled deployment is a future release, not an already running staged process. Review a missed schedule before taking further action.

In active or paused canary details, **Recorded progress** preserves past application results. **Canary gate** separately shows how many released devices have current verification for this assignment. A device that previously verified this version cannot satisfy the current gate while another assignment is effective, its heartbeat is stale, configuration sync is paused, or current application cannot be verified.

The gate explains what needs review:

- **Another assignment is effective:** inspect the device's current assignment and priority before changing the rollout.
- **Waiting for a fresh heartbeat:** check the device connection; a previous success does not replace a fresh report.
- **Configuration sync is paused:** review local and remote pause settings. A host-owned local pause cannot be cleared remotely.
- **Current application is not verified:** inspect the current version, agent settings and reported issues on the device.
- **Device is unavailable:** inspect the original device identity and target membership; a recovered replacement identity is not inferred.

**Observation in progress** means the server is checking current evidence throughout the configured observation period. It is not a countdown or a promise that the next batch will be released. Pausing the rollout or losing qualifying evidence requires a new observation period once current verification is restored. Policy rollouts use acknowledgement of the current agent settings; a policy that intentionally pauses configuration sync can still be verified.

Use **Refresh** in the gate panel to read current evidence without changing the rollout. Target messages refer to their exact device identities; a target with no gate message may simply be waiting for release. If gate details are unavailable, including on an older server, recorded progress alone does not establish readiness.

When an agent rejects a new version, its failed attempt belongs to that assignment even if an older version remains the last verified configuration. The canary counts the current attempt's failure; a delayed failure from an older assignment cannot count against a new retry. Older agents that do not identify their attempts may leave progress waiting for confirmation. Review device activity and update the agent before relying on detailed failure attribution.

Upgrading does not relabel an old cached failure as a newly observed attempt. If no current attempt is reported afterward, create a new reviewed deployment or have a host operator use `vectory retry` with the daemon stopped, then restart it to observe a fresh attempt.

## Read the apply states

| State                          | What it establishes                                                                             | What to do                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Pending, Downloaded, Validated | Work is queued or preparation has succeeded.                                                    | Wait for activation; these are not proof of a running workload.       |
| Applying, Starting Vector      | Replacement and startup are in progress.                                                        | Watch for a terminal result and a fresh heartbeat.                    |
| Applied                        | The agent observed its owned process startup, continued liveness and the expected managed file. | Check version, timestamp and operational behavior.                    |
| Apply failed                   | A required step failed.                                                                         | Read the device issue and fix the pipeline or host dependency.        |
| Rolled back                    | Activation failed and the last verified configuration was restored.                             | Investigate the failed version; the desired version may still differ. |
| Check required                 | The current process state cannot be verified.                                                   | Inspect the host and reported issue before retrying.                  |

An offline device's last result is historical. Reconnection and fresh reports are needed to establish current state. With [local credential bindings](#/docs/resources#rotate-a-bound-credential), the template and rendered file digests can differ legitimately.

In device **Technical details**, **Assignment progress** and **Current assignment attempt** describe the desired configuration. **Last verified generation** records the last confirmed application; it does not advance when a new attempt fails. **Reported workload state** retains the agent's separate local observation. A file remaining on disk or a successful download does not establish that Vector is running it.

## Find a deployment or device result

Open [**Activity → Deployments**](/#/deployments) to search by pipeline or deployment name, version, or status. Use the filter beside the **Status** column header to focus on changes that need attention, are still in progress, or have completed. Select a column title to sort the complete result set, and select it again to reverse the order. **Refresh** checks for updates immediately; the page also refreshes automatically.

[**Schedules**](/#/schedules) includes upcoming schedules and their history, including completed, cancelled and missed schedules. Choose **Scheduled** in the **Status** column filter to see only changes still waiting to start. Dates use your browser's local time zone.

Before a schedule starts, open **Update scheduled devices → Review scheduled devices** to compare its saved selection with the current proposal. Review devices being added, kept and removed. Search, filters and paging only change this view; confirmation includes the complete reviewed proposal. Refreshing the selection does not release devices, change their running workload or verify application.

**Update scheduled devices** checks that the saved snapshot and proposed membership still match the review. If either changed, choose **Refresh review**, inspect the new selection, then confirm separately. An older confirmation cannot replace a newer saved selection even if group membership later returns to the same devices. An empty proposal or incompatible server cannot enable confirmation. Nothing is resent automatically.

If confirmation times out or its reply cannot be read, use **Check current selection**. This reads the saved snapshot; matching devices establish only what is saved now, not which request saved them or whether an earlier request can still finish. A changed selection requires a fresh review and separate confirmation. If the schedule has started or become inactive, review its current status instead of refreshing it. Closing and reopening details in the same tab retains the unresolved context; after reloading the page, review again. A timeout does not cancel server work already received.

Assignments are checked again when a schedule becomes due. An overlapping active canary for the same resource blocks the entire schedule before any device is released, even if the schedule was created first. Its status becomes **Needs attention**; overlapping devices show **Blocked** with the reason, and remaining devices show **Not released**. Review and deliberately pause or cancel the overlapping canary before creating a new deployment. The failed schedule does not retry automatically.

Open a deployment to see its overall progress, then search **Device results** or use its **Progress** column filter. The overall verified count covers the whole deployment, even when only one page of devices is visible. **No reported error** means no error message was recorded; only **Applied and verified** counts as verified application. Select a device name to inspect its connection, pipeline and issues. Returning to Activity keeps your search, status and page until you reload or sign out.

When a device leaves a current persistent assignment (active, paused or completed), including through revocation or identity recovery, its result shows **No longer targeted**. Its original identity and place in the deployment history remain, but it is excluded from the current verified count. Any **Last reported error** is historical context. A rollout can be **Complete** for its current members while still retaining these removed results; that does not mean every historical target verified the change. Snapshot deployments and stopped assignments keep their recorded target states.

A retired device link opens that exact old identity. Recovery creates a separate identity; review and explicitly target the replacement rather than assuming it inherited the old deployment. Re-adding a device to a persistent assignment requires ordinary admission and fresh verification.

Use **Copy link** in deployment details to share or bookmark that exact rollout. The link keeps its Deployments or Schedules origin and the list search, status and page you opened it from. It works after a refresh or sign-in, and opening a deployment name in a new tab works too. Anyone following the link needs their own account and existing permissions. Opening a link never starts or changes a deployment. If clipboard access is unavailable, select and copy the displayed link manually.

## Pause, cancel and unassign

These actions affect different things:

| Action                   | Effect                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Pause rollout            | Stops further release; does not undo devices already updated.                                                  |
| Pause configuration sync | Keeps the current workload while stopping reconciliation on affected devices.                                  |
| Local `vectory pause`    | Host-owned pause that remote resume cannot remove.                                                             |
| Cancel rollout           | Stops further release. Assignments already delivered can remain effective.                                     |
| Remove assignment        | Removes the assignment binding and re-evaluates the desired configuration. It does not inherently stop Vector. |

Open **Remove this assignment → Review assignment removal** to inspect each device's **Current desired state** and **After removal**. The review identifies the next assignment and pipeline version or agent policy. If no configuration assignment remains, the device becomes unmanaged and keeps its established local workload; removing the assignment does not stop Vector. If no policy assignment remains, the default agent policy applies. A host-owned local pause stays in effect. Learn more about [local maintenance](#/docs/installation#local-maintenance-and-recovery).

When the next winning assignment has not been released by its rollout, the review explains that the current desired state remains while that rollout waits. Revoked, missing or no-longer-targeted devices are identified separately, and a device may have no desired-state change. These are projected desired-state effects, not proof that an agent applied or verified them. Search, filters and paging only change the view; they do not remove devices from the reviewed scope.

Choose **Remove assignment** only after reviewing the full effect. The server checks the reviewed membership, assignments and delivered desired state again before committing. If they changed, choose **Refresh review**, inspect the new effects, then confirm separately. A rejected or blocked review does not automatically refresh, change priorities or retry. The dashboard requires a supporting server and will not fall back to an unreviewed removal.

If the removal response is lost or times out, use **Check current status**. Nothing is resent automatically, and closing then reopening the removal dialog keeps this check required. A failed status read leaves the outcome unresolved. **Assignment is currently removed** reports the latest state; it does not prove which request removed it. If the assignment still exists, refresh and review its current effects before a separate confirmation. A timeout does not cancel server work already in progress.

**Resume rollout** checks the current device scope against other active canaries for the same kind of assignment. If there is an overlap, the rollout stays paused and no additional devices are released. **Review active deployments** opens the active list in a new tab without changing any rollout. Wait for the overlapping canary to finish, or deliberately review its pause/cancel controls. Then return and choose **Resume rollout** again. Vectory does not automatically pause the other rollout, raise priority or retry the resume.

If a pause, resume or cancel response cannot be confirmed, choose **Check current status** before trying another action. A timeout does not cancel work already received by the server. The dashboard keeps further actions unavailable until a fresh status read succeeds; a failed read is not proof that the action failed.

## Roll back deliberately

1. Open [**Actions → Version history**](/#/configurations?panel=history) on the pipeline.
2. Select the prior published version and start deployment.
3. Review its target set, priority and rollout as carefully as a new release.
4. Confirm the device reports the intended version as **Applied**.

Rollback creates a newer desired generation; it does not rewrite immutable history. The older version is checked against today's secrets, files and services, so it can still fail validation.

The **Roll back** shortcut opens **Review rollback**. Check the prior pipeline version, then review **Included** and **Excluded** devices. Released, eligible devices share one previously managed version; offline devices remain included. Revoked, missing, removed or never-released devices are listed separately with their reasons. Replacement identities are not added automatically, and the original deployment history stays intact. Search and paging help inspect the full reviewed scope; they do not change it.

Read the effect on the original rollout before confirming. Normally, rollback stops its remaining releases and creates a higher-priority snapshot deployment for the included devices. At the maximum priority of 1,000,000, it removes the original binding and creates the replacement at that same priority; the original is then shown as **Removed**. Only **Roll back N devices** sends the request. Each included agent must still validate and verify the prior version.

If the review is blocked, resolve the stated reason or create a new deployment with a deliberately reviewed target set. Different previously managed versions need separate deployments of the appropriate versions. A competing assignment, or an unsafe effect on excluded devices when stopping the original rollout, can also block the review. Vectory does not silently raise the reviewed priority or substitute a new device identity. If assignments or eligibility change before confirmation, use **Refresh review**, inspect the new scope, then confirm separately. A rejection does not automatically update or resend your request. Older servers must be updated before offering a new reviewed rollback; existing request reminders remain available for recovery.

After a failed attempt, fix the cause and use **Retry** where available, or publish and deploy a corrected version. Identical failed attempts are suppressed to avoid endless restarts. On the host, `vectory retry` requires the daemon to be stopped. A retry requests another attempt; it is not evidence of success.

After using **Roll back**, choose **View rollback deployment** to follow the exact replacement. If its response is lost, **Confirm rollback** checks or retries the original reviewed request on a supporting server, including after closing a tab or reloading in the same browser. Recovery preserves the reviewed version, included devices and exclusions; it does not silently fetch and apply a new scope. The original deployment and its replacement have separate identities. For an older request without retry support, check history before trying again; the dashboard will not blindly resend it.

**Retry application** on a device applies only to the desired version and generation currently shown. The server rejects the request if that assignment changed, the device no longer has a retryable state, or sync is paused. Refresh, inspect the new state and decide again; Vectory does not automatically retry the replacement assignment or resume paused sync. Older servers without this check require an update before the dashboard offers this action.

Retrying an individual device does not restart a canary that stopped at its failure threshold, or release its waiting devices. Review the failure and create a new deployment with the intended targets and rollout policy, or roll back the released devices.
