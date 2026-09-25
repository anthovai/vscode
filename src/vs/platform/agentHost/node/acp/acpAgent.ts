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
import { hasKey } from '../../../../base/common/types.js';
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
import { ACP_AUTH_REQUIRED, AcpClient, AcpError, IAcpAuthMethod, IAcpConfigOption, IAcpInitializeResult, IAcpModel, IAcpNewSessionResult, IAcpPermissionRequest, IAcpSpawnCommand, IAcpToolCall, IAcpToolCallContent, AcpSessionUpdate } from './acpClient.js';

/**
 * What sets one ACP agent apart from another: its CLI, how its models are
 * named, and what it says when it is not installed or not signed in.
 */
export interface IAcpAgentProfile {
	readonly id: AgentProvider;
	readonly displayName: string;
	readonly description: string;
	/** How to start the CLI in ACP mode; `undefined` while it is not installed. */
	resolveCommand(): Promise<IAcpSpawnCommand | undefined>;
	readonly notInstalledMessage: string;
	/**
	 * The message for a turn refused for want of a login, or `undefined` when
	 * the agent is signed in. `authMethods` are the ways the CLI says it can be
	 * signed in.
	 */
	signedOutMessage(authMethods: readonly IAcpAuthMethod[]): Promise<string | undefined>;
	/** A readable model name; the CLI's own name otherwise. */
	modelDisplayName?(model: IAcpModel): string;
	/** Models the CLI runs by id without listing them. */
	readonly extraModels?: readonly IAcpModel[];
}

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
	/** When the CLI last sent anything for this turn. */
	lastActivity: number;
	/** Whether the user has been told the CLI has gone quiet, since it last sent anything. */
	stallNoticed: boolean;
	/** The CLI's last stderr line about a retry, a rate limit or a quota. */
	retryHint: string | undefined;
}

/** How long a turn may go without a word from the CLI before the user is told why it may be waiting. */
const STALL_NOTICE_MS = 45_000;

/** A stderr line that explains a wait: a retry, a rate limit, or a quota. */
const RETRY_HINT = /\b(429|retry|retrying|rate.?limit|quota|resource.?exhausted|overloaded|503|capacity)\b/i;

interface IAcpChat {
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
interface IPersistedAcpChat {
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
 * The chat UI reads a model id of `auto` as its own Auto router and shows a
 * routing step for it, so an agent's `auto` model is renamed on the way out.
 */
function autoModelId(agent: AgentProvider): string {
	return `${agent}-auto`;
}

/** Whether an ACP failure is the agent asking to be signed in. */
function isAuthError(error: unknown): boolean {
	return error instanceof AcpError && (error.code === ACP_AUTH_REQUIRED || /auth/i.test(error.message));
}

/** The one model offered for an agent that names none: whatever its CLI is configured to use. */
function defaultModelId(agent: AgentProvider): string {
	return `${agent}-default`;
}

/** The session setting through which an agent offers its models, when it has one. */
function modelConfigOption(session: IAcpNewSessionResult): IAcpConfigOption | undefined {
	return session.configOptions?.find(option => option.type === 'select' && (option.category === 'model' || option.id === 'model'));
}

/** A model setting's values as models, its groups flattened. */
function modelsOfConfigOption(option: IAcpConfigOption): IAcpModel[] {
	return (option.options ?? []).flatMap(entry => hasKey(entry, { group: true }) ? entry.options : [entry]).map(value => ({ modelId: value.value, name: value.name, description: value.description }));
}

/**
 * Token counts an ACP agent attaches to a finished prompt (`_meta.quota`), read
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
 * Kingu: an agent CLI driven over the Agent Client Protocol (`gemini --acp`,
 * `qwen --acp`, `opencode acp`, ...). One CLI process per chat, started on the
 * chat's first message in its working directory. The CLI does its own model
 * calls, tools and file edits on the user's own login; this agent maps its
 * stream onto the host's chat actions and routes its permission prompts to the
 * user. {@link IAcpAgentProfile} holds what differs between CLIs.
 */
export class AcpAgent extends Disposable implements IAgent {

