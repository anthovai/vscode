/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { KinguVaultSource } from './kinguVault.js';

/**
 * Where one agent keeps its sessions and which files under that root count.
 *
 * A table rather than a scanner per agent, ported from the Kingu ADE: the shapes
 * differ only in a root, an extension and a couple of predicates, and writing
 * each one out as code is how "discoverable" drifts from agent to agent.
 */
export interface IKinguVaultSourceDefinition {
	readonly id: KinguVaultSource;
	/** What the picker calls this agent. */
	readonly label: string;
	/** Roots, each relative to the user's home directory. */
	readonly roots: readonly (readonly string[])[];
	/** Lower-case extensions that can be a session. */
	readonly extensions: readonly string[];
	/** How far below a root to walk. Depth 0 is a child of the root. */
	readonly maxDepth: number;
	/** Rejects a file the extension alone would have accepted. */
	readonly filePredicate?: (segments: readonly string[]) => boolean;
	/** Returns false to skip a directory. Depth 0 is a child of the root. */
	readonly directoryPredicate?: (name: string, depth: number) => boolean;
	/**
	 * A sibling holding the turns, for agents that split a session across two
	 * files. The named file is read after the session file and searched with it.
	 */
	readonly contentPath?: (path: string) => string | undefined;
	/** A working directory recoverable from the path when the file records none. */
	readonly workingDirectoryFromPath?: (segments: readonly string[]) => string | undefined;
	/** True when a file is one JSON document rather than JSON Lines. */
	readonly isJsonDocument?: boolean;
}

/** Splits a path into its segments, on either separator. */
export function pathSegments(path: string): string[] {
	return path.split(/[\\/]+/).filter(Boolean);
}

/**
 * Recovers a readable working directory from a Claude project directory name.
 *
 * The encoding is lossy — every separator and dot became the same dash — so this
 * is a best effort for display only, never for resolving a path. A leading
 * Windows drive is restored because `c--Users-me` is unreadable otherwise.
 */
export function decodeClaudeProjectDirName(dirName: string): string | undefined {
	if (!dirName) {
		return undefined;
	}
	const drive = /^([a-zA-Z])--(.*)$/.exec(dirName);
	return drive ? `${drive[1].toUpperCase()}:/${drive[2].replace(/-/g, '/')}` : dirName.replace(/-/g, '/');
}

/** Antigravity's fixed chain: `<conversation>/.system_generated/logs/transcript.jsonl`. */
export function isAntigravityTranscript(segments: readonly string[]): boolean {
	const end = segments.length - 1;
	return segments[end] === 'transcript.jsonl'
		&& segments[end - 1] === 'logs'
		&& segments[end - 2] === '.system_generated'
		&& segments[end - 3] !== undefined;
}

/**
 * OMP's session artifact directories, named `<stamp>_<uuid>`.
 *
 * Task subagent transcripts live inside them. Surfaced as top-level rows they
 * drown a coordinator under its own workers, so the subtree is pruned.
 */
const OMP_ARTIFACT_DIR = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Depth 0 is the workspace directory, which is never an artifact directory. */
export function isOmpSessionDirectory(name: string, depth: number): boolean {
	return depth === 0 || !OMP_ARTIFACT_DIR.test(name);
}

/** Kimi's layout is `<sessions>/wd_<name>_<hash>/session_<uuid>/state.json`. */
export function isKimiSessionState(segments: readonly string[]): boolean {
	return segments[segments.length - 1] === 'state.json'
		&& (segments[segments.length - 2]?.startsWith('session_') ?? false);
}

/** Cline names each session's manifest after the directory holding it. */
export function isClineSessionManifest(segments: readonly string[]): boolean {
	const fileName = segments[segments.length - 1];
	const sessionId = segments[segments.length - 2];
	return Boolean(fileName && sessionId && fileName === `${sessionId}.json`);
}

/** Cline keeps the turns beside the manifest, not inside it. */
export function clineMessagesPath(path: string): string | undefined {
	return path.endsWith('.json') ? `${path.slice(0, -'.json'.length)}.messages.json` : undefined;
}

