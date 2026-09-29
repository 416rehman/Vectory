# Monitor devices

Start with connection and pipeline status, then open the device's **Metrics** and **Activity** tabs. A recent heartbeat proves the agent checked in; **Applied** describes a reported activation; throughput describes observed event processing. None of these alone proves end-to-end delivery.

## Understand the device's assignments

On the **Pipeline** tab, **View pipeline assignment** opens the exact deployment currently governing the device's published pipeline. **Agent settings** shows the separate server policy for check-in interval, metrics and configuration sync. When its assignment is reported, **View settings assignment** opens that rollout and shows its priority. Configuration and settings can come from different assignments with different priorities.

These links open the identified deployment with a clear list context, so previous deployment searches or filters do not hide it. **Technical details** retains each reported assignment ID, priority and selection reason. A missing assignment link or missing policy metadata is shown as unavailable; the dashboard does not guess an assignment or assume default settings.

Device, metrics and linked pipeline details must match the record requested by the page. A mismatched reply is rejected and offers a fresh read; it never switches the page to another device or pipeline. Follow [mismatched device details](#/docs/troubleshooting#a-device-page-shows-mismatched-details) if that error persists. These records load separately, so a successful read is not a guarantee that an assignment has remained unchanged since the device last reported it.

**No pipeline assigned** does not establish whether Vector is running. An adopted local workload may continue without a published assignment. A newly enrolled device with no managed configuration checks in without starting Vector and waits for a first deployment. A reported file digest is evidence about a file, not a live process. Use **Choose pipeline** to select a published pipeline for this device, or inspect the workload locally. See [adoption and an empty start](#/docs/installation#keep-an-existing-workload).

## Revoke device access

An Operator or Admin can open a device's **Device access** section and choose **Revoke device identity…**. The dialog checks that exact identity before allowing confirmation. Review the device name and the consequences, then choose **Revoke identity**.

Revocation blocks that identity's credentials from future authenticated requests. It also removes the device from groups and current persistent assignment targets. It does not remotely stop Vector or erase local files. Inspect or stop the workload through the host's existing supervisor when that is your intent.

**Device access revoked** means the server has confirmed the state of that exact identity. It does not claim which administrator's request caused the change. Repeating revocation for an already revoked identity does not repeat its cleanup or add another success audit entry.

If the response is lost, the dashboard checks status without sending another revocation. **Check revocation** remains available after closing the dialog or reopening the page in the same browser profile and account. Each request stops waiting after 30 seconds; closing the dialog ends the browser wait, but a submitted request may still complete. Follow [interrupted device revocation](#/docs/troubleshooting#a-device-revocation-is-unconfirmed) when status cannot be established.

Restoring access requires an Admin to authorize [device identity recovery](#/docs/installation#recover-a-device-identity) and a host operator to complete it. The replacement receives a new identity; review and restore its groups and assignments explicitly. Revoking the old identity does not revoke the replacement.

## Enable real metrics

Vectory does not insert monitoring components. Add an `internal_metrics` source and a `prometheus_exporter` sink to the pipeline yourself:

```json
{
  "sources": {
    "vector_metrics": { "type": "internal_metrics" }
  },
  "sinks": {
    "local_metrics": {
      "type": "prometheus_exporter",
      "inputs": ["vector_metrics"],
      "address": "127.0.0.1:9598"
    }
  }
}
```

This is a monitoring-only fragment. Merge its components into the existing `sources` and `sinks` maps rather than replacing your business pipeline. Keep the listener on an explicit loopback IP. Restricted mode also needs `127.0.0.1:9598` in the local listener allowances.

Then:

1. Stop the agent through its existing supervisor. This also stops its supervised Vector process. Set the local scrape URL:

   ```sh
   vectory configure-metrics \
     --state-dir /var/lib/vectory-agent \
     --metrics-url http://127.0.0.1:9598/metrics
   ```

2. Check that the command succeeded, then restart through the same supervisor and deploy the pipeline containing the exporter.
3. Enable telemetry in the effective agent settings for the device.
4. Wait for successive samples, open **Metrics**, and check **Last sample**. Use **Refresh metrics** to reload reported history.

Use the existing state directory and supervisor throughout; the [local settings procedure](#/docs/installation#update-local-agent-settings) covers permissions and refused updates. Saving a scrape URL does not create an exporter or prove that metrics are available.

The agent requires a literal loopback IP, explicit port and path; scrape redirects are disabled. It sends bounded operational measurements, not event payloads. Vector's [monitoring guide](https://vector.dev/docs/administration/monitoring/) explains the native metrics components.

## Change or remove a metrics endpoint

Use `configure-metrics` while the agent is stopped. To move collection to another loopback exporter, repeat the setup command with its new URL. To remove the saved endpoint:

```sh
vectory configure-metrics \
  --state-dir /var/lib/vectory-agent \
  --clear-metrics-url
```

On Windows, use the installed executable and state directory, for example:

```powershell
& 'C:\Program Files\Vectory\vectory.exe' `
  configure-metrics `
  --state-dir C:\ProgramData\Vectory `
  --clear-metrics-url
```

Choose exactly one action: `--metrics-url URL` or `--clear-metrics-url`. An empty URL, both options together, an unexpected positional argument or `--clear-metrics-url=false` is rejected without updating settings. Repeating a clear leaves an already empty setting unchanged. The command preserves enrollment, secret bindings, capabilities, pauses and retry state.

Check the result before restarting through the same supervisor. On the next run, a cleared endpoint means the agent does not scrape local metrics, even if the effective agent settings still allow collection. `vectory doctor --state-dir PATH` reports that no local endpoint is configured. Clearing the setting does not immediately erase stored local state; the next poll refreshes local telemetry. Previously reported dashboard samples remain historical, so check their timestamps.

To temporarily stop collection remotely, turn off **Collect operational metrics** in the device's effective agent settings instead. This preserves the local URL for later use. Clearing the URL does not remove or stop the pipeline's exporter. To retire that listener too, separately remove its monitoring components from the pipeline, review and publish the change, then deploy it and verify the result.

Existing-install maintenance also accepts `install --clear-metrics-url`, including alongside other valid settings changes. Omitting both metrics options preserves the saved URL; invalid combined options reject the request before any requested setting changes. Follow [local settings maintenance](#/docs/installation#update-local-agent-settings) for the stop, permissions and restart procedure.

Check that `vectory help` lists `configure-metrics` before using these commands. Older packages may only offer `install --metrics-url` for setting a URL. If the command or clear flag is unavailable, [upgrade the agent](#/docs/installation#upgrade-an-existing-agent) to a verified package containing this feature. A reused development version label alone does not establish support. For a refused command, follow [metrics endpoint troubleshooting](#/docs/troubleshooting#a-metrics-endpoint-update-is-refused).

## Interpret the numbers

| Measurement          | Meaning                                                                            | Common mistake                                                                             |
| -------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Source throughput    | Events sent per second by observed sources, excluding the internal-metrics source. | Treating it as delivery to the final destination.                                          |
| Component events / s | Observed sent-event rate for that component.                                       | Adding all component rates together as unique events; one event passes several components. |
| Errors               | Cumulative reported error count from the current process.                          | Treating the total as a rate or assuming every error drops an event.                       |
| Discarded            | Cumulative reported discard count.                                                 | Assuming all discards are faults; filters can intentionally remove events.                 |
| Buffered             | Observed buffer size in bytes.                                                     | Assuming an absent value means an empty buffer.                                            |
| Vector uptime        | Reported process uptime.                                                           | Confusing it with the agent's last heartbeat time.                                         |

The first counter sample needs a later sample before a rate can be calculated. A process restart or counter reset does not produce negative throughput. Compare error/discard changes over time and read the affected component's behavior.

The component table includes at most 50 observed IDs. Search it by ID or type. Only reported columns and values appear; a dash means unknown for that component. CPU time and memory are shown only when reported. The tested Windows internal exporter does not provide those resource measurements, so their absence is expected.

## Read history and gaps

Move over the throughput chart to inspect a sample. With keyboard focus on the chart, use the left and right arrow keys. Expand the sample history for exact timestamps and values.

History is bounded and bucketed, not an unbounded monitoring archive. A gap means no usable sample was reported. Disabling telemetry or losing a device connection does not erase old samples; always check the timestamp and any stale-sample notice before interpreting them as current.

## Investigate a change

Suppose throughput falls while buffer bytes rise:

1. Check the last sample and heartbeat times so you know the observation is recent.
2. Inspect the affected sink's error and sent-event counters.
3. Compare **Activity** with the change: deployment, restart, pause or local resource change.
4. Check the destination and device locally. Vectory does not upload event payloads or arbitrary Vector logs for this investigation.

This pattern suggests a processing or delivery bottleneck, but is not a diagnosis by itself. Use the component's native reference and destination monitoring to establish the cause.

## Troubleshoot in order

### Retry a failed application

Fix the reported cause first, then use **Retry application** on the device. Retry is bound to the version and desired generation shown when you click; if another assignment has replaced it, the server rejects that stale review and the page checks current status. Review the new assignment before requesting another attempt.

A lost or timed-out response means the outcome is unknown, not that the retry failed. The dashboard checks status without automatically sending another retry. **Check status** is read-only. If status cannot be loaded, Retry stays disabled until a fresh review is available. A confirmed retry requests another validation and activation attempt; wait for the agent's verification before treating it as applied.

If the displayed assignment or retry eligibility changes, the page drops the old wait and its messages. A new eligible assignment does not have to wait for the old response. Leaving the device or losing operating access also ends that page's wait. None of these events cancels a retry the server has already accepted. [Review current status](#/docs/troubleshooting#device-controls-change-while-a-request-is-pending) before deliberately requesting another attempt.

Retry does not resume paused sync. A local pause requires a host operator to resume it; a server pause requires the appropriate resume policy. Older servers without the guarded retry capability show Retry as unavailable. You can still deploy a published version after reviewing its targets.

| Symptom                                | First checks                                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Device offline                         | Is the agent running? Check its endpoint, network, server trust, clock and credentials locally.                  |
| Connected, desired version not applied | Read the device issue; inspect local/remote pause, capability mode, required files and native validation result. |
| Applied, no metrics yet                | Check exporter configuration, local `--metrics-url`, effective telemetry policy and successive sample times.     |
| Old metrics remain visible             | Read **Last available sample**; a historical value is not a fresh measurement.                                   |
| A particular metric is absent          | Verify whether the actual exporter exposes that series; absence is not zero.                                     |

`vectory doctor` helps check the adopted binary, managed path and configured local telemetry. It does not test control-plane reachability or prove credential validity. `vectory status --json` reports local state. A host-owned pause needs `vectory resume`; the dashboard cannot clear it. See [installation and maintenance](#/docs/installation#local-maintenance-and-recovery) and [deployment states](#/docs/deployments#read-the-apply-states).
