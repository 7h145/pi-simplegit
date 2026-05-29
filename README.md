# pi-simplegit

Tiny Pi extension for boring, reliable git checkpoints.

It intentionally does **one** commit at a time:

1. verify the current directory is inside a git repo
2. `git add -A`
3. inspect staged files with `git diff --cached --name-only`
4. generate one concise commit subject with the active model, or use a fallback
5. `git commit -m <subject>`

No background worker and no multi-commit grouping. Manual mode is the default;
an optional auto-save mode can checkpoint after tool changes.
Use `.gitignore` for files that should never be committed.

## Commands

```text
/save-progress
/save-progress docs: update thesis outline
/save-progress-auto on
/save-progress-auto off
```

With no argument, the extension asks the active Pi model for a short Conventional
Commit subject based on the staged diff. If no model/API key is available, it
uses a simple fallback such as `chore: update 3 files`.

With an argument, the argument is used as the commit subject.

`/save-progress-auto on` enables conservative automatic checkpoints after
successful `write`, `edit`, or `bash` tool calls. It waits until Pi has been idle
for 10 seconds, checks `git diff --numstat HEAD` without staging first, and only
commits when there are more than 10 changed text lines. Binary files are ignored
for auto-save. If staged user changes already exist, auto-save skips the commit
and shows a small warning instead of committing them.

## Tool

The extension also exposes a model-callable tool:

```text
save_progress
```

The assistant can use it when the user asks to save/checkpoint/commit progress.

## Install / try locally

Install the whole `pi-assorted` package from GitHub:

```bash
pi install git:github.com/7h145/pi-assorted
```

For a local targeted install of only `pi-simplegit`:

```bash
git clone https://github.com/7h145/pi-assorted
pi install ./pi-assorted/extensions/pi-simplegit -l
```

To try it temporarily without installing:

```bash
git clone https://github.com/7h145/pi-assorted
pi -e ./pi-assorted/extensions/pi-simplegit
```

Or load the single extension file directly:

```bash
pi -e ./pi-assorted/extensions/pi-simplegit/pi-simplegit.ts
```

Then reload Pi if needed:

```text
/reload
```

## Notes

- `git add -A` respects `.gitignore` for untracked files.
- Keep runtime/scratch paths in `.gitignore`, e.g. `.agents/run/`, `tmp/`, and
  notebook cache directories.
- The implementation uses `git diff --cached --name-only` for machine-readable
  paths, not `--stat` parsing.
