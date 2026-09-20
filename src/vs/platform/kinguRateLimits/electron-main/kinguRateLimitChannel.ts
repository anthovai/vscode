/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { net } from 'electron';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from '../../../base/common/path.js';
import { Event } from '../../../base/common/event.js';
import { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import {
	CLAUDE_OAUTH_USAGE_HEADERS,
	CLAUDE_OAUTH_USAGE_URL,
	KinguQuotaResult,
	problemForStatus,
	readClaudeAccessToken,
	readClaudeQuota,
} from '../common/kinguRateLimits.js';
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

	async call<T>(_context: unknown, command: string): Promise<T> {
		if (command === 'getClaudeQuota') {
			return await this._getClaudeQuota() as T;
		}
		throw new Error(`Unknown Kingu rate limit command: ${command}`);
	}

	private async _getClaudeQuota(): Promise<KinguQuotaResult> {
		let raw: string;
		try {
			raw = await fs.readFile(join(homedir(), '.claude', '.credentials.json'), 'utf8');
		} catch {
			// The ordinary case on a machine that never ran the Claude CLI, and on one
			// where it keeps its token in the OS keychain instead of a file.
			return { ok: false, problem: 'noCredentials' };
		}

		const read = readClaudeAccessToken(raw, Date.now());
		if (!read.ok) {
			return { ok: false, problem: read.problem };
		}

		try {
			const response = await net.fetch(CLAUDE_OAUTH_USAGE_URL, {
				headers: { ...CLAUDE_OAUTH_USAGE_HEADERS, Authorization: `Bearer ${read.token}` },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (!response.ok) {
				return { ok: false, problem: problemForStatus(response.status) };
			}
			return { ok: true, quota: readClaudeQuota(await response.json(), Date.now()) };
		} catch {
			// Nothing about the failure is returned or logged: a rejected request can
			// carry the options that produced it, and one of those headers is the
			// user's token. The window shows no gauge, which is the whole outcome.
			return { ok: false, problem: 'unavailable' };
		}
	}
}
