# Neuralgentics Patches to OpenCode

This document tracks modifications made to the base OpenCode installation to transform it into Neuralgentics.

## TUI Rebranding (Footer)
- **File:** `packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/footer.tsx`
- **Change:** "OpenCode" \u2192 "Neuralgentics powered by OpenCode" (single line) \u2192 stacked two-line with `\u003cBox flexDirection="column" alignItems="center"\u003e`
- **Status:** APPLIED
- **Patch File:** `patches/rebrand.patch`

## TUI Rebranding (Splash Screen)
- **Files:**
  - `packages/opencode/src/cli/cmd/tui/cmd/run/splash.ts` — updated to `neuralgentics start` resume command
  - `packages/opencode/src/cli/cmd/tui/cmd/cli/logo.ts` — ASCII art changed from "OPEN"/"CODE" to "NEURAL"/"GENTICS"
  - `packages/opencode/src/ui.ts` — wordmark "NEURALGENTICS"
- **Status:** APPLIED

## Plugin Integration
- **Status:** DONE
- **Method:** Registered via `neuralgentics/.opencode/opencode.json`, symlinked into `~/.opencode/opencode.json` by install script.
- **Entrypoint:** `packages/plugin/src/index.ts`

## MCP Server Pre-configuration
- **Status:** DONE
- **Method:** `neuralgentics/.opencode/opencode.json` bundled with 5 MCP servers (memini-ai-dev, github-mcp, playwright, searxng, markitdown). Install script copies config and substitutes `${NEURALGENTICS_ROOT}` path placeholder.

## Plugin System
The Neuralgentics plugin integration allows the system to extend OpenCode's core agentic capabilities without modifying the base source code.

### Integration Approach
The plugin is implemented as a standalone TypeScript package located at `packages/plugin/`. It is registered in the OpenCode configuration (`.opencode/opencode.json`), which allows OpenCode to load the plugin's logic and hooks at runtime.

### Implementation Details
- **Restructured API**: The plugin at `packages/plugin/src/index.ts` is designed to match OpenCode's plugin API for seamless lifecycle management.
- **Hooking**: The plugin hooks into core OpenCode events to provide specialized memory and orchestration logic.

## How to Sync
To update Neuralgentics after an OpenCode base update:
1. `git pull upstream` (on the base OpenCode repo `./scripts/update.sh`)
2. Check for merge conflicts in patched files.
3. Reapply patches using `patches/*.patch`.
4. Run `./scripts/verify.sh` to ensure the build is stable.
