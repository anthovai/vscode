/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * What a million tokens costs, in US dollars, per kind.
 *
 * A published price list, not a measurement. It is copied from the Kingu ADE's
 * table, and like that one it has to be maintained by hand when a provider
 * changes a price or ships a model — which is the whole reason a cost here is
 * always presented as an estimate and a model the table does not know is
 * reported as unpriced rather than as zero. A zero would read as "this was
 * free", which is the one wrong answer that looks like an answer.
 */
interface IKinguModelPricing {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	/**
	 * Where the long-context tier begins, for the models that have one.
	 *
	 * Absent for models that bill their whole window at one rate.
	 */
	readonly thresholdTokens?: number;
	readonly inputAbove?: number;
	readonly outputAbove?: number;
	readonly cacheReadAbove?: number;
	readonly cacheWriteAbove?: number;
}

/** The tier the older Sonnets switch to past 200k of context. */
const SONNET_LONG_CONTEXT = {
	thresholdTokens: 200_000,
	inputAbove: 6,
	outputAbove: 22.5,
	cacheReadAbove: 0.6,
	cacheWriteAbove: 7.5,
} as const;

const MODEL_PRICING: Readonly<Record<string, IKinguModelPricing>> = {
	'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	// Sonnet 5 bills its whole window at one rate, so it has no long-context tier.
	'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
	'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	'claude-opus-4-1': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
	'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
	'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, ...SONNET_LONG_CONTEXT },
	'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, ...SONNET_LONG_CONTEXT },
	'claude-sonnet-3-7': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	'claude-sonnet-3-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	'claude-haiku-3-5': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
	'claude-haiku-3': { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 },
};

/**
 * The family a model id belongs to, or `undefined` when the table does not
 * know it.
 *
 * Matched by family rather than by exact id because a transcript records
 * whatever the CLI sent — `claude-opus-4-5-20260101`, `anthropic/claude-opus-5`,
 * a `-thinking` suffix — and the price is a property of the family. The
 * unmatched case returns nothing on purpose: see {@link IKinguModelPricing}.
 */
export function normalizeModelForPricing(model: string | undefined): string | undefined {
	if (!model) {
		return undefined;
	}
	const id = model.toLowerCase().trim().replace(/^anthropic[/:]/, '').replace(/\./g, '-');
	for (const family of ['fable-5', 'opus-5', 'opus-4-8', 'opus-4-7', 'opus-4-6', 'opus-4-5', 'opus-4-1', 'sonnet-5', 'sonnet-4-6', 'sonnet-4-5', 'sonnet-3-7', 'sonnet-3-5', 'haiku-4-5', 'haiku-3-5']) {
		// Anchored on a non-digit so `opus-4-1` does not swallow `opus-4-12`.
		if (new RegExp(`${family}(?:$|[^0-9])`).test(id)) {
			return `claude-${family}`;
		}
	}
	// A version-first id, which older transcripts still carry.
	if (/3-5-sonnet/.test(id)) {
		return 'claude-sonnet-3-5';
	}
	if (/3-5-haiku/.test(id)) {
		return 'claude-haiku-3-5';
	}
	// A base `opus-4` or `sonnet-4` with no point release. Priced as the oldest
	// member of its family, which is the expensive one: an estimate that is too
	// high is a smaller mistake here than one that is too low.
	if (/opus-4(?:$|[^0-9])/.test(id)) {
		return 'claude-opus-4';
	}
	if (/sonnet-4(?:$|[^0-9])/.test(id)) {
		return 'claude-sonnet-4';
	}
	if (/haiku-3(?:$|[^0-9])/.test(id)) {
		return 'claude-haiku-3';
	}
	return undefined;
}

/** Tokens at the base rate up to `threshold`, and at `above` past it. */
function tieredCost(tokens: number, base: number, above: number | undefined, threshold: number | undefined): number {
	if (threshold === undefined || above === undefined) {
		return tokens * base;
	}
	return Math.min(tokens, threshold) * base + Math.max(tokens - threshold, 0) * above;
}