	readonly id: AgentProvider;
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

	private readonly _chats = new Map<string, IAcpChat>();
	private readonly _permissions = new PendingRequestRegistry<boolean>();
	private _refreshing: Promise<void> | undefined;
	private readonly _saves = new Map<string, Promise<void>>();

	/** Whether the CLI can resume a session it saved (`session/load`). */
	private _canLoadSessions = false;
	/** The session setting that picks the model, for an agent that offers models that way rather than through `session/set_model`. */
	private _modelConfigId: string | undefined;
	/** How the CLI says it can be signed in, from its `initialize`. */
	private _authMethods: readonly IAcpAuthMethod[] = [];

	constructor(
		private readonly _profile: IAcpAgentProfile,
		@ILogService private readonly _logService: ILogService,
		@INativeEnvironmentService private readonly _environmentService: INativeEnvironmentService,
	) {
		super();
		this.id = _profile.id;
		queueMicrotask(() => { void this.refreshModels(); });
	}

	getDescriptor(): IAgentDescriptor {
		return {
			provider: this.id,
			displayName: this._profile.displayName,
			description: this._profile.description,
		};
	}

	/**
	 * The models the CLI offers, read from a throwaway ACP session (creating one
	 * needs no login and runs no model call). Empty while the CLI is not
	 * installed, which leaves the harness unusable rather than failing later.
	 */
	refreshModels(): Promise<void> {
		this._refreshing ??= this._readModels().finally(() => { this._refreshing = undefined; });
		return this._refreshing;
	}

	private async _readModels(): Promise<void> {
		const command = await this._profile.resolveCommand();
		if (!command) {
			this._logService.info(`[${this._profile.displayName}] CLI not found; the agent offers no models`);
			this._models.set([], undefined);
			return;
		}
		const client = new AcpClient(command, tmpdir(), this._inertHandlers(), message => this._logService.info(message));
		try {
			this._noteCapabilities(await client.request<IAcpInitializeResult>('initialize', this._initializeParams()));
			const session = await this._newSession(client, tmpdir(), command);
			const configOption = session.models ? undefined : modelConfigOption(session);
			this._modelConfigId = configOption?.id;
			const available = session.models?.availableModels ?? (configOption ? modelsOfConfigOption(configOption) : []);
			const extra = (this._profile.extraModels ?? []).filter(model => !available.some(candidate => candidate.modelId === model.modelId));
			// The CLI's own current model first: the picker takes the first model as the default.
			const current = session.models?.currentModelId ?? configOption?.currentValue;
			const listed = [...available, ...extra].sort((a, b) => Number(b.modelId === current) - Number(a.modelId === current));
			const models = (listed.length ? listed : [{ modelId: defaultModelId(this.id), name: localize('acp.defaultModel', "{0} (configured model)", this._profile.displayName) }]).map(model => ({
				provider: this.id,
				id: this._fromAcpModelId(model.modelId),
				name: this._profile.modelDisplayName?.(model) ?? model.name,
				supportsVision: true,
			} satisfies IAgentModelInfo));
			this._logService.info(`[${this._profile.displayName}] Models refreshed. Count: ${models.length}, ${models.map(model => model.name).join(', ')}`);
			this._models.set(models, undefined);
		} catch (error) {
			if (isAuthError(error)) {
				// Signed out, which hides the models too: still offer the agent, so its
				// first turn can say how to sign in.
				this._logService.info(`[${this._profile.displayName}] not signed in; offering its configured model`);
				this._models.set([{ provider: this.id, id: defaultModelId(this.id), name: localize('acp.defaultModel', "{0} (configured model)", this._profile.displayName), supportsVision: true }], undefined);
			} else {
				this._logService.error(error, `[${this._profile.displayName}] could not read the CLI's models`);
			}
		} finally {
			client.dispose();
		}
	}

