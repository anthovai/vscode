/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { IKinguRateLimit } from './kinguRateLimitTypes.js';
import { IKinguProviderQuota, KinguQuotaProblem } from './kinguRateLimits.js';

/** An agent whose own CLI leaves a token on disk and whose issuer reports quota. */
export const enum KinguQuotaProvider {
	Claude = 'claude',
	Grok = 'grok',
	Kimi = 'kimi',
	Gemini = 'gemini',
}

/** What to call each one in the bar. */
export const KINGU_QUOTA_PROVIDER_LABELS: Readonly<Record<KinguQuotaProvider, string>> = {
	[KinguQuotaProvider.Claude]: 'Claude',
	[KinguQuotaProvider.Grok]: 'Grok',
	[KinguQuotaProvider.Kimi]: 'Kimi',
	[KinguQuotaProvider.Gemini]: 'Gemini',
};

export const KINGU_QUOTA_PROVIDERS: readonly KinguQuotaProvider[] = [
	KinguQuotaProvider.Claude,
	KinguQuotaProvider.Grok,
	KinguQuotaProvider.Kimi,
	KinguQuotaProvider.Gemini,
];

const WEEK_MINUTES = 10_080;

// #region Grok

export const GROK_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';

/** The proxy identifies its caller by a fixed header as well as the token. */
export const GROK_AUTH_HEADER = 'xai-grok-cli';

/**
 * The token Grok's CLI stored, from `auth.json`.
 *
 * The file holds a list of issuers and a stale one can precede the live entry,
 * so the first entry carrying a key wins rather than the first entry.
 */
export function readGrokToken(authJson: string): { readonly ok: true; readonly token: string; readonly userId: string | undefined } | { readonly ok: false; readonly problem: KinguQuotaProblem } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(authJson);
	} catch {
		return { ok: false, problem: 'noCredentials' };
	}
	for (const entry of candidateEntries(parsed)) {
		const key = typeof entry.key === 'string' ? entry.key.trim() : '';
		if (key) {
			const userId = typeof entry.userId === 'string' && entry.userId ? entry.userId : undefined;
			return { ok: true, token: key, userId };
		}
	}
	// A token-less file is a signed-out CLI, not a broken one.
	return { ok: false, problem: 'noCredentials' };
}

function candidateEntries(parsed: unknown): { key?: unknown; userId?: unknown }[] {
	if (Array.isArray(parsed)) {
		return parsed as { key?: unknown }[];
	}
	if (!parsed || typeof parsed !== 'object') {
		return [];
	}
	const record = parsed as Record<string, unknown>;
	const nested = Object.values(record).filter(value => value && typeof value === 'object');
	return [record, ...nested] as { key?: unknown }[];
}

interface IGrokMoney { readonly val?: unknown }

/**
 * Grok's billing response as a window.
 *
 * It reports either a percentage outright or a spend against a limit; the
 * percentage wins because it is the provider's own arithmetic. A zero or
 * missing limit yields no window rather than a fabricated 0% or a division that
 * produces infinity.
 */
export function readGrokQuota(body: unknown, now: number): IKinguProviderQuota {
	const config = (body && typeof body === 'object' ? body : {}) as {
		creditUsagePercent?: unknown;
		monthlyLimit?: IGrokMoney;
		used?: IGrokMoney;
		currentPeriod?: { end?: unknown };
		billingPeriodEnd?: unknown;
	};
	const resetsAt = readDate(config.currentPeriod?.end ?? config.billingPeriodEnd);
	const reported = typeof config.creditUsagePercent === 'number' && Number.isFinite(config.creditUsagePercent)
		? config.creditUsagePercent
		: computed(money(config.used), money(config.monthlyLimit));
	return {
		session: undefined,
		weekly: reported === undefined ? undefined : { usedPercent: clamp(reported), windowDurationMins: WEEK_MINUTES, resetsAt },
		updatedAt: now,
	};
}

function money(value: IGrokMoney | undefined): number | undefined {
	const raw = value?.val;
	const parsed = typeof raw === 'string' ? Number.parseFloat(raw) : raw;
	return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
}

function computed(used: number | undefined, limit: number | undefined): number | undefined {
	return used === undefined || limit === undefined || limit <= 0 ? undefined : (used / limit) * 100;
}

// #endregion

// #region Kimi

export const KIMI_DEFAULT_BASE_URL = 'https://api.kimi.com/coding/v1';
export const KIMI_USAGE_PATH = '/usages';

/** The token Kimi's CLI stored, and whether it is still valid. */
export function readKimiToken(credentialsJson: string, now: number): { readonly ok: true; readonly token: string } | { readonly ok: false; readonly problem: KinguQuotaProblem } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(credentialsJson);
	} catch {
		return { ok: false, problem: 'noCredentials' };
	}
	const record = (parsed && typeof parsed === 'object' ? parsed : {}) as { access_token?: unknown; expires_at?: unknown };
	const token = typeof record.access_token === 'string' ? record.access_token.trim() : '';
	if (!token) {
		return { ok: false, problem: 'noCredentials' };
	}
	const expiresAt = readDate(record.expires_at);
	if (expiresAt !== undefined && expiresAt <= now) {
		return { ok: false, problem: 'expiredCredentials' };
	}
	return { ok: true, token };
}

interface IKimiLimit {
	readonly limit?: unknown;
	readonly remaining?: unknown;
	readonly window?: { readonly duration?: unknown; readonly timeUnit?: unknown };
}

