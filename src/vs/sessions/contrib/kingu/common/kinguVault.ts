/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { Event } from '../../../../base/common/event.js';

/**
 * The coding agents whose transcripts the vault can read.
 *
 * Every one of them writes its history to the user's own disk in a format it
 * never agreed to keep stable, so each is a separate parser and a new one is a
 * new member here rather than a flag on an existing one.
 */
export const enum KinguVaultSource {
	Claude = 'claude',
	Codex = 'codex',
}

/** One past session, as much as can be known without reading the whole transcript. */
export interface IKinguVaultSession {
	/** Stable within a source: the transcript file's own identity. */
	readonly id: string;
	readonly source: KinguVaultSource;
	/** The transcript on disk. Reading it is what the detail view does. */
	readonly resource: URI;
	/** The first thing the user asked, which is the only title these formats carry. */
	readonly title: string;
	/** The working directory the session ran in, when the transcript records one. */
	readonly workingDirectory: string | undefined;
	/** Last write time, in milliseconds since the epoch. */
	readonly modified: number;
}

export interface IKinguVaultSearchResult {
	readonly session: IKinguVaultSession;
	/** The matching line, trimmed for display. */
	readonly excerpt: string;
}

export const IKinguVaultService = createDecorator<IKinguVaultService>('kinguVaultService');

/**
 * An index of the sessions other coding agents have left on this machine.
 *
 * The Agents window knows only the sessions it ran itself. This is the other
 * half: the user's history across every agent they have used, which is on disk
 * already and belongs to them.
 */
export interface IKinguVaultService {
	readonly _serviceBrand: undefined;

	/** Fires when a scan changes what {@link getSessions} would return. */
	readonly onDidChangeSessions: Event<void>;

	/** The indexed sessions, newest first. Triggers a scan if none has run yet. */
	getSessions(token?: CancellationToken): Promise<readonly IKinguVaultSession[]>;

	/** Sessions whose transcript contains `query`, newest first. */
	search(query: string, token?: CancellationToken): Promise<readonly IKinguVaultSearchResult[]>;

	/** Discards the index so the next read re-scans. */
	invalidate(): void;
}

// #region Claude

/**
 * Claude names each project's transcript directory after the working directory
 * it ran in, one dash per non-alphanumeric character.
 *
 * Runs are deliberately not collapsed: `/.claude` encodes to `--claude` and
 * `C:\` to `c--`, and anything that collapses them stops matching real
 * directories on disk.
 *
 * Ported from the Kingu ADE's vault scanner.
 */
