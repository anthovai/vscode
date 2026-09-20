/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { estimateCostUsd } from './kinguPricing.js';
import { KinguVaultSource } from './kinguVault.js';
import { IKinguUsage, totalTokens } from './kinguVaultUsage.js';

/**
 * What every agent on this machine has spent, rolled up.
 *
 * The ADE's Stats & Usage page, as a model. Its shape is ported rather than
 * invented — provider rows, a token mix, a daily series and one "best day" —
 * because those are the questions people actually bring to a usage page, and
 * the ADE has already discovered which ones they are.
 *
 * The source of the numbers is different, and that difference matters. The ADE
 * asks the user to enable a scanner per provider and then reads each agent's
 * logs into its own ledger. This fork already has the vault: every session on
 * the machine, parsed, with per-model token counts. So there is nothing to turn
 * on, and no second copy of the data to keep current.
 */

// #region Shape

/** One session, reduced to what a roll-up needs from it. */
export interface IKinguOverviewSession {
	readonly source: KinguVaultSource;
	readonly sourceLabel: string;
	readonly usage: IKinguUsage;
	/** Last write time, in epoch milliseconds — the session's day. */
	readonly modified: number;
}

export interface IKinguUsageTotals {
	readonly sessions: number;
	readonly totalTokens: number;
	/** Input tokens that were not served from the cache. */
	readonly newInputTokens: number;
	readonly outputTokens: number;
	/** Read and written together: both are cache, and the mix bar shows one band. */
	readonly cacheTokens: number;
	/**
	 * Dollars, or `undefined` where nothing priced.
	 *
	 * Distinct from `0`, which is a real answer — a session that ran no tokens
	 * cost nothing. `undefined` means the models were not in any table, and a
	 * page that showed that as `$0.00` would be claiming a free run.
	 */
	readonly costUsd: number | undefined;
	/** True where some sessions priced and others did not, so the cost is a floor. */
	readonly partialCost: boolean;
}

export interface IKinguProviderOverview extends IKinguUsageTotals {
	readonly source: KinguVaultSource;
	readonly label: string;
	/** The most recent session's time, for "last seen". */
	readonly lastActivityAt: number | undefined;
}

/** One day of the series the intensity grid draws. */
export interface IKinguUsageDay {
	/** `YYYY-MM-DD` in local time, because a day is the user's day. */
	readonly day: string;
	readonly totalTokens: number;
	readonly costUsd: number | undefined;
}

export interface IKinguUsageOverview extends IKinguUsageTotals {
	/** Busiest first, so the agent doing the work is at the top. */
	readonly providers: readonly IKinguProviderOverview[];
	/** Oldest to newest, one entry per day in the window, including empty ones. */
	readonly daily: readonly IKinguUsageDay[];
	readonly bestDay: IKinguUsageDay | undefined;
	/** Days in the window that moved any tokens at all. */
	readonly activeDays: number;
	/**
	 * Cached tokens as a share of everything sent, or `undefined` with nothing
	 * sent. This is the number that tells someone their setup is working.
	 */
	readonly cacheShare: number | undefined;
	readonly lastActivityAt: number | undefined;
}

// #endregion

// #region Building

