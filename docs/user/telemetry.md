# Monitor devices

See which devices are healthy, what they run and how much data flows through them. Three signals answer different questions: a recent check-in means the agent is connected, **Applied** means Vector runs the version, and throughput means events are moving.

## Find devices

[**Devices**](/#/devices) lists your fleet a page at a time, so it opens as quickly with thousands of devices as with ten. The server searches, filters, sorts and counts; the page only holds the rows you're looking at.

- **Search** matches a device's name, platform, pipeline, Vector and agent versions, and the names of its groups. Type a few letters; the list follows a moment after you stop. Labels aren't searched.
- **Quick filters** (**Failing**, **Not on desired version**, **Offline**, **Paused**, **No telemetry**) and the **Status** column filter show how many devices each holds. The counts follow your search, and a device counts in every filter that fits it.
- **Group** shows one group's devices. A group name in a row does the same.
- **Sort** by name, status, pipeline, Vector version, events per second or last seen. Names sort the way people read them, so `edge-2` comes before `edge-10`, and a device with no value sorts last in both directions.
- Devices you have revoked are hidden. Choose **Status → Revoked** to list them.

The page number, rows per page, search, filters and sort are all in the page's address, so a reload, **Back** and a copied link return to the same view.

### Select devices across pages

Tick devices on any page. The selection stays while you page, search and sort, and **12 selected** counts all of it. **Select all 1,204 matching** adds every device the current search and filters find, not only the ones on screen. It reads at most 10,000 devices; when more match, the page says how many it selected ("Selected the first 10,000 of 12,431 matching devices. Narrow the search to select the rest.") so nothing is chosen silently. **Clear selection** starts over.

With devices selected you can **Pause sync…** or **Resume sync…** for all of them. Revoked devices can't be selected.

## Read the Overview

The [**Overview**](/#/overview) reads counts from the server, never a row per device, so it opens at the same speed at any fleet size.

- **Fleet health** splits your devices by state; each count links to those devices.
- **Needs you** lists what needs a person, most urgent first.
- **Running now** answers what runs where. Each row is a pipeline version that devices report running: its name and version, how many devices run it (a link to those devices), the groups they're in (each a link to that group's devices that run it), and events in and out per second, summed over the devices that report. A note says what it is doing now: **1 not delivering** when a device applied it but isn't delivering, or **canary on edge-nyc-02 · measuring delivery** while a canary of it runs. A version no device reports metrics for reads **No metrics yet**, never a zero. Until a device verifies a version, the card reads **Nothing is running yet. Deploy a pipeline to a device.**
- **Rollouts** shows each rollout's progress with the same words as its own page: **2 of 3 devices applied · 1 not delivering**.
- **On desired version** counts devices verified on their assigned version right now. A device that is offline but last verified that version reads **1 offline, last verified v2**, never **not yet verified**. The first-run checklist keeps a step done once this browser has seen it done, so a device going offline never reopens it.
- **Fleet throughput** and **Recent changes** follow. While no device reports metrics, **Fleet throughput** says why, one reason per device, and leads with the fix that applies. For a device whose agent settings turn metrics off it reads **Turn on Collect operational metrics for edge-01 in its agent settings (“No metrics”)**, naming the saved settings the device runs. **Add monitoring to Orders** appears only when the version running on devices has no exporter, and only for editors and administrators; where a pipeline already exports, the card prints its address. A device that runs no pipeline is counted as running none, never as lacking an exporter.

## Read a device

Open [**Devices**](/#/devices) and select a device.

| Section | Tells you |
| --- | --- |
| Header | Status (for example **Applied** or **Updating**), connection, last check-in, **Open rollout** and **Deploy a pipeline**. |
| **Running vs desired** | The version the device should run, what it runs now, and each apply step. **View pipeline assignment** opens the deployment that decided it. |
| **Operational metrics** | Throughput, errors, discarded events and buffers, when the pipeline exports metrics. See [Read history and gaps](#read-history-and-gaps). |
| **Components** | Each component's events in and out, errors and buffers in the latest sample. At 1100 pixels wide or more it spans the page below the cards; on a narrower screen it is part of **Operational metrics**. |
| **Recent Vector warnings and errors** | Vector's own warnings and errors from the last hour, redacted on the device, with control characters shown as spaces. |
| **Activity** | This device's open issues and recent changes. |
| **About this device** | Platform, Vector and agent versions, mode, groups and the agent settings in force: **Check-in 15 s · applied by Ada on Sep 29 (not saved)**. The line names who applied the settings and when only when the server reports it, and says **(not saved)** for settings never saved under a name. **Upgrade agent** is here. |
| **Sync, recovery and access** | Pause sync, device recovery and **Revoke device identity…**. |

A pipeline and agent settings can come from different deployments with different priorities. When something is unknown, the page says so; it never guesses an assignment.

**Running** says what the device runs. A new device reads **Nothing yet. Vector starts when you deploy a pipeline.** A device that kept its existing workload reads **A local configuration adopted at setup (SHA-256 …) keeps running until you deploy.** After a device's first version fails to start, it reads **Nothing running: Vector stopped after v1 failed to start.** Use **Deploy a pipeline** to deploy one.

## Enable real metrics

Vectory reads metrics from a Prometheus exporter in your own pipeline. It never inserts components by itself. The synthetic example (**Try a synthetic example**) already includes it.

<!-- steps -->
1. In the editor, open **Actions** and choose **Add monitoring**. It adds an `internal_metrics` source and a `prometheus_exporter` sink on `127.0.0.1:9598` (the next free port if that one is taken), without changing your other steps.
2. Publish and deploy the pipeline. Restricted devices run this exporter without a listener allowance (see below).
3. Open the device's **Operational metrics**. Numbers appear within two check-ins: rates need two samples.

The agent finds a loopback exporter in the running configuration by itself; nothing changes on the host. The fragment it looks for is:

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

In restricted mode, this is the one listener a pipeline may open without an entry in `allowed_listen_addresses`: a `prometheus_exporter` on a loopback IP literal (such as `127.0.0.1:9598` or `[::1]:9598`) whose inputs are all `internal_metrics` sources. Only one such exporter is exempt. Any other listener, an exporter on another address, or one fed by other sources still needs its [allowance](installation.md#configure-restricted-allowances).

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
| **Components**: **In / s**, **Out / s**, **Errors / min**, **Buffer fill**, **Busy** | The same numbers per component. **Out / s** carries what a filter or sample removed on purpose (**247/min filtered**), and **Errors / min** carries what was lost to errors (**3/min dropped**). **Buffer fill** and **Busy** are small bars: hover one, or read the cell, for its percentage. A buffer over 70% full turns amber and over 90% red, and then writes its percentage; **Busy** turns amber from 80%. | Unique events: one event passes several components. |
| **Vector uptime**, **Memory**, **CPU time** | The Vector process. | The agent's check-in. |

A rate needs two samples, so the first sample shows no rate. A Vector restart resets counters; Vectory never shows negative throughput. A dash means the value wasn't reported: it isn't zero. Some exporters, such as Vector's on Windows, don't report CPU or memory.

The **Components** table fits without sideways scrolling from 1280 pixels wide; on a narrower screen it scrolls and says so, and on a phone each component is a card with every number it reported.

## Delivery health

Applied means Vector runs the version. Delivery is a separate question, so Vectory also checks each device's metrics at every check-in against the version it runs:

- **Sink errors:** a sink fails at least one request a minute.
- **Stalled:** events arrive, but less than 1% is delivered and a sink is struggling.
- **Buffer filling:** a buffer is over 80% full and rising, or over 95% full.
- **Error drops:** a component drops at least one event a minute because of errors.

These are the defaults. Administrators can change them in **Settings → Notifications → Detection**: see [Tune detection thresholds](notifications.md#tune-detection-thresholds). To hear about issues without opening the dashboard, set up [alerts and notifications](notifications.md).

Without metrics, Vectory can't measure delivery: the device page reads **Delivery health: not measured. Add monitoring**, the Overview's **On desired version** tile says so, and **Needs you** says "Nothing is failing that Vectory can measure" rather than "Nothing is failing". Vector's own log is then the only evidence: when a sink logs failed requests (`error_type=request_failed`) in two check-ins in a row, the same **Sink errors** issue opens, its message ending "measured from Vector's log (no metrics)". It closes after three checks in which the log shows no new failures. A quiet log doesn't prove that events arrive, so add monitoring to know.

A problem opens an issue after two checks in a row (three for a stall) and closes by itself after three clean checks, so one noisy sample neither alarms nor heals. A sink counts as recovered only when its buffer is seen low or it sends events again: silence isn't recovery. If you turn metrics off for a device, its delivery issues close as **unmonitored**, because Vectory can no longer check. Meanwhile the device reads **Not delivering**, the **Devices** list shows its events in and out (for example `5.0 → 0`), and **Needs you** on the Overview names the component and the fix. Canary rollouts wait for a few healthy checks before they release more devices, and a canary that isn't delivering fails like one that couldn't apply. See [A pipeline applies but delivers nothing](troubleshooting.md#a-pipeline-applies-but-delivers-nothing).

## Read history and gaps

The charts open on the smallest range that holds everything the device has recorded: **15 min** for a device that started reporting a few minutes ago, **1 hour** otherwise. Choose **6 hours**, **24 hours** or **7 days** to look further back. A chart draws only whole minutes, never the minute still collecting samples, and one that covers less than its range says what it covers (**Last 4 minutes**) instead of stretching a few points across an hour. Its scale fits the numbers, in whole numbers when every value is whole.

Hover over a chart, or focus it and use the arrow keys, to read a sample. Expand the sample history for exact values.

**Version changes.** A marker on the charts shows each time the device reported what happened to a version it was given: **Applied**, **Rolled back**, **Failed** or **Check required**. Hover a marker for the version and the time. **Changes in this range** lists them under the charts, newest first, each linked to its audit entry, and the sample history lists them too, so every marker is reachable from the keyboard and by screen reader. Markers that would overlap merge into one that takes the most serious status. A device that reports **Applied** again after a pause, without a new version, gets no marker. Markers come from the device's 50 newest audit events; when a range reaches back past them, the list says **Changes before Sep 30, 10:04 AM aren't marked**, so a missing marker there never reads as "nothing changed".

**Counters after a switch.** Vector keeps its own counters when a pipeline changes, so its totals still hold the previous pipeline's events. After a version change the **Errors**, **Dropped due to errors** and **Filtered out (expected)** tiles count from the change: **215 since v2 applied**, or **since the rollback**. Vector's total since it started stays in the tile's tooltip. When the version was applied before Vector's current process started, the total already belongs to it and reads **since Vector started**; when no earlier sample says where the counter stood, the tile says **since Vector started, including earlier versions** instead of guessing. A count since a change can leave out what Vector counted before the first sample after it, about one check-in.

History is kept for 7 days by default and bucketed by minute. A gap means no sample arrived. Old samples stay after a device goes offline, so check the timestamp before treating a number as current.

## Storage and limits

Each check-in that carries metrics updates two things on the server:

- **The latest sample**, on the device's record, with its per-component breakdown. The next check-in replaces it.
- **History**: one row per device per minute, with the device-level numbers only (no components). Another check-in in the same minute replaces that minute's row. About once a minute the server deletes rows older than [`VECTORY_TELEMETRY_RETENTION_DAYS`](server-config.md#server-settings) (7 days by default, 1 to 30).

With **Collect operational metrics** off, the server stores neither, but it still checks the sample.

### Estimate the disk history takes

```text
rows per device per day = 86,400 / max(60, check-in interval in seconds)   (an upper bound: at most 1,440)
history bytes           = devices × retention days × rows per device per day × bytes per row
```

A full sample, with all 17 device-level numbers at full precision, measured 585 bytes of JSON and 755 bytes per history row including its two indexes: 78,624 rows written by a release build of the server on 2026-09-30, measured with SQLite's `dbstat`. At a check-in interval of a minute or less that is up to 1,440 rows, about 1.1 MB, per device per day:

| Devices | 7 days (default) | 30 days |
| --- | --- | --- |
| 100 | 0.8 GB | 3.3 GB |
| 1,000 | 7.6 GB | 33 GB |
| 10,000 | 76 GB | 326 GB |

Devices that report fewer numbers, or check in less often than once a minute, take less.

The database file doesn't shrink after old rows are deleted: SQLite reuses the space for new rows. To store less, shorten the retention, or lengthen the check-in interval in the devices' agent settings.

### Audit log storage

The [audit log](administer.md#review-and-export-audit-events) is separate from metrics history, and Vectory never prunes it: it only adds events. An event takes about 0.8 KB with its indexes: 100,000 device events added to a migrated database took 779 bytes each (281 bytes of JSON), measured with SQLite's `dbstat` on 2026-10-02.

A device writes an event about itself when what it reports changes: one when a version reaches it and one when it applies the version, so about two for each deployment. Identical check-ins add none.

A device also adds at most 4 events a minute of each of three kinds (apply state, configuration mode and secret reconciliation), however often it checks in. A change past that is not recorded: the device page always shows the current state, and the audit log holds what fitted. A device that changed state at that rate all day would add at most 17,280 events, about 14 MB.

These are estimates from those rules for device events alone, not measurements of a running fleet:

| Devices | One deployment a day | Five deployments a day |
| --- | --- | --- |
| 100 | 0.16 MB a day, 58 MB a year | 0.8 MB a day, 0.3 GB a year |
| 1,000 | 1.6 MB a day, 0.6 GB a year | 8 MB a day, 2.9 GB a year |
| 10,000 | 16 MB a day, 5.8 GB a year | 80 MB a day, 29 GB a year |

To keep a copy outside Vectory, [export the events](administer.md#review-and-export-audit-events) as JSONL a date range at a time; a [backup of the complete state](administer.md#back-up-the-complete-state) holds them too. Vectory has no command that deletes audit events.

### Limits the server enforces

A sample outside these limits makes the server refuse the whole check-in (HTTP 400), not just the metrics. Nothing is clamped or rounded.

| Limit | Value |
| --- | --- |
| Device-level fields | `sampled_at`, `components` and 17 numbers: `events_per_second`, `events_out_per_second`, `bytes_in_per_second`, `bytes_out_per_second`, `errors`, `errors_per_minute`, `uptime_seconds`, `memory_bytes`, `cpu_seconds`, `discarded_events`, `discarded_intentional`, `discarded_error`, `filtered_per_minute`, `dropped_per_minute`, `buffer_bytes`, `buffer_events` and `buffer_utilization`. Any other field is refused. |
| Component fields | `id`, `type`, `kind` (`source`, `transform` or `sink`), `sent_by_output` and 18 numbers, from `events_per_second` to `latency_mean_seconds`. Any other field is refused. |
| Numbers | Finite, from 0 to 10¹⁵. Buffer and component utilization from 0 to 1. |
| Sample time | Within 24 hours of the server's clock. |
| Components per sample | 50. |
| Outputs per component | 16. |
| Component IDs and output names | 1 to 100 characters: letters, digits, `_`, `.` and `-`, unique within a sample. Component types: up to 64 characters. |
| Check-in size | 1 MiB. Larger requests get HTTP 413. |
| Check-ins per device | 30 a minute. More get HTTP 429 with a wait time. |

The agent keeps its samples inside these limits. It reads at most 1 MiB, 10,000 lines and 5,000 series from the metrics endpoint, reports at most 50 components and the first 16 outputs of each, and sends no sample when a scrape exceeds any limit. The device's latest sample then clears, and history shows a gap.

### Queues and drops

Nothing queues telemetry. The server checks and stores each sample inside its check-in, and the agent sends only its current sample: a sample whose check-in failed is never sent again, so an outage leaves a gap. When the agent listener is busy with 128 requests, further ones get HTTP 503 and the agent retries with backoff; a request that takes over 15 seconds gets HTTP 408.

The server exposes no drop counters: it doesn't count refused samples, samples an agent didn't send, or rows replaced within a minute. A refused check-in shows in the agent's log and in `vectory status` on the device, and the device's last check-in stops advancing. The **Dropped** and **Filtered** numbers on the device page are Vector's own event counters, not telemetry drops.

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

Each issue leads with what it most likely needs next, as a link, and only when there is something to open and your role allows it:

| Link | When |
| --- | --- |
| **Roll back** | A version that stopped delivering, from one rollout. Needs the Operator or Administrator role. It opens the rollout with its rollback review ready; nothing is sent until you confirm there. |
| **Fix in pipeline** | Vector named a problem only the pipeline can fix, such as an unknown field. It opens the pipeline at the step and setting Vector named. Needs the Editor or Administrator role. |
| **Open rollout** | The issue came from one rollout, and neither link above applies. |
| **Open device** | A card about one device that has no rollout to open. |

- An apply issue resolves by itself when the device next applies a version and confirms it.
- A delivery issue (**Not delivering**) resolves by itself after three clean checks, or when the device stops running that version.
- **Acknowledge issue** records that you've looked into it, with an optional note. **Reopen issue** brings it back. Both are recorded in the audit log.
- A new failure after an acknowledgement reopens the issue.

## Retry a failed application

Fix the cause first, then choose **Retry application** on the device. The retry is tied to the version shown; if a different deployment has taken over since, the server refuses it and the page shows the current state.

A lost reply doesn't mean the retry failed: choose **Check status**, which only reads. Retry doesn't resume paused sync. A host pause needs `vectory resume` on the device.

## Revoke device access

Operators and Administrators can open a device's **Device access** section and choose **Revoke device identity…**. The dialog shows the exact device; confirm with **Revoke identity**.

Revocation blocks the device's certificates at once and removes it from groups and from deployments that follow group membership. It doesn't stop Vector or delete files on the host. To remove the agent too, see [Remove the agent](agents.md#remove-the-agent).

Revocation is permanent for that identity. To bring the host back, [recover its identity](agents.md#recover-a-device-identity): it returns as a new device.
