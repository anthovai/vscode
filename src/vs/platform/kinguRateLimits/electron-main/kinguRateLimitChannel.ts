/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { net } from 'electron';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join } from '../../../base/common/path.js';
import { Event } from '../../../base/common/event.js';
import { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import {
	CLAUDE_OAUTH_USAGE_HEADERS,
	CLAUDE_OAUTH_USAGE_URL,
	IKinguProviderQuota,
	KinguQuotaResult,
	problemForStatus,
	readClaudeAccessToken,
	readClaudeQuota,
} from '../common/kinguRateLimits.js';
import {
	GROK_AUTH_HEADER,
	GROK_BILLING_URL,
	GEMINI_LOAD_CODE_ASSIST_BODY,
	GEMINI_LOAD_CODE_ASSIST_URL,
	GEMINI_QUOTA_URL,
	KIMI_DEFAULT_BASE_URL,
	KIMI_USAGE_PATH,
	KinguQuotaProvider,
	readGrokQuota,
	readGrokToken,
	readGeminiProjectId,
	readGeminiQuota,
	readGeminiToken,
	readKimiQuota,
	readKimiToken,
} from '../common/kinguQuotaProviders.js';
export { KINGU_RATE_LIMIT_CHANNEL_NAME } from '../common/kinguRateLimitTypes.js';

/** A status read; a slow one is worth abandoning rather than waiting on. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Reads the quota on accounts this machine is already signed into, in the main
 * process.
 *
 * Here rather than in the window for two reasons. A renderer is a
 * `vscode-file://` origin, so a request to the provider is refused by CORS
 * before it leaves. And the credential never has to cross into a window: this
 * reads the file, makes the call, and returns the percentages. The token is not
 * in the channel's replies, is not in its arguments, and reaches no log.
 *
 * Only providers whose own CLI already stored a token, and only their own
 * issuer. Nothing signs in, refreshes a token or writes to a credential store.
 */
export class KinguRateLimitChannel implements IServerChannel {

	listen<T>(): Event<T> {
		throw new Error('No events on the Kingu rate limit channel');
	}

	async call<T>(_context: unknown, command: string, provider?: KinguQuotaProvider): Promise<T> {
		if (command === 'getQuota') {
			return await this._getQuota(provider) as T;
		}
		throw new Error(`Unknown Kingu rate limit command: ${command}`);
	}

	private async _getQuota(provider: KinguQuotaProvider | undefined): Promise<KinguQuotaResult> {
		switch (provider) {
			case KinguQuotaProvider.Claude: return this._getClaudeQuota();
			case KinguQuotaProvider.Grok: return this._getGrokQuota();
			case KinguQuotaProvider.Kimi: return this._getKimiQuota();
			case KinguQuotaProvider.Gemini: return this._getGeminiQuota();
			default: return { ok: false, problem: 'unavailable' };
		}
	}

	private async _getGrokQuota(): Promise<KinguQuotaResult> {
		const raw = await readIfPresent(join(grokHome(), 'auth.json'));
		if (raw === undefined) {
			return { ok: false, problem: 'noCredentials' };
		}
		const read = readGrokToken(raw);
		if (!read.ok) {
			return { ok: false, problem: read.problem };
		}
		// The proxy identifies its caller by a fixed header as well as the token,
		// and refuses a request carrying only the latter.
		const headers: Record<string, string> = {
			Authorization: `Bearer ${read.token}`,
			'X-XAI-Token-Auth': GROK_AUTH_HEADER,
			Accept: 'application/json',
		};
		if (read.userId) {
			headers['x-userid'] = read.userId;
		}
		return this._request(GROK_BILLING_URL, headers, readGrokQuota);
	}

	private async _getKimiQuota(): Promise<KinguQuotaResult> {
		const raw = await readIfPresent(join(kimiHome(), 'credentials', 'kimi-code.json'));
		if (raw === undefined) {
			return { ok: false, problem: 'noCredentials' };
		}
		const read = readKimiToken(raw, Date.now());
		if (!read.ok) {
			return { ok: false, problem: read.problem };
		}
		const base = process.env['KIMI_CODE_BASE_URL']?.trim() || KIMI_DEFAULT_BASE_URL;
		return this._request(base.replace(/\/+$/, '') + KIMI_USAGE_PATH, {
			Authorization: `Bearer ${read.token}`,
			Accept: 'application/json',
		}, readKimiQuota);
	}

	/**
	 * Gemini takes two calls: the account does not know its own project, so the
	 * project is discovered first and the quota asked for by name.
	 */
	private async _getGeminiQuota(): Promise<KinguQuotaResult> {
		const raw = await readIfPresent(join(homedir(), '.gemini', 'oauth_creds.json'));
		if (raw === undefined) {
			return { ok: false, problem: 'noCredentials' };
		}
		const read = readGeminiToken(raw, Date.now());
		if (!read.ok) {
			return { ok: false, problem: read.problem };
		}
		const headers = {
			Authorization: `Bearer ${read.token}`,
			'Content-Type': 'application/json',
		};
		try {
			const discovery = await net.fetch(GEMINI_LOAD_CODE_ASSIST_URL, {
				method: 'POST',
				headers,
				body: JSON.stringify(GEMINI_LOAD_CODE_ASSIST_BODY),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (!discovery.ok) {
				return { ok: false, problem: problemForStatus(discovery.status) };
			}
			const project = readGeminiProjectId(await discovery.json());
			if (!project) {
				// Signed in, but this account has no Code Assist project — there is no
				// quota to report rather than a failure to report.
				return { ok: false, problem: 'noCredentials' };
			}
			return await this._request(GEMINI_QUOTA_URL, headers, readGeminiQuota, JSON.stringify({ project }));
		} catch {
			return { ok: false, problem: 'unavailable' };
		}
	}

	/**
	 * One request, one shape of failure.
	 *
	 * Nothing about a rejection is returned or logged: a failed request can carry
	 * the options that produced it, and one of those headers is the user's token.
	 */
	private async _request(url: string, headers: Record<string, string>, read: (body: unknown, now: number) => IKinguProviderQuota, body?: string): Promise<KinguQuotaResult> {
		try {
			const response = await net.fetch(url, {
				method: body === undefined ? 'GET' : 'POST',
				headers,
				body,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (!response.ok) {
				return { ok: false, problem: problemForStatus(response.status) };
			}
			return { ok: true, quota: read(await response.json(), Date.now()) };
		} catch {
			return { ok: false, problem: 'unavailable' };
		}
	}

	private async _getClaudeQuota(): Promise<KinguQuotaResult> {
		// The ordinary absence on a machine that never ran the Claude CLI, and on one
		// where it keeps its token in the OS keychain instead of a file.
		const raw = await readIfPresent(join(homedir(), '.claude', '.credentials.json'));
		if (raw === undefined) {
			return { ok: false, problem: 'noCredentials' };
		}
		const read = readClaudeAccessToken(raw, Date.now());
		if (!read.ok) {
			return { ok: false, problem: read.problem };
		}
		return this._request(CLAUDE_OAUTH_USAGE_URL, {
			...CLAUDE_OAUTH_USAGE_HEADERS,
			Authorization: `Bearer ${read.token}`,
		}, readClaudeQuota);
	}
}

async function readIfPresent(path: string): Promise<string | undefined> {
	try {
		return await fs.readFile(path, 'utf8');
	} catch {
		return undefined;
	}
}

/** Each CLI's home, honouring the variable it reads for a moved one. */
function grokHome(): string {
	const override = process.env['GROK_HOME']?.trim();
	return override && isAbsolute(override) ? override : join(homedir(), '.grok');
}

function kimiHome(): string {
	const override = process.env['KIMI_CODE_HOME']?.trim();
	return override && isAbsolute(override) ? override : join(homedir(), '.kimi-code');
}
