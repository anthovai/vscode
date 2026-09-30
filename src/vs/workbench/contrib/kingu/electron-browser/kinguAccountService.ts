/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IKinguAccountService, IKinguCloudAccountRequest, KINGU_ACCOUNT_STATE_COMMAND_ID, KinguCloudAccountReply, KinguAccountState, KinguRedeemOutcome, readKinguAccountReply, readKinguAuthStatus } from '../common/kinguAccount.js';
import { IKinguOrcaService } from '../common/kinguOrca.js';
import { KINGU_CONNECT_CLOUD_COMMAND_ID, skillErrorMessage } from '../common/kinguSkillSharing.js';

/** The ADE's push when the saved sign-in changed on its own (a refresh, an expiry). */
const AUTH_STATUS_CHANGED_CHANNEL = 'kinguProfiles:authStatusChanged';

/**
 * The Kingu account, read from the ADE's cloud sign-in (`kinguProfiles:*`) and
 * from Kingu cloud's `/v1/account`, asked through the ADE
 * (`kinguProfiles:accountRequest`), which holds the session and its token.
 */
class KinguAccountService extends Disposable implements IKinguAccountService {

	declare readonly _serviceBrand: undefined;

	private _state: KinguAccountState = { kind: 'checking' };
	private _refreshing: Promise<void> | undefined;
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	constructor(
		@IKinguOrcaService private readonly _orca: IKinguOrcaService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._register(this._orca.onPush(AUTH_STATUS_CHANGED_CHANNEL)(() => void this.refresh()));
	}

	get state(): KinguAccountState {
		return this._state;
	}

	refresh(): Promise<void> {
		this._refreshing ??= this._refresh().finally(() => { this._refreshing = undefined; });
		return this._refreshing;
	}

	private async _refresh(): Promise<void> {
		let state: KinguAccountState;
		try {
			state = readKinguAuthStatus(await this._orca.invoke('kinguProfiles:authStatus'));
		} catch (error) {
			this._logService.warn('[kingu-account] kinguProfiles:authStatus failed', error);
			state = { kind: 'unavailable' };
		}
		if (state.kind === 'signedIn') {
			// The plan by name and end date; the flags' reading stands when the cloud cannot be asked.
			const outcome = readKinguAccountReply(await this._account().catch(() => undefined));
			if (outcome.kind === 'ok') {
				state = { ...state, plan: outcome.plan };
			} else if (outcome.kind === 'signIn') {
				state = { kind: 'expired', email: state.email };
			}
		}
		this._setState(state);
	}

	async signIn(): Promise<string | undefined> {
		await this._orca.invoke('kinguProfiles:connectCurrent');
		await this.refresh();
		return this._state.kind === 'signedIn' ? this._state.email : undefined;
	}

	async signOut(): Promise<void> {
		await this._orca.invoke('kinguProfiles:signOutCurrent');
		await this.refresh();
	}

	async redeem(code: string): Promise<KinguRedeemOutcome> {
		const outcome = readKinguAccountReply(await this._account({ redeemCode: code }).catch(() => undefined));
		if (outcome.kind === 'ok' && this._state.kind === 'signedIn') {
			this._setState({ ...this._state, plan: outcome.plan });
		}
		// The ADE refreshed its sign-in after the redeem; read it again for every other view of the plan.
		void this.refresh();
		return outcome;
	}

	private _account(request?: IKinguCloudAccountRequest): Promise<KinguCloudAccountReply> {
		// The ADE makes the request: it holds the cloud session, refreshing it as needed.
		return this._orca.invoke<KinguCloudAccountReply>('kinguProfiles:accountRequest', request);
	}

	private _setState(state: KinguAccountState): void {
		this._state = state;
		this._onDidChange.fire();
	}
}

registerSingleton(IKinguAccountService, KinguAccountService, InstantiationType.Delayed);

CommandsRegistry.registerCommand(KINGU_ACCOUNT_STATE_COMMAND_ID, async (accessor): Promise<KinguAccountState> => {
	const service = accessor.get(IKinguAccountService);
	if (service.state.kind === 'checking') {
		await service.refresh();
	}
	return service.state;
});

/** The ADE's Settings "Sign in to Kingu": connects this profile to Kingu cloud and says who it is signed in as. */
registerAction2(class ConnectKinguCloudAction extends Action2 {
	constructor() {
		super({ id: KINGU_CONNECT_CLOUD_COMMAND_ID, title: localize2('kingu.connectCloud', "Kingu: Connect to Kingu Cloud"), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const account = accessor.get(IKinguAccountService);
		const notificationService = accessor.get(INotificationService);
		const progressService = accessor.get(IProgressService);
		try {
			// Sign-in finishes in the browser; say so while it waits, or the button seems dead.
			const email = await progressService.withProgress({
				location: ProgressLocation.Notification,
				title: localize('kingu.connectCloud.waiting', "Finish signing in to Kingu in your browser…"),
			}, () => account.signIn());
			notificationService.info(email
				? localize('kingu.connectCloud.done', "Connected to Kingu cloud as {0}.", email)
				: localize('kingu.connectCloud.notYet', "Kingu cloud did not finish signing in."));
		} catch (error) {
			notificationService.error(localize('kingu.connectCloud.failed', "Could not connect to Kingu cloud: {0}", skillErrorMessage(error)));
		}
	}
});
