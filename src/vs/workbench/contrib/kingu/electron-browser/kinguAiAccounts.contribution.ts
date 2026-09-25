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
import { IKinguGeminiStatus, KINGU_AI_CHANNEL_NAME } from '../../../../platform/kinguAi/common/kinguAi.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IAgentSdkSetupService } from '../../../services/agentHost/browser/agentSdkSetupService.js';
import { agentSdkSetupSessionType } from '../../chat/browser/agentSessions/agentHost/agentHostSdkSetupNotification.js';
import { hasAnyModelTargetingSessionType } from '../../chat/browser/agentSessions/sessionTypeAvailability.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import {
	IKinguAiAccountStatus,
	isKinguAiProvider,
	KINGU_AI_ACCOUNT_STATUS_COMMAND_ID,
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

/**
 * The ADE reports no system-default Claude login (its pane only says "use your
 * current login"), so for Claude the agent's own finding stands in: it lists
 * models only when the Claude SDK found a working login.
 */
async function readStatus(mainProcessService: IMainProcessService, languageModelsService: ILanguageModelsService, provider: KinguAiProvider): Promise<IKinguAiAccountStatus> {
	if (provider === 'gemini') {
		// Gemini's login is its CLI's own, read in the main process.
		const gemini = await mainProcessService.getChannel(KINGU_AI_CHANNEL_NAME).call<IKinguGeminiStatus>('geminiStatus');
		return {
			signedIn: gemini.signedIn,
			email: gemini.email ?? (gemini.signedIn && gemini.method === 'gemini-api-key' ? localize('kingu.ai.geminiApiKey', "Gemini (API key)") : undefined),
		};
	}
	const status = statusOf(await invokeOrca<IAccountsState>(mainProcessService, `${provider}Accounts:list`));
	if (!status.signedIn && provider === 'claude' && hasAnyModelTargetingSessionType(languageModelsService, agentSdkSetupSessionType(kinguAiAgentId(provider)))) {
		return { signedIn: true };
	}
	return status;
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
			await progressService.withProgress({
				location: ProgressLocation.Notification,
				title: localize('kingu.ai.signingInGoogle', "Signing in to Gemini with Google. Finish in the browser window that opened."),
			}, () => mainProcessService.getChannel(KINGU_AI_CHANNEL_NAME).call('geminiSignIn'));
			setupService.requestReload(kinguAiAgentId(provider));
			await KinguAiAccountsContribution.refresh();
			notificationService.info(localize('kingu.ai.signedIn', "Signed in to {0}.", label));
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

/** The editor window's Accounts menu offers the AI sign-ins while they are missing. */
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
				menu: {
					id: MenuId.AccountsContext,
					group: '1_kingu_ai',
					order: KINGU_AI_PROVIDERS.indexOf(provider) + 1,
					when: ContextKeyExpr.not(KinguAiSignedInContext[provider].key),
				},
			});
		}
		run(accessor: ServicesAccessor): Promise<unknown> {
			return accessor.get(ICommandService).executeCommand(KINGU_AI_SIGN_IN_COMMAND_ID, provider);
		}
	});
}
