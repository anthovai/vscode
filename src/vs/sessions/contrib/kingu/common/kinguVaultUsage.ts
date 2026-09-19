/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { KinguVaultSource } from './kinguVault.js';

/**
 * What a session cost in tokens.
 *
 * Tokens rather than money on purpose: prices change, differ by plan and by
 * region, and a number in currency that is quietly six months stale is worse
 * than no number. What the transcripts actually record is tokens, so that is
 * what this reports.
 */
export interface IKinguUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	/** Tokens served from the prompt cache, which are billed differently everywhere. */
	readonly cacheReadTokens: number;
	/** Tokens written into the prompt cache. */
	readonly cacheWriteTokens: number;
	/** Models the session actually ran against, in first-seen order. */
	readonly models: readonly string[];
}

export const EMPTY_USAGE: IKinguUsage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	models: [],
};

export function addUsage(a: IKinguUsage, b: IKinguUsage): IKinguUsage {
	const models = a.models.slice();
	for (const model of b.models) {
		if (!models.includes(model)) {
			models.push(model);
		}
	}
	return {
		inputTokens: a.inputTokens + b.inputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
		cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
		cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
		models,
	};
}

/** Every token the session moved, cache included. */
export function totalTokens(usage: IKinguUsage): number {
	return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/**
 * The part of a session's tokens that is not a cache read.
 *
 * Measured on a real vault, cache reads were 97% of everything — one 4.8MB
 * session read 259M cached tokens against 613k of output. A headline that
 * includes them is a number 40x larger than anything about the work, and every
 * provider prices a cache read far below fresh input. So the figure a person is
 * shown first is this one, with the cache alongside it rather than inside it.
 */
export function uncachedTokens(usage: IKinguUsage): number {
	return usage.inputTokens + usage.outputTokens;
}

/**
 * What a transcript says a session spent.
 *
 * The two families record it in opposite ways and reading one as the other is
 * out by orders of magnitude, so the source decides which reader runs.
 */
export function readTranscriptUsage(transcript: string, source: KinguVaultSource): IKinguUsage {
	return source === KinguVaultSource.Codex
		? readCumulativeUsage(transcript)
		: readPerMessageUsage(transcript);
}

/**
 * Claude's shape: every assistant message carries what that message cost, so the
 * session's cost is their sum.
 */
function readPerMessageUsage(transcript: string): IKinguUsage {
	let usage = EMPTY_USAGE;
	for (const line of transcript.split('\n')) {
		const record = parse(line);
		const message = record?.message;
		if (!message?.usage) {
			continue;
		}
		const counts = message.usage;
		usage = addUsage(usage, {
			inputTokens: count(counts.input_tokens),
			outputTokens: count(counts.output_tokens),
			cacheReadTokens: count(counts.cache_read_input_tokens),
			cacheWriteTokens: count(counts.cache_creation_input_tokens),
			models: typeof message.model === 'string' && message.model ? [message.model] : [],
		});
	}
	return usage;
}

/**
 * Codex's shape: each `token_count` record carries the session's running total,
 * not that turn's cost, so the deltas between them are what add up.
 *
 * A total that goes *down* means the counter restarted — a resumed rollout
 * writes a fresh baseline into the same file — so the new total is all new
 * spend rather than a negative delta. Summing the records directly, or taking
 * the last one, is wrong in that case in opposite directions.
 */
function readCumulativeUsage(transcript: string): IKinguUsage {
	const running = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	let previous: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined;
	const models: string[] = [];
	for (const line of transcript.split('\n')) {
		const record = parse(line);
		const payload = record?.payload;
		if (payload?.type !== 'token_count') {
			const model = payload?.model ?? payload?.info?.model;
			if (typeof model === 'string' && model && !models.includes(model)) {
				models.push(model);
			}
			continue;
		}
		const totals = payload.info?.total_token_usage;
		if (!totals) {
			continue;
		}
		const current = {
			input: count(totals.input_tokens),
			output: count(totals.output_tokens),
			cacheRead: count(totals.cached_input_tokens),
			cacheWrite: count(totals.cache_write_input_tokens),
		};
		running.input += delta(current.input, previous?.input);
		running.output += delta(current.output, previous?.output);
		running.cacheRead += delta(current.cacheRead, previous?.cacheRead);
		running.cacheWrite += delta(current.cacheWrite, previous?.cacheWrite);
		previous = current;
	}
	return {
		inputTokens: running.input,
		outputTokens: running.output,
		cacheReadTokens: running.cacheRead,
		cacheWriteTokens: running.cacheWrite,
		models,
	};
}

/** The new spend a running total represents, allowing for a restarted counter. */
function delta(current: number, previous: number | undefined): number {
	if (previous === undefined || current < previous) {
		return current;
	}
	return current - previous;
}

function count(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

interface IUsageRecord {
	readonly message?: {
		readonly model?: unknown;
		readonly usage?: {
			readonly input_tokens?: unknown;
			readonly output_tokens?: unknown;
			readonly cache_read_input_tokens?: unknown;
			readonly cache_creation_input_tokens?: unknown;
		};
	};
	readonly payload?: {
		readonly type?: unknown;
		readonly model?: unknown;
		readonly info?: {
			readonly model?: unknown;
			readonly total_token_usage?: {
				readonly input_tokens?: unknown;
				readonly output_tokens?: unknown;
				readonly cached_input_tokens?: unknown;
				readonly cache_write_input_tokens?: unknown;
			};
		};
	};
}

function parse(line: string): IUsageRecord | undefined {
	const trimmed = line.trim();
	if (!trimmed.startsWith('{')) {
		return undefined;
	}
	try {
		return JSON.parse(trimmed) as IUsageRecord;
	} catch {
		return undefined;
	}
}

/** A token count at a glance: `26.3B`, `1.2M`, `34.4k`, `97`. */
export function formatTokens(value: number): string {
	// A real vault reaches billions of cached tokens, and `26330.2M` is not a
	// number anyone reads.
	if (value >= 1_000_000_000) {
		return `${(value / 1_000_000_000).toFixed(1)}B`;
	}
	if (value >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(1)}M`;
	}
	if (value >= 1_000) {
		return `${(value / 1_000).toFixed(1)}k`;
	}
	return String(value);
}
