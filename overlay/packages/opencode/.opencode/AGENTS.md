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