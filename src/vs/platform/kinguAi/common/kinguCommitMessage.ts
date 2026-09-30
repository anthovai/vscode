/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The Source Control view's "Generate Commit Message" (the sparkle in the
 * commit box), written by the agent the user is signed into rather than by
 * Copilot, which Kingu does not ship.
 */

/** The agents that can write one, in the order they are asked. */
export type KinguCommitMessageAgent = 'claude' | 'codex' | 'chyle';

/** What the Source Control view asks the main process for. */
export interface IKinguCommitMessageRequest {
	/** The repository's root folder. */
	readonly cwd: string;
}

export interface IKinguCommitMessageResult {
	readonly message: string;
	/** Which agent wrote it. */
	readonly agent: KinguCommitMessageAgent;
}

/** What the repository shows when the message is asked for. */
export interface IKinguCommitChanges {
	readonly branch?: string;
	/** Whether these are the staged changes; otherwise every change, which is what a commit with nothing staged takes. */
	readonly staged: boolean;
	/** `git diff --stat`. */
	readonly stat: string;
	readonly diff: string;
	/** Files git does not track yet; a commit with nothing staged takes them too. */
	readonly untracked: readonly string[];
	/** The latest commit subjects, so the message follows the repository's own style. */
	readonly recentSubjects: readonly string[];
}

/**
 * Enough diff for a model to see what changed without paying for a lockfile.
 * Past this the diff is cut and the `--stat` above it still names every file.
 */
export const MAX_COMMIT_DIFF_CHARS = 12_000;

const MAX_UNTRACKED_FILES = 50;

export function truncateDiff(diff: string, max = MAX_COMMIT_DIFF_CHARS): string {
	return diff.length <= max ? diff : `${diff.slice(0, max)}\n[diff truncated]`;
}

/** The whole request, as one prompt: the CLIs are asked on stdin and have no separate system turn to give. */
export function buildCommitMessagePrompt(changes: IKinguCommitChanges): string {
	const lines = [
		'Write a Git commit message for the changes below.',
		'Return only the commit message text, with no markdown, no code fences, and no commentary.',
		'Use the imperative mood. Keep the subject line under 72 characters.',
		'Add a body, after a blank line, only when it helps explain several related changes.',
		'Do not use any tools; everything you need is here.',
	];
	if (changes.recentSubjects.length) {
		lines.push('', 'Follow the style of the repository\'s recent commit subjects:', ...changes.recentSubjects.map(subject => `- ${subject}`));
	}
	lines.push('', `Branch: ${changes.branch || 'unknown'}`);
	lines.push(changes.staged ? 'Staged changes:' : 'Changes (nothing is staged, so the commit takes all of them):');
	if (changes.stat.trim()) {
		lines.push(changes.stat.trimEnd());
	}
	if (changes.untracked.length) {
		const shown = changes.untracked.slice(0, MAX_UNTRACKED_FILES);
		lines.push('', 'New files:', ...shown.map(file => `- ${file}`));
		if (changes.untracked.length > shown.length) {
			lines.push(`- … and ${changes.untracked.length - shown.length} more`);
		}
	}
	if (changes.diff.trim()) {
		lines.push('', 'Diff:', truncateDiff(changes.diff.trimEnd()));
	}
	return lines.join('\n');
}

/** Whether there is anything to describe. */
export function hasCommitChanges(changes: IKinguCommitChanges): boolean {
	return !!changes.diff.trim() || changes.untracked.length > 0;
}

/**
 * The message as a commit wants it. Models wrap it in a fence or open with
 * "Here is a commit message:" often enough that both are taken off here rather
 * than left for the user to delete.
 */
export function cleanCommitMessage(raw: string): string {
	let text = raw.replace(/\r\n/g, '\n').trim();
	const fenced = /^```[\w-]*\s*\n([\s\S]*?)\n?```$/.exec(text);
	if (fenced) {
		text = fenced[1].trim();
	}
	text = text.replace(/^(?:here(?:'s| is) (?:a|the|your) (?:suggested )?commit message:?|commit message:)\s*\n+/i, '');
	return text.trim();
}
