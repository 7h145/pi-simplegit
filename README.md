# pi-simplegit

Tiny Pi extension for boring, reliable git checkpoints.

It intentionally does **one** commit at a time:

1. verify the current directory is inside a git repo
2. `git add -A`
3. inspect staged files with `git diff --cached --name-only`
4. generate one concise commit subject with the active model, or use a fallback
5. `git commit -m <subject>`

No persistent worker and no multi-commit grouping. Manual mode is the default;
an optional auto-save mode uses a session-scoped timer to checkpoint after tool
changes. Use `.gitignore` for files that should never be committed.

Requires Pi 0.80.4 or newer.

## Commands

```text
/save-progress
/save-progress docs: update thesis outline
/save-progress-auto on
/save-progress-auto off
```

With no argument, the extension asks the active Pi model for a short Conventional
Commit subject based on the staged diff. This sends the changed-file list, diff
stat, and up to 20,000 characters of staged diff to the active model provider.
If no model/auth is available or the request fails, it uses a simple fallback
such as `chore: update 3 files`.

With an argument, the argument is used as the commit subject and no model call
is made.

`/save-progress-auto on` enables conservative automatic checkpoints after
successful `write`, `edit`, or `bash` tool calls. It waits until Pi has fully
settled and remained idle for 10 seconds, checks `git diff --numstat HEAD`
without staging first, and only commits when there are more than 10 changed text
lines. Binary files are ignored for auto-save. If staged user changes already
exist, auto-save skips the commit and shows a small warning instead of
committing them. Automatic checkpoints use deterministic fallback subjects and
do not send diffs to a model. Auto-save state is session-local and resets on
reload or session replacement.

## Tool

The extension also exposes a model-callable tool:

```text
save_progress
```

The assistant can use it when the user asks to save/checkpoint/commit progress.
Set `useModel: false` to use a deterministic local subject and avoid sending the
staged diff to the active model provider.

## Install / try locally

Install this extension from GitHub:

```bash
pi install git:github.com/7h145/pi-simplegit
```

This is a personal/global install. Add `-l` for a project-local install.
Run `/reload` after installing or updating while Pi is running.

If you already use pi-simplegit through `pi-assorted`, disable that copy
with `pi config` before installing the standalone package.

To try a local checkout without installing, run from its root:

```bash
pi --no-extensions -e .
```

This loads only the checkout's extension, avoiding duplicate commands and tools
from an installed copy.

## Notes

- `git add -A` respects `.gitignore` for untracked files.
- Keep runtime/scratch paths in `.gitignore`, e.g. `.agents/run/`, `tmp/`, and
  notebook cache directories.
- Manual saves intentionally stage all non-ignored worktree changes; review the
  worktree first when unrelated changes may be present.
- Machine-readable paths use NUL-delimited git output, including filenames with
  tabs or newlines; `--stat` is used only as model-readable context.
- Repositories without an initial commit are supported.
- Model-generated subjects send staged diff content to the active provider. Use
  an explicit command subject or `useModel: false` when that is inappropriate.
