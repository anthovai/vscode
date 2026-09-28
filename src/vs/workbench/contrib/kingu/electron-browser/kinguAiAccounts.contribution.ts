/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { KINGU_ORCA_CHANNEL_NAME } from '../../../../platform/kinguOrca/common/kinguOrca.js';
import { IKinguClaudeAccount, IKinguGeminiStatus, IKinguGeminiUsage, KINGU_AI_CHANNEL_NAME } from '../../../../platform/kinguAi/common/kinguAi.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ACP_AGENT_CATALOG, acpAgentCatalogEntry, acpAgentLoginCommand } from '../../../../platform/agentHost/common/acpAgentCatalog.js';
import { IAgentSdkSetupService } from '../../../services/agentHost/browser/agentSdkSetupService.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { joinPath } from '../../../../base/common/resources.js';
import { agentSdkSetupSessionType } from '../../chat/browser/agentSessions/agentHost/agentHostSdkSetupNotification.js';
import { hasAnyModelTargetingSessionType } from '../../chat/browser/agentSessions/sessionTypeAvailability.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { KINGU_SETUP_COMMAND_ID } from '../common/kinguLanguageModels.js';
import { KINGU_OPEN_ORCA_SETTINGS_COMMAND_ID } from '../common/kinguOrcaSettingsCommands.js';
import {
	IKinguAiAccountStatus,
	IKinguAiAgentAccount,
	IKinguAiUsage,
	isKinguAiProvider,
	KINGU_AI_ACCOUNT_STATUS_COMMAND_ID,
	KINGU_AI_AGENT_ACCOUNTS_COMMAND_ID,
	KINGU_AI_ARKAI_USAGE_COMMAND_ID,
	KINGU_AI_CHOOSE_SIGN_IN_COMMAND_ID,
	KINGU_AI_SIGN_IN_IN_TERMINAL_COMMAND_ID,
	KINGU_AI_PROVIDERS,
	KINGU_AI_SIGN_IN_COMMAND_ID,
	kinguAiAgentId,
	kinguAiProviderLabel,
	KinguAiProvider,
	KinguAiSignedInContext,
} from '../common/kinguAiAccounts.js';

/** The ADE's `ClaudeRateLimitAccountsState` / `CodexRateLimitAccountsState`, as far as sign-in reads them. */
interface IAccountsState {
	readonly accounts: readonly { readonly id: string; readonly email: string }[];
	readonly activeAccountId: string | null;
	readonly systemDefault?: { readonly email: string | null; readonly hasAuth: boolean };
}

function invokeOrca<T>(mainProcessService: IMainProcessService, channel: string, ...args: unknown[]): Promise<T> {
	return mainProcessService.getChannel(KINGU_ORCA_CHANNEL_NAME).call<T>('invoke', [channel, args]);
}

/** In use: the account the ADE has selected, else a login the provider's own CLI already has. */
function statusOf(state: IAccountsState | undefined): IKinguAiAccountStatus {
	const active = state?.accounts.find(account => account.id === state.activeAccountId);
	if (active) {
		return { signedIn: true, email: active.email };
	}
	return state?.systemDefault?.hasAuth ? { signedIn: true, email: state.systemDefault.email ?? undefined } : { signedIn: false };
}

/** One limit window as the ADE's `rateLimits:get` reports it. */
interface IRateLimitWindow {
	readonly usedPercent: number;
	readonly resetsAt: number | null;
	readonly windowMinutes?: number;
}

/** The ADE's rate-limit snapshot for one provider, as far as the account panel reads it. */
interface IProviderRateLimits {
	readonly status?: string;
	readonly session?: IRateLimitWindow | null;
	readonly weekly?: IRateLimitWindow | null;
}

/** Claude's session limit, else its weekly one, from the ADE's rate limits (the footer's source). */
async function readClaudeUsage(mainProcessService: IMainProcessService): Promise<IKinguAiUsage | undefined> {
	const state = await invokeOrca<{ readonly claude?: IProviderRateLimits | null } | undefined>(mainProcessService, 'rateLimits:get').catch(() => undefined);
	const window = state?.claude?.session ?? state?.claude?.weekly;
	return window ? { usedPercent: window.usedPercent, resetsAt: window.resetsAt ?? undefined, windowMinutes: window.windowMinutes ?? (state?.claude?.session ? 300 : 10080) } : undefined;
}

