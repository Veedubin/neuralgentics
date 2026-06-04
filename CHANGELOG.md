# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-06-03

### Added

- **Multi-arch binary builds**: `scripts/build-binary.sh` now supports `--platform` flag for cross-compilation (`linux-x64`, `darwin-arm64`, `windows-x64`). Default remains local platform detection.
- **Distribution tarballs**: Build script produces `neuralgentics-v<version>-<platform>.tar.gz` after compilation. Version is read from `package.json` via `jq`.
- **CI release workflow**: `.github/workflows/release.yml` — tag-triggered (`v*`) multi-arch build matrix (linux-x64, darwin-arm64, windows-x64) with automatic GitHub Release creation via `softprops/action-gh-release@v2`.
- Phase 1: Plugin wiring, rebrand, documentation.
- Plugin API rewritten for OpenCode contract.
- Agent skill files: architect, coder, reviewer, tester, git, writer.

### Changed

- `package.json` version bumped from `0.0.1-alpha` to `0.1.0`.

### Notes

- Cross-compilation for `darwin-arm64` and `windows-x64` requires `bun build --compile --target=bun-<target>` support. On Linux runners without toolchain, the build step may fail — the CI workflow handles this by using `oven-sh/setup-bun@v2` which provides cross-compile targets.
- Tarball naming convention: `neuralgentics-v<version>-<platform>.tar.gz` (e.g., `neuralgentics-v0.1.0-linux-x64.tar.gz`).

### Fixed

- MemoryAdapter port fixed (8900).
- Rebrand patch updated for OpenCode upstream.