/** The local day a timestamp falls in, as `YYYY-MM-DD`. */
export function localDayKey(timestamp: number): string {
	const date = new Date(timestamp);
	const month = `${date.getMonth() + 1}`.padStart(2, '0');
	const day = `${date.getDate()}`.padStart(2, '0');
	return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * What a session cost, summed over the models it actually ran.
 *
 * Per model rather than per session, because a price belongs to a model and a
 * session routinely uses more than one: a plan on the large model and the edits
 * on the small one cost different amounts for the same token count.
 *
 * A session whose models are all unpriced returns `undefined`. A session where
 * only some priced returns what is known — the total is then a floor, which the
 * roll-up records as {@link IKinguUsageTotals.partialCost}.
 */
export function sessionCostUsd(usage: IKinguUsage): number | undefined {
	let known: number | undefined;
	for (const model of usage.byModel) {
		const cost = estimateCostUsd(model.model, model);
		if (cost !== undefined) {
			known = (known ?? 0) + cost;
		}
	}
	return known;
}

interface IMutableTotals {
	sessions: number;
	totalTokens: number;
	newInputTokens: number;
	outputTokens: number;
	cacheTokens: number;
	knownCost: number;
	anyPriced: boolean;
	anyUnpriced: boolean;
}

function emptyTotals(): IMutableTotals {
	return { sessions: 0, totalTokens: 0, newInputTokens: 0, outputTokens: 0, cacheTokens: 0, knownCost: 0, anyPriced: false, anyUnpriced: false };
}

/**
 * The input a session actually sent, with the cached part taken out.
 *
 * The two families count this in opposite ways: Claude reports cache reads
 * beside the input, Codex reports them inside it. Subtracting for one and not
 * the other is not a special case, it is the same subtraction applied to what
 * each format means — and the pricing code makes exactly this distinction, so
 * the mix bar and the dollar figure cannot disagree about what was sent.
 */
function newInputTokensOf(session: IKinguOverviewSession): number {
	const { inputTokens, cacheReadTokens } = session.usage;
	return session.source === KinguVaultSource.Codex
		? Math.max(0, inputTokens - cacheReadTokens)
		: inputTokens;
}

function addSession(totals: IMutableTotals, session: IKinguOverviewSession, cost: number | undefined): void {
	totals.sessions++;
	totals.totalTokens += totalTokens(session.usage);
	totals.newInputTokens += newInputTokensOf(session);
	totals.outputTokens += session.usage.outputTokens;
	totals.cacheTokens += session.usage.cacheReadTokens + session.usage.cacheWriteTokens;
	if (cost === undefined) {
		// Only a session that actually ran something counts as unpriced. An empty
		// transcript prices to nothing because there was nothing to price, and
		// letting it flag the total as partial would put a "+" on an exact number.
		if (totalTokens(session.usage) > 0) {
			totals.anyUnpriced = true;
		}
	} else {
		totals.anyPriced = true;
		totals.knownCost += cost;
	}
}

function sealTotals(totals: IMutableTotals): IKinguUsageTotals {
	return {
		sessions: totals.sessions,
		totalTokens: totals.totalTokens,
		newInputTokens: totals.newInputTokens,
		outputTokens: totals.outputTokens,
		cacheTokens: totals.cacheTokens,
		costUsd: totals.anyPriced ? totals.knownCost : undefined,
		partialCost: totals.anyPriced && totals.anyUnpriced,
	};
}

export interface IKinguUsageOverviewOptions {
	/** How many days the series covers, ending today. */
	readonly days: number;
	/** Now, in epoch milliseconds. Passed in so the series is testable. */
	readonly now: number;
}

/**
 * The whole page's numbers, in one pass over the sessions.
 *
 * Sessions outside the window still count towards the provider rows and the
 * totals — "what have my agents cost" is not a question about the last six
 * weeks — but only sessions inside it reach the daily series, which is what the
 * window is for.
 */
export function buildKinguUsageOverview(
	sessions: readonly IKinguOverviewSession[],
	options: IKinguUsageOverviewOptions,
): IKinguUsageOverview {
	const overall = emptyTotals();
	const byProvider = new Map<KinguVaultSource, { label: string; totals: IMutableTotals; lastActivityAt: number | undefined }>();
	const byDay = new Map<string, { tokens: number; knownCost: number; anyPriced: boolean }>();

	const earliestDay = new Date(options.now);
	earliestDay.setHours(0, 0, 0, 0);
	const windowStart = earliestDay.getTime() - Math.max(0, options.days - 1) * 86_400_000;

	for (const session of sessions) {
		const cost = sessionCostUsd(session.usage);
		addSession(overall, session, cost);

		let provider = byProvider.get(session.source);
		if (!provider) {
			provider = { label: session.sourceLabel, totals: emptyTotals(), lastActivityAt: undefined };
			byProvider.set(session.source, provider);
		}
		addSession(provider.totals, session, cost);
		if (provider.lastActivityAt === undefined || session.modified > provider.lastActivityAt) {
			provider.lastActivityAt = session.modified;
		}

		if (session.modified >= windowStart) {
			const key = localDayKey(session.modified);
			const day = byDay.get(key) ?? { tokens: 0, knownCost: 0, anyPriced: false };
			day.tokens += totalTokens(session.usage);
			if (cost !== undefined) {
				day.knownCost += cost;
				day.anyPriced = true;
			}
			byDay.set(key, day);
		}
	}

	// Every day in the window, including the empty ones: a grid with the quiet
	// days missing would compress a fortnight off and read as continuous work.
	const daily: IKinguUsageDay[] = [];
	for (let index = 0; index < options.days; index++) {
		const key = localDayKey(windowStart + index * 86_400_000);
		const day = byDay.get(key);
		daily.push({ day: key, totalTokens: day?.tokens ?? 0, costUsd: day?.anyPriced ? day.knownCost : undefined });
	}

	const providers = [...byProvider.entries()]
		.map(([source, provider]): IKinguProviderOverview => ({
			source,
			label: provider.label,
			lastActivityAt: provider.lastActivityAt,
			...sealTotals(provider.totals),
		}))
		.sort((left, right) => right.totalTokens - left.totalTokens);

	const sent = overall.newInputTokens + overall.cacheTokens;
	return {
		providers,
		daily,
		bestDay: daily.reduce<IKinguUsageDay | undefined>(
			(best, day) => day.totalTokens > 0 && (best === undefined || day.totalTokens > best.totalTokens) ? day : best,
			undefined),
		activeDays: daily.filter(day => day.totalTokens > 0).length,
		cacheShare: sent > 0 ? overall.cacheTokens / sent : undefined,
		lastActivityAt: providers.reduce<number | undefined>(
			(latest, provider) => provider.lastActivityAt !== undefined && (latest === undefined || provider.lastActivityAt > latest)
				? provider.lastActivityAt
				: latest,
			undefined),
		...sealTotals(overall),
	};
}

// #endregion

/**
 * A share as a whole percentage, or `n/a` where there is nothing to divide.
 *
 * Rounding alone lies at both ends, and on real data it lies constantly: a
 * vault whose cache reads are 99.99% of everything sent would print `100%`,
 * claiming nothing was ever sent fresh, and the 1.3M tokens that *were* sent
 * fresh would print `0%`. Both are the same mistake `formatCostUsd` avoids by
 * writing `<$0.01` rather than `$0.00` — a rounded number must not become a
 * different claim.
 */
export function formatShare(share: number | undefined): string {
	if (share === undefined) {
		return 'n/a';
	}
	if (share > 0 && share < 0.005) {
		return '<1%';
	}
	if (share < 1 && share > 0.995) {
		return '>99%';
	}
	return `${Math.round(share * 100)}%`;
}
