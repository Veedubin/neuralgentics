# `.opencode/overrides/` — User Personalizations

This directory holds your **personal overrides** for the neuralgentics agent
persona files. It lets you customize the shipped agent personas without
losing your changes on every `neuralgentics` update.

## How it works

1. Create a `.md` file here with the **same basename** as a default agent
   persona in `.opencode/agents/`. For example, to customize the coder
   persona, create `overrides/coder.md`.

2. Write the markdown you want **appended** to the bottom of the default
   agent file. This is where you put your own instructions, conventions,
   project-specific notes, etc.

3. On `neuralgentics init` and `neuralgentics update`, after the default
   agent files are (re)copied, each override's **body** is appended to the
   matching default file. Your customizations survive updates because the
   defaults are refreshed from the tarball and your overrides are layered
   back on top.

## Rules

- **Same basename only.** An override file must match a default agent file
  name exactly (`coder.md`, `architect.md`, …). Files with no matching
  default are treated as orphans and skipped with a warning — they are never
  deleted.
- **YAML frontmatter is stripped.** If your override starts with a `---`
  frontmatter block, it is removed before appending. Only the markdown body
  is appended. The default agent's own frontmatter (model, permissions,
  etc.) always wins — overrides are body-only by contract.
- **Idempotent.** Re-running init/update never double-appends. The merged
  result is SHA-256-checked against the file on disk; if they match the
  file is left untouched.
- **This directory is never touched by neuralgentics.** init and update
  read from it (to merge into `agents/`) but never write to or delete from
  it. Your files here are safe across updates.
- **`README.md` is ignored.** This file is documentation only — it is never
  treated as an override, even though it ends in `.md`.

## Example

Create `overrides/coder.md`:

```markdown
## Project-specific coder notes

- Always run `npm run test` before marking a card done.
- Prefer named exports over default exports.
- Use the project's existing error wrapper for all thrown errors.
```

After the next `neuralgentics update`, `.opencode/agents/coder.md` will end
with your notes appended below the shipped persona content.

## Tips

- Keep overrides focused on *additions* (extra instructions, conventions,
  reminders). You cannot *remove* parts of the default persona from here —
  for that, edit the default file directly (but know it may be overwritten
  on the next update; back it up or copy it into `overrides/` first).
- Multiple overrides compose: each default file gets at most one override
  (the one with the matching basename).
- Orphaned overrides (no matching default) are reported as warnings so you
  can spot typos or stale overrides after a rename.