/**
 * Codex's prices, which are shaped differently from Claude's in two ways that
 * matter.
 *
 * A rollout's `input_tokens` *includes* the cached ones, where Claude reports
 * them apart — so the uncached input has to be derived rather than used as
 * given, or every cached token is billed twice. And OpenAI does not charge for
 * writing the cache at all, so there is no write rate to apply.
 */
interface IKinguCodexPricing {
	readonly input: number;
	readonly cachedInput: number;
	readonly output: number;
	/** Where the long-context tier begins, for the models that have one. */
	readonly thresholdTokens?: number;
	readonly inputAbove?: number;
	readonly cachedInputAbove?: number;
	readonly outputAbove?: number;
}

/** Past this much context, the tiered OpenAI models switch rate. */
const CODEX_LONG_CONTEXT = 272_000;

const CODEX_PRICING: Readonly<Record<string, IKinguCodexPricing>> = {
	'gpt-5': { input: 1.25, cachedInput: 0.125, output: 10 },
	'gpt-5-1': { input: 1.25, cachedInput: 0.125, output: 10 },
	'gpt-5-1-codex': { input: 1.25, cachedInput: 0.125, output: 10 },
	'gpt-5-1-codex-max': { input: 1.25, cachedInput: 0.125, output: 10 },
	'gpt-5-2': { input: 1.75, cachedInput: 0.175, output: 14 },
	'gpt-5-2-codex': { input: 1.75, cachedInput: 0.175, output: 14 },
	'gpt-5-3': { input: 1.75, cachedInput: 0.175, output: 14 },
	'gpt-5-3-codex': { input: 1.75, cachedInput: 0.175, output: 14 },
	'gpt-5-3-codex-spark': { input: 1.75, cachedInput: 0.175, output: 14 },
	'gpt-5-4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 },
	'gpt-5-4-nano': { input: 0.2, cachedInput: 0.02, output: 1.25 },
	'gpt-5-4-pro': { input: 30, cachedInput: 30, output: 180, thresholdTokens: CODEX_LONG_CONTEXT, inputAbove: 60, cachedInputAbove: 60, outputAbove: 270 },
	'gpt-5-4': { input: 2.5, cachedInput: 0.25, output: 15, thresholdTokens: CODEX_LONG_CONTEXT, inputAbove: 5, cachedInputAbove: 0.5, outputAbove: 22.5 },
	'gpt-5-5-pro': { input: 30, cachedInput: 30, output: 180, thresholdTokens: CODEX_LONG_CONTEXT, inputAbove: 60, cachedInputAbove: 60, outputAbove: 270 },
	'gpt-5-5': { input: 5, cachedInput: 0.5, output: 30, thresholdTokens: CODEX_LONG_CONTEXT, inputAbove: 10, cachedInputAbove: 1, outputAbove: 45 },
	'gpt-5-6-sol': { input: 5, cachedInput: 0.5, output: 30, thresholdTokens: CODEX_LONG_CONTEXT, inputAbove: 10, cachedInputAbove: 1, outputAbove: 45 },
	'gpt-5-6-terra': { input: 2.5, cachedInput: 0.25, output: 15, thresholdTokens: CODEX_LONG_CONTEXT, inputAbove: 5, cachedInputAbove: 0.5, outputAbove: 22.5 },
	'gpt-5-6-luna': { input: 1, cachedInput: 0.1, output: 6, thresholdTokens: CODEX_LONG_CONTEXT, inputAbove: 2, cachedInputAbove: 0.2, outputAbove: 9 },
};

/** How hard the model was told to think, which does not change what it costs. */
const REASONING_TIERS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'auto', 'none'];

