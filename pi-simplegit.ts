/** pi-simplegit
 *
 * Purpose: provide a boring, reliable git checkpoint workflow for pi sessions:
 * - `/save-progress` stages all non-ignored changes and creates one simple
 *   commit, using either an explicit subject, a model-generated subject, or a
 *   deterministic fallback
 * - `save_progress` exposes the same behavior as a model-callable tool
 * - optional `/save-progress-auto on` creates conservative automatic
 *   checkpoints after successful mutating tool calls
 *
 * Strategy: keep the implementation intentionally small and synchronous. Manual
 * saves use `git add -A`; auto-save first checks `git diff --numstat HEAD`
 * without staging, ignores binary files, waits for pi to be idle, requires more
 * than 10 changed text lines, and skips if user-staged changes already exist.
 * Machine-readable file lists come from `git diff --cached --name-only`, not
 * display-oriented `--stat` parsing.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI gpt-5.5
 * License: CC BY 4.0
 * Version: 0.1
 * Date: 2026-05-28
 */

import type { UserMessage } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";

const SYSTEM_PROMPT = `You write concise git commit messages.
Return exactly one Conventional Commit subject line, no markdown, no quotes.
Prefer practical types such as feat, fix, docs, chore, refactor, test.
Use present tense and keep it under 72 characters.`;

const AUTO_IDLE_DELAY_MS = 10_000;
const AUTO_MIN_CHANGED_LINES = 10; // strict: auto commits only when changed lines > this
const AUTO_MUTATING_TOOLS = new Set(["write", "edit", "bash"]);

interface SaveOptions {
	message?: string;
	useModel?: boolean;
	paths?: string[];
	signal?: AbortSignal;
}

interface SaveResult {
	ok: boolean;
	message: string;
	hash?: string;
	files?: string[];
}

interface NumstatSummary {
	changedLines: number;
	files: string[];
}

function firstText(response: Awaited<ReturnType<typeof complete>>): string {
	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
}