/**
 * Every agent the vault reads, in the order their rows are broken ties on.
 *
 * The roots are the defaults from the ADE's source table. The environment
 * overrides it also honours (`CODEX_HOME`, `COPILOT_HOME`, …) are not read here:
 * the sandboxed renderer has no process environment to read them from, and a
 * user who has moved a root can still open the transcript as a file.
 */
export const KINGU_VAULT_SOURCES: readonly IKinguVaultSourceDefinition[] = [
	{
		id: KinguVaultSource.Claude,
		label: localize('kingu.vault.source.claude', "Claude"),
		roots: [['.claude', 'projects']],
		extensions: ['.jsonl'],
		maxDepth: 1,
		// Task subagent transcripts share their parent's id and are not separately
		// resumable, so as rows they only duplicate the parent under no title.
		directoryPredicate: name => name !== 'subagents',
		workingDirectoryFromPath: segments => decodeClaudeProjectDirName(segments[segments.length - 2] ?? ''),
	},
	{
		id: KinguVaultSource.Codex,
		label: localize('kingu.vault.source.codex', "Codex"),
		roots: [['.codex', 'sessions']],
		extensions: ['.jsonl'],
		// Bucketed by year/month/day rather than by project.
		maxDepth: 4,
	},
	{
		id: KinguVaultSource.Gemini,
		label: localize('kingu.vault.source.gemini', "Gemini"),
		roots: [['.gemini', 'tmp']],
		extensions: ['.json', '.jsonl'],
		maxDepth: 2,
	},
	{
		id: KinguVaultSource.Copilot,
		label: localize('kingu.vault.source.copilot', "Arkai CLI"),
		roots: [['.copilot', 'session-state']],
		extensions: ['.jsonl'],
		maxDepth: 2,
	},
	{
		id: KinguVaultSource.Cursor,
		label: localize('kingu.vault.source.cursor', "Cursor"),
		roots: [['.cursor', 'projects']],
		extensions: ['.jsonl'],
		maxDepth: 3,
		// A project directory holds more than transcripts.
		filePredicate: segments => segments.includes('agent-transcripts'),
	},
	{
		id: KinguVaultSource.Droid,
		label: localize('kingu.vault.source.droid', "Droid"),
		roots: [['.factory', 'sessions'], ['.factory', 'projects']],
		extensions: ['.jsonl'],
		maxDepth: 3,
	},
	{
		id: KinguVaultSource.Cline,
		label: localize('kingu.vault.source.cline', "Cline"),
		roots: [['.cline', 'data', 'sessions']],
		extensions: ['.json'],
		// One manifest sits directly beneath each session directory.
		maxDepth: 1,
		directoryPredicate: (_name, depth) => depth === 0,
		filePredicate: isClineSessionManifest,
		contentPath: clineMessagesPath,
		isJsonDocument: true,
	},
	{
		id: KinguVaultSource.OpenCode,
		label: localize('kingu.vault.source.opencode', "OpenCode"),
		// Only the per-session files. Since 1.17 OpenCode also writes a SQLite
		// database, which this window has no way to open; sessions that live only
		// there are not listed.
		roots: [['.local', 'share', 'opencode', 'storage', 'session']],
		extensions: ['.json'],
		maxDepth: 2,
		isJsonDocument: true,
	},
	{
		id: KinguVaultSource.Antigravity,
		label: localize('kingu.vault.source.antigravity', "Antigravity"),
		roots: [['.gemini', 'antigravity-cli', 'brain']],
		extensions: ['.jsonl'],
		maxDepth: 3,
		// A brain directory holds large artifact trees; only the fixed transcript
		// chain is part of the conversation.
		directoryPredicate: (name, depth) => depth === 0
			|| (depth === 1 && name === '.system_generated')
			|| (depth === 2 && name === 'logs'),
		filePredicate: isAntigravityTranscript,
	},
	{
		id: KinguVaultSource.Grok,
		label: localize('kingu.vault.source.grok', "Grok"),
		roots: [['.grok', 'sessions']],
		extensions: ['.json'],
		// Grouped by an encoding of the working directory, then by session.
		maxDepth: 2,
		filePredicate: segments => segments[segments.length - 1] === 'summary.json',
	},
	{
		id: KinguVaultSource.Devin,
		label: localize('kingu.vault.source.devin', "Devin"),
		roots: [['.local', 'share', 'devin', 'cli', 'transcripts']],
		extensions: ['.json'],
		maxDepth: 2,
		isJsonDocument: true,
	},
	{
		id: KinguVaultSource.Hermes,
		label: localize('kingu.vault.source.hermes', "Hermes"),
		roots: [['.hermes', 'sessions']],
		extensions: ['.json'],
		maxDepth: 1,
		filePredicate: segments => segments[segments.length - 1].startsWith('session_'),
		isJsonDocument: true,
	},
	{
		id: KinguVaultSource.Rovo,
		label: localize('kingu.vault.source.rovo', "Rovo Dev"),
		roots: [['.rovodev', 'sessions']],
		extensions: ['.json'],
		maxDepth: 2,
		filePredicate: segments => segments[segments.length - 1] === 'metadata.json',
		isJsonDocument: true,
	},
	{
		id: KinguVaultSource.Pi,
		label: localize('kingu.vault.source.pi', "Pi"),
		roots: [['.pi', 'agent', 'sessions']],
		extensions: ['.jsonl'],
		maxDepth: 2,
	},
	{
		id: KinguVaultSource.Omp,
		label: localize('kingu.vault.source.omp', "OMP"),
		roots: [['.omp', 'agent', 'sessions']],
		extensions: ['.jsonl'],
		maxDepth: 2,
		directoryPredicate: isOmpSessionDirectory,
	},
	{
		id: KinguVaultSource.PrimeAgent,
		label: localize('kingu.vault.source.primeAgent', "Prime Agent"),
		roots: [['.prime', 'agent', 'sessions']],
		extensions: ['.jsonl'],
		maxDepth: 2,
	},
	{
		id: KinguVaultSource.OpenClaw,
		label: localize('kingu.vault.source.openclaw', "OpenClaw"),
		// The current and legacy state directories are the same install under two
		// names, so both are walked and their sessions land in one list.
		roots: [['.openclaw', 'agents'], ['.clawdbot', 'agents']],
		extensions: ['.jsonl'],
		maxDepth: 3,
		filePredicate: segments => segments.includes('sessions'),
	},
	{
		id: KinguVaultSource.Kimi,
		label: localize('kingu.vault.source.kimi', "Kimi"),
		roots: [['.kimi-code', 'sessions']],
		extensions: ['.json'],
		maxDepth: 2,
		// Only the session state, not the sibling wire transcripts.
		filePredicate: isKimiSessionState,
		isJsonDocument: true,
	},
];

/** The definition for a source id. */
export function vaultSource(id: KinguVaultSource): IKinguVaultSourceDefinition {
	const found = KINGU_VAULT_SOURCES.find(source => source.id === id);
	if (!found) {
		throw new Error(`Unknown Kingu vault source ${id}`);
	}
	return found;
}

/**
 * Whether a scan of `source` would surface a file at `segments` relative to its
 * root — extension, file predicate, and every directory between passing.
 */
export function isDiscoverable(source: IKinguVaultSourceDefinition, relativeSegments: readonly string[]): boolean {
	const fileName = relativeSegments[relativeSegments.length - 1] ?? '';
	const dot = fileName.lastIndexOf('.');
	const extension = dot === -1 ? '' : fileName.slice(dot).toLowerCase();
	if (!source.extensions.includes(extension)) {
		return false;
	}
	if (source.filePredicate && !source.filePredicate(relativeSegments)) {
		return false;
	}
	const directories = relativeSegments.slice(0, -1);
	if (directories.length > source.maxDepth) {
		return false;
	}
	return !source.directoryPredicate
		|| directories.every((name, depth) => source.directoryPredicate!(name, depth));
}
