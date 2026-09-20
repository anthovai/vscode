/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';
import { Event } from '../../../base/common/event.js';
import { IKinguRateLimit } from './kinguRateLimitTypes.js';

/**
 * Where Anthropic reports what is left of an OAuth account's quota.
 *
 * The same endpoint the Claude CLI itself reads, with the token that CLI already
 * holds. Nothing new is authorized: this asks the provider that issued the token
 * about the account that owns it.
 */
export const CLAUDE_OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

/** Headers the endpoint requires; it refuses a request without the beta opt-in. */
export const CLAUDE_OAUTH_USAGE_HEADERS: Readonly<Record<string, string>> = {
	'anthropic-beta': 'oauth-2025-04-20',
};

/** The five-hour and weekly windows Claude reports, in minutes. */
export const CLAUDE_SESSION_WINDOW_MINUTES = 300;
export const CLAUDE_WEEKLY_WINDOW_MINUTES = 10_080;

/** One provider's quota, as much of it as the provider reported. */
export interface IKinguProviderQuota {
	/** The short rolling window, where there is one. */
	readonly session: IKinguRateLimit | undefined;
	/** The long window. */
	readonly weekly: IKinguRateLimit | undefined;
	/** When this was read, in epoch milliseconds. */
	readonly updatedAt: number;
}

/** Why a quota could not be read, in terms the user can act on. */
export type KinguQuotaProblem =
	| 'noCredentials'
	| 'expiredCredentials'
	| 'unauthorized'
	| 'unavailable';

export type KinguQuotaResult =
	| { readonly ok: true; readonly quota: IKinguProviderQuota }
	| { readonly ok: false; readonly problem: KinguQuotaProblem };

export const IKinguRateLimitService = createDecorator<IKinguRateLimitService>('kinguRateLimitService');

/**
 * Reads what is left of the quota on accounts this machine is already signed
 * into.
 *
 * Only for providers whose own CLI stores a token on disk and whose backend
 * exposes a usage endpoint. Nothing here signs anything in, refreshes a token,
 * or writes to a credential store: it reads what is there and asks the issuer.
 */
export interface IKinguRateLimitService {
	readonly _serviceBrand: undefined;

	/** Fires when a refresh changes what {@link claude} returns. */
	readonly onDidChange: Event<void>;

	/** The last reading for Claude, or `undefined` before the first one. */
	readonly claude: KinguQuotaResult | undefined;

	/** Reads again now. Safe to call often; concurrent calls share one request. */
	refresh(): Promise<void>;
}

// #region Credentials

/**
 * The access token the Claude CLI stored, and whether it is still valid.
 *
 * Read from the CLI's own credentials file. An expired token is reported as
 * expired rather than sent: the endpoint would reject it, and refreshing it
 * would mean writing to a credential store this does not own.
 */
export function readClaudeAccessToken(credentialsJson: string, now: number): { readonly ok: true; readonly token: string } | { readonly ok: false; readonly problem: KinguQuotaProblem } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(credentialsJson);
	} catch {
		return { ok: false, problem: 'noCredentials' };
	}
	const oauth = (parsed as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } })?.claudeAiOauth;
	const token = typeof oauth?.accessToken === 'string' ? oauth.accessToken.trim() : '';
	if (!token) {
		return { ok: false, problem: 'noCredentials' };
	}
	const expiresAt = oauth?.expiresAt;
	if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt <= now) {
		return { ok: false, problem: 'expiredCredentials' };
	}
	return { ok: true, token };
}

// #endregion

// #region Response

interface IClaudeUsageWindow {
	readonly utilization?: unknown;
	readonly used_percentage?: unknown;
	readonly resets_at?: unknown;
}

/**
 * The windows in a usage response.
 *
 * Both spellings of the percentage are accepted because the endpoint has used
 * each; a window that reports neither is absent rather than zero, since "no
 * quota used" and "no quota reported" are different answers.
 */
export function readClaudeQuota(body: unknown, now: number): IKinguProviderQuota {
	const response = (body && typeof body === 'object' ? body : {}) as {
		five_hour?: IClaudeUsageWindow;
		seven_day?: IClaudeUsageWindow;
	};
	return {
		session: readWindow(response.five_hour, CLAUDE_SESSION_WINDOW_MINUTES),
		weekly: readWindow(response.seven_day, CLAUDE_WEEKLY_WINDOW_MINUTES),
		updatedAt: now,
	};
}

function readWindow(raw: IClaudeUsageWindow | undefined, windowDurationMins: number): IKinguRateLimit | undefined {
	const percent = typeof raw?.utilization === 'number'
		? raw.utilization
		: typeof raw?.used_percentage === 'number' ? raw.used_percentage : undefined;
	if (percent === undefined || !Number.isFinite(percent)) {
		return undefined;
	}
	return {
		// The endpoint has been seen to exceed 100 on a hard-limited account, and a
		// gauge past full reads as a bug rather than as being out of quota.
		usedPercent: Math.min(100, Math.max(0, percent)),
		windowDurationMins,
		resetsAt: readResetsAt(raw?.resets_at),
	};
}

/** The reset time, whether it arrived as epoch seconds, milliseconds or a date. */
function readResetsAt(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
		// Ten digits is seconds; the endpoint has used both.
		return value < 100_000_000_000 ? value * 1000 : value;
	}
	if (typeof value === 'string' && value) {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}

/** What an HTTP status means for the user. */
export function problemForStatus(status: number): KinguQuotaProblem {
	return status === 401 || status === 403 ? 'unauthorized' : 'unavailable';
}

// #endregion