	/**
	 * `session/new`, signing in first when the CLI asks for a login that the
	 * user has already set up in the environment: an auth method whose
	 * description names the variables it reads (Qwen Code's "Requires setting
	 * the `OPENAI_API_KEY` environment variable") is used when they are set.
	 */
	private async _newSession(client: AcpClient, cwd: string, command: IAcpSpawnCommand): Promise<IAcpNewSessionResult> {
		try {
			return await client.request<IAcpNewSessionResult>('session/new', { cwd, mcpServers: [] });
		} catch (error) {
			const method = isAuthError(error) ? this._authMethods.find(candidate => {
				const variables = [...(candidate.description ?? '').matchAll(/`(?<name>[A-Z][A-Z0-9_]{2,})`/g)].map(match => match.groups?.name ?? '');
				return variables.length > 0 && variables.every(name => !!command.env[name]);
			}) : undefined;
			if (!method) {
				throw error;
			}
			this._logService.info(`[${this._profile.displayName}] signing in with ${method.id}, set up in the environment`);
			try {
				await client.request('authenticate', { methodId: method.id });
			} catch (authError) {
				// Still signed out; the caller reports it as the sign-in it is.
				this._logService.warn(`[${this._profile.displayName}] could not sign in with ${method.id}: ${authError instanceof AcpError && authError.data ? JSON.stringify(authError.data) : String(authError)}`);
				throw error;
			}
			return await client.request<IAcpNewSessionResult>('session/new', { cwd, mcpServers: [] });
		}
	}

	private _offersOnlyConfiguredModel(): boolean {
		const models = this._models.get();
		return models.length === 1 && models[0].id === defaultModelId(this.id);
	}

	private _noteCapabilities(result: IAcpInitializeResult): void {
		this._canLoadSessions = !!result.agentCapabilities?.loadSession;
		this._authMethods = result.authMethods ?? [];
	}

	private _fromAcpModelId(modelId: string): string {
		return modelId === 'auto' ? autoModelId(this.id) : modelId;
	}

	private _toAcpModelId(modelId: string): string {
		return modelId === autoModelId(this.id) ? 'auto' : modelId;
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
		changeAgent: async (_chat: URI, _agent: AgentSelection | undefined) => { /* ACP has no sub-agents to pick */ },
		getMessages: async (chat, context) => {
			const record = this._chatFor(chat, context);
			await this._hydrate(record);
			return [...record.turns];
		},
	};

