# Release engineering

This tree prepares unsigned development outputs. No release, APT repository, Homebrew tap, MSI, Apple signing identity, or public package namespace is claimed to exist. Native OS acceptance in [COMPATIBILITY](../docs/COMPATIBILITY.md) is independent of cross-compilation.

## Build

Build from a reviewed clean commit with Go 1.26.8, Rust 1.94.0, Node 22, lockfiles, and Python 3.11+:

```sh
python3 packaging/build-release.py --out artifacts/releases
python3 packaging/generate-sbom.py --out artifacts/releases/source.spdx.json
python3 packaging/record-source.py --out artifacts/releases/SOURCE-INPUTS.json
python3 packaging/verify-release.py artifacts/releases --refresh-checksums
```

This produces raw binaries for the dashboard catalog, deterministic ZIP/tar.gz archives, SHA256SUMS, and `catalog.json`. All metadata is derived from actual file bytes. `signed` remains false. Copy the complete directory to the configured local release mirror. Installation tokens are never embedded. The package version defaults to, and must match, `agent/internal/agent/types.go`; development builds remain `0.1.0-dev`.

## Release candidate workflow

`.github/workflows/release-candidate.yml` builds a complete unsigned candidate and keeps it as workflow artifacts only. It needs no secrets, pushes no image and publishes nothing. Start it from any branch and download the result:

```sh
gh workflow run release-candidate.yml --ref <branch>
gh run watch "$(gh run list --workflow release-candidate.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run download <run-id> --name unsigned-release-candidate --dir candidate
(cd candidate && sha256sum -c SHA256SUMS)
```

Leave `attest` false (the default) unless the protected `release` environment and its identity are configured; it then adds GitHub build provenance for `SHA256SUMS`.

| Job | Produces | Checks |
| --- | --- | --- |
| `agents` | Agents for linux/darwin amd64/arm64 and windows/amd64, their archives, `catalog.json`; `.deb` and `.rpm` for amd64 and arm64 | agent tests, verifier regressions, static Linux ELF, catalog and archive verification; nfpm pinned by version and module hash |
| `packages` | logs only | installs the amd64 `.deb` on Debian 12 and `.rpm` on AlmaLinux 9 (images pinned by digest), runs `vectory --version`, `version --json`, `setup --help`, checks the files, that no account or state appears and that `vectory run` exits 78 before setup, then removes the package; checks the arm64 packages' metadata and contents |
| `msi` | `vectory-<version>-windows-amd64.msi` and its install logs | WiX Toolset 5.0.2 (a .NET tool from NuGet, pinned); installs silently on Windows Server 2025, runs `vectory.exe --version`, checks no service was registered, removes it and checks the binary is gone |
| `images` | server and validator images (`docker save`, gzip), their SPDX SBOMs, `image-agent-catalog.json` | image users are 10001 and 10002; the server refuses to start without its safety settings and the validator without `VECTORY_VALIDATOR_ISOLATED` |
| `sbom` | CycloneDX SBOMs for the Rust server (cargo-cyclonedx 0.5.9), the Go agent (cyclonedx-gomod v1.12.0, pinned by module hash) and the npm dashboard and help center (`npm sbom`, runtime dependencies); `THIRD-PARTY-LICENSES.md` and `license-inventory.json` (`license-inventory.py`); the lockfile SPDX inventory and `SOURCE-INPUTS.json`; `npm-dependency-audit.json` (`audit-npm.py`: both raw `npm audit` reports and the verdict) | `audit-npm.py` fails on a high or critical advisory in the shipped npm dependencies that `npm-audit-exceptions.json` does not acknowledge (each entry has a reason and an expiry date, and an expired one fails too); the inventory lists components whose SBOM carries no license under "Needs review"; it is not license clearance |
| `assemble` | `unsigned-release-candidate`: every part in one folder, `CANDIDATE.json` and `SHA256SUMS` over all files | the verifier runs again over the whole folder; `CANDIDATE.json` records the commit, the run, each job's result, the pinned tools and whether the agents bundled in the image are byte-identical to the separately built ones |

A failed `packages`, `msi`, `images` or `sbom` job still leaves the other parts in the candidate; `CANDIDATE.json` names what is missing. The candidate stays unsigned: signing, notarization, the APT repository and publication are the maintainer steps below.

