# Release engineering

This tree prepares unsigned development outputs. No release, APT repository, Homebrew tap, MSI, Apple signing identity, or public package namespace is claimed to exist. Native OS acceptance in [COMPATIBILITY](../docs/COMPATIBILITY.md) is independent of cross-compilation.

Build from a reviewed clean commit with Go 1.26.8, Rust 1.94.0, Node 22, lockfiles, and Python 3.11+:

```sh
python3 packaging/build-release.py --out artifacts/releases
python3 packaging/generate-sbom.py --out artifacts/releases/source.spdx.json
python3 packaging/record-source.py --out artifacts/releases/SOURCE-INPUTS.json
python3 packaging/verify-release.py artifacts/releases --refresh-checksums
```

This produces raw binaries for the dashboard catalog, deterministic ZIP/tar.gz archives, SHA256SUMS, and `catalog.json`. All metadata is derived from actual file bytes. `signed` remains false. Copy the complete directory to the configured local release mirror. Installation tokens are never embedded. The package version must match `agent/internal/agent/types.go` before a release; development builds remain `0.1.0-dev`.

The local source-input inventory records tracked and nonignored untracked file hashes, excluding generated evidence reports and private/build output directories ignored by Git. Capture it after the source freeze. It identifies the inspected bytes and does not assert that an independent builder produced the artifacts or replace signed provenance.

Repeat the build from the same source/toolchain in a fresh directory and compare every binary, archive and catalog digest. Additional source SBOM metadata must be generated consistently before comparing complete checksum inventories. `-trimpath`, disabled VCS stamping, a fixed empty Go build ID, conservative `GOAMD64=v1`, CGO disabled, and normalized archive times make this comparison useful. The verifier parses Linux ELF headers and rejects PT_INTERP or DT_NEEDED; `readelf -l` and `readelf -d` provide an additional native inspection path. Offline builds require preloaded module and npm/Cargo caches and container base images. The final local candidate's two same-host builds matched all eleven binary/archive/catalog files; this is not independent-builder provenance.

`release-candidate.yml` runs only when manually dispatched, uploads development artifacts to the workflow, and generates an SPDX source SBOM. `ci.yml` checks Rust, dashboard, agent tests on three current hosts, backup adversarial tests and image build. CI has not been executed merely because these files exist. Resolve every scanner finding; run `packaging/audit-rust.py`, `govulncheck ./...`, `npm audit`, and an image scanner on the exact release inputs. The Rust gate retains full findings and admits only the specifically proven inactive optional dependency described in [DEPENDENCY-AUDIT](../docs/DEPENDENCY-AUDIT.md). These checks require a current vulnerability database and are not performed by the agent at runtime.

To sign checksums offline using an established cosign key, run `packaging/sign-release.sh artifacts/releases <key-reference>`, then independently verify with `cosign verify-blob --key <public-key> --signature SHA256SUMS.sig --insecure-ignore-tlog SHA256SUMS`. The offline choice intentionally omits transparency-log upload. Ship the pre-established public key through a separate trusted channel. Never change `signed` to true merely because a `.sig` file exists; verification must succeed and the catalog signer identity must be documented. Provenance signing requires a maintainer-controlled CI identity and protected environment; record commit, builder identity, pinned toolchains, lockfile digests, and artifact digests. No attestations are fabricated locally.

Linux packages use `nfpm package --config packaging/nfpm.yaml --packager deb` / `rpm` from a directory layout adjusted to the source paths (the template is relative to `packaging/`). Provide VERSION and GOARCH, build the binary first, inspect package contents and test native install/upgrade/uninstall. No post-install script enrolls, starts Vector, grants sudo, or embeds secrets. Review the systemd example's dedicated user and exact writable roots before enabling it.

On macOS run `packaging/macos/build-pkg.sh <arm64-binary> <version> <output.pkg>`. Use a real Developer ID application signature for the binary and Installer signature for the package, submit to Apple's notarization service and staple the result before claiming signed/notarized status. A Homebrew formula requires a real stable archive URL and its verified SHA256, an actual tap namespace, license, and explicit installation test; until published, install the verified archive manually. Intel Mac is build-only for the current Vector pin.

On Windows install WiX v4 on a build machine, then `wix build packaging/windows/vectory.wxs -arch x64 -d Version=0.1.0 -d Binary=<absolute-agent.exe> -o vectory.msi`. This MSI installs the binary only. Local administrator installation/adoption/enrollment and native service registration are explicit follow-up steps. Sign with an established Authenticode certificate and a trusted timestamp service; verify the chain, timestamp, clean install, upgrade identity preservation and uninstall in a Windows VM. ZIP/native build evidence is not MSI evidence.

`build-apt-repository.sh <debs> <new-directory> <gpg-key-id>` uses dpkg-scanpackages, apt-ftparchive and a real GPG key to create signed repository metadata locally. Publication requires an approved hostname/storage endpoint and namespace review. After publication, operators independently obtain the keyring, check its fingerprint, save it under `/etc/apt/keyrings`, add `deb [signed-by=/etc/apt/keyrings/vectory.gpg] https://<approved-host> stable main`, then run `apt update` and `apt install vectory`. A bare `apt install vectory` is not promised before repository configuration.

Before public release, check Vectory name/trademark and package/repository namespaces, fill the private vulnerability-reporting destination, review third-party license inventory, complete native gates and sign using real credentials. Vectory is independent of Datadog and the Vector project.
