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
	checkStopPortRequest,
	classifyListeningPorts,
	IKinguListeningPort,
	IKinguPortScan,
	IKinguProcessUsage,
	IKinguStopPortRequest,
	KinguStopPortResult,
	nameListeningPorts,
	normalizeListeningPorts,
	parseLsofPorts,
	parseNetstatPorts,
	parseSsPorts,
} from '../common/kinguHostPorts.js';
import { IJevRequest, jevProblemForStatus, resolveJevEndpoint, jevRequestBody, JevResult, parseJevResponse } from '../common/kinguJev.js';
import { cpuBetweenSweeps, IKinguProcessRow, parseWindowsProcessTable, processSubtree, WINDOWS_PROCESS_TABLE_SCRIPT } from '../common/kinguProcessTable.js';
import { executableNames, executableSearchDirectories, MAX_COMMANDS_PER_REQUEST, MAX_SEARCH_DIRECTORIES } from '../common/kinguExecutables.js';
import { KNOWN_AGENT_COMMANDS } from '../common/kinguAgentCommands.js';
import { IProcessEnvironment } from '../../../base/common/platform.js';
import { IKinguMemoryReading } from '../common/kinguHostService.js';
import { ILogService } from '../../log/common/log.js';
import { IKinguComputerRequest, KinguComputerResult } from '../../kinguComputer/common/kinguComputerProtocol.js';
import { KinguComputerSidecar } from '../../kinguComputer/node/kinguComputerSidecar.js';
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

	/**
	 * What each command resolved to last time, so a second window asking costs
	 * nothing. Not invalidated: an agent installed while the app is running is
	 * rare, and the alternative is re-walking PATH on every redraw.
	 */
	private _executables: Promise<ReadonlyMap<string, string>> | undefined;
	/** Started on first use and retired when idle; see `KinguComputerSidecar`. */
	private _computer: KinguComputerSidecar | undefined;
	private _sweep: Promise<IKinguProcessSweep> | undefined;
	private _lastSweep: IKinguProcessSweep | undefined;
	/** The previous sweep's CPU times, from which Windows CPU is derived. */
	private _previousCpuTimes: { readonly at: number; readonly times: ReadonlyMap<number, number> } | undefined;

	constructor(
		private readonly _logService: ILogService,
		private readonly _resolveShellEnv?: () => Promise<IProcessEnvironment>,
		private readonly _allowDesktopInput?: () => boolean,
	) { }

	listen<T>(): Event<T> {
		throw new Error('No events on the Kingu host channel');
	}

	async call<T>(_context: unknown, command: string, arg?: unknown): Promise<T> {
		if (command === 'getQuota') {
			return await this._getQuota(arg as KinguQuotaProvider | undefined) as T;
		}
		if (command === 'readDesktop') {
			return await this._readDesktop(arg as IKinguComputerRequest) as T;
		}
		if (command === 'findExecutables') {
			return await this._findExecutables(Array.isArray(arg) ? arg as string[] : []) as T;
		}
		if (command === 'getMemoryBytes') {
			return this._getMemoryBytes() as T;
		}
		if (command === 'getListeningPorts') {
			return await this._getListeningPorts() as T;
		}
		if (command === 'scanPorts') {
			return await this._scanPorts() as T;
		}
		if (command === 'stopPortProcess') {
			return await this._stopPortProcess(arg as IKinguStopPortRequest | undefined) as T;
		}
		if (command === 'jevDecide') {
			const { request, apiKey } = (arg ?? {}) as { request?: IJevRequest; apiKey?: string };
			return await this._jevDecide(request, apiKey) as T;
		}
		if (command === 'measureProcesses') {
			return await this._measureProcesses(Array.isArray(arg) ? arg.filter((pid): pid is number => Number.isSafeInteger(pid) && pid > 0) : []) as T;
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

	/**
	 * One decision from TypeSafe's Jev.
	 *
	 * Made here rather than in the window: the window is a `vscode-file://`
	 * origin and the request would be refused by CORS. The key is the caller's,
	 * read from the window's secret storage for this one call; it goes out in
	 * the Authorization header and nowhere else — not into a log, not into the
	 * reply.
	 */
	private async _jevDecide(request: IJevRequest | undefined, apiKey: string | undefined): Promise<JevResult> {
		if (!apiKey) {
			return { ok: false, problem: 'no-key' };
		}
		if (!request || typeof request.state !== 'string' || !request.questions || typeof request.questions !== 'object') {
			return { ok: false, problem: 'invalid' };
		}
		const endpoint = resolveJevEndpoint(request.endpoint);
		if (!endpoint) {
			return { ok: false, problem: 'invalid' };
		}
		try {
			const response = await net.fetch(endpoint, {
				method: 'POST',
				headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
				body: jevRequestBody(request),
				signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
			});
			if (!response.ok) {
				return { ok: false, problem: jevProblemForStatus(response.status) };
			}
			return parseJevResponse(await response.json());
		} catch {
			return { ok: false, problem: 'unavailable' };
		}
	}

	/** The ADE's workspace and external ports: this app's own, then everything else worth naming. */
	private async _scanPorts(): Promise<IKinguPortScan> {
		try {
			const [entries, tree] = await Promise.all([this._listSockets(), this._processTree()]);
			// The app's own processes serve its own plumbing (the engine, the debug
			// port); the ADE never counts itself as a workspace, so neither does this.
			const app = this._appPids();
			const owned = new Set([...tree.keys()].filter(pid => !app.has(pid)));
			const scan = classifyListeningPorts(entries, owned);
			return { workspace: nameListeningPorts(scan.workspace, tree), external: nameListeningPorts(scan.external, tree) };
		} catch {
			return { workspace: [], external: [] };
		}
	}

	/** This app's own processes: the main process and every one Electron runs for it. */
	private _appPids(): Set<number> {
		return new Set<number>([process.pid, ...app.getAppMetrics().map(metric => metric.pid)]);
	}

	/**
	 * Stops the process holding a workspace port, as the ADE's
	 * `workspacePorts:kill` does: a fresh scan authorizes it, only that pid is
	 * signalled (not its tree), and a process already gone counts as stopped.
	 */
	private async _stopPortProcess(request: IKinguStopPortRequest | undefined): Promise<KinguStopPortResult> {
		if (!request) {
			return { ok: false, reason: 'Invalid process or port.' };
		}
		const scan = await this._scanPorts();
		const allowed = checkStopPortRequest(request, scan, this._appPids());
		if (!allowed.ok) {
			return allowed;
		}
		try {
			process.kill(request.pid, 'SIGTERM');
			return { ok: true };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
				return { ok: true };
			}
			return { ok: false, reason: error instanceof Error && error.message ? error.message : 'Failed to stop the process.' };
		}
	}

	/**
	 * CPU and memory for each of these processes and everything below it.
	 *
	 * The window's terminals are this app's descendants, so one walk of the app's
	 * own tree answers for all of them. A pid that is not in it - gone, or not
	 * the app's - gets no answer rather than a zero.
	 */
	private async _measureProcesses(pids: readonly number[]): Promise<readonly IKinguProcessUsage[]> {
		if (pids.length === 0) {
			return [];
		}
		let sweep: IKinguProcessSweep;
		try {
			sweep = await this._processTable();
		} catch {
			return [];
		}
		const memory = new Map(sweep.rows.map(row => [row.pid, row.memory]));
		const ours = processSubtree(sweep.rows, process.pid);
		const usage: IKinguProcessUsage[] = [];
		for (const pid of pids.slice(0, 256)) {
			if (!ours.has(pid)) {
				continue;
			}
			let cpu = 0;
			let bytes = 0;
			for (const member of processSubtree(sweep.rows, pid)) {
				cpu += sweep.cpu.get(member) ?? 0;
				bytes += memory.get(member) ?? 0;
			}
			usage.push({ pid, cpu, memory: bytes });
		}
		return usage;
	}

	/**
	 * Which of these commands are installed, and where.
	 *
	 * Answered here because it is a question about the machine: it needs the
	 * login shell's PATH, which a sandboxed window does not have and could not
	 * obtain, and it needs to stat directories the window cannot reach.
	 *
	 * Resolution is a directory listing, not an execution. Running each
	 * candidate with `--version` would be a surer answer and would also mean
	 * this app spawning a dozen third-party binaries every time somebody opened
	 * a list — so presence on disk is what is reported, and it is reported as
	 * presence rather than as "working".
	 */
	private async _findExecutables(commands: readonly string[]): Promise<Record<string, string>> {
		const wanted = [...new Set(commands)].slice(0, MAX_COMMANDS_PER_REQUEST);
		if (wanted.length === 0) {
			return {};
		}
		this._executables ??= this._scanExecutables();
		const found = await this._executables;
		const answer: Record<string, string> = {};
		for (const command of wanted) {
			const resolved = found.get(command);
			if (resolved) {
				answer[command] = resolved;
			}
		}
		return answer;
	}

	private async _scanExecutables(): Promise<ReadonlyMap<string, string>> {
		const resolved = new Map<string, string>();
		let environment: IProcessEnvironment = process.env;
		try {
			// The login shell's PATH when it can be had; this process's otherwise.
			environment = { ...process.env, ...await this._resolveShellEnv?.() };
		} catch {
			// A shell that could not be probed is not a reason to report nothing.
		}
		const directories = executableSearchDirectories({
			platform: platform(),
			// Both spellings: Windows environment names are case-insensitive and a
			// resolved shell environment can carry either.
			pathEnv: environment.PATH ?? environment.Path,
			home: homedir(),
		}).slice(0, MAX_SEARCH_DIRECTORIES);

		// One listing per directory rather than a stat per candidate: a PATH of
		// forty directories against twenty agents is eight hundred stats, and the
		// same answer comes from forty reads.
		for (const directory of directories) {
			let entries: string[];
			try {
				entries = await fs.readdir(directory);
			} catch {
				continue;
			}
			const present = new Set(platform() === 'win32' ? entries.map(entry => entry.toLowerCase()) : entries);
			for (const command of KNOWN_AGENT_COMMANDS) {
				if (resolved.has(command)) {
					continue;
				}
				for (const name of executableNames(platform(), command)) {
					if (present.has(platform() === 'win32' ? name.toLowerCase() : name)) {
						resolved.set(command, join(directory, name));
						break;
					}
				}
			}
		}
		return resolved;
	}

	/**
	 * What is on the desktop right now.
	 *
	 * Reading is always allowed. Acting is refused unless the user has turned it
	 * on, which is checked here — in the process that owns the runtime — rather
	 * than in the window that asked, because a window is the thing an agent can
	 * reach and a permission it could talk its way past is not one.
	 */
	private async _readDesktop(request: IKinguComputerRequest | undefined): Promise<KinguComputerResult> {
		if (!request?.tool) {
			return { ok: false, error: 'No desktop request was given.' };
		}
		this._computer ??= new KinguComputerSidecar(this._logService);
		// Read now rather than cached: a permission the user has just withdrawn
		// should stop the next action, not the next restart.
		return this._computer.request(request, this._allowDesktopInput?.() ?? false);
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
		const { rows } = await this._processTable();
		const names = new Map(rows.map(row => [row.pid, row.name]));
		const tree = new Map<number, string>();
		for (const pid of processSubtree(rows, process.pid)) {
			tree.set(pid, names.get(pid) ?? 'unknown');
		}
		return tree;
	}

	/**
	 * One host-wide process sweep, shared by everything that asks within a second.
	 *
	 * On Windows it is the ADE's own sweep — PowerShell's `Win32_Process`, CPU as
	 * the difference between two sweeps — because the native process-tree module
	 * cannot find this process's own root there, so a walk from it comes back
	 * empty. Elsewhere `ps`, through the workbench's `listProcesses`.
	 */
	private async _processTable(): Promise<IKinguProcessSweep> {
		if (this._lastSweep && Date.now() - this._lastSweep.at < PROCESS_SWEEP_REUSE_MS) {
			return this._lastSweep;
		}
		this._sweep ??= this._takeSweep().then(sweep => {
			this._lastSweep = sweep;
			return sweep;
		}).finally(() => { this._sweep = undefined; });
		return this._sweep;
	}

	private async _takeSweep(): Promise<IKinguProcessSweep> {
		const at = Date.now();
		if (platform() === 'win32') {
			const rows = parseWindowsProcessTable(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_TABLE_SCRIPT], PROCESS_SWEEP_TIMEOUT_MS));
			const cpu = cpuBetweenSweeps(this._previousCpuTimes?.times, rows, this._previousCpuTimes ? at - this._previousCpuTimes.at : 0);
			this._previousCpuTimes = { at, times: new Map(rows.map(row => [row.pid, row.cpuTime ?? 0])) };
			return { at, rows, cpu };
		}
		const rows: IKinguProcessRow[] = [];
		const collect = (item: ProcessItem): void => {
			rows.push({ pid: item.pid, ppid: item.ppid, name: processName(item), memory: item.mem || 0, cpu: item.load || 0 });
			for (const child of item.children ?? []) {
				collect(child);
			}
		};
		collect(await listProcesses(process.pid));
		return { at, rows, cpu: new Map(rows.map(row => [row.pid, row.cpu ?? 0])) };
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
/** A Jev decision takes well under a second; one that takes this long is abandoned. */
const JEV_TIMEOUT_MS = 10_000;
/** A PowerShell sweep can take a few seconds on a busy machine; the ADE allows the same. */
const PROCESS_SWEEP_TIMEOUT_MS = 15_000;
/** Readings asked for within this of each other share one sweep. */
const PROCESS_SWEEP_REUSE_MS = 1_000;

/** One sweep: every process, and each one's CPU. */
interface IKinguProcessSweep {
	readonly at: number;
	readonly rows: readonly IKinguProcessRow[];
	readonly cpu: ReadonlyMap<number, number>;
}

/** A listing tool's stdout, with a fixed argument list and no shell. */
function run(command: string, args: readonly string[], timeout = PORT_LISTING_TIMEOUT_MS): Promise<string> {
	return new Promise((resolve, reject) => {
		// `execFile` rather than `exec`: there is nothing here to interpolate, and a
		// shell would be a way for one to appear later.
		execFile(command, [...args], { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
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
