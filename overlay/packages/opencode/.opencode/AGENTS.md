## User Overrides

Neuralgentics supports **user overrides** to personalize agent personas while preserving your customizations across updates.

### How Overrides Work

- **Directory**: `.opencode/overrides/`
- **File Naming**: Create a file with the same name as an agent (e.g., `overrides/coder.md` for `agents/coder.md`).
- **Behavior**: On `--init` or `--update`, the content of your override file is appended to the bottom of the default agent file.
- **Frontmatter**: YAML frontmatter in override files is stripped — only the markdown body is appended.
- **Preservation**: The `overrides/` directory is never modified by Neuralgentics updates.
- **Idempotent**: Re-running `--init` or `--update` does not double-append your overrides.

### Example

Create `.opencode/overrides/writer.md` to customize documentation standards:

```markdown
## Project Documentation Standards

- Use **sentence case** for all headings.
- Include a "How It Works" section in every feature doc.
- Link to relevant ADRs (Architecture Decision Records) where applicable.
- Run `markdownlint` before committing.
```

After running `npx @veedubin/neuralgentics --update`, the `writer.md` agent file will include your custom standards at the bottom.

### Notes

- Orphaned overrides (no matching agent) produce a warning but are preserved.
- Overrides are **user-owned** — they persist across updates and are never overwritten.

## Team Mode Database (config-only install)

The `--init-project` / `--init-homedir` installer **never touches the team
database**. For team mode:

- **No probe** — the installer does not run `psql` or any connection test.
- **No migration** — the installer does not run `memini-ai init` against the
  team server.
- **No pass/fail block** — the install summary shows a neutral
  `Database: skipped (team mode — tables auto-create on first launch)` line
  instead of a scary red ✗ `Cannot connect` block.

memini-ai auto-creates its schema (`CREATE EXTENSION/TABLE IF NOT EXISTS`) on
first MCP launch against the external postgres, so install-time migration is
unnecessary. The installer just writes the config (DSN in `.env`) and prints an
informational note.

**Make sure PostgreSQL is running before launching opencode.** If you need a
local server, run `neuralgentics --db-start` — it ships a compose file, brings
the stack up, and offers to create your first database user.

The pgembed (built-in) path is different: the installer DOES call
`bootstrapDatabase()` for pgembed because the embedded init is harmless and
makes first launch fast.