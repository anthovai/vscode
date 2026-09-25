/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { promises as fs } from 'fs';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { delimiter, join } from '../../../../base/common/path.js';

/*
 * A client for the Agent Client Protocol (ACP): newline-delimited JSON-RPC 2.0
 * over an agent CLI's stdio, as `gemini --acp` speaks it. Only the part of the
 * protocol the Gemini agent uses is typed here.
 */

export interface IAcpAuthMethod {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
}

export interface IAcpInitializeResult {
	readonly protocolVersion: number;
	readonly authMethods?: readonly IAcpAuthMethod[];
	readonly agentInfo?: { readonly name?: string; readonly title?: string; readonly version?: string };
	readonly agentCapabilities?: { readonly loadSession?: boolean };
}

export interface IAcpModel {
	readonly modelId: string;
	readonly name: string;
	readonly description?: string;
}

export interface IAcpMode {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
}

export interface IAcpConfigOptionValue {
	readonly value: string;
	readonly name: string;
	readonly description?: string;
}

/** A session setting the agent offers (`configOptions`), which is how some agents offer their models. */
export interface IAcpConfigOption {
	readonly id: string;
	readonly name: string;
	readonly category?: string;
	readonly type: string;
	readonly currentValue?: string;
	/** Values, flat or in named groups. */
	readonly options?: readonly (IAcpConfigOptionValue | { readonly group: string; readonly name?: string; readonly options: readonly IAcpConfigOptionValue[] })[];
}

export interface IAcpNewSessionResult {
	readonly sessionId: string;
	readonly models?: { readonly availableModels: readonly IAcpModel[]; readonly currentModelId?: string };
	readonly modes?: { readonly availableModes: readonly IAcpMode[]; readonly currentModeId?: string };
	readonly configOptions?: readonly IAcpConfigOption[];
}

export type AcpContentBlock =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'image'; readonly data: string; readonly mimeType: string }
	| { readonly type: 'resource_link'; readonly uri: string; readonly name: string };

export type AcpToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
export type AcpToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface IAcpToolCallContent {
	readonly type: 'content' | 'diff' | 'terminal';
	readonly content?: AcpContentBlock;
	readonly path?: string;
	readonly oldText?: string | null;
	readonly newText?: string;
}

export interface IAcpToolCall {
	readonly toolCallId: string;
	readonly title?: string;
	readonly kind?: AcpToolKind;
	readonly status?: AcpToolStatus;
	readonly content?: readonly IAcpToolCallContent[];
	readonly locations?: readonly { readonly path: string; readonly line?: number }[];
	readonly rawInput?: unknown;
}

export type AcpSessionUpdate =
	| { readonly sessionUpdate: 'agent_message_chunk'; readonly content: AcpContentBlock }
	| { readonly sessionUpdate: 'agent_thought_chunk'; readonly content: AcpContentBlock }
	| { readonly sessionUpdate: 'user_message_chunk'; readonly content: AcpContentBlock }
	| ({ readonly sessionUpdate: 'tool_call' } & IAcpToolCall)
	| ({ readonly sessionUpdate: 'tool_call_update' } & IAcpToolCall)
	| { readonly sessionUpdate: 'plan'; readonly entries: readonly { readonly content: string; readonly status: string; readonly priority?: string }[] }
	| { readonly sessionUpdate: 'current_mode_update'; readonly currentModeId: string }
	| { readonly sessionUpdate: string };

export interface IAcpPermissionOption {
	readonly optionId: string;
	readonly name: string;
	readonly kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export interface IAcpPermissionRequest {
	readonly sessionId: string;
	readonly toolCall: IAcpToolCall;
	readonly options: readonly IAcpPermissionOption[];
}

export type AcpStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

/** What the agent may ask of the client; answered by the owner of the connection. */
export interface IAcpClientHandlers {
	requestPermission(request: IAcpPermissionRequest): Promise<{ outcome: 'cancelled' } | { outcome: 'selected'; optionId: string }>;
	readTextFile(params: { sessionId: string; path: string; line?: number; limit?: number }): Promise<string>;
	writeTextFile(params: { sessionId: string; path: string; content: string }): Promise<void>;
}

export class AcpError extends Error {
	constructor(message: string, readonly code: number | undefined, readonly data: unknown) {
		super(message);
	}
}

/** ACP's JSON-RPC error code for "authentication required". */
export const ACP_AUTH_REQUIRED = -32000;

interface IPending {
	resolve(value: unknown): void;
	reject(error: Error): void;
}

export interface IAcpSpawnCommand {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: NodeJS.ProcessEnv;
}

/**
 * One ACP connection to one agent process. Requests resolve with their result
 * or reject with an {@link AcpError}; `session/update` notifications are
 * published on {@link onDidUpdateSession}; the agent's own requests go to the
 * handlers. The process exit is published and rejects anything in flight.
 */
export class AcpClient extends Disposable {

