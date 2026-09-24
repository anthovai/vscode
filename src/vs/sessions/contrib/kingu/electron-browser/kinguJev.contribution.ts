/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import Severity from '../../../../base/common/severity.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKinguHostService } from '../../../../platform/kinguHost/common/kinguHostService.js';
import { IJevRequest, JEV_DEFAULT_MODEL, JEV_ENDPOINT, JevResult } from '../../../../platform/kinguHost/common/kinguJev.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { ITerminalStatus } from '../../../../workbench/contrib/terminal/common/terminal.js';
import { AGENT_STATUS_QUESTION, agentStatusFromAnswer, isAgentTerminalName, isFocusReport, KinguAgentTerminalStatus, TerminalOutputTail } from '../common/kinguJevTerminal.js';

export const JEV_ENABLED_SETTING = 'kingu.jev.enabled';
export const JEV_MODEL_SETTING = 'kingu.jev.model';
export const JEV_ENDPOINT_SETTING = 'kingu.jev.endpoint';
/** Kept in secret storage, never in settings: settings.json is what Settings Sync uploads. */
const JEV_KEY_SECRET = 'kingu.jev.apiKey';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'kingu.jev',
	title: localize('kingu.jev.title', "Kingu: Jev"),
	type: 'object',
	properties: {
		[JEV_ENABLED_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('kingu.jev.enabled', "Use TypeSafe's Jev to tell when an agent running in a terminal (Claude Code, Codex, …) is waiting for you, has finished, or has stopped on an error, and mark its terminal. When on, the most recent output of **agent terminals only** (up to a few thousand characters, after the output goes quiet) is sent to TypeSafe's API. Needs an API key: run **Kingu: Set Jev API Key**."),
		},
		[JEV_ENDPOINT_SETTING]: {
			type: 'string',
			default: JEV_ENDPOINT,
			// Application scope only: a repository's settings must not be able to send the key elsewhere.
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('kingu.jev.endpoint', "Where Jev is asked: TypeSafe's own API, or a gateway that serves the same `systemone` endpoint. Must be `https:` (or `http:` on this machine)."),
		},
		[JEV_MODEL_SETTING]: {
			type: 'string',
			default: JEV_DEFAULT_MODEL,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('kingu.jev.model', "The Jev model to ask, e.g. `jev-latest` or a pinned version such as `jev-1.13.0`."),
		},
	},
});

export const IKinguJevService = createDecorator<IKinguJevService>('kinguJevService');

/** Jev, and what it has said about each agent terminal. */
export interface IKinguJevService {
	readonly _serviceBrand: undefined;
	/** On in settings and a key stored. */
	readonly isActive: boolean;
	readonly onDidChangeActive: Event<boolean>;
	/** Fires with the terminal whose status changed. */
	readonly onDidChangeStatus: Event<ITerminalInstance>;
	statusOf(instance: ITerminalInstance): KinguAgentTerminalStatus | undefined;
	decide(request: Omit<IJevRequest, 'model' | 'endpoint'>): Promise<JevResult>;
	setApiKey(key: string): Promise<void>;
	clearApiKey(): Promise<void>;
}

/** How long an agent terminal must be quiet before it is asked about: its output has settled into a state. */
const QUIET_MS = 1500;
/** The fewest milliseconds between two questions about one terminal. */
const MIN_INTERVAL_MS = 4000;

const STATUS_ID = 'kingu.jev.agentStatus';

function terminalStatus(status: KinguAgentTerminalStatus): ITerminalStatus | undefined {
	switch (status) {
		case KinguAgentTerminalStatus.NeedsInput:
			return { id: STATUS_ID, severity: Severity.Warning, icon: Codicon.bellDot, tooltip: localize('kingu.jev.needsInput', "The agent is waiting for your input (Jev)") };
		case KinguAgentTerminalStatus.Error:
			return { id: STATUS_ID, severity: Severity.Error, icon: Codicon.error, tooltip: localize('kingu.jev.error', "The agent stopped on an error (Jev)") };
		case KinguAgentTerminalStatus.Done:
			return { id: STATUS_ID, severity: Severity.Info, icon: Codicon.check, tooltip: localize('kingu.jev.done', "The agent has finished (Jev)") };
		default:
			return undefined;
	}
}

