/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { KinguVaultSource } from './kinguVault.js';

/** The four counts every provider records, whatever it calls them. */
export interface IKinguTokenCounts {
	readonly inputTokens: number;
	readonly outputTokens: number;
	/** Tokens served from the prompt cache, which are billed differently everywhere. */
	readonly cacheReadTokens: number;
	/** Tokens written into the prompt cache. */
	readonly cacheWriteTokens: number;
}

/** One model's share of a session, which is what a price can be applied to. */
export interface IKinguModelUsage extends IKinguTokenCounts {
	readonly model: string;
}

/**
 * What a session spent.
 *
 * The totals are the headline; the per-model split is underneath because a
 * price belongs to a model and a session routinely uses more than one — a plan
 * on Opus and the edits on Sonnet cost different amounts for the same tokens,
 * and a total priced at one rate would be wrong by a multiple.
 */
export interface IKinguUsage extends IKinguTokenCounts {
	/** What each model ran, in first-seen order. */
	readonly byModel: readonly IKinguModelUsage[];
}

export const EMPTY_USAGE: IKinguUsage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	byModel: [],
};

/**
 * The models a session ran against, in first-seen order.
 *
 * Only the ones that moved tokens. Claude Code files its own non-model records
 * — hook output, local edits — under `<synthetic>`, and listing that beside the
 * real models would answer "what did this run on" with something that is not a
 * model and never cost anything.
 */
export function usageModels(usage: IKinguUsage): readonly string[] {
	return usage.byModel.filter(entry => totalTokens(entry) > 0).map(entry => entry.model);
}

export function addUsage(a: IKinguUsage, b: IKinguUsage): IKinguUsage {
	const byModel = a.byModel.map(entry => ({ ...entry }));
	for (const entry of b.byModel) {
		const existing = byModel.find(candidate => candidate.model === entry.model);
		if (existing) {
			existing.inputTokens += entry.inputTokens;
			existing.outputTokens += entry.outputTokens;
			existing.cacheReadTokens += entry.cacheReadTokens;
			existing.cacheWriteTokens += entry.cacheWriteTokens;
		} else {
			byModel.push({ ...entry });
		}
	}
	return {
		inputTokens: a.inputTokens + b.inputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
		cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
		cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
		byModel,
	};
}

/** Every token the session moved, cache included. */
export function totalTokens(usage: IKinguTokenCounts): number {
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
export function uncachedTokens(usage: IKinguTokenCounts): number {
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
		const model = typeof message.model === 'string' && message.model ? message.model : undefined;
		const tokens = {
			inputTokens: count(counts.input_tokens),
			outputTokens: count(counts.output_tokens),
			cacheReadTokens: count(counts.cache_read_input_tokens),
			cacheWriteTokens: count(counts.cache_creation_input_tokens),
		};
		usage = addUsage(usage, { ...tokens, byModel: model ? [{ model, ...tokens }] : [] });
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
	const tokens = {
		inputTokens: running.input,
		outputTokens: running.output,
		cacheReadTokens: running.cacheRead,
		cacheWriteTokens: running.cacheWrite,
	};
	// The running total is the session's, not any one model's, so the split can
	// only be honest when the session used one model. With more than one the
	// models are still named — the report needs them — but every count sits on
	// the first, and a cost derived from that would be a guess presented as
	// arithmetic. `readTranscriptUsage`'s caller learns this from `byModel`
	// having a single entry with the whole total in it.
	const byModel = models.length === 1 ? [{ model: models[0], ...tokens }] : [];
	return { ...tokens, byModel };
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
