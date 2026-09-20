/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { IKinguRateLimit } from '../../../../platform/kinguHost/common/kinguHostTypes.js';

export type { IKinguRateLimit };

/**
 * The quota an account reports, or `undefined` when it reports none usable.
 *
 * Accepts only a percentage that is actually a percentage. A gauge is read at a
 * glance and never questioned, so one drawn from a value outside 0–100 would be
 * a confident lie rather than a missing number.
 */
export function readRateLimitFromAccount(account: { readonly rateLimit?: { readonly usedPercent?: number; readonly windowDurationMins?: number; readonly resetsAt?: number } } | undefined): IKinguRateLimit | undefined {
	const limit = account?.rateLimit;
	const used = limit?.usedPercent;
	if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) {
		return undefined;
	}
	return {
		usedPercent: used,
		windowDurationMins: positive(limit?.windowDurationMins),
		resetsAt: positive(limit?.resetsAt),
	};
}

function positive(value: number | undefined): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The gauge's text: `58% 5h`, or just `58%` when the window is not stated.
 *
 * The window matters as much as the number — half of a five-hour window and
 * half of a week are not the same news — so it is shown whenever it is known.
 */
export function formatRateLimit(limit: IKinguRateLimit): string {
	const percent = `${Math.round(limit.usedPercent)}%`;
	const window = limit.windowDurationMins === undefined ? undefined : formatWindow(limit.windowDurationMins);
	return window ? `${percent} ${window}` : percent;
}

/** A window length as the unit a person would say: `5h`, `wk`, `30m`. */
export function formatWindow(minutes: number): string {
	if (minutes >= 10_080) {
		const weeks = Math.round(minutes / 10_080);
		return weeks === 1 ? 'wk' : `${weeks}wk`;
	}
	if (minutes >= 1_440) {
		const days = Math.round(minutes / 1_440);
		return days === 1 ? 'd' : `${days}d`;
	}
	if (minutes >= 60) {
		return `${Math.round(minutes / 60)}h`;
	}
	return `${Math.round(minutes)}m`;
}