/** The ADE's `OpenCodeUsageDailyPoint`, as far as the account panel reads it. */
interface IOpenCodeDailyPoint {
	readonly day: string;
	readonly totalTokens: number;
}

/**
 * OpenCode's tokens today, from the ADE's OpenCode usage scan of OpenCode's
 * own database (`openCodeUsage:*`), switched on the first time it is asked.
 */
async function readOpenCodeUsage(mainProcessService: IMainProcessService): Promise<IKinguAiUsage | undefined> {
	try {
		const scan = await invokeOrca<{ readonly enabled: boolean } | undefined>(mainProcessService, 'openCodeUsage:getScanState');
		if (!scan?.enabled) {
			await invokeOrca(mainProcessService, 'openCodeUsage:setEnabled', { enabled: true });
		}
		const daily = await invokeOrca<readonly IOpenCodeDailyPoint[] | undefined>(mainProcessService, 'openCodeUsage:getDaily', { scope: 'all', range: '7d' });
		const now = new Date();
		const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
		return { tokensToday: daily?.find(point => point.day === today)?.totalTokens ?? 0 };
	} catch {
		return undefined;
	}
}

/**
 * The ADE reports no system-default Claude login (its pane only says "use your
 * current login"), so for Claude the agent's own finding stands in: it lists
 * models only when the Claude SDK found a working login.
 */
async function readStatus(mainProcessService: IMainProcessService, languageModelsService: ILanguageModelsService, provider: KinguAiProvider): Promise<IKinguAiAccountStatus> {
	if (provider === 'gemini') {
		// Gemini's login is its CLI's own, read in the main process.
		const channel = mainProcessService.getChannel(KINGU_AI_CHANNEL_NAME);
		const gemini = await channel.call<IKinguGeminiStatus>('geminiStatus');
		const usage = gemini.signedIn ? await channel.call<IKinguGeminiUsage>('geminiUsageToday').catch(() => undefined) : undefined;
		return {
			signedIn: gemini.signedIn,
			email: gemini.email ?? (gemini.signedIn && gemini.method === 'gemini-api-key' ? localize('kingu.ai.geminiApiKey', "Gemini (API key)") : undefined),
			plan: gemini.signedIn ? (gemini.method === 'gemini-api-key' ? localize('kingu.ai.geminiApiPlan', "Gemini API") : localize('kingu.ai.geminiGooglePlan', "Gemini Code Assist")) : undefined,
			usage: usage ? { tokensToday: usage.inputTokens + usage.outputTokens } : undefined,
		};
	}
	const status = statusOf(await invokeOrca<IAccountsState>(mainProcessService, `${provider}Accounts:list`));
	if (provider !== 'claude') {
		return status;
	}
	// Claude Code's own record names the login in use, the ADE's or the user's own.
	const [account, usage] = await Promise.all([
		mainProcessService.getChannel(KINGU_AI_CHANNEL_NAME).call<IKinguClaudeAccount | undefined>('claudeAccount').catch(() => undefined),
		readClaudeUsage(mainProcessService),
	]);
	const signedIn = status.signedIn || !!account || hasAnyModelTargetingSessionType(languageModelsService, agentSdkSetupSessionType(kinguAiAgentId(provider)));
	return signedIn ? { signedIn, email: status.email ?? account?.email, plan: account?.plan, usage } : { signedIn };
}

/** Keeps the signed-in context keys current for the menus that offer sign-in. */
class KinguAiAccountsContribution extends Disposable {

	static readonly ID = 'kingu.contrib.aiAccounts';

	private static _instance: KinguAiAccountsContribution | undefined;

	private readonly _keys: Record<KinguAiProvider, IContextKey<boolean>>;

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@IMainProcessService private readonly _mainProcessService: IMainProcessService,
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._keys = {
			claude: KinguAiSignedInContext.claude.bindTo(contextKeyService),
			codex: KinguAiSignedInContext.codex.bindTo(contextKeyService),
			gemini: KinguAiSignedInContext.gemini.bindTo(contextKeyService),
		};
		KinguAiAccountsContribution._instance = this;
		this._register({ dispose: () => { KinguAiAccountsContribution._instance = undefined; } });
		void this.refresh();
		// Claude's system login shows up as its models arriving.
		this._register(_languageModelsService.onDidChangeLanguageModels(() => void this.refresh()));
	}

	static refresh(): Promise<void> {
		return KinguAiAccountsContribution._instance?.refresh() ?? Promise.resolve();
	}

	async refresh(): Promise<void> {
		await Promise.all(KINGU_AI_PROVIDERS.map(async provider => {
			try {
				this._keys[provider].set((await readStatus(this._mainProcessService, this._languageModelsService, provider)).signedIn);
			} catch (error) {
				this._logService.trace(`[kingu-ai] could not read ${provider} accounts`, error);
			}
		}));
	}
}

