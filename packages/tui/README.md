# @neuralgentics/tui

OpenTUI-based terminal interface for Neuralgentics v0.1.0.

## Prerequisites

- **Zig** ≥ 0.14.0 — Required by `@opentui/core` for native bindings compilation. Install via system package manager or download from [ziglang.org](https://ziglang.org/learn/getting-started/). On Arch Linux: `pacman -S zig`. On other systems, download the binary from <https://ziglang.org/download/> and add it to `$PATH`.
- **Bun** ≥ 1.3.0 — The project runtime. Install from [bun.sh](https://bun.sh/). On Linux: `curl -fsSL https://bun.sh/install | bash`.

Verify installations:

```bash
zig version   # Should print 0.14.0 or later
bun --version # Should print 1.3.0 or later
```

## Setup

```bash
cd packages/tui
bun install
```

## Development

```bash
# Run the TUI (interactive terminal)
bun run start

# Build for production
bun run build

# Type check
bun run typecheck

# Run tests
bun run test
```

## Architecture

This package uses `@opentui/core` (v0.3.1) which provides a native Zig rendering core with TypeScript bindings via Bun's FFI. The Zig binary (`libopentui.so`) is pre-compiled and distributed as `@opentui/core-linux-x64` — no Zig compilation step is needed at runtime for Linux x86_64. Zig is only required if building from source or on unsupported platforms.

The TUI is **Bun-exclusive** (Node.js and Deno support are in progress per OpenTUI).

## Notes

- **No blessed dependencies** — This package uses OpenTUI exclusively for terminal rendering.
- **Platform-native binary** — `@opentui/core-linux-x64` provides the pre-compiled Zig shared library. Other platforms (macOS, Windows, ARM) need their respective `@opentui/core-*` package.