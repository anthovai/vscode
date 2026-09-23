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
 * The gauge's text: `58% used 3h 54m`, or `58% used` with nothing else known.
 *
 * Two halves, and both are the ADE's rather than this window's earlier shape.
 *
 * **`used`, spelled out.** A bare `58%` does not say which way it counts, and
 * the two readings are opposites. The ADE lets the user pick which one the
 * strip shows and then says which one it is; this does the same.
 *
 * **Time until the window resets, not the window's length.** `5h` is a
 * constant — it says the same thing at 1% and at 99%, and what a person wants
 * from a quota they are near is *when do I get more*. The length is still the
 * fallback, for an account that reports a percentage without a reset time.
 * This is also what the ADE's own detail panel already said, so the strip and
 * the panel agreeing is a bug fixed rather than a feature added.
 */
export function formatRateLimit(limit: IKinguRateLimit, display: KinguUsageDisplay = 'used', now: number = Date.now()): string {
	const percent = `${displayedUsagePercent(limit.usedPercent, display)}%`;
	const reading = display === 'used' ? `${percent} used` : `${percent} left`;
	const window = formatRateLimitWindow(limit, now);
	return window ? `${reading} ${window}` : reading;
}

/**
 * Which way the percentage counts.
 *
 * The ADE offers both and defaults to `used`, because that is what its gauge
 * fills towards. Kept as its own type rather than a boolean so a call site
 * reads as the thing it means.
 */
export type KinguUsageDisplay = 'used' | 'remaining';

/**
 * The number on the gauge, rounded once.
 *
 * Rounded *before* the complement is taken, not after. `Math.round(100 - 20.5)`
 * is 80 and `100 - Math.round(20.5)` is 79, so rounding last makes the two
 * display modes disagree by a point about the same account — and makes the
 * label disagree with the bar beside it, which fills from the same number.
 */
export function displayedUsagePercent(usedPercent: number, display: KinguUsageDisplay): number {
	if (!Number.isFinite(usedPercent)) {
		// Not 100% remaining: a provider that reported nothing usable must not be
		// drawn as a full tank.
		return 0;
	}
	const used = Math.round(Math.min(100, Math.max(0, usedPercent)));
	return display === 'used' ? used : 100 - used;
}

/** What follows the percentage: the countdown, else the window's length. */
export function formatRateLimitWindow(limit: IKinguRateLimit, now: number = Date.now()): string | undefined {
	if (limit.resetsAt !== undefined) {
		return formatResetDuration(limit.resetsAt - now);
	}
	return limit.windowDurationMins === undefined ? undefined : formatWindow(limit.windowDurationMins);
}

/**
 * Time until a window resets, floored: `47m`, `3h 54m`, `6d 7h`.
 *
 * Floored rather than rounded so the label never promises a reset sooner than
 * it happens, and `now` for a window that has already turned over — the caller
 * decides whether that is worth saying.
 */
export function formatResetDuration(ms: number): string {
	if (ms <= 0) {
		return 'now';
	}
	const totalMinutes = Math.floor(ms / 60_000);
	if (totalMinutes < 60) {
		return `${totalMinutes}m`;
	}
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours >= 24) {
		const days = Math.floor(hours / 24);
		const remainingHours = hours % 24;
		return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
	}
	return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

/**
 * How long until the soonest countdown would read differently, or `undefined`
 * when nothing is counting down.
 *
 * A countdown floored to minutes changes once a minute, and once an hour past a
 * day — so this wakes just after the next boundary instead of ticking every
 * second. A status bar that re-rendered every second to change a digit once a
 * minute would keep the window's compositor busy for nothing.
 */
export function nextResetTickDelay(now: number, resetTimes: readonly number[]): number | undefined {
	let soonest: number | undefined;
	for (const resetAt of resetTimes) {
		if (!Number.isFinite(resetAt) || resetAt <= now) {
			continue;
		}
		const remaining = resetAt - now;
		const unit = remaining >= 86_400_000 ? 3_600_000 : 60_000;
		// Past the boundary, not on it: on it the label has not flipped yet.
		const delay = (remaining % unit) + 1;
		soonest = soonest === undefined ? delay : Math.min(soonest, delay);
	}
	return soonest;
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
