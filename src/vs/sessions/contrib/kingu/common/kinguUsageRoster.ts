/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { KINGU_QUOTA_PROVIDER_LABELS, KinguQuotaProvider } from '../../../../platform/kinguHost/common/kinguQuotaProviders.js';
import { KinguQuotaProblem } from '../../../../platform/kinguHost/common/kinguRateLimits.js';
import { formatWindow, IKinguRateLimit } from './kinguStatusBar.js';

/**
 * The roster behind the Usage panel: every agent's quota in one reading.
 *
 * Pure, and separate from the element that draws it, because this is the half
 * worth testing — which row is worst, what a row says when there is no number,
 * and how a percentage is rounded. The ADE splits it the same way and for the
 * same reason.
 */

// #region Severity

/**
 * How loudly a reading should be drawn.
 *
 * The thresholds are the ADE's, and they are shared by the bar and the number
 * so the two can never disagree about whether something is urgent.
 */
export const enum KinguUsageSeverity {
	Neutral = 'neutral',
	Warning = 'warning',
	Critical = 'critical',
}

export function usageSeverity(usedPercent: number): KinguUsageSeverity {
	if (usedPercent >= 80) {
		return KinguUsageSeverity.Critical;
	}
	if (usedPercent >= 60) {
		return KinguUsageSeverity.Warning;
	}
	return KinguUsageSeverity.Neutral;
}

// #endregion

// #region Percentages

/**
 * A percentage fit to be drawn: finite, whole, and inside 0–100.
 *
 * A gauge is glanced at and believed. A value outside the range would be a
 * confident lie rather than a missing number, so it is pulled into range here
 * once and never questioned downstream.
 */
export function clampUsedPercent(usedPercent: number): number {
	if (!Number.isFinite(usedPercent)) {
		return 0;
	}
	return Math.max(0, Math.min(100, Math.round(usedPercent)));
}

/** Whether a reading counts up to the limit or down to nothing. */
export type KinguUsageDisplay = 'used' | 'remaining';

/**
 * The number to print, in whichever direction the user reads them.
 *
 * Rounded *before* the complement is taken, not after. Rounding afterwards
 * makes `Math.round(100 - 20.5)` and `100 - Math.round(20.5)` disagree by one,
 * so the same window would read differently depending on which caller got
 * there first. The ADE learned this one the hard way; the note is theirs.
 */
export function displayedPercent(usedPercent: number, display: KinguUsageDisplay): number {
	if (!Number.isFinite(usedPercent)) {
		// Nothing known must not be drawn as a full tank.
		return 0;
	}
	const used = Math.round(Math.max(0, Math.min(100, usedPercent)));
	return display === 'used' ? used : 100 - used;
}

// #endregion

// #region Rows

/** One quota window, labelled by its length. */
export interface IKinguUsageWindow {
	/** `5h`, `wk` — the unit a person would say. */
	readonly label: string;
	readonly limit: IKinguRateLimit;
}

/**
 * What a row has to say, when it has no numbers to say it with.
 *
 * Separate kinds rather than one "no data": a machine that never ran an agent,
 * an account that is signed out and a provider that refused a request are three
 * different situations, and only one of them is the user's to fix.
 */
export type KinguUsageRowKind = 'usage' | 'loading' | 'signedOut' | 'unavailable' | 'error' | 'empty';

export interface IKinguUsageRow {
	readonly provider: KinguQuotaProvider;
	readonly label: string;
	readonly kind: KinguUsageRowKind;
	/** What to print in place of the bars, when there are none. */
	readonly statusLabel: string | undefined;
	readonly windows: readonly IKinguUsageWindow[];
	/** Milliseconds until the soonest window resets, when any window says. */
	readonly resetsInMs: number | undefined;
	/** The fullest window, which is the one that will stop the user first. */
	readonly worstPercent: number;
}

/** What the panel is told about one provider, before it is turned into a row. */
export interface IKinguUsageSource {
	readonly provider: KinguQuotaProvider;
	readonly limits: readonly IKinguRateLimit[];
	/** Why there are no limits, when there are none. */
	readonly problem: KinguQuotaProblem | undefined;
	/** True while the first read is still outstanding. */
	readonly pending: boolean;
}

function windowsOf(limits: readonly IKinguRateLimit[]): IKinguUsageWindow[] {
	return limits.map(limit => ({
		label: limit.windowDurationMins === undefined
			? localize('kingu.usage.window.unknown', "window")
			: formatWindow(limit.windowDurationMins),
		limit,
	}));
}