/**
 * Jev in this window: the key in secret storage, the calls made from the main
 * process, and a watch over agent terminals.
 *
 * A terminal is watched only while it is an agent's (by its title or process)
 * and only while Jev is on and has a key. Once its output has been quiet for a
 * moment, its latest output is asked about — at most once every few seconds,
 * and not again until the output changes. A confident answer marks the
 * terminal: waiting for input, finished, or stopped on an error; typing into it
 * clears the mark.
 */
class KinguJevService extends Disposable implements IKinguJevService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeActive = this._register(new Emitter<boolean>());
	readonly onDidChangeActive = this._onDidChangeActive.event;
	private readonly _onDidChangeStatus = this._register(new Emitter<ITerminalInstance>());
	readonly onDidChangeStatus = this._onDidChangeStatus.event;

	private _hasKey = false;
	private _active = false;
	private _warnedUnauthorized = false;
	private readonly _watches = this._register(new DisposableMap<ITerminalInstance>());
	private readonly _statuses = new Map<ITerminalInstance, KinguAgentTerminalStatus>();

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ISecretStorageService private readonly _secretStorageService: ISecretStorageService,
		@IKinguHostService private readonly _hostService: IKinguHostService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._register(this._configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(JEV_ENABLED_SETTING)) {
				this._update();
			}
		}));
		this._register(this._secretStorageService.onDidChangeSecret(key => {
			if (key === JEV_KEY_SECRET) {
				void this._readKey();
			}
		}));
		this._register(this._terminalService.onDidCreateInstance(instance => this._consider(instance)));
		this._register(this._terminalService.onDidDisposeInstance(instance => this._forget(instance)));
		void this._readKey();
	}

	get isActive(): boolean {
		return this._active;
	}

	statusOf(instance: ITerminalInstance): KinguAgentTerminalStatus | undefined {
		return this._statuses.get(instance);
	}

	async setApiKey(key: string): Promise<void> {
		await this._secretStorageService.set(JEV_KEY_SECRET, key.trim());
		this._warnedUnauthorized = false;
	}

	async clearApiKey(): Promise<void> {
		await this._secretStorageService.delete(JEV_KEY_SECRET);
	}

	async decide(request: Omit<IJevRequest, 'model' | 'endpoint'>): Promise<JevResult> {
		const key = await this._secretStorageService.get(JEV_KEY_SECRET);
		if (!key) {
			return { ok: false, problem: 'no-key' };
		}
		const result = await this._hostService.jevDecide({
			...request,
			model: this._configurationService.getValue<string>(JEV_MODEL_SETTING) || JEV_DEFAULT_MODEL,
			endpoint: this._configurationService.getValue<string>(JEV_ENDPOINT_SETTING) || JEV_ENDPOINT,
		}, key);
		if (!result.ok && result.problem === 'unauthorized' && !this._warnedUnauthorized) {
			this._warnedUnauthorized = true;
			this._notificationService.warn(localize('kingu.jev.unauthorized', "Jev refused the API key. Run \"Kingu: Set Jev API Key\" to replace it."));
		}
		return result;
	}

	private async _readKey(): Promise<void> {
		try {
			this._hasKey = !!(await this._secretStorageService.get(JEV_KEY_SECRET));
		} catch {
			this._hasKey = false;
		}
		this._update();
	}

	private _update(): void {
		const active = this._hasKey && this._configurationService.getValue<boolean>(JEV_ENABLED_SETTING) === true;
		if (active === this._active) {
			return;
		}
		this._active = active;
		if (active) {
			for (const instance of this._terminalService.instances) {
				this._consider(instance);
			}
		} else {
			for (const instance of [...this._statuses.keys()]) {
				this._setStatus(instance, undefined);
			}
			this._watches.clearAndDisposeAll();
		}
		this._onDidChangeActive.fire(active);
	}

	/** Watches a terminal while Jev is on; its name decides, and is looked at again when its title changes. */
	private _consider(instance: ITerminalInstance): void {
		if (!this._active || this._watches.has(instance) || instance.isDisposed) {
			return;
		}
		const store = new DisposableStore();
		this._watches.set(instance, store);
		const tail = new TerminalOutputTail();
		let quiet: number | undefined;
		let asking = false;
		let lastAsked = 0;
		let lastState = '';
		const isAgent = () => isAgentTerminalName(instance.title, instance.processName, instance.shellLaunchConfig.executable, instance.shellLaunchConfig.name);
		const cancel = () => {
			if (quiet !== undefined) {
				mainWindow.clearTimeout(quiet);
				quiet = undefined;
			}
		};
		store.add(toDisposable(cancel));
		const ask = async () => {
			quiet = undefined;
			if (!this._active || asking || !isAgent()) {
				return;
			}
			const wait = lastAsked + MIN_INTERVAL_MS - Date.now();
			if (wait > 0) {
				quiet = mainWindow.setTimeout(() => void ask(), wait);
				return;
			}
			const state = tail.read();
			if (!state || state === lastState) {
				return;
			}
			asking = true;
			lastAsked = Date.now();
			lastState = state;
			try {
				const result = await this.decide({ state, questions: { status: AGENT_STATUS_QUESTION } });
				// An answer about output that has since moved on is out of date.
				if (store.isDisposed || instance.isDisposed || tail.read() !== state) {
					return;
				}
				if (result.ok) {
					const status = agentStatusFromAnswer(result.answers.status);
					if (status !== undefined) {
						this._setStatus(instance, status);
					}
				} else if (result.problem !== 'no-key' && result.problem !== 'unauthorized') {
					this._logService.trace(`[kingu-jev] no decision: ${result.problem}`);
				}
			} finally {
				asking = false;
			}
		};
		store.add(instance.onData(data => {
			tail.append(data);
			// New text means the agent is working again and a mark from before no longer holds. Output
			// that leaves the text as it was — a title update, a cursor move, a repaint — keeps the mark.
			const marked = this._statuses.get(instance);
			if (marked !== undefined && marked !== KinguAgentTerminalStatus.Working && tail.read() !== lastState) {
				this._setStatus(instance, KinguAgentTerminalStatus.Working);
			}
			cancel();
			quiet = mainWindow.setTimeout(() => void ask(), QUIET_MS);
		}));
		store.add(instance.onDidInputData(data => {
			// The user answered: whatever it was waiting for is being given. Focus moving in or out
			// of the terminal is reported as input too, and answers nothing.
			const marked = this._statuses.get(instance);
			if (!isFocusReport(data) && (marked === KinguAgentTerminalStatus.NeedsInput || marked === KinguAgentTerminalStatus.Done)) {
				this._setStatus(instance, KinguAgentTerminalStatus.Working);
			}
		}));
	}

	private _forget(instance: ITerminalInstance): void {
		this._watches.deleteAndDispose(instance);
		if (this._statuses.delete(instance)) {
			this._onDidChangeStatus.fire(instance);
		}
	}

	private _setStatus(instance: ITerminalInstance, status: KinguAgentTerminalStatus | undefined): void {
		if (this._statuses.get(instance) === status) {
			return;
		}
		instance.statusList.remove(STATUS_ID);
		if (status === undefined) {
			this._statuses.delete(instance);
		} else {
			this._statuses.set(instance, status);
			const mark = terminalStatus(status);
			if (mark) {
				instance.statusList.add(mark);
			}
		}
		this._onDidChangeStatus.fire(instance);
	}
}

