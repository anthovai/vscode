/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { app, net } from 'electron';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { homedir, platform } from 'os';
import { isAbsolute, join } from '../../../base/common/path.js';
import { Event } from '../../../base/common/event.js';
import { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { listProcesses } from '../../../base/node/ps.js';
import { ProcessItem } from '../../../base/common/processes.js';
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
import {
	IKinguListeningPort,
	nameListeningPorts,
	normalizeListeningPorts,
	parseLsofPorts,
	parseNetstatPorts,
	parseSsPorts,
} from '../common/kinguHostPorts.js';
import { IKinguMemoryReading } from '../common/kinguHostService.js';
export { KINGU_HOST_CHANNEL_NAME } from '../common/kinguHostTypes.js';

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
export class KinguHostChannel implements IServerChannel {

	listen<T>(): Event<T> {
		throw new Error('No events on the Kingu host channel');
	}

	async call<T>(_context: unknown, command: string, provider?: KinguQuotaProvider): Promise<T> {
		if (command === 'getQuota') {
			return await this._getQuota(provider) as T;
		}
		if (command === 'getMemoryBytes') {
			return this._getMemoryBytes() as T;
		}
		if (command === 'getListeningPorts') {
			return await this._getListeningPorts() as T;
		}
		throw new Error(`Unknown Kingu host command: ${command}`);
	}

	/**
	 * What the app is holding, across every process it runs.
	 *
	 * The renderer can only see its own heap, which is a fraction of the answer —
	 * the agent host, the extension host and the other windows are where the
	 * memory of an agent session actually goes.
	 */
	private _getMemoryBytes(): IKinguMemoryReading | undefined {
		try {
			const byKind = new Map<string, number>();
			let total = 0;
			for (const metric of app.getAppMetrics()) {
				// `workingSetSize` is reported in kilobytes.
				const bytes = (metric.memory?.workingSetSize ?? 0) * 1024;
				total += bytes;
				// Grouped by what the process is for, because "3.8 GB" alone cannot be
				// acted on and "2.1 GB of it is agent hosts" can.
				const kind = metric.serviceName || metric.type || 'other';
				byKind.set(kind, (byKind.get(kind) ?? 0) + bytes);
			}
			return {
				total,
				byKind: [...byKind].map(([kind, bytes]) => ({ kind, bytes })).sort((left, right) => right.bytes - left.bytes),
			};
		} catch {
			return undefined;
		}
	}

	/**
	 * The ports this app's own processes are listening on.
	 *
	 * Read from the operating system's listing rather than by probing, because a
	 * probe is a connection: it would appear in the logs of whatever answered and
	 * could wake a server that was idle.
	 *
	 * Scoped to this app's process tree. Everything an agent starts — a dev
	 * server in a terminal, a preview, a language server — is a descendant of
	 * this process, and everything else on the machine is not the user's
	 * question. Unscoped, a Windows machine reports around thirty system
	 * services, which is a number nobody would read twice.
	 */
	private async _getListeningPorts(): Promise<readonly IKinguListeningPort[]> {
		try {
			const [entries, tree] = await Promise.all([this._listSockets(), this._processTree()]);
			return nameListeningPorts(normalizeListeningPorts(entries, new Set(tree.keys())), tree);
		} catch {
			// A missing tool, a denied read: the strip simply shows no ports.
			return [];
		}
	}

	/** Every listening TCP socket the platform will name a process for. */
	private async _listSockets(): Promise<IKinguListeningPort[]> {
		switch (platform()) {
			case 'win32':
				return parseNetstatPorts(await run('netstat', ['-ano', '-p', 'tcp']));
			case 'darwin':
				return parseLsofPorts(await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']));
			case 'linux':
				// `ss` over `lsof` because iproute2 is on every modern distribution
				// and `lsof` is not; `-H` drops the header, `-p` names the owner.
				return parseSsPorts(await run('ss', ['-ltnpH']));
			default:
				return [];
		}
	}

	/**
	 * This process and everything below it, each with the name it runs under.
	 *
	 * One walk answers both questions the ports listing has — whether a socket is
	 * ours and what is holding it — and the second is what turns `3000` into
	 * `3000 node`.
	 */
	private async _processTree(): Promise<ReadonlyMap<number, string>> {
		const tree = new Map<number, string>();
		const collect = (item: ProcessItem): void => {
			tree.set(item.pid, processName(item));
			for (const child of item.children ?? []) {
				collect(child);
			}
		};
		collect(await listProcesses(process.pid));
		return tree;
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

/** How long a listing tool is given before the strip does without it. */
const PORT_LISTING_TIMEOUT_MS = 5_000;

/** A listing tool's stdout, with a fixed argument list and no shell. */
function run(command: string, args: readonly string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		// `execFile` rather than `exec`: there is nothing here to interpolate, and a
		// shell would be a way for one to appear later.
		execFile(command, [...args], { timeout: PORT_LISTING_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
			// `lsof` exits non-zero when some sockets were unreadable while still
			// printing the ones that were, so output wins over the exit code.
			if (stdout) {
				resolve(stdout);
			} else if (error) {
				reject(error);
			} else {
				resolve('');
			}
		});
	});
}

/**
 * What to call a process in one word.
 *
 * The command line is a path plus its arguments and would fill the row; the
 * executable's own name is what a person would say. A name the tree already
 * shortened (`electron-nodejs (server.js)`) is kept as it is, because that is
 * more useful than `node`.
 */
function processName(item: ProcessItem): string {
	const name = item.name?.trim();
	if (name && !/[\\/]/.test(name)) {
		return name;
	}
	// The executable is the command's first token, and the rest is arguments. The
	// basename has to be taken from that token alone: a command line ends in a
	// path as often as it begins with one, and taking the last path in the whole
	// string named the root process after its `--user-data-dir`.
	const command = (name ?? item.cmd ?? '').trim();
	const executable = command.startsWith('"')
		? command.slice(1, command.indexOf('"', 1))
		: command.split(/\s/)[0];
	return executable.split(/[\\/]/).pop() || 'unknown';
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