export function encodeClaudeProjectPath(pathValue: string): string {
	const separated = pathValue.replace(/\\/g, '/');
	const trimmed = separated === '/' || /^[A-Za-z]:\/$/.test(separated)
		? separated
		: separated.replace(/\/+$/, '');
	return trimmed.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Recovers a readable working directory from one of those directory names.
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

// #endregion

// #region Transcripts

/**
 * The name a transcript gives itself, or `undefined` when it gives none.
 *
 * Claude writes a `custom-title` record as the very first line, which is a far
 * better name than the opening prompt — it is what the user or the agent settled
 * on once the session had a subject. Codex writes no such record, so that one
 * falls through to the prompt.
 */
export function readRecordedTitle(transcript: string): string | undefined {
	for (const line of transcript.split('\n')) {
		const record = parseRecord(line);
		if (!record) {
			continue;
		}
		const title = (record as { customTitle?: unknown }).customTitle;
		if (typeof title === 'string' && title.trim()) {
			return collapseWhitespace(title);
		}
		// The header records sit at the top; once real turns begin there is none.
		if (record.type === 'user' || record.message || record.payload) {
			break;
		}
	}
	return undefined;
}

/**
 * The first user prompt in a transcript, which is the only title these formats
 * carry, or `undefined` when the file holds none.
 *
 * Both agents write JSON Lines, and both bury the text at a different depth, so
 * this reads whichever shape it finds rather than branching on the source: a
 * transcript that has been through a format change contains both.
 *
 * Lines that do not parse are skipped. A transcript is appended to while it is
 * being read, so a torn last line is normal rather than corruption.
 */
export function readFirstUserPrompt(transcript: string): string | undefined {
	for (const line of transcript.split('\n')) {
		const record = parseRecord(line);
		if (!record) {
			continue;
		}
		const text = userTextOf(record);
		if (text) {
			return collapseWhitespace(text);
		}
	}
	return undefined;
}

/** The working directory a transcript records, when any record carries one. */
export function readWorkingDirectory(transcript: string): string | undefined {
	for (const line of transcript.split('\n')) {
		const record = parseRecord(line);
		const cwd = record?.cwd ?? record?.payload?.cwd;
		if (typeof cwd === 'string' && cwd) {
			return cwd;
		}
	}
	return undefined;
}

/**
 * The first line of a transcript containing `query`, trimmed for display, or
 * `undefined` when it contains none.
 *
 * Matching is done on the raw text rather than on parsed records so a hit in a
 * tool result or a file path is found too — the user is searching their own
 * history, not a structured log.
 */
export function findExcerpt(transcript: string, query: string): string | undefined {
	const needle = query.toLowerCase();
	for (const line of transcript.split('\n')) {
		if (!line.toLowerCase().includes(needle)) {
			continue;
		}
		const record = parseRecord(line);
		const text = record ? (userTextOf(record) ?? assistantTextOf(record)) : undefined;
		const excerpt = collapseWhitespace(text ?? line);
		if (excerpt) {
			return excerpt.length > 200 ? excerpt.slice(0, 200) + '…' : excerpt;
		}
	}
	return undefined;
}

interface ITranscriptRecord {
	readonly type?: unknown;
	readonly role?: unknown;
	readonly cwd?: unknown;
	readonly message?: { readonly role?: unknown; readonly content?: unknown };
	readonly payload?: { readonly cwd?: unknown; readonly role?: unknown; readonly content?: unknown; readonly type?: unknown };
	readonly content?: unknown;
}

function parseRecord(line: string): ITranscriptRecord | undefined {
	const trimmed = line.trim();
	if (!trimmed.startsWith('{')) {
		return undefined;
	}
	try {
		return JSON.parse(trimmed) as ITranscriptRecord;
	} catch {
		return undefined;
	}
}

function userTextOf(record: ITranscriptRecord): string | undefined {
	return textOfRole(record, 'user');
}

function assistantTextOf(record: ITranscriptRecord): string | undefined {
	return textOfRole(record, 'assistant');
}

function textOfRole(record: ITranscriptRecord, role: string): string | undefined {
	// Claude nests the turn under `message`; Codex under `payload`; older records
	// put the role at the top level. All three appear in a long-lived transcript.
	const candidates = [record.message, record.payload, record];
	for (const candidate of candidates) {
		if (!candidate || typeof candidate !== 'object') {
			continue;
		}
		const turn = candidate as { role?: unknown; content?: unknown };
		if (turn.role !== role) {
			continue;
		}
		const text = contentText(turn.content);
		if (text) {
			return text;
		}
	}
	return undefined;
}

/** Flattens the several shapes `content` takes: a string, or parts with `text`. */
function contentText(content: unknown): string | undefined {
	if (typeof content === 'string') {
		return content.trim() || undefined;
	}
	if (!Array.isArray(content)) {
		return undefined;
	}
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part === 'string') {
			parts.push(part);
		} else if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
			parts.push((part as { text: string }).text);
		}
	}
	const joined = parts.join(' ').trim();
	return joined || undefined;
}

function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

/**
 * The title to show for a session.
 *
 * A prompt is often a whole paragraph, and the list is scanned rather than read,
 * so it is cut to one line's worth. Sessions with no prompt at all still need a
 * name, and the file's own is the only honest one left.
 */
export function sessionTitle(prompt: string | undefined, fallback: string): string {
	const trimmed = prompt?.trim();
	if (!trimmed) {
		return fallback;
	}
	return trimmed.length > 120 ? trimmed.slice(0, 120) + '…' : trimmed;
}

// #endregion
