# skills/

Two DSH skills, copied from BaoCut and adapted. `install.sh` copies `design/` and `design-system/`
into `<dsh home>/skills/` — **do not symlink this whole directory**: the skill provider treats every
top-level `*.md` and `<name>/SKILL.md` under a scanned root as a skill, so this README would itself
show up as a skill named "README".

## What they are

| Skill | Teaches the agent |
|---|---|
| `design/` | write a design canvas: `canvas.json` (v3) plus one `.dc.html` per artboard, validate with `design_check`, then render with `design_render` |
| `design-system/` | write a design system: `design-system.json`, `tokens.json`, a brand-manual `README.md`, components and assets |

They route automatically — the `description` frontmatter decides when a skill is pulled in. `design/`
carries nine reference pages (`references/format.md` is the syntax card for `.dc.html`), `design-system/`
carries seven.

## What changed from upstream

The prose and all reference pages are BaoCut's, kept as-is. Only the platform mechanisms were adapted:

| Upstream | Here |
|---|---|
| `skills_read` tool for reference pages | the file-read tool, resolving relative paths against the skill's base directory (the `skill` tool reports it) |
| "a design/design-system card appears in the thread" | removed — that is BaoCut's session UI |
| "the user previews, edits and annotates it in the workspace tab" | removed; the skill now says outright that the deliverable is validated source you can render |
| `design_check` only, and "never verify unless asked" | **added `design_render`** — rendering is now mandatory, because seeing the result is the only way to catch layout problems |
| finding a design system via BaoCut's Space (`space_list`) | look for a directory containing `design-system.json` in the workspace |
| `AskUserQuestion` rejected → write questions as plain text | use DSH's `ask_user_question` tool |
| `references/view-state.md` — a whole page about `<baocut-design-annotations>` | rewritten: there is no viewer and no annotation channel, so ask the user when a reference is ambiguous |

Tool names (`design_check`, `design_import_asset`, `design_system_check`, `design_system_import_asset`)
match upstream exactly, so every call site in the prose is unchanged.

## Installing by hand

```sh
cp -r skills/design skills/design-system "${DSH_HOME:-$HOME/.dsh}/skills/"
```

The skill provider watches that directory, so new skills reach the next session catalog **without a
restart** — unlike the plugin, which does need one.
