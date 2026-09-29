# Monitor devices

See which devices are healthy, what they run and how much data flows through them. Three signals answer different questions: a recent check-in means the agent is connected, **Applied** means Vector runs the version, and throughput means events are moving.

## Read a device

Open [**Devices**](/#/devices) and select a device.

| Section | Tells you |
| --- | --- |
| Header | Status (for example **Applied** or **Updating**), connection, last check-in, **Open rollout** and **Deploy a pipeline**. |
| **Running vs desired** | The version the device should run, what it runs now, and each apply step. **View pipeline assignment** opens the deployment that decided it. |
| **Operational metrics** | Throughput, errors, discarded events and buffers, when the pipeline exports metrics. |
| **Recent Vector warnings and errors** | Vector's own warnings and errors from the last hour, redacted on the device. |
| **Activity** | This device's open issues and recent changes. |
| **About this device** | Platform, Vector and agent versions, mode, groups and the agent settings in force. **Upgrade agent** is here. |
| **Sync, recovery and access** | Pause sync, device recovery and **Revoke device identity…**. |

A pipeline and agent settings can come from different deployments with different priorities. When something is unknown, the page says so; it never guesses an assignment.

**No pipeline** doesn't mean Vector is stopped. A device that kept its existing workload runs it until you deploy a version. A new device with no configuration waits without starting Vector. Use **Deploy a pipeline** to deploy one.

## Enable real metrics

Vectory reads metrics from a Prometheus exporter in your own pipeline. It never inserts components by itself.

<!-- steps -->
1. In the editor, open **Actions** and choose **Add monitoring**. It adds an `internal_metrics` source and a `prometheus_exporter` sink on `127.0.0.1:9598` (the next free port if that one is taken), without changing your other steps.
2. On restricted devices, allow the listener: add `127.0.0.1:9598` to `allowed_listen_addresses` in the device's [allowances](installation.md#configure-restricted-allowances).
3. Publish and deploy the pipeline.
4. Open the device's **Operational metrics**. Numbers appear within two check-ins: rates need two samples.

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

| Measurement | Means | Don't read it as |
| --- | --- | --- |
| **Throughput** (In / Out) | Events per second leaving sources and entering sinks. | Delivery confirmed by the destination. |
| **Errors / min** | Component errors per minute; the tile also shows the total since Vector started. | Lost events. |
| **Dropped due to errors** | Events components discarded because of errors. | Filtering. |
| **Filtered out (expected)** | Events a filter, route or sample removed on purpose. | A fault. |
| **Buffer fill** | How full the fullest buffer is, with the bytes buffered. | Empty, when missing. |
| Components table: **In / s**, **Out / s**, **Errors / min**, **Dropped / min**, **Filtered / min** | The same numbers per component. | Unique events: one event passes several components. |
| **Vector uptime**, **Memory**, **CPU time** | The Vector process. | The agent's check-in. |

A rate needs two samples, so the first sample shows no rate. A Vector restart resets counters; Vectory never shows negative throughput. A dash means the value wasn't reported: it isn't zero. Some exporters, such as Vector's on Windows, don't report CPU or memory.

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

[**Activity → Issues**](/#/issues) lists problems devices reported, such as a version that failed to apply. Each issue names the device, the version and the reason, and links to the device and the deployment. Issues are grouped by version and reason; choose **All issues** for one row per device.

- An issue resolves by itself when the device next applies a version and confirms it.
- **Acknowledge issue** records that you've looked into it, with an optional note. **Reopen issue** brings it back. Both are recorded in the audit log.
- A new failure after an acknowledgement reopens the issue.

## Retry a failed application

Fix the cause first, then choose **Retry application** on the device. The retry is tied to the version shown; if a different deployment has taken over since, the server refuses it and the page shows the current state.

A lost reply doesn't mean the retry failed: choose **Check status**, which only reads. Retry doesn't resume paused sync. A host pause needs `vectory resume` on the device.

## Revoke device access

Operators and Administrators can open a device's **Device access** section and choose **Revoke device identity…**. The dialog shows the exact device; confirm with **Revoke identity**.

Revocation blocks the device's certificates at once and removes it from groups and from deployments that follow group membership. It doesn't stop Vector or delete files on the host. To remove the agent too, see [Remove the agent](agents.md#remove-the-agent).

Revocation is permanent for that identity. To bring the host back, [recover its identity](agents.md#recover-a-device-identity): it returns as a new device.