registerWorkbenchContribution2(KinguAiAccountsContribution.ID, KinguAiAccountsContribution, WorkbenchPhase.AfterRestored);

CommandsRegistry.registerCommand(KINGU_AI_ACCOUNT_STATUS_COMMAND_ID, (accessor: ServicesAccessor, provider: unknown): Promise<IKinguAiAccountStatus> => {
	if (!isKinguAiProvider(provider)) {
		return Promise.resolve({ signedIn: false });
	}
	return readStatus(accessor.get(IMainProcessService), accessor.get(ILanguageModelsService), provider);
});

/**
 * Runs the provider's own login through the ADE (`<provider>Accounts:add`),
 * then puts the new account in use — the ADE adds without selecting, but
 * signing in here means "use this" — and asks the agent to look again, so its
 * models appear without a restart.
 */
CommandsRegistry.registerCommand(KINGU_AI_SIGN_IN_COMMAND_ID, async (accessor: ServicesAccessor, provider: unknown): Promise<boolean> => {
	if (!isKinguAiProvider(provider)) {
		return false;
	}
	const mainProcessService = accessor.get(IMainProcessService);
	const progressService = accessor.get(IProgressService);
	const notificationService = accessor.get(INotificationService);
	const setupService = accessor.get(IAgentSdkSetupService);
	const label = kinguAiProviderLabel(provider);
	try {
		if (provider === 'gemini') {
			// Google no longer lets the Gemini CLI's own client sign individuals in with
			// Google (it points them at Antigravity), so the CLI's sign-in screen is
			// the way in: an API key, a Workspace login, or Vertex AI.
			await runInTerminal(accessor.get(ITerminalService), localize('kingu.ai.signInTerminal', "Sign in to {0}", label), 'gemini');
			return true;
		}
		const before = await invokeOrca<IAccountsState>(mainProcessService, `${provider}Accounts:list`).catch(() => undefined);
		const known = new Set(before?.accounts.map(account => account.id) ?? []);
		const after = await progressService.withProgress({
			location: ProgressLocation.Notification,
			title: localize('kingu.ai.signingIn', "Signing in to {0}. Finish in the browser window that opened.", label),
			cancellable: true,
		}, () => invokeOrca<IAccountsState>(mainProcessService, `${provider}Accounts:add`, { runtime: 'host', wslDistro: null }), () => {
			void invokeOrca(mainProcessService, `${provider}Accounts:cancelPendingLogin`).catch(() => undefined);
		});
		const added = after?.accounts.find(account => !known.has(account.id)) ?? after?.accounts.find(account => account.id === after.activeAccountId);
		if (added && after.activeAccountId !== added.id) {
			await invokeOrca(mainProcessService, `${provider}Accounts:select`, { accountId: added.id });
		}
		if (provider === 'codex') {
			// Each ChatGPT account has its own Codex home; point the agent at the new one.
			await mainProcessService.getChannel(KINGU_AI_CHANNEL_NAME).call('refreshCodexHome');
		}
		setupService.requestReload(kinguAiAgentId(provider));
		await KinguAiAccountsContribution.refresh();
		notificationService.info(added?.email
			? localize('kingu.ai.signedInAs', "Signed in to {0} as {1}.", label, added.email)
			: localize('kingu.ai.signedIn', "Signed in to {0}.", label));
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/cancel/i.test(message)) {
			notificationService.error(localize('kingu.ai.signInFailed', "Could not sign in to {0}: {1}", label, message));
		}
		return false;
	}
});

/** Opens a terminal named `name` and runs `command` in it, for a sign-in the user completes there. */
async function runInTerminal(terminalService: ITerminalService, name: string, command: string): Promise<void> {
	const instance = await terminalService.createTerminal({ config: { name } });
	terminalService.setActiveInstance(instance);
	await terminalService.revealTerminal(instance);
	await instance.sendText(command, true);
}

