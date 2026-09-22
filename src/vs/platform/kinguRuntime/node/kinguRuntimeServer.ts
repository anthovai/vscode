/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import { createReadStream, promises as fs } from 'fs';
// A type import, and `http` loaded on demand below: it is one of the modules
// the fork keeps off the startup path because requiring it is slow, and nothing
// here runs until someone opens the workbench.
import type { Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { getMediaOrTextMime } from '../../../base/common/mime.js';
import { join, normalize, sep } from '../../../base/common/path.js';
import { ILogService } from '../../log/common/log.js';
import { IKinguRuntimeEndpoint, IKinguRuntimePaths, KinguRuntimeStatus } from '../common/kinguRuntime.js';

/**
 * How long to wait for the runtime to announce itself.
 *
 * Its first boot builds a terminal daemon and runs a self-test against it, and
 * on a cold machine that is not instant. The runtime's own smoke test allows
 * two minutes for the same payload, so this matches rather than inventing a
 * tighter bound that would fail on the slowest real case.
 */
const READY_TIMEOUT_MS = 120_000;

/** Long enough for the runtime to close its sockets, short enough not to hang a quit. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/** The ready payload, as much of it as this window reads. */
interface IKinguServerReady {
	readonly type: string;
	readonly runtimeId?: string;
	readonly advertisedEndpoint?: string;
	readonly endpoint?: string;
	readonly pairing?: {
		readonly available?: boolean;
		readonly url?: string;
		readonly scope?: string;
		readonly reason?: string;
		readonly guidance?: string;
	};
}

/**
 * Pulls the bare pairing code out of the URL the runtime prints.
 *
 * The runtime emits `kingu://pair?code=<base64url>`, and the web client's own
 * parser only strips an `orca://` prefix — a leftover from the rebrand — so
 * handing it the whole URL fails to decode. It accepts the bare code, which is
 * also what its `?code=` startup path expects, so the code is what gets passed.
 */
export function pairingCodeFromUrl(url: string): string | undefined {
	const query = url.indexOf('?');
	if (query === -1) {
		return undefined;
	}
	const code = new URLSearchParams(url.slice(query + 1)).get('code')?.trim();
	return code ? code : undefined;
}

/** Reads the runtime's announcement out of a line of its stdout, if that is what the line is. */
export function readReadyPayload(line: string): IKinguServerReady | undefined {
	const trimmed = line.trim();
	// The runtime also prints a plain-text notice about its bind address, so a
	// line that is not JSON is ordinary rather than a problem.
	if (!trimmed.startsWith('{')) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(trimmed) as IKinguServerReady;
		return parsed.type === 'kingu_server_ready' ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Runs the Kingu runtime and serves its web client in front of it.
 *
 * Two processes rather than one: the runtime is `kingud`, the Electron-free
 * build of the ADE's backend, run as a child of this window. Its own
 * `MERGE.md` rules out the alternative — the ADE's Electron entry point owns an
 * application lifecycle (a `BrowserWindow`, a daemon, a tray) that this window
 * already owns, so it cannot simply be required in.
 *
 * What makes this a seam rather than a workaround: the web client reaches the
 * runtime over a public pairing + RPC surface, not through Electron IPC. The
 * same surface is what a future in-process backend would implement, and what
 * the SvelteKit client will talk to — so nothing above this line has to know
 * which side of a process boundary the runtime is on.
 */
export class KinguRuntimeServer extends Disposable {

	private _runtime: ChildProcess | undefined;
	private _web: Server | undefined;
	private _starting: Promise<IKinguRuntimeEndpoint> | undefined;
	private _endpoint: IKinguRuntimeEndpoint | undefined;
	private _failure: string | undefined;

	constructor(
		private readonly _resolvePaths: () => Promise<IKinguRuntimePaths>,
		private readonly _logService: ILogService,
	) {
		super();
		this._register(toDisposable(() => void this.stop()));
	}

	status(): KinguRuntimeStatus {
		if (this._endpoint) {
			return { kind: 'running', endpoint: this._endpoint };
		}
		if (this._starting) {
			return { kind: 'starting' };
		}
		return this._failure ? { kind: 'failed', message: this._failure } : { kind: 'stopped' };
	}

	start(): Promise<IKinguRuntimeEndpoint> {
		if (this._endpoint) {
			return Promise.resolve(this._endpoint);
		}
		// Shared rather than per-caller: two surfaces opening at once must not
		// race two runtimes onto two ports, each with half the window's state.
		if (!this._starting) {
			this._failure = undefined;
			this._starting = this._start().then(endpoint => {
				this._endpoint = endpoint;
				this._starting = undefined;
				return endpoint;
			}, error => {
				this._starting = undefined;
				this._failure = error instanceof Error ? error.message : String(error);
				void this.stop();
				throw error;
			});
		}
		return this._starting;
	}

	private async _start(): Promise<IKinguRuntimeEndpoint> {
		const paths = await this._resolvePaths();
		await this._assertReadable(paths.runtimeEntry, 'runtime');
		await this._assertReadable(join(paths.webRoot, 'web-index.html'), 'web client');

		const webOrigin = await this._serveWebClient(paths.webRoot);
		const ready = await this._spawnRuntime(paths.runtimeEntry);

		const pairing = ready.pairing;
		if (!pairing?.available || !pairing.url) {
			throw new Error(pairing?.guidance
				?? `The Kingu runtime started without a pairing offer${pairing?.reason ? ` (${pairing.reason})` : ''}.`);
		}
		const code = pairingCodeFromUrl(pairing.url);
		if (!code) {
			throw new Error('The Kingu runtime offered a pairing URL this window could not read.');
		}

		return {
			endpoint: ready.advertisedEndpoint ?? ready.endpoint ?? '',
			runtimeId: ready.runtimeId ?? '',
			webUrl: `${webOrigin}/web-index.html?code=${encodeURIComponent(code)}`,
		};
	}

	private async _assertReadable(path: string, what: string): Promise<void> {
		try {
			await fs.access(path);
		} catch {
			// Named rather than generic: the overwhelmingly likely cause is that
			// the sibling checkout has not been built yet, and a path in the
			// message is what lets someone see that at a glance.
			throw new Error(`Could not find the Kingu ${what} at ${path}. Build it with \`pnpm run build:kingud\` and \`pnpm run build:web\`, or set the path in settings.`);
		}
	}

	/**
	 * Serves the built web client on loopback.
	 *
	 * The runtime does not serve it — its ready payload reports `webClientUrl`
	 * as null — and the client cannot be loaded from `file:`, because it is an
	 * ES-module bundle that fetches its own chunks. So this window serves it,
	 * bound to 127.0.0.1 on a port the OS picks.
	 */
	private async _serveWebClient(webRoot: string): Promise<string> {
		const root = normalize(webRoot);
		const { createServer } = await import('http');
		const server = createServer((request, response) => {
			void this._serveFile(root, request.url ?? '/', response);
		});
		this._web = server;
		return new Promise<string>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => {
				const address = server.address() as AddressInfo;
				resolve(`http://127.0.0.1:${address.port}`);
			});
		});
	}

	private async _serveFile(root: string, requestUrl: string, response: ServerResponse): Promise<void> {
		const requested = decodeURIComponent(requestUrl.split('?')[0].split('#')[0]);
		const relative = requested === '/' ? 'web-index.html' : requested.replace(/^\/+/, '');
		const file = normalize(join(root, relative));
		// Containment check before anything touches disk: this server is on
		// loopback, but "only local" is not a reason to serve `../../`.
		if (file !== root && !file.startsWith(root.endsWith(sep) ? root : root + sep)) {
			response.writeHead(403);
			response.end();
			return;
		}
		try {
			const stat = await fs.stat(file);
			if (stat.isDirectory()) {
				response.writeHead(404);
				response.end();
				return;
			}
			response.writeHead(200, {
				'Content-Type': getMediaOrTextMime(file) ?? 'application/octet-stream',
				'Content-Length': stat.size,
			});
			createReadStream(file).pipe(response);
		} catch {
			response.writeHead(404);
			response.end();
		}
	}

	private _spawnRuntime(entry: string): Promise<IKinguServerReady> {
		// `--json` is what makes the announcement machine-readable; without it the
		// runtime prints for a human and there is nothing to wait on.
		const runtime = spawn(process.execPath, [entry, '--port', '0', '--json'], {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
		});
		this._runtime = runtime;

		return new Promise<IKinguServerReady>((resolve, reject) => {
			let settled = false;
			let buffer = '';
			const finish = (error: Error | undefined, ready?: IKinguServerReady) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				if (error) {
					reject(error);
				} else {
					resolve(ready!);
				}
			};

			const timer = setTimeout(
				() => finish(new Error(`The Kingu runtime did not announce itself within ${READY_TIMEOUT_MS / 1000}s.`)),
				READY_TIMEOUT_MS);

			runtime.stdout?.setEncoding('utf8');
			runtime.stdout?.on('data', (chunk: string) => {
				buffer += chunk;
				let newline = buffer.indexOf('\n');
				while (newline !== -1) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					const ready = readReadyPayload(line);
					if (ready) {
						finish(undefined, ready);
					} else if (line.trim()) {
						this._logService.trace(`[Kingu runtime] ${line.trim()}`);
					}
					newline = buffer.indexOf('\n');
				}
			});
			runtime.stderr?.setEncoding('utf8');
			runtime.stderr?.on('data', (chunk: string) => this._logService.warn(`[Kingu runtime] ${chunk.trim()}`));

			runtime.on('error', error => finish(error));
			runtime.on('exit', code => finish(new Error(`The Kingu runtime exited with ${code} before it was ready.`)));
		});
	}

	async stop(): Promise<void> {
		this._endpoint = undefined;
		const web = this._web;
		this._web = undefined;
		if (web) {
			await new Promise<void>(resolve => web.close(() => resolve()));
		}
		const runtime = this._runtime;
		this._runtime = undefined;
		if (!runtime || runtime.exitCode !== null) {
			return;
		}
		await new Promise<void>(resolve => {
			// SIGTERM first so the runtime can close its own daemon; killed only
			// if it does not, because a daemon orphaned by SIGKILL outlives the
			// window and holds the next run's port.
			const timer = setTimeout(() => {
				runtime.kill('SIGKILL');
				resolve();
			}, SHUTDOWN_TIMEOUT_MS);
			runtime.once('exit', () => {
				clearTimeout(timer);
				resolve();
			});
			runtime.kill();
		});
	}
}
