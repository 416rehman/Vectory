# Secrets, enrichment & tests

Give pipelines credentials, lookup data and tests, from [**Settings**](/#/configurations?panel=settings) in the editor toolbar. Credentials and files live on each device, never in the pipeline, so provision them before you deploy.

## Choose the right reference

| Mechanism | Example | Resolved by | Use it for |
| --- | --- | --- | --- |
| Event template | `{{ hostname }}` | Vector, from each event | Fields that document template support. |
| Environment variable | `${API_TOKEN}` | Vector, from its service environment | Full-mode devices whose service environment you manage. |
| Native secret | `SECRET[local_credentials.api_token]` | A Vector secret backend on the device | Credential fields on full-mode devices. |
| Device secret | `vectory-secret:API_TOKEN` | The agent, from a local file you bind | Every credential field, in restricted and full mode. |
| Deployment value | `site_name`, from **Settings → Variables** | Vectory, in each device's own copy | A setting that differs by device, such as a site name or a port. Never a credential. |

These aren't interchangeable. A path in the dashboard doesn't upload a file, and a variable in your shell isn't in a service's environment. The Vectory server never reads your devices' secret files.

## Keep credentials on the device

A device secret keeps a credential out of the pipeline. The pipeline stores only a name, such as `vectory-secret:DD_API_KEY`, and each device fills in the value from a private file of its own. The value never reaches the Vectory server, its database, the dashboard or the audit log.

It works in every field Vector marks as a credential, in any component: API keys, passwords, tokens, AWS secret keys and TLS key passphrases, plus the user names of basic authentication.

### Reference a secret in the pipeline

In the component inspector, a credential field asks for a secret name, never the value. Type a name such as `DD_API_KEY`, or choose the one it suggests. The pipeline stores the reference:

```json
{
  "sinks": {
    "datadog": {
      "type": "datadog_logs",
      "inputs": ["app_logs"],
      "default_api_key": "vectory-secret:DD_API_KEY"
    }
  }
}
```

Vectory refuses plain text in a credential field. Saving or publishing it fails with the field's name and the fix: use a device secret, then bind it on each device with `vectory configure-secrets`. Versions you already published are never rewritten.

The publish review lists every device secret a version reads, and marks names that are new since the published version.

### Bind it on each device

On each device that runs the pipeline:

<!-- steps -->
1. Put the credential in a private file that the agent's service account can read, for example `/etc/vectory/secrets/DD_API_KEY`.
2. Create a bindings file that maps each name the device needs to its file path (not the value):

   ```json
   { "DD_API_KEY": "/etc/vectory/secrets/DD_API_KEY" }
   ```

3. With the agent stopped, register the bindings, then start the agent:

   ```sh
   sudo vectory service-stop
   sudo vectory configure-secrets --secret-files /etc/vectory/secret-bindings.json
   sudo vectory service-start
   ```

4. Deploy the pipeline and wait for **Applied**.

On Windows, double each backslash in the bindings file, as in `"C:\\ProgramData\\Vectory\\secrets\\DD_API_KEY"`, and run the commands in an administrator PowerShell:

```powershell
vectory service-stop
vectory configure-secrets --secret-files C:\ProgramData\Vectory\secret-bindings.json
vectory service-start
```

A credential field's **How to bind it on a device** shows these steps with your names filled in.

### Check which devices have it

The device page's **Device secrets** card lists the names its version reads and, for each, **Bound** or **Not bound**. The agent reports names only, at each check-in: never values or file paths.

A device with a name **Not bound** can't apply that version, and keeps running what it runs now. Bind the name and start the agent: its next check-in applies the version. An agent too old to report names shows **Not reported**, and its apply status says whether each secret resolved.

The page's **Effective configuration** shows the text the device was offered, with `vectory-secret:NAME` where the value goes. The server never has the value, so no page can show it. [How Vectory compares them](deployments.md#how-vectory-compares-them) says how a file with a resolved value is checked.

### What restricted and full mode allow

| Reference | Restricted mode | Full mode |
| --- | --- | --- |
| `vectory-secret:NAME` | Every credential field | Every credential field |
| `SECRET[backend.key]` | Not available | Credential fields, from a secret backend you configure |
| `${VAR}` or `$VAR` | Not available | Values from the Vector service's environment |

On a restricted device, a device secret is the only way to keep a credential out of the pipeline.

### The rules

- The reference must be the whole value of a credential field. A reference anywhere else, such as a URL, an endpoint, a header, a path, a command or a VRL program, is refused on the server and again on the device. So a pipeline can't copy a secret into another setting or an event.
- A credential goes only to the destination its step sends to. On a restricted device, that destination must be in the device's allowances.
- The bindings file replaces all bindings. List every name you still need; `{}` removes them all. Up to 64 names.
- Names start with a letter and use up to 64 letters, digits, `_`, `.` or `-`.
- Each secret file must be a regular, private file (no links), owned by the agent's account or an administrator, valid UTF-8, and at most 16 KiB. One trailing newline is removed.
- In full mode, a value containing `${` or similar interpolation markers is refused, so it is inserted exactly as written.

> [!WARNING]
> **The rendered configuration contains the value**
> The agent writes the resolved value into the device's managed configuration and its recovery copies. Keep those files, and backups of them, readable only by the agent's account and your administrators.

If the bindings file is rejected, nothing changes. See [A secret-binding map is rejected](troubleshooting.md#a-secret-binding-map-is-rejected).

### Rotate a bound credential

Replace the secret file, keeping its owner and permissions. At its next check-in the agent renders a new configuration, even though the version is unchanged. If the new value fails, the device keeps the last working configuration.

The device's technical details then show a new effective digest and local secret revision, while the version's template digest stays the same. These identify the change without revealing the value.

## Values that differ by device

A variable makes one field of a pipeline take a different value on each device, such as a site name, a listen port or a log path. The pipeline keeps the field and the variable's name. You enter the values when you deploy, and each device receives its own copy of the configuration with its value in place.

Variables are Vectory deployment values. They are separate from Vector's environment variables and secret providers, and they're stored with the deployment where authorized users can read them. Never put a credential in one: use a [device secret](#keep-credentials-on-the-device), which works in restricted and full mode.

### Add a variable

<!-- steps -->
1. In the editor, choose [**Settings → Variables**](/#/configurations?panel=settings&section=variables).
2. Under **Add a device-specific field**, choose the **Pipeline field**. The list holds the text, whole-number and true-or-false fields the draft has now. It leaves out inputs, VRL programs, commands, headers, TLS settings, the `api` block and anything that looks like a credential.
3. Type a **Variable name**: a letter first, then letters, digits or underscores, up to 64 characters.
4. Choose **Add variable**, then save the draft.

A pipeline can have up to 64 variables, and **Remove** takes one away. A version records the variables the draft had when you published it.

### Enter the values when you deploy

<!-- steps -->
1. Publish a version and choose **Choose devices**.
2. Under **Values by device**, tick **Set default for selected devices** and enter the value the devices share. A deployment that also includes future group members asks for **Set required default** instead, because new members take it.
3. In the **Each device** table, give a device its own value. A cell left empty uses the default, and reads **Needs a value** when there is none.
4. To fill many devices at once, open **Paste values for many devices** and paste one device per line: its name, then its values in the order of the variables, separated by commas or tabs. A spreadsheet copy works. Choose **Fill these values**.
5. Choose **Review deployment**.

You should see **Device-specific values** in the summary, and for each device its value, marked **Default** or **Override**, beside the SHA-256 of the exact text it would receive.

When the devices already run an earlier version of the pipeline, the dialog fills in the values they have and says so: **Filled 3 values from Edge syslog processing v2, what these devices run now.** Change any of them before you review. A device you tick by itself gets its own cell; devices you add in bulk take the default.

A whole-number field takes a whole number and a true-or-false field takes **True** or **False**. A text value is a plain literal of up to 4,096 bytes: Vectory refuses `$`, `{{`, `%{`, secret references and text that looks like a credential in it.

On a restricted device, each value must still meet the host's allowances, such as a destination or a listen address. **Check on devices** in the review tries each device's own values.

### See what a device was offered

Open the device's page and choose **Effective configuration → Variables**. It lists each variable with the field it sets and the value this device was offered, and says where the value came from: **Set for this device** or **Deployment default**. A version without variables reads "This version has no device-specific values: every device gets the same text."

## Use native Vector secret providers

On full-mode devices, Vector can resolve secrets itself. In [**Settings → Secrets**](/#/configurations?panel=settings&section=secret), add a backend, for example a file backend:

```json
{
  "secret": {
    "local_credentials": {
      "type": "file",
      "path": "/etc/vector/native-secrets.json"
    }
  }
}
```

The file is a JSON object of names to values. Reference them as `SECRET[local_credentials.api_token]`, and provision the file on every device. The [Vector secrets reference](https://vector.dev/docs/reference/configuration/secrets/) lists the available backends.

Full mode also enables `$NAME` and `${NAME}` [environment variables](https://vector.dev/docs/reference/environment_variables/). Set them in the agent service's environment on the device, never in the dashboard.

Vectory can't track changes made through providers or environment variables: they follow Vector's own loading rules.

## Enrich events with local data

An enrichment table lets a transform look up reference data on the device. Create a CSV on each full-mode device, for example `/opt/vector/hosts.csv`:

```csv
hostname,owner
edge-01,platform
edge-02,observability
```

Add the table in [**Settings → Enrichment tables**](/#/configurations?panel=settings&section=enrichment_tables):

```json
{
  "enrichment_tables": {
    "hosts": {
      "type": "file",
      "file": {
        "path": "/opt/vector/hosts.csv",
        "encoding": { "type": "csv" }
      }
    }
  }
}
```

Then look up a record in a `remap` transform:

```vrl
record = get_enrichment_table_record!("hosts", {"hostname": "edge-01"})
.owner = record.owner
```

This sets `.owner = "platform"`. In a real pipeline, look up a field from the event, and decide what should happen when no record matches: the `!` makes a missing record an error. The CSV isn't part of the version, so check it exists on every device. The server never opens it: its check leaves the table to the devices, and the pipeline's tests run only on a device (see [Test transformations](#test-transformations)). See the [enrichment table reference](https://vector.dev/docs/reference/configuration/pipeline-components/#enrichment_tables).

## Test transformations

Tests prove that a transform does what you expect, using events you supply. In [**Settings → Tests**](/#/configurations?panel=settings&section=tests), choose **Run pipeline tests**. Each test is listed as passed or failed; a failed test shows Vector's reason and the events the step produced. Vector reads every test before it runs the first, so a test it can't read or build (a misspelled setting, an unknown step name, no expected output) stops them all: that test shows Vector's reason and the others are marked **Not run**. To start a test from a sample, run the sample in the VRL editor and choose **Save as test**.

This test belongs to the [complete example](pipelines.md#try-a-complete-example), whose `normalize` transform sets `.service`:

```json
{
  "tests": [
    {
      "name": "sets service name",
      "inputs": [
        {
          "insert_at": "normalize",
          "type": "log",
          "log_fields": { "message": "example event" }
        }
      ],
      "outputs": [
        {
          "extract_from": "normalize",
          "conditions": [".service == \"edge\""]
        }
      ]
    }
  ]
}
```

You should see **Pipeline tests passed**. Change `"edge"` to `"wrong"` and run again to see a failure, then change it back. For filters and routes, also try `no_outputs_from`. See [Vector unit tests](https://vector.dev/docs/reference/configuration/unit-tests/).

**Tests gate publishing.** **Review & publish** runs the pipeline's tests when it opens and says how they went: "Tests: 2 of 2 passed", or, when Vector couldn't build a test, which one and why, and that the others didn't run. While a test fails, was refused or didn't run, the primary button reads **Publish anyway** and sits beside **Open tests**, which takes you to the first test that isn't passing. Publishing anyway is allowed and recorded: the audit entry says tests were failing and how many of each kind, never what they contain. The server runs the tests again when it publishes, so a script that calls [`POST /configurations/{id}/publish`](api.md) gets `409 TESTS_FAILED` with the results until it sends `acknowledge_test_failures: true`. A pipeline with no tests, or whose tests Vector skipped and explained (a device runs them), publishes as before.

The server runs tests in its sandboxed validator when the pipeline needs nothing from the device. **These tests need the device environment** means they couldn't run there; that isn't a pass.

A pipeline with a Lua step, an enrichment table that reads a file (`file`, `geoip` or `mmdb`), a remap that loads its VRL program from a file (`file` or `files`) or an AWS instance metadata step (`aws_ec2_metadata`) is never tested on the server: Lua can run any program, the files live on the device, and the metadata step asks the host's own metadata service. **Run pipeline tests** says which, and the review counts those tests as not run, so the primary button reads **Publish anyway**. Run them on a device instead: in the deploy review, choose **Check on devices** and **Also run the pipeline's tests**. A `memory` table reads no file, so its tests run here as before. A remap takes exactly one of `source`, `file` and `files`; if it names more than one, the check fails with Vector's own rule, "must provide exactly one of `source` or `file` or `files`", and its tests can't be built on any device. When a version has tests, each device runs `vector test` before applying it, and keeps its current configuration if any test fails. Restricted devices run tests too: a test only inserts your sample events into transforms and checks the output, with no file or network access, and any VRL in a test is still held to the device's allowances.

The server never sends network requests or reads device files from samples or tests. A program that calls `http_request`, `dns_lookup`, `reverse_dns`, `validate_json_schema`, `parse_proto` or `encode_proto`, or that passes a file to `parse_groks` (`alias_sources`) or `parse_etld` (`psl`), isn't run there, and the tester says so. Without a file, `parse_groks` and `parse_etld` run as usual. A device in full mode runs it for real.

To run the tests yourself, export the configuration as JSON and run the pinned Vector with the device's service account:

```sh
vector test --config-json example.json
```

Local output can include your sample events; treat it as sensitive.

## Configuration providers

[**Settings → Configuration provider**](/#/configurations?panel=settings&section=provider) sets up Vector's native mechanism for loading configuration from a provider on the device. It needs full mode and whatever the provider depends on.

A provider supplies configuration, not a single value, and Vectory can't version what it fetches. Prefer explicit pipeline content when you want every change in your version history.