registerSingleton(IKinguJevService, KinguJevService, InstantiationType.Delayed);

/** Brings the service up with the window, so terminals are watched from the start when Jev is on. */
class KinguJevContribution extends Disposable {
	static readonly ID = 'kingu.contrib.jev';
	constructor(@IKinguJevService _jev: IKinguJevService) {
		super();
	}
}

registerWorkbenchContribution2(KinguJevContribution.ID, KinguJevContribution, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'kingu.jev.setApiKey', title: localize2('kingu.jev.setApiKey', "Kingu: Set Jev API Key"), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const jev = accessor.get(IKinguJevService);
		const configurationService = accessor.get(IConfigurationService);
		const notificationService = accessor.get(INotificationService);
		const key = await quickInputService.input({
			password: true,
			ignoreFocusLost: true,
			title: localize('kingu.jev.setApiKey.title', "Jev API Key"),
			prompt: localize('kingu.jev.setApiKey.prompt', "Your TypeSafe API key. It is kept in this machine's secret storage, not in settings."),
			validateInput: async value => value.trim() ? undefined : localize('kingu.jev.setApiKey.empty', "Enter a key."),
		});
		if (!key) {
			return;
		}
		await jev.setApiKey(key);
		if (configurationService.getValue<boolean>(JEV_ENABLED_SETTING) !== true) {
			notificationService.info(localize('kingu.jev.setApiKey.enable', "Jev API key saved. Turn on \"{0}\" in settings to use it.", JEV_ENABLED_SETTING));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'kingu.jev.clearApiKey', title: localize2('kingu.jev.clearApiKey', "Kingu: Clear Jev API Key"), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IKinguJevService).clearApiKey();
	}
});
