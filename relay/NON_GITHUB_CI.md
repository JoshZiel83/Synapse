# Relay Non-GitHub x86 Builds

This build path is for x86_64/amd64 Relay artifacts outside GitHub Actions.
It reuses the existing Relay runtime preparation, Wails build, and packaging
scripts instead of introducing a second packaging system.

## Targets

- CLI:
  - `synapse-relay-linux-amd64`
  - `synapse-relay-windows-amd64.exe`
  - `synapse-relay-darwin-amd64`
  - `synapse-relay-mount-linux-amd64`
- GUI:
  - Linux: portable `.tar.gz`, `.deb`, `.AppImage`
  - Windows: portable `.zip`, optional setup `.exe`
  - macOS: portable `.zip`, `.pkg`, `.dmg`

The default output directory is:

```bash
artifacts/relay/<version>/
```

## Host Setup

Linux host requirements:

- Go 1.24+
- Node.js and npm
- Python 3 with pip. Runtime bundles currently use Python 3.13.10 because
  the pinned native package set has complete x86 wheels for that runtime.
- `tar`, `unzip`, `7z`
- Linux GUI packaging tools: `libgtk-3-dev`, `libwebkit2gtk-4.1-dev`,
  `desktop-file-utils`, `patchelf`, `squashfs-tools`, `curl`, ImageMagick
- Optional Windows/macOS VM builds: an x86_64 builder with nested
  virtualization enabled, Docker with Compose plugin, `/dev/kvm`, and
  `/dev/net/tun`

The scripts default `PIP_INDEX_URL` to `https://pypi.org/simple` and
`NPM_CONFIG_REGISTRY` to `https://registry.npmjs.org/`. Override those
environment variables before running the scripts if the builder needs an
internal mirror.

Run:

```bash
cd relay
make non-github-preflight
```

If submodules are not initialized, the build entrypoint initializes them unless
`--skip-submodule-update` is set.

## Build Commands

Build everything the Linux host can complete directly, and stage Windows/macOS
worker commands:

```bash
cd relay
bash scripts/non-github-ci/build-all.sh --version=v0.1.0 --platforms=all
```

Build only Linux:

```bash
bash scripts/non-github-ci/build-all.sh \
  --version=v0.1.0 \
  --platforms=linux-amd64 \
  --run-vfs-validation
```

Build CLI for one platform:

```bash
bash scripts/non-github-ci/build-cli.sh \
  --platform=windows-amd64 \
  --version=v0.1.0
```

Prepare a portable runtime bundle for a worker:

```bash
bash scripts/non-github-ci/prepare-bundle.sh \
  --platform=windows-amd64 \
  --output-dir=artifacts/relay/v0.1.0
```

## Windows GUI Worker

The Windows GUI build must run on Windows because Wails packages a native
WebView2 desktop app and NSIS installer. The repo includes a `dockurr/windows`
Compose service for KVM-backed local VM builds.

Start the worker after staging artifacts:

```bash
cd relay
bash scripts/non-github-ci/build-all.sh \
  --version=v0.1.0 \
  --platforms=windows-amd64 \
  --start-windows-vm
```

Connect to the web viewer on port `8006` or RDP on `3389`. Inside Windows,
open the shared repo folder, run:

```powershell
.\relay\scripts\non-github-ci\bootstrap-windows.ps1
.\artifacts\relay\v0.1.0\vm\run-windows-gui-build.ps1
```

The portable zip and setup exe are written under:

```text
artifacts/relay/v0.1.0/gui/
```

## macOS GUI Worker

macOS GUI builds must run on a macOS x86_64 builder. The dockur macOS service is
available only as an explicit opt-in path because macOS licensing must be
handled by the operator.

Stage and start the macOS worker:

```bash
cd relay
bash scripts/non-github-ci/build-all.sh \
  --version=v0.1.0 \
  --platforms=darwin-amd64 \
  --enable-dockur-macos \
  --start-macos-vm
```

After the macOS installation is ready, mount the shared folder in the VM:

```bash
sudo -S mount_9p shared
```

Then from the shared repo checkout:

```bash
bash relay/scripts/non-github-ci/bootstrap-macos.sh
bash artifacts/relay/v0.1.0/vm/run-macos-gui-build.sh
```

macOS artifacts are written under:

```text
artifacts/relay/v0.1.0/gui/
```

## Notes

- Runtime bundle preparation writes the ignored runtime payload directories and
  updates the tracked runtime manifests while the build is running, matching the
  existing GitHub Actions flow.
- Windows package variants are controlled with
  `--windows-package-variants=all|portable|setup`.
- `dockurr/windows` provides automatic Windows installation and `/shared` host
  file exchange. `dockurr/macos` provides KVM macOS containers and documents the
  manual installer plus `mount_9p shared` flow.
