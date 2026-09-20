/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import { platform } from 'os';
import { Disposable } from '../../../base/common/lifecycle.js';
import { FileAccess } from '../../../base/common/network.js';
import { ILogService } from '../../log/common/log.js';
import {
	decodeComputerReply,
	encodeComputerRequest,
	IKinguComputerRequest,
	isReadOnlyComputerTool,
	KinguComputerLineReader,
	KinguComputerResult,
} from '../common/kinguComputerProtocol.js';

/** A read of the desktop is a UI Automation walk; a slow one is worth abandoning. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * How long the runtime is kept alive with nothing to do.
 *
 * Starting it costs a PowerShell launch and a UI Automation handshake, which is
 * seconds — so a second question soon after the first should not pay it again.
 * Past this the process goes, because a helper that can read every window on
 * the desktop should not sit resident for a capability nobody is using.
 */
const IDLE_SHUTDOWN_MS = 120_000;

/**
 * Reads the desktop, through the ADE's own Windows runtime.
 *
 * The runtime is that project's `runtime.ps1`, brought across whole rather than
 * reimplemented: it is thirteen hundred lines of UI Automation with the corners
 * already found, and a hand-trimmed copy would be a second thing to maintain
 * and a new place for bugs.
 *
 * It can also click, type and paste. This host cannot reach any of that —
 * {@link isReadOnlyComputerTool} is checked before anything is written to the
 * process — because reading the desktop and acting on it are different
 * decisions, and only the first has been made.
 *
 * Windows only so far. The ADE has a Swift package for macOS and a Python
 * script for Linux; neither is here, and a host that claimed to support them
 * would be claiming something nobody has run.
 */
export class KinguComputerSidecar extends Disposable {

	private _process: ChildProcess | undefined;
	private readonly _reader = new KinguComputerLineReader();
	private readonly _pending = new Map<number, { resolve: (result: KinguComputerResult) => void; timer: ReturnType<typeof setTimeout> }>();
	private _nextRequestId = 1;
	private _idleTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(@ILogService private readonly _logService: ILogService) {
		super();
		this._register({ dispose: () => this._stop('the window is closing') });
	}

	/** Whether this machine has a runtime at all. */
	static get supported(): boolean {
		return platform() === 'win32';
	}

	async request(request: IKinguComputerRequest): Promise<KinguComputerResult> {
		if (!KinguComputerSidecar.supported) {
			return { ok: false, error: 'Reading the desktop is only supported on Windows so far.' };
		}
		if (!isReadOnlyComputerTool(request.tool)) {
			// Not reachable through the public shape, and checked anyway: this is the
			// boundary between reading the desktop and acting on it.
			return { ok: false, error: `Refusing ${request.tool}: this host only reads the desktop.` };
		}
		const child = this._ensureStarted();
		if (!child?.stdin) {
			return { ok: false, error: 'The desktop runtime could not be started.' };
		}
		const requestId = this._nextRequestId++;
		const result = new Promise<KinguComputerResult>(resolve => {
			const timer = setTimeout(() => {
				this._pending.delete(requestId);
				// The stream is now ambiguous — a late reply would be matched against
				// a later request — so the process goes rather than being reused.
				this._stop('a request timed out');
				resolve({ ok: false, error: 'The desktop runtime did not answer in time.' });
			}, REQUEST_TIMEOUT_MS);
			this._pending.set(requestId, { resolve, timer });
		});
		child.stdin.write(encodeComputerRequest(requestId, request) + '\n');
		this._armIdleShutdown();
		return result;
	}

	private _ensureStarted(): ChildProcess | undefined {
		if (this._process) {
			return this._process;
		}
		const script = FileAccess.asFileUri('vs/platform/kinguComputer/node/kinguComputerWindows.ps1').fsPath;
		try {
			// `-NoProfile` because a user's profile can print banners onto the stdout
			// this protocol reads, and `-NonInteractive` so a prompt fails instead of
			// hanging a process nobody is watching.
			this._process = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Serve'], {
				windowsHide: true,
				stdio: ['pipe', 'pipe', 'pipe'],
			});
		} catch (error) {
			this._logService.warn('[Kingu] could not start the desktop runtime', error);
			return undefined;
		}
		this._process.stdout?.setEncoding('utf8');
		this._process.stdout?.on('data', (chunk: string) => this._readStdout(chunk));
		// Its diagnostics, not its answers. Logged so a runtime that is failing says
		// why, rather than only ever timing out.
		this._process.stderr?.setEncoding('utf8');
		this._process.stderr?.on('data', (chunk: string) => this._logService.trace(`[Kingu] desktop runtime: ${String(chunk).trim()}`));
		this._process.on('exit', code => this._onExit(code));
		this._process.on('error', error => {
			this._logService.warn('[Kingu] the desktop runtime failed', error);
			this._stop('the runtime failed');
		});
		return this._process;
	}

	private _readStdout(chunk: string): void {
		for (const line of this._reader.read(chunk)) {
			const reply = decodeComputerReply(line);
			if (!reply) {
				continue;
			}
			const pending = this._pending.get(reply.requestId);
			if (!pending) {
				// A reply to a request that already timed out.
				continue;
			}
			this._pending.delete(reply.requestId);
			clearTimeout(pending.timer);
			pending.resolve(reply.result);
		}
	}

	private _onExit(code: number | null): void {
		this._process = undefined;
		this._settleAll(`The desktop runtime exited (${code ?? 'signal'}).`);
	}

	private _stop(why: string): void {
		this._clearIdleShutdown();
		const child = this._process;
		this._process = undefined;
		child?.kill();
		this._settleAll(`The desktop runtime was stopped: ${why}.`);
	}

	/** Nothing waits forever on a process that has gone. */
	private _settleAll(error: string): void {
		for (const [, pending] of this._pending) {
			clearTimeout(pending.timer);
			pending.resolve({ ok: false, error });
		}
		this._pending.clear();
	}

	private _armIdleShutdown(): void {
		this._clearIdleShutdown();
		this._idleTimer = setTimeout(() => {
			if (this._pending.size === 0) {
				this._stop('it was idle');
			}
		}, IDLE_SHUTDOWN_MS);
	}

	private _clearIdleShutdown(): void {
		if (this._idleTimer) {
			clearTimeout(this._idleTimer);
			this._idleTimer = undefined;
		}
	}
}
