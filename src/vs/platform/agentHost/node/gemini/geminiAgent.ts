/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { homedir, tmpdir } from 'os';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../base/common/observable.js';
import { dirname, join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { ILogService } from '../../../log/common/log.js';
import {
	AgentChatOperationContext,
	AgentSession,
	GITHUB_COPILOT_PROTECTED_RESOURCE,
	resolveAgentChatContext,
	type AgentChatMigrationResult,
	type AgentProvider,
	type AgentSignal,
	type IActiveClient,
	type IAgent,
	type IAgentChatConfigCompletionsParams,
	type IAgentChatContext,
	type IAgentChatMetadata,
	type IAgentChats,
	type IAgentCreateChatOptions,
	type IAgentCreateChatResult,
	type IAgentDescriptor,
	type IAgentDiscoveredChat,
	type IAgentModelInfo,
	type IAgentResolveChatConfigParams,
} from '../../common/agent.js';
import { PendingRequestRegistry } from '../../common/pendingRequestRegistry.js';
import type { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/commands.js';
import type { AgentSelection, MessageAttachment, ModelSelection, ProtectedResourceMetadata, ToolDefinition } from '../../common/state/protocol/state.js';
import { ActionType, type ChatAction } from '../../common/state/sessionActions.js';
import {
	createErrorResponsePart,
	MessageKind,
	ResponsePartKind,
	ToolCallConfirmationReason,
	ToolCallStatus,
	ToolResultContentType,
	TurnState,
	type ClientPluginCustomization,
	type Customization,
	type ResponsePart,
	type ToolCallResult,
	type Turn,
} from '../../common/state/sessionState.js';
import { ensureWorkspacelessScratchDir } from '../workspacelessScratchDir.js';
import { ACP_AUTH_REQUIRED, AcpClient, AcpError, IAcpModel, IAcpNewSessionResult, IAcpPermissionRequest, IAcpToolCall, IAcpToolCallContent, AcpSessionUpdate, resolveGeminiCommand } from './acpClient.js';
import { readGeminiAuthStatus } from './geminiAuth.js';

export const GEMINI_AGENT_PROVIDER_ID: AgentProvider = 'gemini';

interface IToolState {
	started: boolean;
	ready: boolean;
	done: boolean;
	title: string;
	kind: string;
}

interface IActiveTurn {
	readonly turnId: string;
	readonly prompt: string;
	readonly startedAt: number;
	/** The part streaming deltas now go into; reset by a tool call so text stays in order. */
	markdownPartId: string | undefined;
	reasoningPartId: string | undefined;
	partCounter: number;
	/** Final markdown per part, kept for the transcript. */
	readonly markdown: Map<string, string>;
	readonly tools: Map<string, IToolState>;
	cancelled: boolean;
}

interface IGeminiChat {
	readonly chat: URI;
	readonly session: URI;
	workingDirectory: URI | undefined;
	model: ModelSelection | undefined;
	client: AcpClient | undefined;
	acpSessionId: string | undefined;
	/** The CLI's own session id, kept across restarts so `session/load` resumes it. */
	savedAcpSessionId: string | undefined;
	startup: Promise<void> | undefined;
	/** Reads the chat's saved record, once. */
	hydrated: Promise<void> | undefined;
	/** Whether the chat has a saved record. */
	onDisk: boolean;
	/** While `session/load` replays the CLI's history, which is not a new turn. */
	replaying: boolean;
	lastReplayUpdate: number;
	/** The saved transcript, sent ahead of the next prompt when the CLI could not resume its session. */
	historyPreamble: string | undefined;
	readonly turns: Turn[];
	active: IActiveTurn | undefined;
	startTime: number;
	modifiedTime: number;
	summary: string | undefined;
}

/** What a chat keeps on disk, so it opens again after the agent host restarts. */
interface IPersistedGeminiChat {
	readonly acpSessionId?: string;
	readonly workingDirectory?: string;
	readonly model?: ModelSelection;
	readonly startTime: number;
	readonly modifiedTime: number;
	readonly summary?: string;
	readonly turns: readonly Turn[];
}

/** A tool's human title from ACP, falling back to its kind. */
function toolTitle(call: IAcpToolCall, fallback: string): string {
	return call.title?.trim() || fallback;
}

/** The text a tool result carries, for the transcript and the result card. */
function toolText(content: readonly IAcpToolCallContent[] | undefined): string | undefined {
	const texts: string[] = [];
	for (const item of content ?? []) {
		if (item.type === 'content' && item.content?.type === 'text') {
			texts.push(item.content.text);
		} else if (item.type === 'diff' && item.path) {
			texts.push(item.path);
		}
	}
	return texts.length ? texts.join('\n') : undefined;
}

/**
 * The conversation so far as text, for a CLI session that starts without it:
 * the recent turns, each cut to a readable length.
 */
function historyPreamble(turns: readonly Turn[]): string | undefined {
	const recent = turns.slice(-20);
	if (!recent.length) {
		return undefined;
	}
	const clip = (text: string) => text.length > 4000 ? `${text.slice(0, 4000)}...` : text;
	const lines = recent.map(turn => {
		const reply = turn.responseParts.map(part => part.kind === ResponsePartKind.Markdown ? part.content : '').join('').trim();
		return `User: ${clip(turn.message.text)}\nAssistant: ${clip(reply)}`;
	});
	return `Earlier in this conversation (restored after a restart):\n\n${lines.join('\n\n')}\n\nContinue the conversation.`;
}

/**
 * The CLI's `auto` model, renamed on the way out: the chat UI reads a model id
 * of `auto` as its own Auto router and shows a routing step for it.
 */
const AUTO_MODEL_ID = 'gemini-auto';

function fromAcpModelId(modelId: string): string {
	return modelId === 'auto' ? AUTO_MODEL_ID : modelId;
}

function toAcpModelId(modelId: string): string {
	return modelId === AUTO_MODEL_ID ? 'auto' : modelId;
}

/**
 * A name that says which Gemini it is: the CLI names most models by their id
 * (`gemini-3.1-pro-preview`), which reads as `Gemini 3.1 Pro Preview`.
 */
function geminiModelDisplayName(model: IAcpModel): string {
	if (model.modelId === 'auto') {
		return localize('gemini.autoModel', "Gemini Auto");
	}
	if (!/^gemini-[a-z0-9.-]+$/.test(model.name)) {
		return model.name;
	}
	return model.name.split('-').map(word => /^\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/**
 * Token counts Gemini attaches to a finished prompt (`_meta.quota`), read
 * defensively: the field is the CLI's extension, not part of ACP.
 */
function readPromptUsage(result: object): { inputTokens?: number; outputTokens?: number; model?: string } | undefined {
	const meta: unknown = Reflect.get(result, '_meta');
	const quota: unknown = meta && typeof meta === 'object' ? Reflect.get(meta, 'quota') : undefined;
	if (!quota || typeof quota !== 'object') {
		return undefined;
	}
	const count: unknown = Reflect.get(quota, 'token_count');
	const models: unknown = Reflect.get(quota, 'model_usage');
	const number = (value: unknown) => typeof value === 'number' ? value : undefined;
	const model = Array.isArray(models) && models[0] && typeof models[0] === 'object' ? Reflect.get(models[0], 'model') : undefined;
	return count && typeof count === 'object'
		? { inputTokens: number(Reflect.get(count, 'input_tokens')), outputTokens: number(Reflect.get(count, 'output_tokens')), model: typeof model === 'string' ? model : undefined }
		: undefined;
}

function permissionKindOf(kind: string | undefined): 'shell' | 'write' | 'read' | undefined {
	switch (kind) {
		case 'execute': return 'shell';
		case 'edit':
		case 'delete':
		case 'move': return 'write';
		case 'read':
		case 'search': return 'read';
		default: return undefined;
	}
}

/**
 * Kingu: the Gemini agent, running the user's Gemini CLI over the Agent Client
 * Protocol (`gemini --acp`). One CLI process per chat, started on the chat's
 * first message in its working directory. The CLI does its own model calls,
 * tools and file edits on the user's own Gemini login (API key or Google);
 * this agent maps its stream onto the host's chat actions and routes its
 * permission prompts to the user.
 */
export class GeminiAgent extends Disposable implements IAgent {

	readonly id = GEMINI_AGENT_PROVIDER_ID;
	readonly agentHostCapabilities = { workspaceConversion: false } as const;

	private readonly _onDidChatProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidChatProgress = this._onDidChatProgress.event;
	readonly onDidMaterializeChat = Event.None;
	readonly onDidChangeChatData = Event.None;
	readonly onDidSpawnChat = Event.None;
	private readonly _onDidDiscoverChats = this._register(new Emitter<readonly IAgentDiscoveredChat[]>());
	readonly onDidDiscoverChats = this._onDidDiscoverChats.event;

	private readonly _models = observableValue<readonly IAgentModelInfo[]>(this, []);
	readonly models = this._models;

	private readonly _chats = new Map<string, IGeminiChat>();
	private readonly _permissions = new PendingRequestRegistry<boolean>();
	private _refreshing: Promise<void> | undefined;
	private readonly _saves = new Map<string, Promise<void>>();

	constructor(
		@ILogService private readonly _logService: ILogService,
		@INativeEnvironmentService private readonly _environmentService: INativeEnvironmentService,
	) {
		super();
		queueMicrotask(() => { void this.refreshModels(); });
	}

	getDescriptor(): IAgentDescriptor {
		return {
			provider: this.id,
			displayName: localize('gemini.displayName', "Gemini"),
			description: localize('gemini.description', "Gemini agent backed by your Gemini CLI"),
		};
	}

	/**
	 * The models the CLI offers, read from a throwaway ACP session (creating one
	 * needs no login and runs no model call). Empty while no Gemini CLI is
	 * installed, which leaves the harness unusable rather than failing later.
	 */
	refreshModels(): Promise<void> {
		this._refreshing ??= this._readModels().finally(() => { this._refreshing = undefined; });
		return this._refreshing;
	}

	private async _readModels(): Promise<void> {
		const command = await resolveGeminiCommand();
		if (!command) {
			this._logService.info('[Gemini] no Gemini CLI on PATH; the agent offers no models');
			this._models.set([], undefined);
			return;
		}
		const client = new AcpClient(command, tmpdir(), this._inertHandlers(), message => this._logService.info(message));
		try {
			await client.request('initialize', this._initializeParams());
			const session = await client.request<IAcpNewSessionResult>('session/new', { cwd: tmpdir(), mcpServers: [] });
			const models = (session.models?.availableModels ?? []).map(model => ({
				provider: this.id,
				id: fromAcpModelId(model.modelId),
				name: geminiModelDisplayName(model),
				supportsVision: true,
			} satisfies IAgentModelInfo));
			this._logService.info(`[Gemini] Models refreshed. Count: ${models.length}, ${models.map(model => model.name).join(', ')}`);
			this._models.set(models, undefined);
		} catch (error) {
			this._logService.error(error, '[Gemini] could not read the CLI\'s models');
		} finally {
			client.dispose();
		}
	}

	private _initializeParams(): unknown {
		return { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false } };
	}

	private _inertHandlers() {
		return {
			requestPermission: async () => ({ outcome: 'cancelled' as const }),
			readTextFile: async () => { throw new Error('Not available.'); },
			writeTextFile: async () => { throw new Error('Not available.'); },
		};
	}

	// ---- Chats -----------------------------------------------------------------

	readonly chats: IAgentChats = {
		createChat: (chat, context, options) => this._createChat(chat, context, options),
		disposeChat: async chat => this._disposeChat(chat),
		releaseChat: async chat => this._releaseChat(chat),
		canReleaseChat: async chat => !this._chats.get(chat.toString())?.active,
		sendMessage: (chat, prompt, workingDirectories, attachments, turnId, _senderClientId, clientTypeOrContext, context) =>
			this._sendMessage(chat, prompt, workingDirectories, attachments, turnId, context ?? (typeof clientTypeOrContext === 'object' ? clientTypeOrContext : undefined)),
		abort: async chat => this._abort(chat),
		getModel: chat => this._chats.get(chat.toString())?.model,
		changeModel: async (chat, model) => this._changeModel(chat, model),
		changeAgent: async (_chat: URI, _agent: AgentSelection | undefined) => { /* Gemini has no sub-agents to pick */ },
		getMessages: async (chat, context) => {
			const record = this._chatFor(chat, context);
			await this._hydrate(record);
			return [...record.turns];
		},
	};

	private _chatFor(chat: URI, context?: AgentChatOperationContext): IGeminiChat {
		const key = chat.toString();
		let record = this._chats.get(key);
		if (!record) {
			const resolved = context ? resolveAgentChatContext(context, chat) : undefined;
			record = {
				chat,
				session: resolved?.configurationResource ?? chat,
				workingDirectory: undefined,
				model: undefined,
				client: undefined,
				acpSessionId: undefined,
				savedAcpSessionId: undefined,
				startup: undefined,
				hydrated: undefined,
				onDisk: false,
				replaying: false,
				lastReplayUpdate: 0,
				historyPreamble: undefined,
				turns: [],
				active: undefined,
				startTime: Date.now(),
				modifiedTime: Date.now(),
				summary: undefined,
			};
			this._chats.set(key, record);
		}
		return record;
	}

	private async _createChat(chat: URI, context: AgentChatOperationContext, options?: IAgentCreateChatOptions): Promise<IAgentCreateChatResult> {
		const record = this._chatFor(chat, context);
		record.model = options?.model ?? record.model;
		record.workingDirectory = options?.workingDirectories?.[0] ?? record.workingDirectory;
		// A new chat has nothing saved: skip the read and start its record.
		record.hydrated ??= Promise.resolve();
		this._save(record);
		return { resolvedWorkingDirectory: record.workingDirectory };
	}

	async materializeChat(chat: URI, context: URI | IAgentChatContext): Promise<IAgentCreateChatResult | void> {
		await this._hydrate(this._chatFor(chat, context));
	}

	private async _disposeChat(chat: URI): Promise<void> {
		const record = this._chats.get(chat.toString());
		record?.client?.dispose();
		this._chats.delete(chat.toString());
		if (record) {
			try {
				await fs.rm(this._storePath(record), { force: true });
			} catch (error) {
				this._logService.warn(`[Gemini] could not remove the saved chat: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	// ---- Persistence ---------------------------------------------------------------

	/** One file per session, under the agent host's user data. */
	private _storePath(record: IGeminiChat): string {
		return join(this._environmentService.userDataPath, 'geminiAgent', `${AgentSession.id(record.session)}.json`);
	}

	private _hydrate(record: IGeminiChat): Promise<void> {
		record.hydrated ??= this._readSaved(record);
		return record.hydrated;
	}

	private async _readSaved(record: IGeminiChat): Promise<void> {
		let saved: IPersistedGeminiChat;
		try {
			saved = JSON.parse(await fs.readFile(this._storePath(record), 'utf8'));
		} catch {
			return;
		}
		record.onDisk = true;
		record.savedAcpSessionId = saved.acpSessionId;
		record.workingDirectory ??= saved.workingDirectory ? URI.parse(saved.workingDirectory) : undefined;
		record.model ??= saved.model;
		record.summary ??= saved.summary;
		record.startTime = saved.startTime;
		record.modifiedTime = saved.modifiedTime;
		record.turns.unshift(...saved.turns);
	}

	/** Writes the chat's record; writes queue per chat so the last one lands last. */
	private _save(record: IGeminiChat): void {
		const saved: IPersistedGeminiChat = {
			acpSessionId: record.savedAcpSessionId,
			workingDirectory: record.workingDirectory?.toString(),
			model: record.model,
			startTime: record.startTime,
			modifiedTime: record.modifiedTime,
			summary: record.summary,
			turns: record.turns,
		};
		record.onDisk = true;
		const path = this._storePath(record);
		const content = JSON.stringify(saved);
		const previous = this._saves.get(path) ?? Promise.resolve();
		const next = previous.then(async () => {
			try {
				await fs.mkdir(dirname(path), { recursive: true });
				await fs.writeFile(path, content, 'utf8');
			} catch (error) {
				this._logService.warn(`[Gemini] could not save the chat: ${error instanceof Error ? error.message : String(error)}`);
			}
		});
		this._saves.set(path, next);
		void next.finally(() => {
			if (this._saves.get(path) === next) {
				this._saves.delete(path);
			}
		});
	}

	private _releaseChat(chat: URI): void {
		// Keep the transcript; the CLI process restarts on the next message.
		const record = this._chats.get(chat.toString());
		if (record && !record.active) {
			record.client?.dispose();
			record.client = undefined;
			record.acpSessionId = undefined;
			record.startup = undefined;
		}
	}

	/** Starts the chat's CLI process and ACP session, once, in its working directory. */
	private _ensureStarted(record: IGeminiChat): Promise<void> {
		if (record.client && !record.client.exited && record.acpSessionId) {
			return Promise.resolve();
		}
		record.startup ??= this._start(record).catch(error => {
			record.startup = undefined;
			record.client?.dispose();
			record.client = undefined;
			record.acpSessionId = undefined;
			throw error;
		});
		return record.startup;
	}

	private async _start(record: IGeminiChat): Promise<void> {
		const command = await resolveGeminiCommand();
		if (!command) {
			throw new Error(localize('gemini.notInstalled', "The Gemini CLI is not installed. Install it with `npm install -g @google/gemini-cli`, then try again."));
		}
		const cwd = record.workingDirectory ?? await ensureWorkspacelessScratchDir(URI.file(homedir()), AgentSession.id(record.session));
		record.workingDirectory = cwd;
		const client = new AcpClient(command, cwd.fsPath, {
			requestPermission: request => this._requestPermission(record, request),
			readTextFile: async params => {
				const text = await fs.readFile(params.path, 'utf8');
				if (params.line === undefined && params.limit === undefined) {
					return text;
				}
				const lines = text.split(/\r?\n/);
				const start = Math.max(0, (params.line ?? 1) - 1);
				return lines.slice(start, params.limit !== undefined ? start + params.limit : undefined).join('\n');
			},
			writeTextFile: async params => {
				await fs.mkdir(dirname(params.path), { recursive: true });
				await fs.writeFile(params.path, params.content, 'utf8');
			},
		}, message => this._logService.info(message));
		record.client = client;
		client.onDidUpdateSession(({ sessionId, update }) => {
			if (record.replaying) {
				record.lastReplayUpdate = Date.now();
			} else if (sessionId === record.acpSessionId) {
				this._onUpdate(record, update);
			}
		});
		client.onDidExit(({ code }) => {
			this._logService.info(`[Gemini] CLI for ${record.chat.toString()} exited (${code})`);
			if (record.client === client) {
				record.client = undefined;
				record.acpSessionId = undefined;
				record.startup = undefined;
			}
		});
		await client.request('initialize', this._initializeParams());
		// Resume the CLI's own session when there is one, so the model keeps the
		// conversation. The CLI replays its history as updates just after it
		// answers; those are dropped until the stream goes quiet.
		let session: IAcpNewSessionResult | undefined;
		if (record.savedAcpSessionId) {
			record.replaying = true;
			record.lastReplayUpdate = Date.now();
			try {
				const loaded = await client.request<Omit<IAcpNewSessionResult, 'sessionId'> | null>('session/load', { sessionId: record.savedAcpSessionId, cwd: cwd.fsPath, mcpServers: [] });
				session = { ...loaded, sessionId: record.savedAcpSessionId };
				await this._replayQuiet(record);
			} catch (error) {
				this._logService.warn(`[Gemini] could not resume session ${record.savedAcpSessionId}, starting a new one: ${error instanceof Error ? error.message : String(error)}${error instanceof AcpError && error.data ? ` ${JSON.stringify(error.data)}` : ''}`);
				// The CLI keeps no session it cannot find (it also loses one resumed within a
				// minute of its start); the model still needs the conversation so far.
				record.historyPreamble = historyPreamble(record.turns);
			} finally {
				record.replaying = false;
			}
		}
		session ??= await client.request<IAcpNewSessionResult>('session/new', { cwd: cwd.fsPath, mcpServers: [] });
		record.acpSessionId = session.sessionId;
		if (record.savedAcpSessionId !== session.sessionId) {
			record.savedAcpSessionId = session.sessionId;
			this._save(record);
		}
		if (record.model?.id && toAcpModelId(record.model.id) !== session.models?.currentModelId) {
			await this._applyModel(record, record.model.id);
		}
	}

	/** Resolves once the CLI has sent no replayed update for a moment (at most a few seconds). */
	private async _replayQuiet(record: IGeminiChat): Promise<void> {
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && Date.now() - record.lastReplayUpdate < 400) {
			await new Promise(resolve => setTimeout(resolve, 100));
		}
	}

	private async _applyModel(record: IGeminiChat, modelId: string): Promise<void> {
		if (!record.client || !record.acpSessionId) {
			return;
		}
		try {
			await record.client.request('session/set_model', { sessionId: record.acpSessionId, modelId: toAcpModelId(modelId) });
		} catch (error) {
			this._logService.warn(`[Gemini] could not switch the model to ${modelId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async _changeModel(chat: URI, model: ModelSelection): Promise<void> {
		const record = this._chatFor(chat);
		record.model = model;
		this._save(record);
		await this._applyModel(record, model.id);
	}

	private async _sendMessage(chat: URI, prompt: string, workingDirectories: readonly URI[] | URI | undefined, attachments: readonly MessageAttachment[] | undefined, turnId: string | undefined, context: URI | IAgentChatContext | undefined): Promise<void> {
		const record = this._chatFor(chat, context);
		await this._hydrate(record);
		const requested = Array.isArray(workingDirectories) ? workingDirectories[0] : workingDirectories as URI | undefined;
		if (requested && !record.client) {
			record.workingDirectory = requested;
		}
		const id = turnId ?? generateUuid();
		const active: IActiveTurn = { turnId: id, prompt, startedAt: Date.now(), markdownPartId: undefined, reasoningPartId: undefined, partCounter: 0, markdown: new Map(), tools: new Map(), cancelled: false };
		record.active = active;
		record.summary ??= prompt.slice(0, 80);
		record.modifiedTime = Date.now();
		try {
			await this._ensureStarted(record);
			const result = await record.client!.request<{ stopReason: string }>('session/prompt', {
				sessionId: record.acpSessionId,
				prompt: this._promptBlocks(record, prompt, attachments),
			});
			if (active.cancelled || result.stopReason === 'cancelled') {
				return;
			}
			const usage = readPromptUsage(result);
			if (usage) {
				this._fire(record, { type: ActionType.ChatUsage, turnId: id, usage });
			}
			this._fire(record, { type: ActionType.ChatTurnComplete, turnId: id, duration: Date.now() - active.startedAt });
			this._finishTurn(record, active, TurnState.Complete);
		} catch (error) {
			if (active.cancelled) {
				return;
			}
			const signedOut = error instanceof AcpError && (error.code === ACP_AUTH_REQUIRED || /auth/i.test(error.message)) && !(await readGeminiAuthStatus()).signedIn;
			const message = signedOut
				? localize('gemini.signIn', "Gemini is not signed in. Choose Sign in to Gemini in the account menu, or set GEMINI_API_KEY, then try again.")
				: error instanceof Error ? error.message : String(error);
			this._fire(record, { type: ActionType.ChatError, turnId: id, duration: Date.now() - active.startedAt, part: createErrorResponsePart({ errorType: signedOut ? 'authentication' : 'gemini', message }) });
			this._finishTurn(record, active, TurnState.Error);
		} finally {
			if (record.active === active) {
				record.active = undefined;
			}
		}
	}

	/** The prompt as ACP content: the text, then attached files as links the CLI reads itself. */
	private _promptBlocks(record: IGeminiChat, prompt: string, attachments: readonly MessageAttachment[] | undefined): unknown[] {
		const blocks: unknown[] = [];
		if (record.historyPreamble) {
			blocks.push({ type: 'text', text: record.historyPreamble });
			record.historyPreamble = undefined;
		}
		blocks.push({ type: 'text', text: prompt });
		for (const attachment of attachments ?? []) {
			const uri = (attachment as { uri?: string | URI }).uri;
			if (uri) {
				const parsed = typeof uri === 'string' ? URI.parse(uri) : URI.revive(uri);
				if (parsed.scheme === 'file') {
					blocks.push({ type: 'resource_link', uri: parsed.toString(), name: (attachment as { label?: string }).label ?? parsed.path.split('/').pop() ?? parsed.path });
				}
			}
		}
		return blocks;
	}

	private _finishTurn(record: IGeminiChat, active: IActiveTurn, state: TurnState): void {
		const responseParts: ResponsePart[] = [...active.markdown].map(([id, content]): ResponsePart => ({ kind: ResponsePartKind.Markdown, id, content }));
		record.turns.push({
			id: active.turnId,
			startedAt: new Date(active.startedAt).toISOString(),
			duration: Date.now() - active.startedAt,
			message: { text: active.prompt, origin: { kind: MessageKind.User } },
			responseParts,
			usage: undefined,
			state,
		});
		record.modifiedTime = Date.now();
		this._save(record);
	}

	private async _abort(chat: URI): Promise<void> {
		const record = this._chats.get(chat.toString());
		if (!record?.active) {
			return;
		}
		record.active.cancelled = true;
		for (const toolCallId of record.active.tools.keys()) {
			this._permissions.respond(toolCallId, false);
		}
		if (record.client && record.acpSessionId) {
			record.client.notify('session/cancel', { sessionId: record.acpSessionId });
		}
	}

	// ---- Stream mapping ----------------------------------------------------------

	private _fire(record: IGeminiChat, action: ChatAction): void {
		this._onDidChatProgress.fire({ kind: 'action', resource: record.chat, action });
	}

	private _newPartId(active: IActiveTurn): string {
		return `${active.turnId}#gemini#${active.partCounter++}`;
	}

	private _onUpdate(record: IGeminiChat, update: AcpSessionUpdate): void {
		const active = record.active;
		if (!active || active.cancelled) {
			return;
		}
		switch (update.sessionUpdate) {
			case 'agent_message_chunk': {
				const content = (update as { content: { type: string; text?: string } }).content;
				if (content.type !== 'text' || !content.text) {
					return;
				}
				if (!active.markdownPartId) {
					active.markdownPartId = this._newPartId(active);
					active.markdown.set(active.markdownPartId, '');
					this._fire(record, { type: ActionType.ChatResponsePart, turnId: active.turnId, part: { kind: ResponsePartKind.Markdown, id: active.markdownPartId, content: '' } });
				}
				active.markdown.set(active.markdownPartId, (active.markdown.get(active.markdownPartId) ?? '') + content.text);
				this._fire(record, { type: ActionType.ChatDelta, turnId: active.turnId, partId: active.markdownPartId, content: content.text });
				return;
			}
			case 'agent_thought_chunk': {
				const content = (update as { content: { type: string; text?: string } }).content;
				if (content.type !== 'text' || !content.text) {
					return;
				}
				if (!active.reasoningPartId) {
					active.reasoningPartId = this._newPartId(active);
					this._fire(record, { type: ActionType.ChatResponsePart, turnId: active.turnId, part: { kind: ResponsePartKind.Reasoning, id: active.reasoningPartId, content: '' } });
				}
				this._fire(record, { type: ActionType.ChatReasoning, turnId: active.turnId, partId: active.reasoningPartId, content: content.text });
				return;
			}
			case 'tool_call':
			case 'tool_call_update':
				this._onToolCall(record, active, update as IAcpToolCall);
				return;
		}
	}

	private _startTool(record: IGeminiChat, active: IActiveTurn, call: IAcpToolCall): IToolState {
		let tool = active.tools.get(call.toolCallId);
		if (!tool) {
			tool = { started: false, ready: false, done: false, title: toolTitle(call, call.kind ?? 'tool'), kind: call.kind ?? 'other' };
			active.tools.set(call.toolCallId, tool);
		}
		if (call.title) {
			tool.title = call.title;
		}
		if (!tool.started) {
			tool.started = true;
			// Text after a tool starts a new part, so the transcript reads in order.
			active.markdownPartId = undefined;
			active.reasoningPartId = undefined;
			this._fire(record, { type: ActionType.ChatToolCallStart, turnId: active.turnId, toolCallId: call.toolCallId, toolName: tool.kind, displayName: tool.title });
		}
		return tool;
	}

	private _readyTool(record: IGeminiChat, active: IActiveTurn, call: IAcpToolCall, tool: IToolState): void {
		if (!tool.ready) {
			tool.ready = true;
			this._fire(record, {
				type: ActionType.ChatToolCallReady,
				turnId: active.turnId,
				toolCallId: call.toolCallId,
				invocationMessage: tool.title,
				toolInput: call.rawInput !== undefined ? JSON.stringify(call.rawInput, undefined, 2) : undefined,
				confirmed: ToolCallConfirmationReason.NotNeeded,
			});
		}
	}

	private _onToolCall(record: IGeminiChat, active: IActiveTurn, call: IAcpToolCall): void {
		const tool = this._startTool(record, active, call);
		if (call.status === 'in_progress') {
			this._readyTool(record, active, call, tool);
		} else if ((call.status === 'completed' || call.status === 'failed') && !tool.done) {
			this._readyTool(record, active, call, tool);
			tool.done = true;
			const text = toolText(call.content);
			const success = call.status === 'completed';
			const result: ToolCallResult = {
				success,
				pastTenseMessage: tool.title,
				...(text ? { content: [{ type: ToolResultContentType.Text, text }] } : {}),
				...(success ? {} : { error: { message: text ?? localize('gemini.toolFailed', "The tool failed.") } }),
			};
			this._fire(record, { type: ActionType.ChatToolCallComplete, turnId: active.turnId, toolCallId: call.toolCallId, result });
		}
	}

	/**
	 * The CLI asks before a tool runs: the user answers through the host's
	 * confirmation, and the answer goes back as the CLI's allow-once or
	 * reject-once option. Keyed by the tool call id, as the host answers it.
	 */
	private async _requestPermission(record: IGeminiChat, request: IAcpPermissionRequest): Promise<{ outcome: 'cancelled' } | { outcome: 'selected'; optionId: string }> {
		const active = record.active;
		if (!active || active.cancelled) {
			return { outcome: 'cancelled' };
		}
		const tool = this._startTool(record, active, request.toolCall);
		const approved = await this._permissions.registerAndFire(request.toolCall.toolCallId, () => this._onDidChatProgress.fire({
			kind: 'pending_confirmation',
			chat: record.chat,
			state: {
				status: ToolCallStatus.PendingConfirmation,
				toolCallId: request.toolCall.toolCallId,
				toolName: tool.kind,
				displayName: tool.title,
				invocationMessage: tool.title,
				toolInput: request.toolCall.rawInput !== undefined ? JSON.stringify(request.toolCall.rawInput, undefined, 2) : undefined,
				confirmationTitle: tool.title,
			},
			permissionKind: permissionKindOf(tool.kind),
			permissionPath: request.toolCall.locations?.[0]?.path,
		}));
		// The host moves the tool on after an answer; ours must not repeat it.
		tool.ready = true;
		const option = request.options.find(candidate => candidate.kind === (approved ? 'allow_once' : 'reject_once'))
			?? request.options.find(candidate => approved ? candidate.kind.startsWith('allow') : candidate.kind.startsWith('reject'));
		return option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' };
	}

	respondToPermissionRequest(requestId: string, approved: boolean): void {
		this._permissions.respond(requestId, approved);
	}

	// ---- The rest of the contract, answered minimally ------------------------------

	async setWorkingDirectory(): Promise<void> {
		throw new Error('The Gemini agent does not support changing the working directory of an existing session.');
	}

	getOrCreateActiveClient(_chat: URI, _context: URI | IAgentChatContext, client: { readonly clientId: string; readonly displayName?: string }): IActiveClient {
		let tools: readonly ToolDefinition[] = [];
		let customizations: readonly ClientPluginCustomization[] = [];
		return {
			clientId: client.clientId,
			displayName: client.displayName,
			get tools() { return tools; },
			set tools(value: readonly ToolDefinition[]) { tools = value; },
			get customizations() { return customizations; },
			set customizations(value: readonly ClientPluginCustomization[]) { customizations = value; },
		};
	}

	removeActiveClient(): void { }

	onClientToolCallComplete(_chat: URI, _toolCallId: string, _result: ToolCallResult): void { }

	respondToUserInputRequest(): void { }

	async resolveChatConfig(params: IAgentResolveChatConfigParams): Promise<ResolveSessionConfigResult> {
		return { schema: { type: 'object', properties: {} }, values: params.config ?? {} };
	}

	getInheritedChatConfig(): Record<string, unknown> | undefined {
		return undefined;
	}

	async chatConfigCompletions(_params: IAgentChatConfigCompletionsParams): Promise<SessionConfigCompletionsResult> {
		return { items: [] };
	}

	async getChatCustomizations(): Promise<readonly Customization[]> {
		return [];
	}

	async listChatsToMigrate(): Promise<AgentChatMigrationResult> {
		return [];
	}

	async getChatMetadata(chat: URI, context: URI | IAgentChatContext): Promise<IAgentChatMetadata | undefined> {
		let record = this._chats.get(chat.toString());
		if (!record) {
			// Not open in this process: known only if it was saved.
			const candidate = this._chatFor(chat, context);
			await this._hydrate(candidate);
			if (!candidate.onDisk) {
				this._chats.delete(chat.toString());
				return undefined;
			}
			record = candidate;
		}
		return {
			chat,
			startTime: record.startTime,
			modifiedTime: record.modifiedTime,
			summary: record.summary,
			model: record.model,
			workingDirectories: record.workingDirectory ? [record.workingDirectory] : undefined,
		};
	}

	/**
	 * Gemini runs on the user's own Gemini login, never GitHub: the Copilot
	 * resource is declared optional, as Claude and Codex declare it, so the
	 * Agents window does not ask for GitHub before offering Gemini.
	 */
	getProtectedResources(): ProtectedResourceMetadata[] {
		return [{ ...GITHUB_COPILOT_PROTECTED_RESOURCE, required: false }];
	}

	async authenticate(): Promise<boolean> {
		return true;
	}

	async shutdown(): Promise<void> {
		const exits: Promise<void>[] = [];
		for (const record of this._chats.values()) {
			if (record.client) {
				// Let each CLI exit on its own, so it saves its session for `session/load`.
				exits.push(record.client.kill());
				record.client.dispose();
				record.client = undefined;
			}
		}
		await Promise.all([...exits, ...this._saves.values()]);
	}

	override dispose(): void {
		void this.shutdown();
		super.dispose();
	}
}