	private readonly _onDidUpdateSession = this._register(new Emitter<{ sessionId: string; update: AcpSessionUpdate }>());
	readonly onDidUpdateSession: Event<{ sessionId: string; update: AcpSessionUpdate }> = this._onDidUpdateSession.event;

	/** What the agent writes to stderr, as it arrives: CLIs report retries and quota errors there. */
	private readonly _onDidWriteStderr = this._register(new Emitter<string>());
	readonly onDidWriteStderr: Event<string> = this._onDidWriteStderr.event;

	private readonly _onDidExit = this._register(new Emitter<{ code: number | null; stderr: string }>());
	readonly onDidExit: Event<{ code: number | null; stderr: string }> = this._onDidExit.event;

	private readonly _child: ChildProcessWithoutNullStreams;
	private readonly _pending = new Map<number, IPending>();
	private _nextId = 0;
	private _buffer = '';
	private _stderr = '';
	private _exited = false;

	constructor(spawnCommand: IAcpSpawnCommand, cwd: string, private readonly _handlers: IAcpClientHandlers, private readonly _log: (message: string) => void) {
		super();
		this._child = spawn(spawnCommand.command, [...spawnCommand.args], { cwd, env: spawnCommand.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
		this._child.stdout.setEncoding('utf8');
		this._child.stdout.on('data', (chunk: string) => this._onData(chunk));
		this._child.stderr.setEncoding('utf8');
		this._child.stderr.on('data', (chunk: string) => {
			this._stderr = `${this._stderr}${chunk}`.slice(-8000);
			this._onDidWriteStderr.fire(chunk);
		});
		this._child.on('error', error => this._onExit(null, error.message));
		this._child.on('close', code => this._onExit(code, undefined));
		this._register({ dispose: () => { void this.kill(); } });
	}

	get exited(): boolean {
		return this._exited;
	}

	/**
	 * Closes stdin and lets the CLI exit on its own, then kills it if it is
	 * still running: the CLI saves the session as it exits, and `session/load`
	 * finds nothing for a session whose process was killed outright.
	 */
	kill(): Promise<void> {
		if (this._exited) {
			return Promise.resolve();
		}
		return new Promise<void>(resolve => {
			const timer = setTimeout(() => {
				if (!this._exited) {
					this._child.kill();
				}
			}, 3000);
			this._child.once('close', () => {
				clearTimeout(timer);
				resolve();
			});
			this._child.stdin.end();
		});
	}

	request<T>(method: string, params: unknown): Promise<T> {
		if (this._exited) {
			return Promise.reject(new AcpError(`The agent has exited. ${this._stderr.trim()}`.trim(), undefined, undefined));
		}
		const id = ++this._nextId;
		return new Promise<T>((resolve, reject) => {
			this._pending.set(id, { resolve: value => resolve(value as T), reject });
			this._write({ jsonrpc: '2.0', id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		if (!this._exited) {
			this._write({ jsonrpc: '2.0', method, params });
		}
	}

	private _write(message: unknown): void {
		this._child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private _onData(chunk: string): void {
		this._buffer += chunk;
		let newline: number;
		while ((newline = this._buffer.indexOf('\n')) >= 0) {
			const line = this._buffer.slice(0, newline).trim();
			this._buffer = this._buffer.slice(newline + 1);
			if (!line) {
				continue;
			}
			let message: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
			try {
				message = JSON.parse(line);
			} catch {
				this._log(`[Gemini] ignoring a line that is not JSON-RPC: ${line.slice(0, 200)}`);
				continue;
			}
			if (message.method !== undefined && message.id !== undefined) {
				void this._answer(message.id, message.method, message.params);
			} else if (message.method !== undefined) {
				if (message.method === 'session/update') {
					const params = message.params as { sessionId: string; update: AcpSessionUpdate };
					this._onDidUpdateSession.fire(params);
				}
			} else if (typeof message.id === 'number') {
				const pending = this._pending.get(message.id);
				this._pending.delete(message.id);
				if (message.error) {
					pending?.reject(new AcpError(message.error.message ?? 'The agent reported an error.', message.error.code, message.error.data));
				} else {
					pending?.resolve(message.result);
				}
			}
		}
	}

	private async _answer(id: number | string, method: string, params: unknown): Promise<void> {
		try {
			let result: unknown;
			switch (method) {
				case 'session/request_permission':
					result = { outcome: await this._handlers.requestPermission(params as IAcpPermissionRequest) };
					break;
				case 'fs/read_text_file':
					result = { content: await this._handlers.readTextFile(params as { sessionId: string; path: string; line?: number; limit?: number }) };
					break;
				case 'fs/write_text_file':
					await this._handlers.writeTextFile(params as { sessionId: string; path: string; content: string });
					result = null;
					break;
				default:
					this._write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
					return;
			}
			this._write({ jsonrpc: '2.0', id, result });
		} catch (error) {
			this._write({ jsonrpc: '2.0', id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
		}
	}

	private _onExit(code: number | null, error: string | undefined): void {
		if (this._exited) {
			return;
		}
		this._exited = true;
		const detail = (error ?? this._stderr).trim();
		for (const pending of this._pending.values()) {
			pending.reject(new AcpError(`The agent exited${code !== null ? ` (code ${code})` : ''}. ${detail}`.trim(), undefined, undefined));
		}
		this._pending.clear();
		this._onDidExit.fire({ code, stderr: this._stderr });
	}
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await fs.stat(path)).isFile();
	} catch {
		return false;
	}
}

/** The environment an agent CLI runs in: the host's own, less what would make it act as Electron or VS Code. */
function agentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const childEnv: NodeJS.ProcessEnv = { ...env };
	for (const key of Object.keys(childEnv)) {
		if (key.startsWith('VSCODE_') || key.startsWith('ELECTRON_') || key === 'NODE_OPTIONS') {
			delete childEnv[key];
		}
	}
	return childEnv;
}

function pathDirs(env: NodeJS.ProcessEnv): string[] {
	const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
	return pathValue.split(delimiter).filter(Boolean);
}

/**
 * How to start an agent CLI found on PATH with `args`, or `undefined` when it
 * is not installed. On Windows an npm install is a `.cmd` shim; its script is
 * run with Node directly (no `cmd.exe` in between, which would mangle
 * arguments and outlive a kill), and a shim that wraps an executable runs that
 * executable. Elsewhere the executable runs as is.
 */
export async function resolveAcpCommand(executable: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<IAcpSpawnCommand | undefined> {
	const dirs = pathDirs(env);
	const childEnv = agentEnv(env);
	if (process.platform !== 'win32') {
		for (const dir of dirs) {
			const candidate = join(dir, executable);
			if (await isFile(candidate)) {
				return { command: candidate, args: [...args], env: childEnv };
			}
		}
		return undefined;
	}
	for (const dir of dirs) {
		const exe = join(dir, `${executable}.exe`);
		if (await isFile(exe)) {
			return { command: exe, args: [...args], env: childEnv };
		}
		const shim = join(dir, `${executable}.cmd`);
		if (!await isFile(shim)) {
			continue;
		}
		let text: string;
		try {
			text = await fs.readFile(shim, 'utf8');
		} catch {
			continue;
		}
		// The shim's target, not the `node.exe` it looks for beside itself first.
		const target = [...text.matchAll(/"%~?dp0%?\\(?<target>[^"%]+\.(?<kind>m?js|cjs|exe))"/gi)]
			.map(match => match.groups)
			.find(groups => groups && !/(^|\\)node\.exe$/i.test(groups.target));
		if (!target) {
			continue;
		}
		const script = join(dir, target.target);
		if (!await isFile(script)) {
			continue;
		}
		if (target.kind.toLowerCase() === 'exe') {
			return { command: script, args: [...args], env: childEnv };
		}
		const node = await findNode(dirs);
		return node
			? { command: node, args: [script, ...args], env: childEnv }
			: { command: process.execPath, args: [script, ...args], env: { ...childEnv, ELECTRON_RUN_AS_NODE: '1' } };
	}
	return undefined;
}

/** How to start `gemini --acp`, or `undefined` when no Gemini CLI is installed. */
export function resolveGeminiCommand(env: NodeJS.ProcessEnv = process.env): Promise<IAcpSpawnCommand | undefined> {
	return resolveAcpCommand('gemini', ['--acp'], env);
}

async function findNode(dirs: readonly string[]): Promise<string | undefined> {
	for (const dir of dirs) {
		const candidate = join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
		if (await isFile(candidate)) {
			return candidate;
		}
	}
	return undefined;
}
