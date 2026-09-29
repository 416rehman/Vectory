# Build a pipeline

Build the event flow on the graph, configure each component in the right-hand panel, then check and publish a version. Moving nodes changes the diagram only; component settings and connections become the Vector configuration sent to devices.

You need an Editor or Admin role to change drafts. Publishing and deploying require Operator or Admin access. A Viewer can inspect configurations and history.

## Find and organize pipelines

Open [**Pipelines**](/#/configurations) and search by name or description. Use the **Status** column's filter to switch between active and archived pipelines. Select **Pipeline** or **Updated** in the header to sort; select it again to reverse the order. A page contains up to 12 pipelines. Open a pipeline to inspect its draft, components and history; returning to the library keeps your search, filters and page during the current signed-in visit.

Editors and administrators can use a pipeline's **Actions** menu to:

| Action                 | Result                                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Duplicate pipeline** | Create a separate active pipeline from the current saved draft configuration and canvas. Choose its name and description. The copy begins at revision 1 and inherits no published versions, device assignments or deployments. |
| **Archive pipeline**   | Move it out of the active library and freeze changes to its draft and publication. Existing history, published versions and device deployments remain in place.                                                                |
| **Unarchive pipeline** | Return it to the active library and allow draft editing and publication again. This does not deploy a version.                                                                                                                 |

These actions are also available under [**Actions**](/#/configurations?panel=tools) in the editor. Complete pending field edits before changing the pipeline's lifecycle. If the pipeline changed since you opened the action, load and review its latest details before trying again.

Starting from a device's **Choose pipeline** action carries that device into the pipeline workflow. Check the selected-device context and still review the target set before deployment; choosing a pipeline does not apply it automatically.

### Recover a creation or duplication

Creating or duplicating a pipeline saves the exact request in this browser before sending it. A duplicate stays bound to the source's saved revision; it never copies later edits silently. If the reply is lost, choose **Close and review request** to open the saved requests. After closing or reloading, use **Review pipeline requests**. Review the reminder before starting another create or duplicate; existing pipelines can still be opened, edited or archived.

**Check status** looks up the original request. A missing result may still be in flight, including from another tab. **Retry same request** sends only the preserved request with its original ID. Nothing is retried automatically. If the initial duplicate is definitively rejected because the source revision changed, **Load latest for review** preserves the proposed copy name and description while loading the source for review. A subsequent explicit submission uses that reviewed revision and a new request ID. If a recovery retry is rejected, review the error and deliberately dismiss its reminder before starting a separate request.

**Pipeline saved** identifies the exact result with its current details. **Open pipeline** opens that UUID, including later edits or an archived state; the current editor's unsaved-change confirmation still applies. Recovery never overwrites the result with the original creation contents. A saved copy remains independent and recoverable after its source changes or disappears. Creating, duplicating and recovering a pipeline do not publish a version or deploy it.

Use **Your pipeline requests** in the library or the editor's **Actions** menu to find requests saved by your account on the server, including from another tab or device. This list can recover a committed result after a browser reminder is lost, but cannot reconstruct a missing request for retry. **Dismiss reminder** removes only the local reminder, without cancelling a request or deleting a pipeline.

Working browser storage and an updated server are required. An unsupported server is blocked before this tab sends a create or duplicate, but the saved reminder stays available for review because another tab may have sent it.

## Add and connect components

1. Open [**Pipelines**](/#/configurations) and create a pipeline, or open an existing draft.
2. Right-click an empty part of the canvas, or use the labeled **Add component** floating button at its upper left. Search by name, such as `http_server` or `remap`, and filter by sources, transforms or destinations. A component added on empty canvas starts without new connections.
3. Drag an output handle to a transform or sink input. Drop it on empty canvas to choose a compatible component and connect it to that exact output. Existing branches stay connected. For a named output, choose the port that carries the intended events.
4. Select a node. Complete its required settings in the right-hand panel. **Add field** stays in the Configuration toolbar while you scroll; use it to search for optional settings. Nested objects have their own Add field control above their children. The small info icon beside a field shows its description, limits, defaults and examples on hover or keyboard focus. Moving the pointer away from both the icon and help closes it, including after a mouse click. On touch screens, tap the icon to open help and tap outside to dismiss it. Its actions menu contains JSON, null and removal options when supported.

Related properties appear together in sections such as Sampling, Encoding, Connection and Delivery. The sidebar closes with **×** or **Escape**; no Done action is needed. Committed edits stay in the editor until you choose **Save draft**, **Discard changes**, or **Review & publish**. Unfinished inputs still require applying or deliberately discarding them before closing. Save state remains visible in the pipeline toolbar.
5. Choose **Check pipeline** to review the current edits. To keep your work without publishing, open the arrow beside **Review & publish** and choose **Save draft**. Use **Review & publish** when ready to create a version; it saves committed edits before publishing.

A source receives events, a transform changes or routes them, and a sink delivers them. Connections must not form a cycle. See [pipeline terms](#/docs/glossary#pipeline-and-components).

Hover a connection to highlight that exact line and its two endpoint nodes. Other lines fade and unrelated cards become quieter while their text and controls stay readable. Move away to restore the graph. Keyboard focus on a connection provides the same aid; Escape clears it. This is only a view change and does not edit, save or recheck the pipeline.

Select a connection to reveal its endpoint grips and action button. Drag either grip to a highlighted compatible port to move that end. Dropping an existing grip on blank canvas disconnects the line; dropping it on an incompatible node leaves the original connection in place. Press Escape during the drag to cancel. Named output connections keep their exact output name.

Use **Connection style** in the canvas view controls to choose **Curved**, **Right-angle** (square circuit-style corners), or **Straight** lines. New connection previews use the same style. The choice is remembered on this browser and changes only the display; it does not edit or save the pipeline.

Right-click a line for **Disconnect**, or select it and press **Delete** / **Backspace**. Middle-clicking a line also disconnects it. Open a node's **…** menu, or right-click it, for properties, duplication, disconnecting its connections, and removal. Read-only nodes offer properties only. All of these edits support **Undo**. Removing a simple transform reconnects its neighboring steps; use **Disconnect connections** when you want to break its links explicitly. **Arrange graph** spaces the cards and named outputs automatically; use it if an older saved layout is crowded.

Focus a node and use arrow keys to move it by 10 pixels, or hold Shift for 50 pixels. **Ctrl/⌘ D** duplicates it, **Enter** opens its properties, and **Delete** removes it. **Ctrl/⌘ Z** undoes; adding Shift redoes. **Shift F10** or the Menu key opens actions for the focused node or connection. The **Canvas shortcuts** help button beside Fit graph lists these controls.

The toolbar above the canvas contains a shared **Graph / Code** view switch, **Check pipeline**, **Pipeline settings**, **Actions**, and publishing. **Discard changes** appears when graph, code or field edits have not been saved. Confirm to return to the last acknowledged draft revision; Cancel keeps your unsaved edits. Nothing saves in the background. The floating canvas controls contain **Undo**, **Redo**, zoom, **Fit graph**, and **Arrange graph**. Fit animates to the graph; reduced-motion preferences disable the animation. Use arrow keys to browse component search results, Enter to add, and Escape to dismiss the menu without changing the pipeline.

Select a component to edit its properties. Sources are blue, transformations purple, and destinations teal; the same labels and colors appear in the canvas, component picker, and properties header. The help icon beside the name opens its Vector reference in a new tab. Nested objects use full-width sections and small property paths instead of increasingly narrow cards. Values fixed by the selected format, such as a buffer's internal type, stay in the configuration without repeating as inputs. Missing or mismatched fixed values offer an explicit repair action.

Fields and required markers follow the schema's conditions and dependencies. A field's info control explains why it is required. Changing an option preserves existing values and guards unfinished edits. Requirements that the schema cannot resolve remain advisory; device validation still checks the complete configuration. Use the pipeline's **Code** view to edit the complete configuration, including custom components and input patterns.

The catalog describes production component types in the pinned Vector 0.58.0 reference. Availability still depends on the device's OS and Vector build. Types and features outside restricted policy require [full Vector mode](#/docs/installation#choose-configuration-capabilities).

Use the pencil beside a component name to rename it. Literal connections and native test targets follow the new name; wildcard expressions and VRL text remain unchanged. Review those expressions afterward. To rename the pipeline itself or change its description, click its name or description in the page header. Pipelines without a description show **Add description**. [**Actions → Pipeline details**](/#/configurations?panel=details) opens the same form. Read-only pipelines show the details without editing controls.

The compact status beside save and publish shows **Saved**, **Saving…**, **Unsaved**, **Unapplied edits**, or **Save failed**. Hover over it for the full status and draft or published-version context. In history, the status sits beside Refresh. Failed saves retain your input so you can retry.

## Try a complete example

This deliberately synthetic pipeline generates a log once per second, adds a service field and discards the result. It does not read production events or send data to an external destination.

Save it as `example.json`, replace `data_dir` with an existing writable directory on the target device, then choose [**Actions**](/#/configurations?panel=tools) → **Import configuration file**. In restricted mode, that directory also needs a local file allowance.

```json
{
  "data_dir": "/var/lib/vectory-data",
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

The graph should show `example → normalize → discard`. Sources and transforms in a branch with no path to a destination have a dashed outline and a **No destination** hint. Connect the branch to a destination to clear the hint. This describes the configured connections, not live traffic, and does not block checking or publishing. Native dynamic inputs can make connectivity uncertain, so the editor avoids declaring those branches unused. **Check pipeline** checks the configuration; it does not display a live event stream. Add the [transformation test](#/docs/resources#test-transformations) to verify the new field. To observe rates after deployment, add [local metrics](#/docs/telemetry#enable-real-metrics).

## Work with detailed settings

The field's type determines its control. A setting may also carry a more specific intent, such as a device path, event template or credential reference.

| Field shape       | How to edit it                                               | What to check                                                                      |
| ----------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Text              | Enter a string; use multiline input for code or longer text. | A URL, path, regex and VRL program have different native meanings.                 |
| Number or integer | Enter a numeric value within the shown bounds.               | Read the unit: seconds, milliseconds and bytes are different quantities.           |
| Boolean or enum   | Choose an explicit value.                                    | `false` is a real setting; it is not omission.                                     |
| Object            | Open its settings and complete the relevant children.        | Adding an object does not make all its optional children required.                 |
| Map               | Add a name, then edit its typed value.                       | Names must be unique; a header map and a component map have different value types. |
| List              | Add, duplicate, reorder or remove rows.                      | Order is preserved. A list of objects is not comma-separated text.                 |
| Variant           | Choose a supported mode or shape, then configure it.         | Changing mode can change which fields are legal or required.                       |

A mode change, such as Syslog TCP to Unix, replaces mode-specific settings. The editor keeps the previous branch's draft during editing and retains shared settings; review the selected branch before saving or publishing. **Undo** can reverse an edit. Do not rely on an inactive branch draft being stored in an exported or published configuration.

Some rules simply require an alternative field. For example, remap accepts inline **VRL program**, **File**, or **Files**. That is a requirement to supply a program, not three different component types. Use **Add field** to configure device-local files; they require full mode.

## Omitted null and empty values

| Configuration                  | Meaning                                                                     |
| ------------------------------ | --------------------------------------------------------------------------- |
| Field absent                   | Let Vector use its default or absence behavior.                             |
| `"field": null`                | Explicit null, only when the schema permits it.                             |
| `"field": ""`                  | An empty string.                                                            |
| `"field": []` or `"field": {}` | An empty list or object. These can still be invalid for a particular field. |

Leave optional fields omitted unless you need an override. Choose **Add field**, search by name or description, then select a field to configure it. Open the field's actions menu beside its name: **Remove field** restores omission, **Set to null** stores an explicit null, and **Edit as JSON** switches a record or list to its highlighted JSON editor. **Enter value** opens the non-null control. Adding a field prepares an input; it does not mean you have supplied a valid value.

JSON editors highlight syntax and mark invalid values while you type. **Format JSON** adjusts indentation; it does not apply the change. Choose **Apply** to update the field or **Discard changes** to keep its saved value. These controls work the same way in component properties and pipeline-wide settings, including secrets and configuration providers.

Unfinished input remains in the editor until you correct, apply or deliberately discard it. Resolve pending edits before checking the pipeline, changing editing modes or leaving. A displayed default is explanatory; it need not be written into the document.

The browser refuses integers outside −9,007,199,254,740,991 through 9,007,199,254,740,991 during import, loading and saving. Use a lossless native workflow for larger values; converting an integer to a string changes its type.

## VRL

A remap transform runs Vector Remap Language. Its **VRL program** can assign, parse or remove event fields:

```vrl
.service = "edge"
.environment = "staging"
del(.temporary_debug_field)
```

Use the editor's VRL test with explicitly supplied sample events, then add [pipeline assertions](#/docs/resources#test-transformations) for repeatable checks. Neither test reads production device events. Native Vector checks VRL syntax and semantics; the browser does not treat VRL as JavaScript.

A file-based remap program is read on the device. It is not uploaded when you enter its path, and its contents are not frozen into the published document.

## Event templates

In fields that support Vector templates, `{{ hostname }}` reads a value from each event. For example, a supported destination template could use `logs/{{ service }}/` to select an event-specific path or key. Missing fields and supported template features depend on the component. See [Vector template syntax](https://vector.dev/docs/reference/configuration/template-syntax/).

Templates differ from `${HOSTNAME}`, which reads the Vector process environment, and from `SECRET[backend.key]`, which reads a secret provider. These device-dependent features require full mode. Use the [reference comparison](#/docs/resources#choose-the-right-reference) before choosing a mechanism.

## Input patterns

An input such as `normalize` names a component's default output. A reference such as `routes.errors` names a particular output. A wildcard such as `normalize_*` can connect matching outputs, including ones added later.

Use explicit graph connections when you want a fixed set. Review wildcard inputs in the pipeline's **Code** view. Renaming a component does not rewrite patterns or embedded VRL. Check the pipeline after changes so missing inputs or newly introduced cycles are caught.

## Global settings

Open [**Actions → Pipeline settings**](/#/configurations?panel=settings), then choose a section:

| Section | What you configure |
| --- | --- |
| [General](/#/configurations?panel=settings&section=general) | Pipeline-wide Vector options, including the data directory and internal API. |
| [Enrichment tables](/#/configurations?panel=settings&section=enrichment_tables) | Lookup data used to enrich events. |
| [Secrets](/#/configurations?panel=settings&section=secret) | Providers that resolve credentials on each device. |
| [Tests](/#/configurations?panel=settings&section=tests) | Sample events and assertions for your transforms. |
| [Configuration provider](/#/configurations?panel=settings&section=provider) | A device-side provider that supplies Vector configuration. |

These links open the relevant section of your pipeline. If you opened help without a pipeline selected, choose one first. These settings travel with the published document. Paths refer to the target device, not the browser or Vectory server.

A memory enrichment table with inputs appears as a graph destination. If it exports events, its separately named source appears too. Both graph roles open the same table settings. See [enrichment tables](#/docs/resources#enrich-events-with-local-data).

## Import and export

Drop a UTF-8 `.json`, `.yaml`, `.yml` or `.toml` file onto the graph or Code view, or choose [**Actions**](/#/configurations?panel=tools) → **Import configuration file**. Files may be up to 1 MiB. Vectory checks syntax, configuration structure and known local constraints before changing the draft. Invalid files show a message explaining the problem.

A valid file loads directly into an empty pipeline. For an existing pipeline, review the highlighted configuration diff and choose **Replace pipeline**, or cancel to keep the draft. Switch the diff between YAML, JSON and TOML when those formats can represent every value. Imports can be undone. Apply or discard unfinished code and property fields before importing.

**Code** provides syntax colors, line numbers, folding, search and inline diagnostics for all three formats. **Format code** (Ctrl/Cmd+Shift+F) normalizes the text; **Copy code** copies the current editor contents, including unapplied edits. **Check pipeline** checks the current Code candidate without applying or saving it. Choose **Apply code changes** to update the draft, or **Discard code changes** to return to the draft. Either action clears the earlier check result so it cannot describe a different editing state. Local diagnostics do not run Vector or resolve device environment variables; use **Check pipeline** before publishing.

The configuration is normalized to JSON for deployment; original comments and formatting are not preserved. [**Actions**](/#/configurations?panel=tools) → **Export configuration** exports the current configuration, including reference strings rather than resolved Vectory credentials.

The component picker also offers **Import a component definition** for a custom build. Imported unknown fields remain in the document and can be edited as JSON. Importing does not install a component or make it available on target devices.

TOML cannot represent an explicit `null`. Vectory checks format conversions and refuses any conversion that would drop a value. Use JSON or YAML for those configurations. If a restored or reloaded snapshot cannot be represented in the selected format, the code editor switches to JSON and explains why; the complete saved configuration is preserved.

Apply or discard Code edits before switching to Graph. Never paste passwords, tokens or private keys into a shared configuration; use [secret references](#/docs/resources#keep-credentials-on-the-device).

## Validate, test, publish

1. Resolve incomplete fields. To save without publishing, open the arrow beside **Review & publish** (or **Choose devices**) and select **Save draft**. Editors without publishing access have a **Save draft** button instead. Apply or discard unfinished code and field edits first. **Save draft** is available when there are committed unsaved changes.
2. Choose **Check pipeline**. It checks connections, required fields and known local schema constraints such as field types and numeric bounds before requesting server validation. Any local error keeps the result red and appears in the check results; in Code view, this checks the current code rather than an older graph and leaves unapplied edits out of the draft. Green means the isolated Vector check passed without warnings. Amber means checks passed with warnings, or full Vector validation is still pending on a device; it does not promise the device will accept the configuration. A disconnected branch appears as a warning in the results. Red means the check failed; new edits make the result stale until you check again. Applying or discarding checked Code edits makes that result stale. Hover or focus the icon for its current status and latest results; hovering does not run another check. Results appear beside the button and close when the pointer leaves both. With keyboard focus, press Arrow Down to enter the results and Escape to dismiss them. Read warnings as well as errors.
3. Run declared tests under [**Pipeline settings → Tests**](/#/configurations?panel=settings&section=tests).
4. Choose **Review & publish**, review the version and publish it.
5. Choose devices in the deployment step. Publishing alone changes no device.

When you choose **Publish version**, the dashboard saves committed unsaved edits first, waits for that save to finish, then stores the exact saved revision, version note and request ID in this browser. If the reply is lost or takes too long, choose **Close and review request**, then **Review publish requests**. Closing or reloading preserves the request. Do not publish a replacement while its result is uncertain.

**Check status** reads the original request. A missing result may still be in flight; it does not mean publication failed. Only **Retry same request** resends the original revision and note with the same ID. A supporting server returns the original immutable version if it was already published. No retry or deployment happens automatically.

**Published** identifies the exact version and its source draft revision. **Review published version** opens that version in History, even when newer versions exist. Recovering it does not replace your current draft. A successful earlier publication remains recoverable after the draft changes or the pipeline is archived. If the request never succeeded and its revision is now stale, review the rejection, deliberately dismiss its reminder, then review the current draft before publishing separately.

Open **Actions → Your publish requests** to find publications saved by your account for this pipeline, including from another tab or device. This server list can recover an exact saved version after a browser reminder is lost; it cannot reconstruct missing original contents for a retry. Dismissing a reminder removes only the browser reminder, without cancelling publication or deleting a version. Publishing requires working browser storage and an updated server; an older server is blocked before an unsafe request is sent.

An error does not erase the saved request, even if the draft changed or the server rejected this attempt. Another tab may already have published it. Review its status first. If no result is confirmed, retry only the same request, or deliberately dismiss its reminder after checking history before reviewing a corrected draft. Vectory does not silently replace the original revision or version note.

Structural checks, native checks and activation are separate. A device-resource-dependent check can be **deferred**; that is not a native runtime success. The agent validates the exact assigned document in its own environment before activation. Follow [deployment results](#/docs/deployments#read-the-apply-states).

For a native rejection, Check pipeline identifies a safe error category and, when Vector's output can be matched to the submitted configuration, the affected component and required setting. The portal does not display raw Vector diagnostics: they can contain configuration values, local paths, VRL source or sample-event data. If the category is not enough to fix the pipeline, run the pinned Vector `validate` command locally with the intended configuration and service identity, and handle its output as sensitive. A successful isolated check still leaves device resources and activation unverified.

If another editor saved first, preserve your local changes before reloading the newer draft. Resolve the revision conflict deliberately, check the merged result and publish that result.

## Compare saved history

Open [**Actions → Version history**](/#/configurations?panel=history) to review published versions and saved draft revisions without replacing the editor. **Back to editor** returns to your work. Unapplied field input stays in the editor; it is not included in configuration comparisons.

1. Choose **Published versions** or **Draft revisions**, then select a snapshot. Use **Previous** and **Next** to browse older entries.
2. **Compare changes** shows that snapshot before your current draft. Each change includes its exact configuration path and the before/after values.
3. Use **Choose comparison** to compare it with another published version or saved revision. This can compare two historical snapshots without changing the current draft.
4. Choose **Configuration** to inspect the selected snapshot's complete read-only JSON, including fields the visual editor does not recognize.

Only configuration values are compared. Pipeline names, descriptions and graph positions are excluded. Array order matters. **Not set**, `null`, `""`, `0` and `false` are different values; the comparison preserves those distinctions. For example, a change at `sources.input.include[0]` changes the first file pattern, while `["field.with.dot"]` identifies a single key containing dots, not nested objects.

History lists load 12 entries per page; comparisons show up to 25 changes per page. Refresh the history if another person has saved or published since you opened it.

The snapshot header shows its creation time, author when recorded, change message and available source information. Expand **Snapshot details** for the snapshot, author and source identifiers. Older records may have less authorship or source information.

## Restore a snapshot as a new draft

Choose the snapshot in History, then **Restore as draft**. Review the confirmation before selecting **Restore draft**. This replaces the current draft configuration and canvas with the chosen snapshot, keeps the pipeline's current name and description, and creates a new revision. It does not rewrite the historical snapshot or change running devices.

Finish or discard unapplied editor fields first. If another person saved a newer revision, review that conflict rather than repeatedly submitting the old restore request. An archived pipeline's draft cannot be changed until the pipeline is restored to the active library.

Inspect the restored draft, check it and publish a new version when ready. To deploy an already published historical version directly, choose **Deploy this version** in History and review its target devices. Published versions remain deployable when their pipeline is archived. See [deliberate rollback](#/docs/deployments#roll-back-deliberately) for the difference between restoring a draft and changing a device's assigned version.
