# Secrets, enrichment & tests

Give pipelines credentials, lookup data and tests, from [**Actions → Pipeline settings**](/#/configurations?panel=settings). Credentials and files live on each device, never in the pipeline, so provision them before you deploy.

## Choose the right reference

| Mechanism | Example | Resolved by | Use it for |
| --- | --- | --- | --- |
| Event template | `{{ hostname }}` | Vector, from each event | Fields that document template support. |
| Environment variable | `${API_TOKEN}` | Vector, from its service environment | Full-mode devices whose service environment you manage. |
| Native secret | `SECRET[local_credentials.api_token]` | A Vector secret backend on the device | Credential fields on full-mode devices. |
| Vectory local binding | `vectory-secret:API_TOKEN` | The agent, from a local file you approve | Auth fields of `http`, `loki` and `elasticsearch` sinks, in either mode. |

These aren't interchangeable. A path in the dashboard doesn't upload a file, and a variable in your shell isn't in a service's environment. The Vectory server never reads your devices' secret files.

## Keep credentials on the device

A local binding puts a credential into a sink's auth field without it ever leaving the device. Use it in `auth.user`, `auth.password` or `auth.token` of an `http`, `loki` or `elasticsearch` sink:

```json
{
  "auth": {
    "strategy": "bearer",
    "token": "vectory-secret:API_TOKEN"
  }
}
```

On each device that runs the pipeline:

<!-- steps -->
1. Put the credential in a private file that the agent's service account can read, for example `/etc/vectory/secrets/api-token.txt`.
2. Create a bindings file that maps names to file paths (not values):

   ```json
   { "API_TOKEN": "/etc/vectory/secrets/api-token.txt" }
   ```

3. With the agent stopped, register it, then start the agent:

   ```sh
   sudo vectory service-stop
   sudo vectory configure-secrets --secret-files /etc/vectory/secret-bindings.json
   sudo vectory service-start
   ```

4. Deploy the pipeline and wait for **Applied**.

On Windows, double each backslash in the bindings file: `"C:\\ProgramData\\Vectory\\secrets\\api-token.txt"`.

The rules:

- The bindings file replaces all bindings. List every name you still need; `{}` removes them all. Up to 64 names.
- Names start with a letter and use up to 64 letters, digits, `_`, `.` or `-`.
- Each secret file must be a regular, private file (no links), owned by the agent's account or an administrator, valid UTF-8, and at most 16 KiB. One trailing newline is removed.
- The reference must be the whole field value. `prefix-vectory-secret:API_TOKEN`, a reference inside a URL and a reference in VRL are refused.
- In full mode, a value containing `${` or similar interpolation markers is refused, so it is inserted exactly as written.

> [!WARNING]
> **The rendered configuration contains the value**
> The agent writes the resolved value into the device's managed configuration and its recovery copies. Keep those files, and backups of them, readable only by the agent's account and your administrators.

If the bindings file is rejected, nothing changes. See [A secret-binding map is rejected](troubleshooting.md#a-secret-binding-map-is-rejected).

### Rotate a bound credential

Replace the secret file, keeping its owner and permissions. At its next check-in the agent renders a new configuration, even though the version is unchanged. If the new value fails, the device keeps the last working configuration.

The device's technical details then show a new effective digest and local secret revision, while the version's template digest stays the same. These identify the change without revealing the value.

## Use native Vector secret providers

On full-mode devices, Vector can resolve secrets itself. In [**Pipeline settings → Secrets**](/#/configurations?panel=settings&section=secret), add a backend, for example a file backend:

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

Add the table in [**Pipeline settings → Enrichment tables**](/#/configurations?panel=settings&section=enrichment_tables):

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

This sets `.owner = "platform"`. In a real pipeline, look up a field from the event, and decide what should happen when no record matches: the `!` makes a missing record an error. The CSV isn't part of the version, so check it exists on every device. See the [enrichment table reference](https://vector.dev/docs/reference/configuration/pipeline-components/#enrichment_tables).

## Test transformations

Tests prove that a transform does what you expect, using events you supply. In [**Pipeline settings → Tests**](/#/configurations?panel=settings&section=tests), choose **Run pipeline tests**. Each test is listed as passed or failed; a failed test shows Vector's reason and the events the step produced. Vector reads every test before it runs the first, so a test it can't read or build (a misspelled setting, an unknown step name, no expected output) stops them all: that test shows Vector's reason and the others are marked **Not run**. To start a test from a sample, run the sample in the VRL editor and choose **Save as test**.

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

The server runs tests in its sandboxed validator when the pipeline needs nothing from the device. **These tests need the device environment** means they couldn't run there; that isn't a pass. When a version has tests, each device runs `vector test` before applying it, and keeps its current configuration if any test fails. Restricted devices run tests too: a test only inserts your sample events into transforms and checks the output, with no file or network access, and any VRL in a test is still held to the device's allowances.

The server never sends network requests or reads device files from samples or tests. A program that calls `http_request`, `dns_lookup`, `reverse_dns`, `validate_json_schema`, `parse_proto` or `encode_proto` isn't run there, and the tester says so. A device in full mode runs it for real.

To run the tests yourself, export the configuration as JSON and run the pinned Vector with the device's service account:

```sh
vector test --config-json example.json
```

Local output can include your sample events; treat it as sensitive.

## Configuration providers

[**Pipeline settings → Configuration provider**](/#/configurations?panel=settings&section=provider) sets up Vector's native mechanism for loading configuration from a provider on the device. It needs full mode and whatever the provider depends on.

A provider supplies configuration, not a single value, and Vectory can't version what it fetches. Prefer explicit pipeline content when you want every change in your version history.
