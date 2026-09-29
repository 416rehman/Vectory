# Secrets, enrichment & tests

Configure resources under [**Actions → Pipeline settings**](/#/configurations?panel=settings). Their files, credentials, executable dependencies and permissions belong on each target device. Provision those resources before deploying; most native resource features require [full Vector mode](#/docs/installation#choose-configuration-capabilities).

## Choose the right reference

| Mechanism               | Example                               | Resolved by                            | When to use it                                             |
| ----------------------- | ------------------------------------- | -------------------------------------- | ---------------------------------------------------------- |
| Event template          | `{{ hostname }}`                      | Vector, from each event                | A field documented to support event templates.             |
| Environment reference   | `${API_TOKEN}`                        | Vector, from its process environment   | A full-mode host whose service environment is provisioned. |
| Native secret reference | `SECRET[local_credentials.api_token]` | A configured Vector secret backend     | Native integrations and credential fields in full mode.    |
| Vectory local binding   | `vectory-secret:API_TOKEN`            | The agent, from an approved local file | Supported HTTP, Loki and Elasticsearch sink auth fields.   |

These strings are not interchangeable. A path in the dashboard does not upload a file. A shell environment variable is not automatically present in a system service. The Vectory server never resolves your device's secret files.

## Keep credentials on the device

Vectory local bindings support an exact reference in `auth.user`, `auth.password` or `auth.token` of an `http`, `loki` or `elasticsearch` sink. For a bearer token, the sink fragment is:

```json
{
  "auth": {
    "strategy": "bearer",
    "token": "vectory-secret:API_TOKEN"
  }
}
```

On each target host:

1. Put the credential in a private file accessible to the actual agent service identity.
2. Create a protected JSON name-to-file map, saved as UTF-8 without a byte-order mark (BOM). Paths must be absolute, and each name must appear only once.
3. Stop the agent through its existing supervisor, register the complete map, and check the command succeeds before restarting. Stopping the agent also stops its supervised Vector process.

Example `bindings.json`, containing a path rather than the credential:

```json
{ "API_TOKEN": "/protected/vector/api-token.txt" }
```

```sh
vectory configure-secrets \
  --state-dir /var/lib/vectory-agent \
  --secret-files /protected/vector/bindings.json
```

The map replaces all existing local bindings and can contain up to 64 names; include every name still needed, or use `{}` to remove them all. Follow [local settings maintenance](#/docs/installation#update-local-agent-settings) to retain the installed service's access and verify the result after restarting.

Both `configure-secrets` and `install --secret-files` require a JSON object. `null`, a list, duplicate names, extra data after the object and values that are not valid file paths are rejected without changing the existing bindings. Supply the map through `--secret-files`; a filename placed after the command without that option is not accepted. See [rejected secret-binding maps](#/docs/troubleshooting#a-secret-binding-map-is-rejected) for correction steps and older-build behavior.

On Windows, JSON paths need escaped backslashes, for example:

```json
{ "API_TOKEN": "C:\\ProgramData\\Vectory\\secrets\\api-token.txt" }
```

```powershell
& 'C:\Program Files\Vectory\vectory.exe' configure-secrets `
  --state-dir C:\ProgramData\Vectory `
  --secret-files C:\ProgramData\Vectory\bindings.json
```

Use your installation's actual paths. A successful command saves the bindings; it does not start Vector or verify a credential. After restarting the same supervisor, check the next authorized, unpaused configuration attempt and the destination's behavior.

Each bound file must be regular, private, single-link, owned by the agent account or administrator, at most 16 KiB, and valid UTF-8 without NUL. One trailing CRLF or LF is removed. Symlinks, hardlinks and broadly readable files are rejected. Protect the managed configuration and recovery backups too: they contain the rendered value.

Binding names start with a letter and contain up to 64 letters, digits, underscores, dots or hyphens. References are not interpolation: `prefix-vectory-secret:API_TOKEN`, a reference in a URL, or a reference in VRL is rejected. In full mode, a bound value containing native interpolation markers is rejected to preserve literal insertion; use a native provider for such values.

### Rotate a bound credential

Replace the protected credential file while preserving its ownership and permissions. On the next authorized, unpaused reconciliation, the agent renders a new effective configuration even if the pipeline version is unchanged. A failed attempt keeps the last verified workload.

Verify the device returns to **Applied** and inspect its technical details: the template digest remains tied to the published version, while the effective digest and local secret revision identify the rendered attempt. These values identify changes; they do not reveal the credential or prove that a downstream service accepted it.

## Use native Vector secret providers

In full mode, open [**Pipeline settings → Secrets**](/#/configurations?panel=settings&section=secret) and add a backend. This configuration fragment names a native file backend:

```json
{
  "secret": {
    "local_credentials": {
      "type": "file",
      "path": "/protected/vector/native-secrets.json"
    }
  }
}
```

The private file contains a JSON object mapping names to credential values. In a supported field, reference `SECRET[local_credentials.api_token]`. Configure the file and permissions on every target. The [native secrets reference](https://vector.dev/docs/reference/configuration/secrets/) describes available backends and options.

Native provider changes follow Vector's own loading behavior. They do not use Vectory's local-binding revision tracking, and a managed-file digest cannot attest to a provider's current value.

Full mode also enables native `$NAME` and `${NAME}` environment interpolation. Set variables for the account and service that runs the agent; do not paste their values into the dashboard. See [Vector environment variables](https://vector.dev/docs/reference/environment_variables/).

## Enrich events with local data

A file enrichment table lets a transform look up reference data. For example, create this CSV on each full-mode device at `/opt/vector/hosts.csv`:

```csv
hostname,owner
edge-01,platform
edge-02,observability
```

Add this top-level fragment through [**Pipeline settings → Enrichment tables**](/#/configurations?panel=settings&section=enrichment_tables) or the configuration editor:

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

In a remap transform, query a matching record:

```vrl
record = get_enrichment_table_record!("hosts", {"hostname": "edge-01"})
.owner = record.owner
```

This example produces `.owner = "platform"`. Replace the fixed lookup key with a checked event field for a real pipeline. A missing or ambiguous record can fail the expression; decide how your transform should handle that case and add a test.

The CSV is a host resource, not part of the published artifact. Test readability and columns on each target. Refresh behavior depends on the native table implementation. The [pipeline component reference](https://vector.dev/docs/reference/configuration/pipeline-components/#enrichment_tables) covers table options.

## Test transformations

Use [**Pipeline settings → Tests**](/#/configurations?panel=settings&section=tests) → **Run pipeline tests** to check supplied events against declared transform assertions. Complete pending field edits first. Tests use your sample events; they do not fetch live device events.

Merge this fragment into the [complete example pipeline](#/docs/pipelines#try-a-complete-example), whose `normalize` transform sets `.service = "edge"`:

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

Expect **Pipeline tests passed**. Change the expected service to `wrong` and run again to confirm the assertion can fail, then restore it. For filters or routes, also consider `no_outputs_from` assertions. See [Vector unit tests](https://vector.dev/docs/reference/configuration/unit-tests/).

The server runs native tests only when the configuration is safe and self-contained in its isolated worker. **These tests need the device environment** means deferred, not passed. With nonempty top-level tests, the agent runs real `vector validate` and `vector test --config-json` before activation. A failure leaves the previous workload intact. Top-level tests require full mode under the current local policy.

A failed isolated test reports that an assertion failed, without returning test names, event payloads or raw Vector output. Review the declared conditions and run the exported document locally for details. Local Vector output can include sample events and should be handled as sensitive.

To test an exported JSON document on a prepared host:

```sh
vector test --config-json example.json
```

Use the adopted Vector version and the intended service identity. Native tests and validation can access configured files or execute providers, so run only host-approved configurations.

## Configuration providers

[**Pipeline settings → Configuration provider**](/#/configurations?panel=settings&section=provider) configures Vector's native mechanism for loading configuration from a provider available on the device. This requires full mode and any provider-specific dependencies.

A provider is different from a secret backend: it can supply configuration, rather than one credential value. Review its external content and loading behavior with the host operator. Vectory tracks the published managed document; it does not turn remotely fetched provider content into an immutable Vectory version. Prefer explicit pipeline content when you need every configuration change represented in version history.