	private _chatFor(chat: URI, context?: AgentChatOperationContext): IAcpChat {
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
		if (this._offersOnlyConfiguredModel()) {
			// Signed out when the models were read; a new chat is the moment a sign-in
			// made since then (in a terminal, with the CLI's own login) should show.
			void this.refreshModels();
		}
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
				this._logService.warn(`[${this._profile.displayName}] could not remove the saved chat: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	// ---- Persistence ---------------------------------------------------------------

	/** One file per session, under the agent host's user data. */
	private _storePath(record: IAcpChat): string {
		return join(this._environmentService.userDataPath, `${this.id}Agent`, `${AgentSession.id(record.session)}.json`);
	}

	private _hydrate(record: IAcpChat): Promise<void> {
		record.hydrated ??= this._readSaved(record);
		return record.hydrated;
	}

	private async _readSaved(record: IAcpChat): Promise<void> {
		let saved: IPersistedAcpChat;
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
	private _save(record: IAcpChat): void {
		const saved: IPersistedAcpChat = {
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
				this._logService.warn(`[${this._profile.displayName}] could not save the chat: ${error instanceof Error ? error.message : String(error)}`);
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
	private _ensureStarted(record: IAcpChat): Promise<void> {
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

	private async _start(record: IAcpChat): Promise<void> {
		const command = await this._profile.resolveCommand();
		if (!command) {
			throw new Error(this._profile.notInstalledMessage);
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
		client.onDidWriteStderr(chunk => {
			const active = record.active;
			const line = chunk.split(/\r?\n/).map(text => text.trim()).filter(text => RETRY_HINT.test(text)).pop();
			if (active && line) {
				active.retryHint = line.length > 300 ? `${line.slice(0, 300)}...` : line;
			}
		});
		client.onDidExit(({ code }) => {
			this._logService.info(`[${this._profile.displayName}] CLI for ${record.chat.toString()} exited (${code})`);
			if (record.client === client) {
				record.client = undefined;
				record.acpSessionId = undefined;
				record.startup = undefined;
			}
		});
		this._noteCapabilities(await client.request<IAcpInitializeResult>('initialize', this._initializeParams()));
		// Resume the CLI's own session when there is one, so the model keeps the
		// conversation. The CLI replays its history as updates just after it
		// answers; those are dropped until the stream goes quiet.
		let session: IAcpNewSessionResult | undefined;
		if (record.savedAcpSessionId && !this._canLoadSessions) {
			record.historyPreamble = historyPreamble(record.turns);
		} else if (record.savedAcpSessionId) {
			record.replaying = true;
			record.lastReplayUpdate = Date.now();
			try {
				const loaded = await client.request<Omit<IAcpNewSessionResult, 'sessionId'> | null>('session/load', { sessionId: record.savedAcpSessionId, cwd: cwd.fsPath, mcpServers: [] });
				session = { ...loaded, sessionId: record.savedAcpSessionId };
				await this._replayQuiet(record);
			} catch (error) {
				this._logService.warn(`[${this._profile.displayName}] could not resume session ${record.savedAcpSessionId}, starting a new one: ${error instanceof Error ? error.message : String(error)}${error instanceof AcpError && error.data ? ` ${JSON.stringify(error.data)}` : ''}`);
				// The CLI keeps no session it cannot find (it also loses one resumed within a
				// minute of its start); the model still needs the conversation so far.
				record.historyPreamble = historyPreamble(record.turns);
			} finally {
				record.replaying = false;
			}
		}
		session ??= await this._newSession(client, cwd.fsPath, command);
		record.acpSessionId = session.sessionId;
		if (record.savedAcpSessionId !== session.sessionId) {
			record.savedAcpSessionId = session.sessionId;
			this._save(record);
		}
		if (!session.models) {
			this._modelConfigId ??= modelConfigOption(session)?.id;
		}
		const current = session.models?.currentModelId ?? (this._modelConfigId ? session.configOptions?.find(option => option.id === this._modelConfigId)?.currentValue : undefined);
		if (record.model?.id && record.model.id !== defaultModelId(this.id) && this._toAcpModelId(record.model.id) !== current) {
			await this._applyModel(record, record.model.id);
		}
	}

	/** Resolves once the CLI has sent no replayed update for a moment (at most a few seconds). */
	private async _replayQuiet(record: IAcpChat): Promise<void> {
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && Date.now() - record.lastReplayUpdate < 400) {
			await new Promise(resolve => setTimeout(resolve, 100));
		}
	}

	private async _applyModel(record: IAcpChat, modelId: string): Promise<void> {
		if (!record.client || !record.acpSessionId || modelId === defaultModelId(this.id)) {
			return;
		}
		try {
			await (this._modelConfigId
				? record.client.request('session/set_config_option', { sessionId: record.acpSessionId, configId: this._modelConfigId, value: modelId })
				: record.client.request('session/set_model', { sessionId: record.acpSessionId, modelId: this._toAcpModelId(modelId) }));
		} catch (error) {
			this._logService.warn(`[${this._profile.displayName}] could not switch the model to ${modelId}: ${error instanceof Error ? error.message : String(error)}`);
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
		const active: IActiveTurn = { turnId: id, prompt, startedAt: Date.now(), markdownPartId: undefined, reasoningPartId: undefined, partCounter: 0, markdown: new Map(), tools: new Map(), cancelled: false, lastActivity: Date.now(), stallNoticed: false, retryHint: undefined };
		record.active = active;
		const watchdog = setInterval(() => this._checkStall(record, active), 5_000);
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
			const signedOut = isAuthError(error) ? await this._profile.signedOutMessage(this._authMethods) : undefined;
			const message = signedOut ?? (error instanceof Error ? error.message : String(error));
			this._fire(record, { type: ActionType.ChatError, turnId: id, duration: Date.now() - active.startedAt, part: createErrorResponsePart({ errorType: signedOut ? 'authentication' : this.id, message }) });
			this._finishTurn(record, active, TurnState.Error);
		} finally {
			clearInterval(watchdog);
			if (record.active === active) {
				record.active = undefined;
			}
		}
	}

	/**
	 * A turn the CLI has gone quiet on: CLIs retry rate limits and quota
	 * errors on their own, for minutes, with nothing on the protocol to say so.
	 * The user is told once per silence, with the CLI's own words when it wrote
	 * any, so a wait is not mistaken for work.
	 */
	private _checkStall(record: IAcpChat, active: IActiveTurn): void {
		if (active.cancelled || active.stallNoticed || record.active !== active || Date.now() - active.lastActivity < STALL_NOTICE_MS) {
			return;
		}
		active.stallNoticed = true;
		const seconds = Math.round((Date.now() - active.lastActivity) / 1000);
		const content = active.retryHint
			? localize('acp.stalledRetrying', "{0} has sent nothing for {1} seconds. Its CLI reports: {2}. It may keep retrying for several minutes; stop the turn to give up.", this._profile.displayName, seconds, active.retryHint)
			: localize('acp.stalled', "{0} has sent nothing for {1} seconds. Its CLI may be retrying after a rate limit or a used-up quota; stop the turn to give up, or keep waiting.", this._profile.displayName, seconds);
		this._fire(record, { type: ActionType.ChatResponsePart, turnId: active.turnId, part: { kind: ResponsePartKind.SystemNotification, content } });
	}

	/** The prompt as ACP content: the text, then attached files as links the CLI reads itself. */
	private _promptBlocks(record: IAcpChat, prompt: string, attachments: readonly MessageAttachment[] | undefined): unknown[] {
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

	private _finishTurn(record: IAcpChat, active: IActiveTurn, state: TurnState): void {
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

	private _fire(record: IAcpChat, action: ChatAction): void {
		this._onDidChatProgress.fire({ kind: 'action', resource: record.chat, action });
	}

	private _newPartId(active: IActiveTurn): string {
		return `${active.turnId}#${this.id}#${active.partCounter++}`;
	}

	private _onUpdate(record: IAcpChat, update: AcpSessionUpdate): void {
		const active = record.active;
		if (!active || active.cancelled) {
			return;
		}
		active.lastActivity = Date.now();
		active.stallNoticed = false;
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

	private _startTool(record: IAcpChat, active: IActiveTurn, call: IAcpToolCall): IToolState {
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

	private _readyTool(record: IAcpChat, active: IActiveTurn, call: IAcpToolCall, tool: IToolState): void {
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

	private _onToolCall(record: IAcpChat, active: IActiveTurn, call: IAcpToolCall): void {
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
				...(success ? {} : { error: { message: text ?? localize('acp.toolFailed', "The tool failed.") } }),
			};
			this._fire(record, { type: ActionType.ChatToolCallComplete, turnId: active.turnId, toolCallId: call.toolCallId, result });
		}
	}

	/**
	 * The CLI asks before a tool runs: the user answers through the host's
	 * confirmation, and the answer goes back as the CLI's allow-once or
	 * reject-once option. Keyed by the tool call id, as the host answers it.
	 */
	private async _requestPermission(record: IAcpChat, request: IAcpPermissionRequest): Promise<{ outcome: 'cancelled' } | { outcome: 'selected'; optionId: string }> {
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
		throw new Error(`The ${this._profile.displayName} agent does not support changing the working directory of an existing session.`);
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
	 * An ACP agent runs on the user's own login with its CLI, never GitHub: the
	 * Copilot resource is declared optional, as Claude and Codex declare it, so
	 * the Agents window does not ask for GitHub before offering it.
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