/**
 * Kimi's usage response as windows.
 *
 * It reports a limit and what is left rather than a percentage, and it can
 * report several windows at once; the shortest becomes the session gauge and
 * the longest the weekly one, which is how a person reads two numbers.
 */
export function readKimiQuota(body: unknown, now: number): IKinguProviderQuota {
	const limits = ((body && typeof body === 'object' ? body : {}) as { limits?: IKimiLimit[] }).limits;
	const windows: { minutes: number; limit: IKinguRateLimit }[] = [];
	for (const entry of Array.isArray(limits) ? limits : []) {
		const total = integer(entry.limit);
		const remaining = integer(entry.remaining);
		const minutes = windowMinutes(entry.window);
		if (total === undefined || remaining === undefined || total <= 0 || minutes === undefined) {
			continue;
		}
		windows.push({
			minutes,
			limit: { usedPercent: clamp(((total - remaining) / total) * 100), windowDurationMins: minutes, resetsAt: undefined },
		});
	}
	windows.sort((a, b) => a.minutes - b.minutes);
	return {
		session: windows.at(0)?.limit,
		// One window is one window, not a session and a duplicate of it.
		weekly: windows.length > 1 ? windows.at(-1)?.limit : undefined,
		updatedAt: now,
	};
}

/** A window's length, from the unit Kimi names it in. */
export function windowMinutes(window: { readonly duration?: unknown; readonly timeUnit?: unknown } | undefined): number | undefined {
	const duration = integer(window?.duration);
	if (duration === undefined || duration <= 0) {
		return undefined;
	}
	switch (String(window?.timeUnit ?? '').toUpperCase()) {
		case 'MINUTE':
		case 'MINUTES':
			return duration;
		case 'HOUR':
		case 'HOURS':
			return duration * 60;
		case 'DAY':
		case 'DAYS':
			return duration * 1_440;
		case 'WEEK':
		case 'WEEKS':
			return duration * WEEK_MINUTES;
		case 'MONTH':
		case 'MONTHS':
			return duration * 43_200;
		default:
			return undefined;
	}
}

function integer(value: unknown): number | undefined {
	const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value;
	return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
}

// #endregion

// #region Gemini

/** Where the project this account bills against is discovered. */
export const GEMINI_LOAD_CODE_ASSIST_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';

/** Where that project's remaining quota is reported. */
export const GEMINI_QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota';

/** What the discovery call sends to identify the caller. */
export const GEMINI_LOAD_CODE_ASSIST_BODY = { metadata: { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' } };

/** The token Gemini's CLI stored, and whether it is still valid. */
export function readGeminiToken(credentialsJson: string, now: number): { readonly ok: true; readonly token: string } | { readonly ok: false; readonly problem: KinguQuotaProblem } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(credentialsJson);
	} catch {
		return { ok: false, problem: 'noCredentials' };
	}
	const record = (parsed && typeof parsed === 'object' ? parsed : {}) as { access_token?: unknown; expiry_date?: unknown };
	const token = typeof record.access_token === 'string' ? record.access_token.trim() : '';
	if (!token) {
		return { ok: false, problem: 'noCredentials' };
	}
	const expiry = readDate(record.expiry_date);
	if (expiry !== undefined && expiry <= now) {
		// Reported rather than refreshed: renewing it means writing a new token into
		// the CLI's own credential store, which this does not own.
		return { ok: false, problem: 'expiredCredentials' };
	}
	return { ok: true, token };
}

/** The project the discovery call named, or `undefined` when it named none. */
export function readGeminiProjectId(body: unknown): string | undefined {
	if (!body || typeof body !== 'object') {
		return undefined;
	}
	const project = (body as { cloudaicompanionProject?: unknown }).cloudaicompanionProject;
	return typeof project === 'string' && project ? project : undefined;
}

interface IGeminiBucket {
	readonly remainingFraction?: unknown;
	readonly resetTime?: unknown;
	readonly modelId?: unknown;
}

/**
 * Gemini's quota response as one window.
 *
 * It reports a bucket per model, each as the fraction *remaining*, so each is
 * inverted into a used percentage. The bar shows one number, and the fullest
 * bucket is the one that matters: it is the first that will stop the user.
 */
export function readGeminiQuota(body: unknown, now: number): IKinguProviderQuota {
	const raw = Array.isArray(body)
		? body
		: ((body && typeof body === 'object' ? body : {}) as { buckets?: unknown }).buckets;
	let worst: IKinguRateLimit | undefined;
	for (const entry of Array.isArray(raw) ? raw as IGeminiBucket[] : []) {
		const remaining = entry?.remainingFraction;
		if (typeof remaining !== 'number' || !Number.isFinite(remaining)) {
			continue;
		}
		const candidate: IKinguRateLimit = {
			usedPercent: clamp((1 - remaining) * 100),
			// The buckets are hourly; the response states no length of its own.
			windowDurationMins: 60,
			resetsAt: readDate(entry?.resetTime),
		};
		if (!worst || candidate.usedPercent > worst.usedPercent) {
			worst = candidate;
		}
	}
	return { session: worst, weekly: undefined, updatedAt: now };
}

// #endregion

function clamp(percent: number): number {
	return Math.min(100, Math.max(0, percent));
}

/** A time in any of the shapes these providers send: epoch seconds, millis, or a date. */
export function readDate(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
		return value < 100_000_000_000 ? value * 1000 : value;
	}
	if (typeof value === 'string' && value) {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}
