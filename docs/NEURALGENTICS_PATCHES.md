# Neuralgentics Patches to OpenCode

This document tracks modifications made to the base OpenCode installation to transform it into Neuralgentics.

## TUI Rebranding
- **File:** `packages/app/src/components/footer.tsx`
- **Change:** "OpenCode" $\rightarrow$ "Neuralgentics powered by OpenCode"
- **Applied:** 2026-05-21

## How to Sync
To update Neuralgentics after an OpenCode base update:
1. `git pull upstream` (on the base OpenCode repo)
2. Check for merge conflicts in patched files.
3. Reapply patches using `patches/*.patch`.
4. Run `./scripts/verify.sh` to ensure the build is stable.