The server image bundles agents: `deploy/Dockerfile` runs `build-release.py --no-archives` (binaries, `catalog.json` and `SHA256SUMS` only) into `/app/agent-releases` (`VECTORY_BUNDLED_RELEASES_DIR`). Devices fetch them from the agent listener through `/agent/v1/install.sh` and `/agent/v1/downloads/{os}/{arch}`, which verify SHA-256 values shown on the authenticated Add device page. An operator mirror in `VECTORY_RELEASES_DIR` replaces the bundled build for each platform it lists. `scripts/preview.sh` builds the same bundle under its preview directory.

Default agent locations are the same in `vectory setup`, the installer, the service definitions here and the documentation: state `/var/lib/vectory-agent` (macOS `/Library/Application Support/Vectory/agent`, Windows `C:\ProgramData\Vectory\agent`), managed configuration `/etc/vectory/managed/vector.json` (macOS `/Library/Application Support/Vectory/managed/vector.json`, Windows `C:\ProgramData\Vectory\managed\vector.json`), service account `vectory` (`_vectory`, `NT SERVICE\Vectory`). The installer puts the agent at `/usr/local/bin/vectory`; OS packages use `/usr/bin/vectory`, which setup then runs in place.

## Verify

The verifier requires a nonempty catalog and the exact offline archive inventory, including the target OS service template. It rejects duplicate members, path traversal, symlinks and other nonregular members before inspecting the packaged executable. Run `python3 packaging/test_verify_release.py` for synthetic negative archive cases. These checks establish archive structure and byte identity, not signature trust or native compatibility.

## Web build and CI

The web build has separate locked dependencies in `dashboard/` and `help-center/`. Run `npm ci` in each directory before running `npm run build` in `dashboard/`; the latter builds and copies the static help center into `dashboard/dist/help`. The Dockerfile and dashboard/release-candidate CI build gates perform those installs. The source SPDX collector includes both npm lockfiles alongside Cargo and Go dependencies; adding help content does not require an external documentation service at runtime. This source inventory includes build tools and optional packages, and is not a runtime image scan.

The dashboard CI job is configured to build the Rust test server and run `node help-center/tests/ci.mjs`. To reproduce locally, first build the server and dashboard and install Chromium with the dashboard's Playwright dependency. The harness starts a fresh loopback development instance, uses only a temporary synthetic account, exercises the public help and contextual-link tests, and removes its server state afterward. Reports go to `artifacts/help-ci`; the normal preview instance and its credentials are not used. This is HTTP/browser acceptance, not production TLS or container-isolation evidence.

CI also sets `VECTORY_HELP_ACCOUNT_TESTS=true` to include the account lifecycle browser tests, with `VECTORY_HELP_CI_OUTPUT=artifacts/help-account-ci` keeping that combined report separate. These tests create their own synthetic administrators and accounts. The standalone `node tests/security/account-review.mjs` provisions separate temporary servers for real HTTP authorization, session/reset races, MFA preservation and in-flight offboarding checks. Set `VECTORY_ACCOUNT_EVIDENCE` to choose its JSON report path (CI uses `artifacts/account-review.json`). Both harnesses accept an explicit test server binary through `VECTORY_HELP_SERVER` or `VECTORY_ACCOUNT_SERVER`; neither uses preview credentials.

## Reproduce and audit

The local source-input inventory records tracked and nonignored untracked file hashes, excluding generated evidence reports and private/build output directories ignored by Git. Capture it after the source freeze. It identifies the inspected bytes and does not assert that an independent builder produced the artifacts or replace signed provenance.

Repeat the build from the same source/toolchain in a fresh directory and compare every binary, archive and catalog digest. Additional source SBOM metadata must be generated consistently before comparing complete checksum inventories. `-trimpath`, disabled VCS stamping, a fixed empty Go build ID, conservative `GOAMD64=v1`, CGO disabled, and normalized archive times make this comparison useful. The verifier parses Linux ELF headers and rejects PT_INTERP or DT_NEEDED; `readelf -l` and `readelf -d` provide an additional native inspection path. Offline builds require preloaded module and npm/Cargo caches and container base images. The final local candidate's two same-host builds matched all eleven binary/archive/catalog files; this is not independent-builder provenance.

