# Monitor devices

See which devices are healthy, what they run and how much data flows through them. Three signals answer different questions: a recent check-in means the agent is connected, **Applied** means Vector runs the version, and throughput means events are moving.

## Read a device

Open [**Devices**](/#/devices) and select a device.

<!-- verify-after-merge: device page section names after W6's redesign (running vs desired header, timeline) -->
| Section | Tells you |
| --- | --- |
| Connection | Whether the agent checked in recently, and its mode, agent version and Vector version. |
| **Pipeline** | The version the device should run, what it runs now, and the deployment that decided it. **View pipeline assignment** opens that deployment. |
| **Agent settings** | The check-in interval, sync and metrics settings in force, and the deployment they came from. |
| **Metrics** | Throughput, errors and per-component numbers, when the pipeline exports them. |
| **Activity** | This device's issues and audit history. |

A pipeline and agent settings can come from different deployments with different priorities. When something is unknown, the page says so; it never guesses an assignment.

**No pipeline assigned** doesn't mean Vector is stopped. A device that kept its existing workload runs it until you deploy a version. A new device with no configuration waits without starting Vector. Use **Choose pipeline** to deploy one.

## Enable real metrics

Vectory reads metrics from a Prometheus exporter in your own pipeline. It never inserts components by itself.

<!-- verify-after-merge: agent auto-discovery of a loopback prometheus_exporter (W2) -->
<!-- steps -->
1. In the editor, open **Actions** and choose **Add monitoring**. It adds an `internal_metrics` source and a `prometheus_exporter` sink on `127.0.0.1:9598` (the next free port if that one is taken), without changing your other steps.
2. On restricted devices, allow the listener: add `127.0.0.1:9598` to `allowed_listen_addresses` in the device's [allowances](installation.md#configure-restricted-allowances).
3. Publish and deploy the pipeline.
4. Open the device's **Metrics**. Numbers appear within two check-ins: rates need two samples.

The agent finds a loopback exporter in the running configuration by itself. The fragment it looks for is:

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

Keep the exporter on a loopback IP. Metrics also need **Collect operational metrics** on in the device's agent settings, which is the default.

Metrics are bounded operational numbers. They never include event contents.

## Change or remove a metrics endpoint

To read metrics from an exporter the agent can't find by itself, set its URL on the device, with the agent stopped:

```sh
sudo vectory service-stop
sudo vectory configure-metrics --metrics-url http://127.0.0.1:9598/metrics
sudo vectory service-start
```

The URL needs a literal loopback IP, a port and a path. `--clear-metrics-url` removes a saved URL. Choose one or the other.

| To | Do this |
| --- | --- |
| Pause collection for a while | Turn off **Collect operational metrics** in the device's agent settings. The URL stays. |
| Stop reading a custom endpoint | `vectory configure-metrics --clear-metrics-url` on the device. |
| Remove the exporter itself | Remove the monitoring components from the pipeline, then publish and deploy. |

Clearing the URL doesn't remove the exporter from the pipeline, and old samples stay in history with their timestamps.

## Interpret the numbers

<!-- verify-after-merge: metric names and the discarded split in TelemetryPanel (W2) -->
| Measurement | Means | Don't read it as |
| --- | --- | --- |
| Throughput | Events per second sent by sources, excluding the metrics source itself. | Delivery to the final destination. |
| Component events / s | Events per second sent by one component. | Unique events: one event passes several components. |
| Errors | Errors reported since Vector started. | A rate, or a count of lost events. |
| Discarded | Events a component dropped: filtered out on purpose, or dropped due to errors. | Always a fault: filters discard by design. |
| Buffered | Data waiting in a buffer. | Empty, when the value is missing. |
| Vector uptime | How long Vector has run. | The agent's last check-in. |

A rate needs two samples, so the first sample shows no rate. A Vector restart resets counters; Vectory never shows negative throughput. A dash means the value wasn't reported: it isn't zero. Some exporters, such as Vector's on Windows, don't report CPU or memory.

## Delivery health

Applied means Vector runs the version. Delivery is a separate question, so Vectory also checks each device's metrics at every check-in against the version it runs:

- **Sink errors:** a sink fails at least one request a minute.
- **Stalled:** events arrive, but less than 1% is delivered and a sink is struggling.
- **Buffer filling:** a buffer is over 80% full and rising, or over 95% full.
- **Error drops:** a component drops at least one event a minute because of errors.

A problem opens an issue after two checks in a row (three for a stall) and closes by itself after three clean checks, so one noisy sample neither alarms nor heals. A sink counts as recovered only when its buffer is seen low or it sends events again: silence isn't recovery. If you turn metrics off for a device, its delivery issues close as **unmonitored**, because Vectory can no longer check. Meanwhile the device reads **Degraded**, the **Devices** list shows its events in and out (for example `5.0 → 0`), and **Needs you** on the Overview names the component and the fix. Canary rollouts wait for a few healthy checks before they release more devices, and a canary that isn't delivering fails like one that couldn't apply. See [A pipeline applies but delivers nothing](troubleshooting.md#a-pipeline-applies-but-delivers-nothing).

## Read history and gaps

Hover over the throughput chart, or focus it and use the arrow keys, to read a sample. Expand the sample history for exact values.

History is kept for 7 days by default and bucketed by minute. A gap means no sample arrived. Old samples stay after a device goes offline, so check the timestamp before treating a number as current.

## Investigate a change

Suppose throughput drops while buffered data grows:

<!-- steps -->
1. Check the last sample and check-in times, so you know the numbers are fresh.
2. Look at the destination's error and sent counters.
3. Compare with **Activity**: a deployment, restart, pause or local change at that time.
4. Check the destination and the device itself. Vectory doesn't collect events or Vector's full logs for you.

This pattern points to a slow or failing destination, but confirm it with the destination's own monitoring.

## Work with issues

<!-- verify-after-merge: issue grouping, acknowledgement on live devices and recovery actions (W2) -->
[**Activity → Issues**](/#/issues) lists problems devices reported, such as a version that failed to apply. Each issue names the device, the version and the reason, and links to the device and the deployment.

- An apply issue resolves by itself when the device next applies a version and confirms it.
- A delivery issue (**Degraded**) resolves by itself after three clean checks, or when the device stops running that version.
- **Acknowledge issue** records that you've looked into it, with an optional note. **Reopen issue** brings it back. Both are recorded in the audit log.
- A new failure after an acknowledgement reopens the issue.

## Retry a failed application

Fix the cause first, then choose **Retry application** on the device. The retry is tied to the version shown; if a different deployment has taken over since, the server refuses it and the page shows the current state.

A lost reply doesn't mean the retry failed: choose **Check status**, which only reads. Retry doesn't resume paused sync. A host pause needs `vectory resume` on the device.

## Revoke device access

Operators and Administrators can open a device's **Device access** section and choose **Revoke device identity…**. The dialog shows the exact device; confirm with **Revoke identity**.

Revocation blocks the device's certificates at once and removes it from groups and from deployments that follow group membership. It doesn't stop Vector or delete files on the host. To remove the agent too, see [Remove the agent](agents.md#remove-the-agent).

Revocation is permanent for that identity. To bring the host back, [recover its identity](agents.md#recover-a-device-identity): it returns as a new device.