function cleanSubject(text: string): string {
	let subject = text
		.split("\n")
		.map((line) => line.trim())
		.find(Boolean) ?? "";

	subject = subject.replace(/^```[a-z]*\s*/i, "").replace(/```$/i, "").trim();
	subject = subject.replace(/^[-*]\s+/, "").trim();
	subject = subject.replace(/^['\"]|['\"]$/g, "").trim();

	if (!subject) return "chore: save progress";
	if (subject.length > 72) subject = subject.slice(0, 69).trimEnd() + "...";
	return subject;
}

function fallbackSubject(files: string[]): string {
	if (files.length === 0) return "chore: save progress";
	if (files.every((f) => /(^|\/)(readme|docs?|notes?)/i.test(f) || /\.(md|txt|rst)$/i.test(f))) {
		return "docs: update notes";
	}
	if (files.every((f) => /(^|\/)tests?\//i.test(f) || /\.(test|spec)\./i.test(f))) {
		return "test: update tests";
	}
	if (files.some((f) => /package(-lock)?\.json$|\.pi\//i.test(f))) {
		return "chore: update project configuration";
	}
	return files.length === 1 ? `chore: update ${files[0].split("/").pop()}` : `chore: update ${files.length} files`;
}

function parseNumstatZ(text: string): NumstatSummary {
	let changedLines = 0;
	const files: string[] = [];

	for (const record of text.split("\0")) {
		if (!record) continue;
		const firstTab = record.indexOf("\t");
		const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
		if (firstTab < 0 || secondTab < 0) continue;

		const added = record.slice(0, firstTab);
		const deleted = record.slice(firstTab + 1, secondTab);
		const path = record.slice(secondTab + 1);
		if (!path || added === "-" || deleted === "-") continue; // ignore binary files for auto mode

		const addedCount = Number(added);
		const deletedCount = Number(deleted);
		if (!Number.isFinite(addedCount) || !Number.isFinite(deletedCount)) continue;
		changedLines += addedCount + deletedCount;
		files.push(path);
	}

	return { changedLines, files };
}

function parseNulList(text: string): string[] {
	return text.split("\0").filter(Boolean);
}

function countTextLines(buffer: Buffer): number | undefined {
	if (buffer.includes(0)) return undefined;
	const text = buffer.toString("utf8");
	if (!text) return 0;
	return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

async function git(pi: ExtensionAPI, cwd: string, args: string[]) {
	return pi.exec("git", args, { cwd, timeout: 30_000 });
}

async function getRepoRoot(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	const result = await git(pi, cwd, ["rev-parse", "--show-toplevel"]);
	if (result.code !== 0) return undefined;
	return result.stdout.trim() || undefined;
}

async function hasStagedChanges(pi: ExtensionAPI, repoRoot: string): Promise<boolean | undefined> {
	const result = await git(pi, repoRoot, ["diff", "--cached", "--quiet"]);
	if (result.code === 0) return false;
	if (result.code === 1) return true;
	return undefined;
}

async function getAutoSummary(pi: ExtensionAPI, repoRoot: string): Promise<NumstatSummary | undefined> {
	const head = await git(pi, repoRoot, ["rev-parse", "--verify", "HEAD"]);
	let summary: NumstatSummary = { changedLines: 0, files: [] };
	if (head.code === 0) {
		const numstat = await git(pi, repoRoot, ["diff", "--numstat", "--no-renames", "-z", "HEAD"]);
		if (numstat.code !== 0) return undefined;
		summary = parseNumstatZ(numstat.stdout);
	}

	// In a repository without an initial commit, every worktree file is untracked.
	// Otherwise, add untracked files to the tracked-file numstat summary.
	const seen = new Set(summary.files);

	const untracked = await git(pi, repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
	if (untracked.code !== 0) return summary;

	for (const file of parseNulList(untracked.stdout)) {
		if (seen.has(file)) continue;

		try {
			const lines = countTextLines(await readFile(join(repoRoot, file)));
			if (lines === undefined) continue;
			summary.changedLines += lines;
			summary.files.push(file);
			seen.add(file);
		} catch {
			// Ignore files that disappear or cannot be read while auto-save is checking.
		}
	}

	return summary;
}

async function generateSubject(
	ctx: ExtensionContext,
	files: string[],
	diffStat: string,
	diff: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (!ctx.model) return undefined;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok) return undefined;

	const clippedDiff = diff.length > 20_000 ? diff.slice(0, 20_000) + "\n... diff truncated ..." : diff;
	const userMessage: UserMessage = {
		role: "user",
		content: [
			{
				type: "text",
				text: [
					`Changed files (${files.length}):`,
					files.map((f) => `- ${f}`).join("\n"),
					"",
					"Diff stat:",
					diffStat,
					"",
					"Diff:",
					clippedDiff,
				].join("\n"),
			},
		],
		timestamp: Date.now(),
	};

	const response = await complete(
		ctx.model,
		{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			maxTokens: 100,
			signal: signal ?? ctx.signal,
		},
	);

	if (response.stopReason === "aborted") return undefined;
	return cleanSubject(firstText(response));
}

async function saveProgress(pi: ExtensionAPI, ctx: ExtensionContext, options: SaveOptions = {}): Promise<SaveResult> {
	const repoRoot = await getRepoRoot(pi, ctx.cwd);
	if (!repoRoot) return { ok: false, message: "Not inside a git repository." };

	const status = await git(pi, repoRoot, ["status", "--porcelain=v1"]);
	if (status.code !== 0) return { ok: false, message: status.stderr.trim() || "git status failed." };
	if (!status.stdout.trim()) return { ok: true, message: "No changes to save." };

	const paths = options.paths?.filter(Boolean);
	const addArgs = paths && paths.length > 0 ? ["add", "--", ...paths] : ["add", "-A"];
	const add = await git(pi, repoRoot, addArgs);
	if (add.code !== 0) return { ok: false, message: add.stderr.trim() || "git add failed." };

	const names = await git(pi, repoRoot, ["diff", "--cached", "--name-only", "-z"]);
	if (names.code !== 0) return { ok: false, message: names.stderr.trim() || "git diff --name-only failed." };
	const files = parseNulList(names.stdout);
	if (files.length === 0) return { ok: true, message: "No staged changes to save." };

	if (paths && files.some((file) => !paths.includes(file))) {
		return { ok: false, message: "Auto-save stopped because unrelated staged changes appeared.", files };
	}

	const stat = await git(pi, repoRoot, ["diff", "--cached", "--stat"]);
	const diff = await git(pi, repoRoot, ["diff", "--cached"]);

	let subject = options.message ? cleanSubject(options.message) : undefined;
	if (!subject && options.useModel !== false) {
		subject = await generateSubject(ctx, files, stat.stdout.trim(), diff.stdout, options.signal);
	}
	if (!subject) subject = cleanSubject(fallbackSubject(files));

	const commit = await git(pi, repoRoot, ["commit", "-m", subject]);
	if (commit.code !== 0) return { ok: false, message: commit.stderr.trim() || "git commit failed.", files };

	const hashResult = await git(pi, repoRoot, ["rev-parse", "--short", "HEAD"]);
	const hash = hashResult.code === 0 ? hashResult.stdout.trim() : undefined;
	return { ok: true, message: `${hash ? `${hash} ` : ""}${subject}`, hash, files };
}

export default function (pi: ExtensionAPI) {
	let autoEnabled = false;
	let autoTimer: NodeJS.Timeout | undefined;
	let autoCommitRunning = false;
	let autoSaveTask: Promise<void> | undefined;
	let autoSavePending = false;
	let sessionActive = false;
	let lastStagedWarningAt = 0;

	function clearAutoTimer(): void {
		if (!autoTimer) return;
		clearTimeout(autoTimer);
		autoTimer = undefined;
	}

	function scheduleAutoSave(ctx: ExtensionContext): void {
		if (!sessionActive || !autoEnabled || !autoSavePending) return;
		clearAutoTimer();

		autoTimer = setTimeout(() => {
			autoTimer = undefined;
			autoSaveTask = (async () => {
				try {
					await maybeAutoSave(ctx);
				} catch (error) {
					if (sessionActive) {
						const message = error instanceof Error ? error.message : String(error);
						ctx.ui.notify(`pi-simplegit auto: ${message}`, "error");
					}
				} finally {
					autoSaveTask = undefined;
				}
			})();
		}, AUTO_IDLE_DELAY_MS);
	}

	async function maybeAutoSave(ctx: ExtensionContext): Promise<void> {
		if (!sessionActive || !autoEnabled || !autoSavePending || autoCommitRunning) return;

		if (!ctx.isIdle()) return;
		autoSavePending = false;

		const repoRoot = await getRepoRoot(pi, ctx.cwd);
		if (!repoRoot) return;

		const staged = await hasStagedChanges(pi, repoRoot);
		if (staged) {
			const now = Date.now();
			if (now - lastStagedWarningAt > 60_000) {
				lastStagedWarningAt = now;
				ctx.ui.notify("pi-simplegit: auto-save skipped; staged user changes exist", "info");
			}
			return;
		}
		if (staged === undefined) return;

		const summary = await getAutoSummary(pi, repoRoot);
		if (!summary || summary.changedLines <= AUTO_MIN_CHANGED_LINES || summary.files.length === 0) return;
		if (!sessionActive) return;
		if (!ctx.isIdle()) {
			autoSavePending = true;
			return;
		}

		autoCommitRunning = true;
		try {
			const result = await saveProgress(pi, ctx, { paths: summary.files });
			ctx.ui.notify(`pi-simplegit auto: ${result.message}`, result.ok ? "info" : "error");
		} finally {
			autoCommitRunning = false;
		}
	}

	pi.on("session_start", async () => {
		sessionActive = true;
	});

	pi.on("agent_start", async () => {
		clearAutoTimer();
	});

	pi.on("agent_settled", async (_event, ctx) => {
		scheduleAutoSave(ctx);
	});

	pi.on("tool_result", async (event) => {
		if (!autoEnabled || event.isError || !AUTO_MUTATING_TOOLS.has(event.toolName)) return;
		autoSavePending = true;
	});

	pi.on("session_shutdown", async () => {
		sessionActive = false;
		autoSavePending = false;
		clearAutoTimer();
		await autoSaveTask;
	});

	pi.registerCommand("save-progress", {
		description: "Stage all non-ignored changes and create one simple git commit",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const message = args.trim() || undefined;
			const result = await saveProgress(pi, ctx, { message });
			ctx.ui.notify(`pi-simplegit: ${result.message}`, result.ok ? "info" : "error");
		},
	});

	pi.registerCommand("save-progress-auto", {
		description: "Toggle automatic git save-progress commits after tool changes",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (["on", "enable", "enabled", "true", "1"].includes(arg)) autoEnabled = true;
			else if (["off", "disable", "disabled", "false", "0"].includes(arg)) autoEnabled = false;
			else if (["", "toggle"].includes(arg)) autoEnabled = !autoEnabled;
			else {
				ctx.ui.notify("Usage: /save-progress-auto [on|off|toggle]", "error");
				return;
			}

			if (!autoEnabled) {
				autoSavePending = false;
				clearAutoTimer();
			}
			ctx.ui.notify(
				`pi-simplegit auto-save ${autoEnabled ? "enabled" : "disabled"} (> ${AUTO_MIN_CHANGED_LINES} changed lines, ${AUTO_IDLE_DELAY_MS / 1000}s idle)`,
				"info",
			);
		},
	});

	pi.registerTool({
		name: "save_progress",
		label: "Save Progress",
		description: "Stage all non-ignored git changes and create one simple commit.",
		promptSnippet: "Create a simple git save-progress commit for the current repository.",
		promptGuidelines: [
			"Use save_progress when the user asks to save, checkpoint, or commit current progress simply.",
			"Call save_progress only after file-mutating tools have completed, not in the same parallel tool batch.",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			message: Type.Optional(Type.String({ description: "Optional commit subject to use instead of generating one." })),
			useModel: Type.Optional(Type.Boolean({ description: "Generate a commit subject with the active model. Defaults to true." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await saveProgress(pi, ctx, { ...params, signal });
			if (!result.ok) throw new Error(result.message);

			return {
				content: [{ type: "text", text: result.message }],
				details: result,
			};
		},
	});
}