/**
 * Why a row has no numbers, in terms the user can act on.
 *
 * Expired credentials are reported as signed out rather than as an error. They
 * are the one case here the user can resolve, and saying "error" would send
 * them looking for a fault instead of to a login.
 */
function stateOf(source: IKinguUsageSource): { kind: KinguUsageRowKind; statusLabel: string | undefined } {
	if (source.pending) {
		return { kind: 'loading', statusLabel: localize('kingu.usage.loading', "Reading usage…") };
	}
	switch (source.problem) {
		case 'noCredentials':
			return { kind: 'signedOut', statusLabel: localize('kingu.usage.signedOut', "not signed in") };
		case 'expiredCredentials':
			return { kind: 'signedOut', statusLabel: localize('kingu.usage.expired', "sign-in expired") };
		case 'unauthorized':
			return { kind: 'error', statusLabel: localize('kingu.usage.unauthorized', "account refused the request") };
		case 'unavailable':
			return { kind: 'unavailable', statusLabel: localize('kingu.usage.unavailable', "usage unavailable") };
		default:
			return { kind: 'empty', statusLabel: localize('kingu.usage.none', "no usage reported") };
	}
}

function toRow(source: IKinguUsageSource): IKinguUsageRow {
	const windows = windowsOf(source.limits);
	const label = KINGU_QUOTA_PROVIDER_LABELS[source.provider];
	if (windows.length === 0) {
		const state = stateOf(source);
		return { provider: source.provider, label, ...state, windows, resetsInMs: undefined, worstPercent: 0 };
	}
	const resets = source.limits
		.map(limit => limit.resetsAt)
		.filter((at): at is number => typeof at === 'number' && Number.isFinite(at));
	return {
		provider: source.provider,
		label,
		kind: 'usage',
		statusLabel: undefined,
		windows,
		resetsInMs: resets.length > 0 ? Math.min(...resets) - Date.now() : undefined,
		worstPercent: Math.max(...source.limits.map(limit => clampUsedPercent(limit.usedPercent))),
	};
}

/**
 * Every provider as a row, worst first.
 *
 * Worst first because the panel is opened by someone asking "how close am I",
 * and the answer is whichever agent is nearest a wall — not whichever happens
 * to sort first alphabetically. Rows with no numbers fall to the bottom, since
 * a provider that reports nothing cannot be the answer to that question.
 */
export function usageRows(sources: readonly IKinguUsageSource[]): IKinguUsageRow[] {
	return sources.map(toRow).sort((a, b) => {
		if ((a.kind === 'usage') !== (b.kind === 'usage')) {
			return a.kind === 'usage' ? -1 : 1;
		}
		return b.worstPercent - a.worstPercent;
	});
}

/** The fullest window of a row, which is the one its single-line summary shows. */
export function tightestWindow(row: IKinguUsageRow): IKinguUsageWindow | undefined {
	if (row.windows.length === 0) {
		return undefined;
	}
	return row.windows.reduce((worst, candidate) =>
		clampUsedPercent(candidate.limit.usedPercent) > clampUsedPercent(worst.limit.usedPercent) ? candidate : worst);
}

// #endregion

// #region Countdown

/**
 * How long until a window resets, as someone would say it.
 *
 * Coarse on purpose: a five-hour window is not read to the second, and a
 * countdown that ticks every second in the corner of the screen is a thing that
 * demands attention rather than a thing that answers a question.
 */
export function formatResetCountdown(remainingMs: number): string {
	if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
		return localize('kingu.usage.resetsNow', "resets any moment");
	}
	const minutes = Math.floor(remainingMs / 60_000);
	if (minutes < 60) {
		return localize('kingu.usage.resetsMinutes', "resets in {0}m", Math.max(1, minutes));
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		const rest = minutes % 60;
		return rest === 0
			? localize('kingu.usage.resetsHours', "resets in {0}h", hours)
			: localize('kingu.usage.resetsHoursMinutes', "resets in {0}h {1}m", hours, rest);
	}
	const days = Math.floor(hours / 24);
	const restHours = hours % 24;
	return restHours === 0
		? localize('kingu.usage.resetsDays', "resets in {0}d", days)
		: localize('kingu.usage.resetsDaysHours', "resets in {0}d {1}h", days, restHours);
}

// #endregion

/** How much of each row the panel draws. */
export type KinguUsageDetail = 'detailed' | 'compact';