/**
 * The Codex family an id belongs to, or `undefined`.
 *
 * Matched longest-first rather than by prefix, so `gpt-5-6-terra` is not
 * swallowed by a `gpt-5-6` rule — those are different models at different
 * prices. The bare `gpt-5-6` alias is OpenAI's routing name for Sol, and is
 * matched exactly for the same reason.
 */
export function normalizeCodexModelForPricing(model: string | undefined): string | undefined {
	if (!model) {
		return undefined;
	}
	let id = model.toLowerCase().trim().replace(/^openai[/:]/, '').replace(/\./g, '-');
	// A reasoning tier is written either in parentheses or as a suffix, and can
	// be stacked; neither form changes the price.
	const parenthesized = /^(.*)\(([^()]*)\)$/.exec(id);
	if (parenthesized) {
		if (!REASONING_TIERS.includes(parenthesized[2].trim())) {
			return undefined;
		}
		// Trimmed: `gpt-5.5 (medium)` leaves a trailing space that would stop the
		// exact-family match and fall through to a shorter, cheaper family.
		id = parenthesized[1].trim();
	}
	for (let stripped = 0; stripped < REASONING_TIERS.length; stripped++) {
		const suffix = REASONING_TIERS.find(tier => id.endsWith(`-${tier}`));
		if (!suffix) {
			break;
		}
		id = id.slice(0, -suffix.length - 1);
	}
	if (id === 'gpt-5-codex') {
		return 'gpt-5';
	}
	if (id === 'gpt-5-6') {
		return 'gpt-5-6-sol';
	}
	const families = Object.keys(CODEX_PRICING).sort((left, right) => right.length - left.length);
	return families.find(family => id === family || id.startsWith(`${family}-`));
}

/** What a model's tokens cost, in US dollars, or `undefined` for a model no table prices. */
export function estimateCostUsd(model: string | undefined, tokens: {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
}): number | undefined {
	const family = normalizeModelForPricing(model);
	const pricing = family === undefined ? undefined : MODEL_PRICING[family];
	if (!pricing) {
		return estimateCodexCostUsd(model, tokens);
	}
	const perMillion =
		tieredCost(tokens.inputTokens, pricing.input, pricing.inputAbove, pricing.thresholdTokens)
		+ tieredCost(tokens.outputTokens, pricing.output, pricing.outputAbove, pricing.thresholdTokens)
		+ tieredCost(tokens.cacheReadTokens, pricing.cacheRead, pricing.cacheReadAbove, pricing.thresholdTokens)
		+ tieredCost(tokens.cacheWriteTokens, pricing.cacheWrite, pricing.cacheWriteAbove, pricing.thresholdTokens);
	return perMillion / 1_000_000;
}

function estimateCodexCostUsd(model: string | undefined, tokens: {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
}): number | undefined {
	const family = normalizeCodexModelForPricing(model);
	const pricing = family === undefined ? undefined : CODEX_PRICING[family];
	if (!pricing) {
		return undefined;
	}
	// The cached tokens are inside the input count, so the uncached part is the
	// difference. Clamped because a transcript that reported more cache than
	// input would otherwise produce a negative charge.
	const cached = Math.min(Math.max(tokens.cacheReadTokens, 0), tokens.inputTokens);
	const uncached = tokens.inputTokens - cached;
	const perMillion =
		tieredCost(uncached, pricing.input, pricing.inputAbove, pricing.thresholdTokens)
		+ tieredCost(cached, pricing.cachedInput, pricing.cachedInputAbove, pricing.thresholdTokens)
		+ tieredCost(tokens.outputTokens, pricing.output, pricing.outputAbove, pricing.thresholdTokens);
	return perMillion / 1_000_000;
}

/** What a cost reads as: `$12.40`, `$0.03`, `<$0.01`. */
export function formatCostUsd(usd: number): string {
	if (usd > 0 && usd < 0.01) {
		// Rounding this to `$0.00` would say it was free, which it was not.
		return '<$0.01';
	}
	return `$${usd.toFixed(2)}`;
}