`release-candidate.yml` runs only when manually dispatched (see [Release candidate workflow](#release-candidate-workflow)) and had never run on GitHub Actions as of 2026-09-29, so no workflow has yet built or verified a release candidate. `ci.yml` runs on every push; [docs/internal/CI.md](../docs/internal/CI.md) lists what each job proves and what it does not. Resolve every scanner finding; run `packaging/audit-rust.py`, `packaging/audit-npm.py`, `govulncheck ./...`, and an image scanner on the exact release inputs. The Rust gate retains full findings and admits only the specifically proven inactive optional dependency described in [DEPENDENCY-AUDIT](../docs/internal/DEPENDENCY-AUDIT.md). The npm gate retains both raw audits and admits only the advisories in `npm-audit-exceptions.json`, each until its expiry date; `python3 packaging/test_audit_npm.py` tests it against a stub `npm`. These checks require a current vulnerability database and are not performed by the agent at runtime.

## Sign and package

To sign checksums offline using an established cosign key, run `packaging/sign-release.sh artifacts/releases <key-reference>`, then independently verify with `cosign verify-blob --key <public-key> --signature SHA256SUMS.sig --insecure-ignore-tlog SHA256SUMS`. The offline choice intentionally omits transparency-log upload. Ship the pre-established public key through a separate trusted channel. Never change `signed` to true merely because a `.sig` file exists; verification must succeed and the catalog signer identity must be documented. Provenance signing requires a maintainer-controlled CI identity and protected environment; record commit, builder identity, pinned toolchains, lockfile digests, and artifact digests. No attestations are fabricated locally.

Linux packages: build the binaries first (`build-release.py`), then from `packaging/` run `VERSION=0.1.0-dev GOARCH=amd64 nfpm package --config nfpm.yaml --packager deb --target ../artifacts/packages/` (or `rpm`, or `GOARCH=arm64`). Paths in the template are relative to `packaging/`; `expand: true` lets nfpm substitute `VERSION` and `GOARCH` in the binary's path. A `0.1.0-dev` build is versioned `0.1.0~dev`, which sorts before `0.1.0`. The release workflow installs and removes the packages in containers. `.github/workflows/platforms.yml` runs the packaged unit under real systemd on demand, with only `ExecStart` adjusted; upgrades still need a native test. No post-install script enrolls, starts Vector, grants sudo, or embeds secrets. Review the systemd example's dedicated user and exact writable roots before enabling it. The packaged unit (`systemd/vectory.service`) makes the whole file system read-only to the agent and the Vector it runs, and hides home directories, except the state directory, the managed configuration directory and `/var/lib/vector`. A pipeline that writes anywhere else (a file sink's directory, a `data_dir` of its own, `--vector-data-dir`) needs that directory added with `sudo systemctl edit vectory.service` and `ReadWritePaths=` under `[Service]`. The unit that `vectory setup` registers in `/etc/systemd/system` is a different, weaker one (`ProtectSystem=full`, `ProtectHome=read-only`) and takes precedence over the packaged one. `python3 packaging/test_systemd_unit.py` fails when the packaged unit loses its confinement.

On macOS run `packaging/macos/build-pkg.sh <arm64-binary> <version> <output.pkg>`. Use a real Developer ID application signature for the binary and Installer signature for the package, submit to Apple's notarization service and staple the result before claiming signed/notarized status. A Homebrew formula requires a real stable archive URL and its verified SHA256, an actual tap namespace, license, and explicit installation test; until published, install the verified archive manually. Intel Mac is build-only for the current Vector pin.

On Windows install WiX (the workflow uses `dotnet tool install wix --version 5.0.2`; v6 and later add a maintenance-fee EULA), then `wix build packaging/windows/vectory.wxs -arch x64 -d Version=0.1.0 -d Binary=<absolute-agent.exe> -o vectory.msi`. MSI versions are numeric, so `0.1.0-dev` builds as `0.1.0`. This MSI installs the binary only. Local administrator installation/adoption/enrollment and native service registration are explicit follow-up steps. Sign with an established Authenticode certificate and a trusted timestamp service; verify the chain, timestamp, clean install, upgrade identity preservation and uninstall in a Windows VM. ZIP/native build evidence is not MSI evidence.

`build-apt-repository.sh <debs> <new-directory> <gpg-key-id>` uses dpkg-scanpackages, apt-ftparchive and a real GPG key to create signed repository metadata locally. Publication requires an approved hostname/storage endpoint and namespace review. After publication, operators independently obtain the keyring, check its fingerprint, save it under `/etc/apt/keyrings`, add `deb [signed-by=/etc/apt/keyrings/vectory.gpg] https://<approved-host> stable main`, then run `apt update` and `apt install vectory`. A bare `apt install vectory` is not promised before repository configuration.

## Before public release

Before public release, check Vectory name/trademark and package/repository namespaces, fill the private vulnerability-reporting destination, review third-party license inventory, complete native gates and sign using real credentials. Vectory is independent of Datadog and the Vector project.
