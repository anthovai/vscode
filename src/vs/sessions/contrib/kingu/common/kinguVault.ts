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
	Gemini = 'gemini',
	Copilot = 'copilot',
	Cursor = 'cursor',
	Droid = 'droid',
	Cline = 'cline',
	OpenCode = 'opencode',
	Antigravity = 'antigravity',
}

/** One past session, as much as can be known without reading the whole transcript. */
export interface IKinguVaultSession {
	/** Stable within a source: the transcript file's own identity. */
	readonly id: string;
	readonly source: KinguVaultSource;
	/** The transcript on disk. Reading it is what opening a row does. */
	readonly resource: URI;
	/**
	 * The turns, for agents that keep them beside the file that names the session
	 * rather than inside it. Searched together with {@link resource}.
	 */
	readonly contentResource: URI | undefined;
	/** What the agent called this session, or its opening prompt, or the file name. */
	readonly title: string;
	/** What to call the agent in a list row. */
	readonly sourceLabel: string;
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
		const named = record as { customTitle?: unknown; aiTitle?: unknown };
		// `custom-title` is the user's, `ai-title` the agent's; either beats a prompt.
		const title = typeof named.customTitle === 'string' && named.customTitle.trim()
			? named.customTitle
			: typeof named.aiTitle === 'string' && named.aiTitle.trim() ? named.aiTitle : undefined;
		if (title) {
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
	let fallback: string | undefined;
	for (const line of transcript.split('\n')) {
		const record = parseRecord(line);
		if (!record) {
			continue;
		}
		const text = userTextOf(record);
		if (!text) {
			continue;
		}
		const prompt = unwrapPrompt(text);
		if (prompt.typed) {
			return prompt.text;
		}
		// Injected context still names the session better than the file does, but
		// only once it is clear the user never typed anything in this transcript.
		fallback ??= prompt.text || undefined;
	}
	return fallback;
}

/** The working directory a transcript records, when any record carries one. */
export function readWorkingDirectory(transcript: string): string | undefined {
	for (const line of transcript.split('\n')) {
		const record = parseRecord(line);
		// Each agent names the field differently; all three mean the same thing.
		const cwd = record?.cwd ?? record?.payload?.cwd ?? record?.workspace_root ?? record?.directory;
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
	readonly workspace_root?: unknown;
	readonly directory?: unknown;
	readonly message?: { readonly role?: unknown; readonly content?: unknown };
	readonly payload?: {
		readonly cwd?: unknown;
		readonly role?: unknown;
		readonly content?: unknown;
		readonly type?: unknown;
		readonly item?: { readonly type?: unknown; readonly content?: unknown };
	};
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
	// Claude nests the whole turn under `message`; Codex under `payload`; older
	// records put both at the top level; Cursor splits them, keeping the role at
	// the top and the content under `message`. All four appear across these agents,
	// and more than one can appear in a single long-lived transcript.
	const item = record.payload?.item;
	const candidates = [
		record.message,
		record.payload,
		record,
		{ role: record.role, content: record.message?.content },
		// Codex names the speaker in the item's own type and carries no role field.
		{ role: roleOfItemType(item?.type), content: item?.content },
	];
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

/**
 * The speaker an item type names, for the agents that type their turns instead
 * of labelling them with a role.
 */
function roleOfItemType(type: unknown): string | undefined {
	if (type === 'UserMessage') {
		return 'user';
	}
	return type === 'AssistantMessage' ? 'assistant' : undefined;
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

/**
 * Title and working directory from a session written as one JSON document
 * rather than JSON Lines — Cline's manifest, OpenCode's per-session file.
 *
 * The document is only ever read as a bounded prefix, so it usually does not
 * parse: the fields wanted are near the top of a file whose tail was cut off.
 * A failed parse therefore falls back to reading the individual fields out of
 * the text, which is enough for a list row and never claims more than it found.
 */
export function readJsonDocumentDescriptor(head: string): { title?: string; workingDirectory?: string } {
	const fromParse = parseWholeDocument(head);
	if (fromParse) {
		return fromParse;
	}
	return {
		title: firstStringField(head, ['title', 'customTitle', 'name', 'summary']),
		workingDirectory: firstStringField(head, ['cwd', 'workspace_root', 'directory', 'workspacePath']),
	};
}

function parseWholeDocument(head: string): { title?: string; workingDirectory?: string } | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(head);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== 'object') {
		return undefined;
	}
	const document = parsed as Record<string, unknown>;
	const pick = (keys: string[]): string | undefined => {
		for (const key of keys) {
			const value = document[key];
			if (typeof value === 'string' && value.trim()) {
				return collapseWhitespace(value);
			}
		}
		return undefined;
	};
	return {
		title: pick(['title', 'customTitle', 'name', 'summary']),
		workingDirectory: pick(['cwd', 'workspace_root', 'directory', 'workspacePath']),
	};
}

/**
 * The first `"<field>": "<value>"` in the text, for a document whose tail was cut.
 *
 * Deliberately not a JSON parser: it is reading a fragment, and the only thing
 * asked of it is one short scalar that agents write near the top of the file.
 */
function firstStringField(text: string, fields: readonly string[]): string | undefined {
	for (const field of fields) {
		const value = scanStringField(text, field);
		if (value) {
			return value;
		}
	}
	return undefined;
}

/**
 * Scans out `"<field>": "<value>"`, honouring backslash escapes, or `undefined`
 * when the field is absent or its value runs past the end of the fragment.
 *
 * Written as a scan rather than a pattern because the escape rules are the one
 * part that has to be exactly right: a title containing a quote must not end the
 * value early, and a value cut off by the prefix bound must yield nothing rather
 * than everything after it.
 */
function scanStringField(text: string, field: string): string | undefined {
	const key = '"' + field + '"';
	let from = 0;
	for (;;) {
		const keyAt = text.indexOf(key, from);
		if (keyAt === -1) {
			return undefined;
		}
		from = keyAt + key.length;
		let index = from;
		while (index < text.length && (text[index] === ' ' || text[index] === '\t')) {
			index++;
		}
		if (text[index] !== ':') {
			continue; // The key appeared as a value, not as a field name.
		}
		index++;
		while (index < text.length && (text[index] === ' ' || text[index] === '\t')) {
			index++;
		}
		if (text[index] !== '"') {
			continue; // The field holds something other than a string.
		}
		const value = scanStringLiteral(text, index);
		if (value?.trim()) {
			return collapseWhitespace(value);
		}
	}
}

/** Decodes the JSON string literal starting at the quote `at`, or `undefined` if it is unterminated. */
function scanStringLiteral(text: string, at: number): string | undefined {
	let index = at + 1;
	const escape = String.fromCharCode(92);
	while (index < text.length) {
		const char = text[index];
		if (char === escape) {
			index += 2;
			continue;
		}
		if (char === '"') {
			try {
				return JSON.parse(text.slice(at, index + 1)) as string;
			} catch {
				return undefined;
			}
		}
		index++;
	}
	return undefined;
}

function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

/**
 * The question inside a prompt an agent wrapped in its own tags.
 *
 * Cursor prefixes every user turn with a `<timestamp>` block and puts the typed
 * text in `<user_query>`. Titling from the raw text gives every session of a day
 * the same name, so the wrapper is unwrapped when it is there and the text is
 * left alone when it is not.
 */
function unwrapPrompt(value: string): { readonly text: string; readonly typed: boolean } {
	// The explicit marker, where an agent provides one.
	const query = /<user_query>([\s\S]*?)<\/user_query>/.exec(value);
	if (query?.[1]?.trim()) {
		return { text: collapseWhitespace(query[1]), typed: true };
	}
	// Otherwise strip whatever tag blocks the turn opens with. Agents prepend
	// several — environment context, recommended plugins, timestamps — and they
	// vary by version, so the shape is matched rather than the tag names. What is
	// left after them is what the user actually typed; nothing left means this
	// whole turn was injected and the next one is the first real question.
	const stripped = collapseWhitespace(value.replace(/^(?:\s*<([a-zA-Z][\w-]*)>[\s\S]*?<\/\1>)+/, ''));
	if (stripped) {
		return { text: stripped, typed: true };
	}
	return { text: collapseWhitespace(value), typed: false };
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