/**
 * The ACP agents this machine runs, from the models they offer: each offers a
 * single configured model while its CLI is signed out.
 */
CommandsRegistry.registerCommand(KINGU_AI_AGENT_ACCOUNTS_COMMAND_ID, async (accessor: ServicesAccessor): Promise<IKinguAiAgentAccount[]> => {
	const languageModelsService = accessor.get(ILanguageModelsService);
	const mainProcessService = accessor.get(IMainProcessService);
	const models = languageModelsService.getLanguageModelIds().map(id => languageModelsService.lookupLanguageModel(id));
	const accounts = ACP_AGENT_CATALOG.flatMap(entry => {
		const own = models.filter(model => model?.targetChatSessionType === agentSdkSetupSessionType(entry.id));
		if (!own.length) {
			return [];
		}
		const signedIn = !(own.length === 1 && own[0]?.id === `${entry.id}-default`);
		return [{ id: entry.id, displayName: entry.displayName, signedIn, modelCount: signedIn ? own.length : 0 }];
	});
	// The ADE reads OpenCode's usage from OpenCode's own database; the other agents have no source it reads.
	return Promise.all(accounts.map(async account => account.id === 'opencode' || account.id === 'opencode2'
		? { ...account, usage: await readOpenCodeUsage(mainProcessService) }
		: account));
});

CommandsRegistry.registerCommand(KINGU_AI_SIGN_IN_IN_TERMINAL_COMMAND_ID, async (accessor: ServicesAccessor, agentId: unknown): Promise<void> => {
	const entry = typeof agentId === 'string' ? acpAgentCatalogEntry(agentId) : undefined;
	if (entry) {
		await runInTerminal(accessor.get(ITerminalService), localize('kingu.ai.signInTerminal', "Sign in to {0}", entry.displayName), acpAgentLoginCommand(entry));
	}
});

/**
 * Chyle's use today, from the file the agent host's Chyle gateway keeps
 * (`~/.arkai/usage.json`, see `chyleRuntime.ts`); nothing before its first
 * answer of the day.
 */
CommandsRegistry.registerCommand(KINGU_AI_ARKAI_USAGE_COMMAND_ID, async (accessor: ServicesAccessor): Promise<IKinguAiUsage | undefined> => {
	const fileService = accessor.get(IFileService);
	const home = await accessor.get(IPathService).userHome();
	try {
		const content = await fileService.readFile(joinPath(home, '.arkai', 'usage.json'));
		const usage = JSON.parse(content.value.toString()) as { date?: string; promptTokens?: number; completionTokens?: number };
		const now = new Date();
		const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
		return usage.date === today ? { tokensToday: (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0) } : { tokensToday: 0 };
	} catch {
		return { tokensToday: 0 };
	}
});

interface IKinguSignInPick extends IQuickPickItem {
	readonly run: () => Promise<unknown>;
}

/**
 * Every AI this machine can use, in one list: the accounts Kingu signs in to
 * itself (Claude, ChatGPT, Gemini), the agent CLIs it runs (each signs in in
 * its own terminal), and a model endpoint of the user's own. Signed-in ones
 * stay listed, to add another account.
 */
