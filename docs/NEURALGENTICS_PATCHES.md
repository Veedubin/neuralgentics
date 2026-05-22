# Neuralgentics Patches to OpenCode

This document tracks modifications made to the base OpenCode installation to transform it into Neuralgentics.

## TUI Rebranding
- **File:** `packages/app/src/components/footer.tsx`
- **Change:** "OpenCode" $\rightarrow$ "Neuralgentics powered by OpenCode"
- **Status:** READY (Not yet applied — requires OpenCode clone)
- **Patch File:** `patches/rebrand.patch`

## Plugin Integration
- **Status:** DONE
- **Method:** Registered via `.opencode/opencode.json` in the `"plugin"` array.
- **Entrypoint:** `packages/plugin/src/index.ts`

## Plugin System
The Neuralgentics plugin integration allows the system to extend OpenCode's core agentic capabilities without modifying the base source code.

### Integration Approach
The plugin is implemented as a standalone TypeScript package located at `packages/plugin/`. It is registered in the OpenCode configuration (`.opencode/opencode.json`), which allows OpenCode to load the plugin's logic and hooks at runtime.

### Implementation Details
- **Restructured API**: The plugin at `packages/plugin/src/index.ts` is designed to match OpenCode's plugin API for seamless lifecycle management.
- **Hooking**: The plugin hooks into core OpenCode events to provide specialized memory and orchestration logic.

## How to Sync
To update Neuralgentics after an OpenCode base update:
1. `git pull upstream` (on the base OpenCode repo)
2. Check for merge conflicts in patched files.
3. Reapply patches using `patches/*.patch`.
4. Run `./scripts/verify.sh` to ensure the build is stable.
