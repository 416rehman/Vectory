# Build a pipeline

Draw the event flow on the graph, configure each component, then check and publish a version. Moving cards only changes the picture; components and their connections become the Vector configuration devices run.

Editors and Administrators can change drafts. Operators and Administrators can publish and deploy. Everyone can view pipelines and their history.

## Find and organize pipelines

Open [**Pipelines**](/#/configurations) to search by name or description, sort by name or last update, and filter active or archived pipelines. Your search and page are kept while you work.

A row's **Status** says where the pipeline runs: its latest published version and when it was published, the versions devices verified running and on how many of the devices it is assigned to (**Running v2 on 1, v1 on 2 of 3 · v4 not running**), and **Unpublished changes** when the draft differs. An assignment alone isn't evidence that Vector runs it: **Assigned to 2 devices · not verified running yet**. When no device runs the latest version, the row also says how its newest rollout ended, linked to that rollout: **v4 failed on 1 device · 12m ago** or **v4 rolled back on 1 device · 12m ago**. The row reads the 20 newest failed and the 20 newest rolled-back rollouts, so an older ending isn't shown, and it says nothing about a rollout that went well.

A pipeline's **Actions** menu offers:

| Action | Result |
| --- | --- |
| **Duplicate pipeline** | A new, independent pipeline from the saved draft. It starts at revision 1, with no versions or deployments. |
| **Archive pipeline** | Moves it out of the active list and freezes the draft. Published versions stay deployable, and running devices are unaffected. |
| **Unarchive pipeline** | Returns it to the active list so you can edit and publish again. |

To start from a device, use **Choose pipeline** on its page. You still review the devices before anything deploys.

## Add and connect components

<!-- steps -->
1. Open a draft, or choose **Create pipeline**.
2. Add a component: right-click empty canvas, or use **Add component**. Search by name (`http_server`, `remap`) and filter by sources, transforms and destinations.
3. Connect it: drag from an output handle to the next component. Drop on empty canvas to add a compatible component already connected. For components with named outputs, such as `route`, pick the output that carries the events you want.
4. Select a card and complete its required settings in the right-hand panel. **Add field** searches the optional settings; the info icon beside a field explains it, with limits, defaults and examples.
5. Choose **Check pipeline**, then **Save draft** to keep your work or **Review & publish** to create a version.

A **source** receives or generates events, a **transform** changes, filters or routes them, and a **sink** delivers them. Connections can't form a loop. A branch that never reaches a sink gets a dashed outline and a **No destination** hint; it doesn't block publishing.

| To | Do this |
| --- | --- |
| Move or remove a connection | Select it, then drag an end grip to another port, or press **Delete**. |
| Change connection lines | **Connection style**: **Curved**, **Right-angle** or **Straight**. Display only. |
| Tidy the graph | **Arrange graph**, then **Fit graph**. |
| Insert a component into a connection | Choose **+** on the line, then pick a component. It is wired in between. |
| Find a component | **Ctrl F** (**⌘ F**), then type an ID, name or type. The graph moves to it. |
| Select several components | **Ctrl**-click (**⌘**-click) or **Shift**-drag; **Ctrl A** selects all. Then move, duplicate (**Ctrl D**) or delete them together. |
| Copy components | Select them, then **Ctrl C**, **Ctrl V** (**⌘ C**, **⌘ V**). They are copied as Vector YAML and pasted with new IDs and their connections rewired. You can also paste components from any Vector configuration. |
| See live rates | **Live** is on when a device runs the pipeline, and Vectory remembers your choice for each pipeline. Each connection carries its events per second on a label and gets thicker as the rate grows, with error, drop and buffer badges on the steps. Rates are summed across the devices verified running a version of this pipeline. **Fit** brings the whole graph into view with the numbers still readable, and **Show as table** lists every number as text. It shows rates only, never event contents, and needs devices with [telemetry](telemetry.md) on. **Add monitoring** adds Vector's internal metrics if the pipeline doesn't export them. |
| Tell cards apart | A card's title takes two lines before it is cut, and its tooltip holds all of it. Steps that share a title lead with their IDs, for example **archive · Discard events**. |
| Open a step from a link | **Fix in pipeline**, on a rollout or an issue, opens the pipeline with the step the failure names selected and the setting it names in view. If this draft has no such step or setting, the pipeline opens as usual and one line says so. |
| Rename a component | The pencil beside its name. Connections and test targets follow; wildcard inputs and VRL text don't, so review those. An ID can't contain `.`, `/`, `\` or control characters, or start with a drive letter and a colon (like `C:`): Vector uses it as a folder name for its checkpoints and disk buffers. |
| Undo | **Ctrl Z** (**⌘ Z**); add Shift to redo. |
| Work from the keyboard | Arrow keys move a focused card, **Enter** opens it, **Delete** removes it, **Shift F10** opens its menu. **Canvas shortcuts** lists the rest. |

The status beside **Save draft** always shows where you are: **Saved**, **Saving…**, **Unsaved**, **Unapplied edits** or **Save failed**. Nothing saves in the background. **Discard changes** returns to the last saved draft. When the server refuses a draft, your edits stay and the message says why. If one setting is the cause, such as a plaintext credential, **Go to field** opens it. **Reload server draft** appears only when the draft changed elsewhere, such as in another tab.

The component catalog covers the 128 production component types of Vector 0.58.0. A component in the catalog still needs the device's Vector build and platform to support it, and restricted devices accept [only some components](security.md#restricted-and-full-mode).

## Try a complete example

This synthetic pipeline generates a log line every second, adds a field and discards the result. It reads no files and sends nothing anywhere. Save it as `example.json` and choose **Actions → Import configuration file**:

```json
{
  "sources": {
    "example": { "type": "demo_logs", "format": "json", "interval": 1 }
  },
  "transforms": {
    "normalize": {
      "type": "remap",
      "inputs": ["example"],
      "source": ".service = \"edge\""
    }
  },
  "sinks": {
    "discard": { "type": "blackhole", "inputs": ["normalize"] }
  }
}
```

You should see `example → normalize → discard`. Add a [pipeline test](resources.md#test-transformations) to prove the new field, or [local metrics](telemetry.md#enable-real-metrics) to watch throughput after you deploy.

## Work with detailed settings

Each field's type decides its control.

| Field | How to edit it | Watch for |
| --- | --- | --- |
| Text | Type a value; multi-line fields fit code. | A URL, path, regex and VRL program mean different things. |
| Number | Enter a value within the shown bounds. | Units: seconds, milliseconds and bytes differ. |
| Boolean or choice | Pick an explicit value. | `false` is a real value, not "unset". |
| Object | Open it and fill in the children you need. | Adding an object doesn't make its optional children required. |
| Map | Add a name, then its value. | Names must be unique. |
| List | Add, reorder, duplicate or remove rows. | Order matters. |
| Variant | Choose a mode, then configure it. | Changing mode changes which fields apply. |

Changing a mode (for example Syslog TCP to Unix) keeps shared settings and replaces mode-specific ones. **Undo** brings the previous values back. Some rules ask for one of several fields, for example a remap's inline **VRL program**, **File** or **Files**; supply one.

## Omitted null and empty values

| Configuration | Meaning |
| --- | --- |
| Field absent | Vector uses its default. |
| `"field": null` | An explicit null, where the field allows it. |
| `"field": ""` | An empty string. |
| `"field": []` or `"field": {}` | An empty list or object. Some fields reject these. |

Leave optional fields out unless you need to override a default. A field's menu offers **Remove field** (back to absent), **Set to null** and **Edit as JSON**. JSON editors mark errors as you type; choose **Apply** to use the value or **Discard changes** to keep the saved one.

Numbers beyond ±9,007,199,254,740,991 can't be edited safely in a browser, so Vectory refuses them rather than rounding. Edit such configurations outside the browser.

## VRL

A `remap` transform runs [Vector Remap Language](https://vector.dev/docs/reference/vrl/). Its **VRL program** can add, parse or remove fields:

```vrl
.service = "edge"
.environment = "staging"
del(.temporary_debug_field)
```

The VRL editor highlights the program, completes function names and marks problems on the line Vector reports. Choose **Expand** for a wide editor. Under the program, add sample events (one JSON object per line) and choose **Run**: the server's sandboxed Vector runs the step on each sample and shows what comes out, or why an event was dropped. Samples stay in your browser, and a new sample starts from a realistic event for the source, such as a syslog line. **Auto-run** repeats the run when you pause typing. For a step that isn't first in the pipeline, **Run through upstream steps** sends the samples through the steps before it, so a `route` or `filter` sees the fields they added; turn it off to test the step alone. A `route` also shows how many samples each output received. **Save as test** turns a result into a [pipeline test](resources.md#test-transformations) that keeps it working. Nothing here reads live device events.

A remap that reads its program from a **File** reads it on the device. That file isn't uploaded or frozen into the version, and it needs full mode. A restricted device refuses it; paste the program into **Source** instead.

## Event templates

Fields that support Vector templates can read a value from each event: `{{ hostname }}`, or `logs/{{ service }}/` for a per-service path. Which fields accept templates, and how missing values behave, depends on the component. See [Vector template syntax](https://vector.dev/docs/reference/configuration/template-syntax/).

Templates differ from `${HOSTNAME}`, which reads the Vector process environment, and from `SECRET[backend.key]`, which reads a secret provider. Restricted devices refuse all three. [Choose the right reference](resources.md#choose-the-right-reference) compares them.

## Input patterns

An input names what a component reads from:

| Input | Reads |
| --- | --- |
| `normalize` | The default output of `normalize`. |
| `routes.errors` | The `errors` output of the `routes` component. |
| `normalize_*` | Every matching output, including ones added later. |

Use graph connections when you want a fixed set. Wildcards live in **Code** view; the graph draws each one as dashed lines from the components it matches, with the pattern on a chip. Renaming a component doesn't rewrite patterns or VRL, so check the pipeline after a rename.

## Global settings

Choose [**Settings**](/#/configurations?panel=settings) in the editor toolbar for settings that apply to the whole pipeline:

| Section | What you configure |
| --- | --- |
| [General](/#/configurations?panel=settings&section=general) | Pipeline-wide Vector options, such as the data directory and the internal API. |
| [Enrichment tables](/#/configurations?panel=settings&section=enrichment_tables) | Lookup data for enriching events. |
| [Secrets](/#/configurations?panel=settings&section=secret) | Providers that resolve credentials on each device. |
| [Variables](/#/configurations?panel=settings&section=variables) | Fields whose value differs by device. You enter the values when you deploy: see [Values that differ by device](resources.md#values-that-differ-by-device). |
| [Tests](/#/configurations?panel=settings&section=tests) | Sample events and assertions for your transforms. |
| [Configuration provider](/#/configurations?panel=settings&section=provider) | A device-side provider that supplies Vector configuration. |

These settings travel with the version. Paths refer to the device, not your browser or the server. If you opened help without a pipeline, the links ask you to choose one first.

Leave **Data directory** empty unless you need a specific path: the agent gives Vector a private data directory on each device. If you set one, it must exist and be writable on every device, and restricted devices must allow it.

A pipeline that enables the internal API needs a full-mode device. Vector's API has no authentication, so restricted devices refuse it, and the deploy review says so.

## Import and export

Drop a UTF-8 `.json`, `.yaml`, `.yml` or `.toml` file (up to 1 MiB) onto the graph or **Code** view, or choose **Actions → Import configuration file**. Vectory checks the syntax and structure first. Into an existing pipeline, you review a diff and choose **Replace pipeline**. Imports can be undone.

**Code** view edits the complete configuration in YAML, JSON or TOML, with search, folding and inline errors. It lists sources, transforms and sinks first, in the order events flow, then anything else, with `tests` last. **Format code** tidies it; **Apply code changes** puts it into the draft. **Ctrl S** (**⌘ S**) applies code that parses and then saves the draft. Code that doesn't parse isn't saved: the message says where, for example "Not saved. Line 12:5: Map keys must be unique", and the status stays on **Unapplied edits**. **Actions → Export configuration** downloads the configuration in the selected format, with secret references rather than values.

Devices receive JSON. Comments and formatting from an imported file aren't kept. TOML can't express `null`, so Vectory refuses a conversion that would lose one; use JSON or YAML for those.

> [!WARNING]
> Never paste passwords, tokens or keys into a pipeline, even in imported files. Use a [device secret](resources.md#keep-credentials-on-the-device), such as `vectory-secret:DD_API_KEY`, in the credential field. Vectory refuses to save or publish plain text there.

## Validate, test, publish

<!-- steps -->
1. Choose the check button in the toolbar. It checks connections, required fields and types, then asks the sandboxed Vector on your server to validate the configuration. The **Problems** panel under the canvas lists every problem by step; choose one to jump to the step, field or line. With **Auto-check** on, the editor checks again shortly after you stop editing.
2. Run your tests under [**Settings → Tests**](/#/configurations?panel=settings&section=tests).
3. Choose **Review & publish**. The review checks again, runs the pipeline's tests and lists what changes since the last version, with line-by-line differences for VRL programs. Add a note and choose **Publish version**. Unsaved edits are saved first. While a test is failing, the button reads **Publish anyway**: see [Tests gate publishing](resources.md#test-transformations).
4. Deploy it: choose **Choose devices** when the version is published, or see [Deploy a published version](deployments.md#deploy-a-published-version).

| Check button | Meaning |
| --- | --- |
| **Checked** | Vector accepted the configuration. Anything only a device can resolve, such as a local file, is checked there before it applies. |
| **Partly checked** | No Vector checker is configured on the server, so only the structure was checked. |
| **N problems** | Fix the listed problems before publishing. Each one names the step and setting. |
| **Not checked** | You changed the pipeline since the last check. |
| **Couldn't check** | The checker didn't answer. Publishing waits until a check succeeds. |

Some checks can only run on the device, such as reading local files, resolving environment variables, talking to providers, running Lua or reading enrichment tables. The device runs them before it applies the version, and keeps its current configuration if they fail.

The server never runs Lua, because Lua can run any program, and it never opens the file of an enrichment table (`file`, `geoip` or `mmdb`), because that file lives on the device. Its check covers the rest of the pipeline and leaves those steps to the devices, so it still reads **Checked** with a note that each device checks them. A restricted device refuses a Lua step; only a full-mode device runs it. A `memory` table reads no file, so it is checked here as before.

Results point at the component and setting to fix, with Vector's message, and are bounded in size. For Vector's complete output, run `vector validate` on a host with the same configuration.

If someone else saved while you were editing, keep your changes, review theirs and save the merged draft.

## Compare saved history

Open [**Actions → Version history**](/#/configurations?panel=history) to compare published versions and saved draft revisions without leaving your work.

<!-- steps -->
1. Choose **Published versions** or **Draft revisions** and select a snapshot.
2. **Compare changes** lists every changed configuration path with its before and after values.
3. **Choose comparison** compares any two snapshots.
4. **Configuration** shows the snapshot's complete JSON.

Comparisons cover configuration only, not names or card positions. Unset, `null`, `""`, `0` and `false` are all different values.

## Restore a snapshot as a new draft

Select a snapshot in History and choose **Restore as draft**. It becomes a new draft revision; history and running devices don't change. Check and publish it when you're ready.

To run an older version without editing, choose **Deploy this version** instead. That is how you [roll back](deployments.md#roll-back-deliberately).