CommandsRegistry.registerCommand(KINGU_AI_CHOOSE_SIGN_IN_COMMAND_ID, async (accessor: ServicesAccessor): Promise<void> => {
	const quickInputService = accessor.get(IQuickInputService);
	const commandService = accessor.get(ICommandService);
	const mainProcessService = accessor.get(IMainProcessService);
	const languageModelsService = accessor.get(ILanguageModelsService);
	const signedInAs = (email: string | undefined) => email
		? localize('kingu.ai.pick.signedInAs', "Signed in as {0}", email)
		: localize('kingu.ai.pick.signedIn', "Signed in");
	const notSignedIn = localize('kingu.ai.pick.notSignedIn', "Not signed in");

	const picks = (async (): Promise<(IKinguSignInPick | IQuickPickSeparator)[]> => {
		const [statuses, agents] = await Promise.all([
			Promise.all(KINGU_AI_PROVIDERS.map(provider => readStatus(mainProcessService, languageModelsService, provider).catch((): IKinguAiAccountStatus => ({ signedIn: false })))),
			commandService.executeCommand<IKinguAiAgentAccount[]>(KINGU_AI_AGENT_ACCOUNTS_COMMAND_ID).catch(() => undefined),
		]);
		const accounts: IKinguSignInPick[] = KINGU_AI_PROVIDERS.map((provider, index) => ({
			label: kinguAiProviderLabel(provider),
			description: statuses[index].signedIn ? signedInAs(statuses[index].email) : notSignedIn,
			run: () => commandService.executeCommand(KINGU_AI_SIGN_IN_COMMAND_ID, provider),
		}));
		const agentPicks: IKinguSignInPick[] = (agents ?? []).map(agent => ({
			label: agent.displayName,
			description: agent.signedIn ? signedInAs(undefined) : notSignedIn,
			detail: localize('kingu.ai.pick.inTerminal', "Signs in with its own CLI, in a terminal"),
			run: () => commandService.executeCommand(KINGU_AI_SIGN_IN_IN_TERMINAL_COMMAND_ID, agent.id),
		}));
		return [
			{ type: 'separator', label: localize('kingu.ai.pick.accounts', "AI accounts") },
			...accounts,
			...(agentPicks.length ? [{ type: 'separator', label: localize('kingu.ai.pick.agents', "Agents on this computer") } satisfies IQuickPickSeparator, ...agentPicks] : []),
			{ type: 'separator', label: localize('kingu.ai.pick.other', "Other") },
			{
				label: localize('kingu.ai.pick.endpoint', "Add a Model Endpoint..."),
				detail: localize('kingu.ai.pick.endpointDetail', "Any OpenAI- or Anthropic-compatible API, with your own key, or a model running on this computer"),
				run: () => commandService.executeCommand(KINGU_SETUP_COMMAND_ID),
			},
		];
	})();
	const picked = await quickInputService.pick(picks, {
		title: localize('kingu.ai.pick.title', "Sign In to an AI"),
		placeHolder: localize('kingu.ai.pick.placeholder', "Pick an AI provider to sign in to"),
		matchOnDescription: true,
	});
	await picked?.run();
});

/** The provider sign-ins, for the command palette; the Accounts menu reaches them through "Sign In to Another AI...". */
for (const provider of KINGU_AI_PROVIDERS) {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: `${KINGU_AI_SIGN_IN_COMMAND_ID}.${provider}`,
				title: provider === 'claude'
					? localize2('kingu.ai.signInClaude', "Sign in to Claude...")
					: provider === 'codex'
						? localize2('kingu.ai.signInChatGPT', "Sign in to ChatGPT...")
						: localize2('kingu.ai.signInGemini', "Sign in to Gemini..."),
				f1: true,
				precondition: ContextKeyExpr.not(KinguAiSignedInContext[provider].key),
			});
		}
		run(accessor: ServicesAccessor): Promise<unknown> {
			return accessor.get(ICommandService).executeCommand(KINGU_AI_SIGN_IN_COMMAND_ID, provider);
		}
	});
}

/** The Accounts menu's first entry: the Kingu account Arkai runs on, in Kingu Settings. */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'kingu.arkai.signIn',
			title: localize2('kingu.arkai.signIn', "Sign in to Arkai..."),
			f1: true,
			menu: {
				id: MenuId.AccountsContext,
				group: '1_kingu_ai',
				order: 0,
			},
		});
	}
	run(accessor: ServicesAccessor): Promise<unknown> {
		return accessor.get(ICommandService).executeCommand(KINGU_OPEN_ORCA_SETTINGS_COMMAND_ID, { pane: 'kingu-account' });
	}
});

/** The Accounts menu's way to every other AI: more accounts, agent CLIs, an endpoint. */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: `${KINGU_AI_CHOOSE_SIGN_IN_COMMAND_ID}.menu`,
			title: localize2('kingu.ai.signInToAi', "Sign In to Another AI..."),
			f1: true,
			menu: {
				id: MenuId.AccountsContext,
				group: '1_kingu_ai',
				order: KINGU_AI_PROVIDERS.length + 1,
			},
		});
	}
	run(accessor: ServicesAccessor): Promise<unknown> {
		return accessor.get(ICommandService).executeCommand(KINGU_AI_CHOOSE_SIGN_IN_COMMAND_ID);
	}
});
