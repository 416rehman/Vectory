# Distribution notices

`manifest.json` records pinned component versions, source archive integrity,
original upstream text SHA-256, and checked-in text SHA-256. The snapshots in
`texts/` preserve the original wording. CRLF is normalized to LF for reproducible
Git checkouts; the two digests distinguish that transport normalization. Identical
texts are retained once and associated with every relevant component.

Generate or verify the root distribution notice without network access:

```sh
python packaging/generate-notices.py
python packaging/generate-notices.py --check
```

The check verifies lockfile/source-input digests, pinned compiler images,
component coverage, source-text hashes, and exact generated `NOTICE` bytes.
Packages with SPDX declarations but missing publisher text have an explicit
provenance note. Copyright ownership or years are never inferred from authors.
The Replit color-picker's canonical MIT terms retain the published declaration
and separately identify the SPDX standard-text source and extraction. The
React remove-scroll-bar notice identifies the accessible upstream revision and
does not assert correspondence to its unavailable published gitHead.

The browser scope was captured from the app/designer Rollup chunks and rendered
Astro Help modules. Pagefind's precompiled UI additionally exposes its bundled
module markers; the matching immutable UI lockfile pins those five runtime
packages. The Rust scope is the Linux normal/build graph and standard-library
copyright document; the Go scope covers the pinned toolchain and agent modules.
Compiler macros/build inputs can be a conservative superset of linked code.
Operating-system notices stay in the containers' original copyright directories.
The inherited Vector validator retains its upstream third-party notice material.

When lockfiles, compiler images, browser imports, or precompiled dependencies
change, capture the distribution graphs again. Retrieve each package's actual
LICENSE/COPYING/NOTICE text from its integrity-verified archive or an immutable
upstream revision mapped by package provenance. Record the file's original hash,
normalize only its line endings for the snapshot, and update the manifest and
scope. Do not substitute a license label for a missing copyright statement.
Regenerate `NOTICE`, copy it to `dashboard/public/NOTICE.txt`, and build/test all
distribution surfaces. The snapshots are upstream legal text and retain their
original punctuation and whitespace.

Pagefind compiled search includes a GPLv3 dependency. Its exact source tree,
vendored WASM dependencies, matched Snowball algorithm/generator source, and five
embedded UI source packages are delivered separately in
`help-center/legal/pagefind-1.5.2-source.tar.gz`. Its manifest binds the shipped
WASM bytes and records the isolated offline source-build proof. This optional
developer source bundle does not change the prebuilt installation path.

Verify it offline, or reconstruct it from the pinned HTTPS inputs:

```sh
python packaging/build-pagefind-source.py --check
python packaging/build-pagefind-source.py --download
```

Reconstruction caches verified inputs in `.local/pagefind-source-inputs/`.
The deterministic tar/gzip uses fixed member order, owner, permissions and
timestamps. Rebuilding the raw WASM and regenerating the English stem succeeded
inside an isolated pinned Rust container with registry access disabled. The
manifest records raw build hashes and explicitly does not claim byte equivalence
to upstream's separately optimized/packaged WASM.

These files document shipped materials and provenance. They are not legal
clearance or a completeness claim for a future changed distribution.
