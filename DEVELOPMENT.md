# pi-simplegit development notes

This document describes the archived implementation, its compatibility limits,
and why reliable automatic checkpointing needs a new design. The source remains
unchanged; the problems below have not been fixed.

## Compatibility and modernization

pi-simplegit is archived and no longer maintained. Its manual save command is
not enough reason to maintain a separate extension: a Pi prompt can already ask
the agent to commit. Automatic checkpointing has a distinct purpose, because it
preserves progress without requiring the user or model to remember to commit.

That purpose needs stronger write-safety and lifecycle guarantees than this
implementation provides. A replacement would be a rewrite of the checkpoint
workflow, not a provider-API update with a few additional checks. This repository
preserves the existing implementation rather than presenting such a rewrite as
continued maintenance.

### Compatibility baseline

The reviewed source is revision `3479654`. Strict TypeScript checks pass against
Pi SDKs 1.0.2 and 1.1.0 using Node.js 24.21.0. Actual Pi 1.1.0 checks using Node.js
26.10.0 pass in regular and fullscreen TUI modes for explicit-subject and
fallback commits, notifications, automatic-save toggling, state reset after a
new session or reload, and clean exit.

These checks establish basic loading and command integration, not reliable
automatic checkpointing. Disposable Git repositories reproduce the correctness
problems below. Model-request checks use synthetic providers; no live OAuth or
paid-provider compatibility is established.

The README and optional peer dependencies advertise Pi 0.80.4 as the minimum,
and the source header records Pi 0.80.6 as its last verified version. The older
minimum has not been revalidated. The repository has no checked-in test setup or
CI, so it does not provide a repeatable supported-version check.

### Known correctness problems

The implementation is in [`pi-simplegit.ts`](./pi-simplegit.ts).

- **False success after termination.** The Git wrapper and its callers inspect
  exit codes but ignore `killed`. Pi's executor can return
  `{ code: 0, killed: true }` for a terminated command. A timed-out commit can
  therefore be reported as successful with the old HEAD hash even though no
  new commit exists. A disposable pre-commit-hook fixture with a shortened
  timeout confirms this outcome. The same mistake can make a terminated staged
  check look like an empty index, bypassing automatic-save protection.
- **No shared save-operation serialization.** Commands, the model-callable tool,
  and automatic work can overlap. The tool's `executionMode: "sequential"`
  does not protect the entire extension. A manual save can complete while an
  automatic preflight is still pending.
- **Staged checks do not protect the commit boundary.** Automatic mode checks
  for staged changes before scanning, and checks selected filenames after
  staging. Other Git activity can change the index after these checks. A
  separately staged file introduced just before `git commit` is included in
  the automatic commit. The existing checks do not guarantee that user-staged
  work remains untouched.
- **Incomplete disabling and cancellation.** Disabling automatic mode clears
  its timer and pending flag, but an already running preflight can still
  proceed to commit: it does not recheck `autoEnabled` before saving. Tool
  cancellation is checked at selected points but is not forwarded to Git
  subprocesses. Shutdown waits for automatic work rather than providing a
  cancellation path for its Git operations. Cancellation also cannot promise
  to undo a commit that has already completed.
- **Configuration-dependent change detection.** The initial `git status` call
  inherits `status.showUntrackedFiles`. With untracked files hidden, a new,
  non-ignored prose file can be reported as “No changes to save” and left
  uncommitted.
- **Filenames interpreted as pathspecs.** `git add -- <paths>` prevents option
  parsing but does not disable Git pathspec magic. An automatically selected
  filename such as `:(glob)*.txt` can cause an unplanned binary file to be
  staged. The later membership check stops the commit, but the index has
  already changed.

Automatic preflight also reads entire untracked files before classifying them
as text or binary. There is no size bound. Large media files are a resource risk;
an out-of-memory failure has not been demonstrated.

### Model-provider integration

Subject generation imports `complete()` from
`@earendil-works/pi-ai/compat`. That entry point is explicitly temporary and uses
the global compatibility registry rather than the session's configured provider
runtime. A synthetic session-native provider completes successfully through
Pi's model registry, but pi-simplegit does not call it and silently falls back
to a deterministic subject.

The manual auth-copying path also omits the resolved optional `baseUrl`. This is
a code-level limitation for auth-derived endpoint overrides, not a demonstrated
failure of every configured custom endpoint. An endpoint already present in
`ctx.model.baseUrl` is still passed to the compatibility call.

Updating this path to the session model registry would improve compatibility,
but would not fix the checkpoint workflow. Automatic mode already uses local,
deterministic subjects and makes no model request.

### Why a rewrite rather than incremental modernization

The important defects concern the relationship between inspection, staging,
committing, cancellation, concurrent work, and reporting. More preflight checks
alone cannot establish ownership of a shared Git index. A successful exit code
alone cannot confirm a checkpoint after a command was terminated.

A replacement needs an explicit repository and file scope, one operation owner
per repository, effective stop controls, bounded inspection, and truthful
outcomes. It must define how checkpoints coexist with ordinary Git work before
choosing whether they are normal branch commits or a separate history. An
internal mutex handles the extension's own operations, not external Git actors;
Git locking and publication behavior still need a deliberate design.

For prose, the current requirement for more than ten changed lines is also a
poor preservation rule: a one-word correction may deserve a checkpoint. Quiet
intervals and duplicate-snapshot detection are more appropriate controls than
assuming that small edits are unimportant.

These changes replace the operational core and its guarantees. Retaining only
manual saving would avoid some complexity but remove the extension's distinct
purpose. Archiving this implementation keeps its source and history available
without implying that its automatic mode is being made reliable in place.

## Existing behavior and scope

Manual saving stages all non-ignored worktree changes in the repository
containing Pi's working directory, including preexisting staged work. It is not
limited to files Pi edited and does not automatically save repositories listed
by `/workspace`. Repositories without an initial commit are supported.

Automatic mode is session-local, wakes after successful `write`, `edit`, or
`bash` tool results, waits for Pi to settle and remain idle for ten seconds,
and uses a more-than-ten-line threshold. These describe the current scheduling
rules, not a guarantee that every file-changing tool is detected or that each
checkpoint is safe.

Machine-readable filenames use NUL-delimited Git output. Manual subjects may
be explicit, generated by the active model, or deterministic fallbacks. Model
generation sends the changed-file list, diff stat, and up to 20,000 characters
of staged diff to the selected provider. Automatic mode makes no such request.

`.gitignore` excludes untracked files from normal staging; it does not remove
already tracked files or make a repository a safe place to store secrets.
