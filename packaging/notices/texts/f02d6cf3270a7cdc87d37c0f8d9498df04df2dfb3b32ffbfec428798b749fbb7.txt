These files are derived from Vector 0.58.0, commit
`2bcad9bbb84e201dcfd58c22b1f779290101b728`, published by the Vector contributors
at https://github.com/vectordotdev/vector. The upstream files and generated schema
are covered by the Mozilla Public License 2.0; its unmodified text is in LICENSE.
Individual upstream copyright notices remain in their respective files.

`vector-schema-0.58.0.json` is the unmodified JSON data emitted by the verified
official Windows x64 executable's experimental `generate-schema` command,
serialized with sorted object keys and two-space indentation (the native command
does not guarantee object-key order). `vector-list-0.58.0.json` captures the
same executable's `list --format json` output. `capture.json` records the
executable digest and exact version string. The `src/` and `website/` files are
unmodified snapshots from the pinned commit. `official-component-inventory.json`
records every generated component document in that commit's complete Git tree.

The dashboard's generated schema adds per-type wrappers, removes test-only and
duplicate registrations, and projects public CUE fields for the three Unix
sources absent from the Windows executable. These projections describe editor
fields, not a complete substitute for native runtime validation. They are marked
`pinned-cue-projection`, and Linux/macOS runtime execution is not asserted.
Presence in the catalog does not authorize a component on an enrolled device.

Reproduce the checked-in outputs offline:

```
node scripts/generate-vector-catalog.mjs
node scripts/generate-vector-catalog.mjs --check
```

Refresh source snapshots from the same immutable commit:

```
node scripts/generate-vector-catalog.mjs --refresh-upstream
```

Recapture the pinned verified Windows executable explicitly:

```
node scripts/generate-vector-catalog.mjs --capture --vector PATH/TO/vector.exe
```

The capture profile checks the exact executable digest and version. Supporting
another native extraction profile requires an explicit generator update.
`provenance.json` records all input hashes, output hashes, generation commands,
source URLs, coverage and generator digest. It contains no machine-specific paths
or timestamps, so unchanged inputs produce identical artifacts.
