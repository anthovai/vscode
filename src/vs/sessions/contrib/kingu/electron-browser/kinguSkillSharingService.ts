/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IKinguOrcaService } from '../common/kinguOrca.js';
import {
	IKinguDiscoveredSkill,
	IKinguOwnedSkillShare,
	IKinguSkillInstallResult,
	IKinguSkillSharePreview,
	IKinguSkillSharingService,
	IKinguSkillVersion,
	KINGU_CONNECT_CLOUD_COMMAND_ID,
	KinguSkillCloudOperation,
	KinguSkillOutcome,
	readSkillOperation,
	skillErrorMessage,
} from '../common/kinguSkillSharing.js';

/** The ADE's `KinguProfileAuthStatus`, the part read here. */
interface IAuthStatus {
	readonly state: string;
	readonly cloud?: { readonly email: string };
}

/**
 * The ADE's skill sharing handlers (`main/ipc/skill-cloud-ipc-handlers.ts`),
 * called the way its own Skills page calls them.
 */
class KinguSkillSharingService implements IKinguSkillSharingService {

	declare readonly _serviceBrand: undefined;
	readonly available = true;

	constructor(@IKinguOrcaService private readonly _orca: IKinguOrcaService) { }

	async discover(): Promise<readonly IKinguDiscoveredSkill[]> {
		return (await this._orca.invoke<{ readonly skills: readonly IKinguDiscoveredSkill[] }>('skills:discover', { refresh: true })).skills;
	}

	prepare(skillIds: readonly string[], bundleName: string): Promise<IKinguSkillSharePreview> {
		return this._orca.invoke<IKinguSkillSharePreview>('skills:prepareShare', { skillIds, bundleName });
	}

	async cancel(preparationId: string): Promise<void> {
		await this._orca.invoke('skills:cancelShare', preparationId).catch(() => undefined);
	}

	async publish(preparationId: string, releaseNotes: string): Promise<KinguSkillOutcome<{ readonly url: string }>> {
		const outcome = await this._operation<{ readonly share: { readonly url: string } }>('skills:publishShare', { preparationId, releaseNotes });
		if (outcome.kind === 'ok') {
			// The review's staged archive is only needed until the upload is done.
			void this._orca.invoke('skills:releaseShare', preparationId).catch(() => undefined);
			return { kind: 'ok', value: { url: outcome.value.share.url } };
		}
		return outcome;
	}

	listOwnedShares(): Promise<KinguSkillOutcome<readonly IKinguOwnedSkillShare[]>> {
		return this._operation('skills:listOwnedShares');
	}

	revoke(shareId: string): Promise<KinguSkillOutcome<void>> {
		return this._operation('skills:revokeShare', shareId);
	}

	async resolve(shareId: string): Promise<KinguSkillOutcome<IKinguSkillVersion>> {
		const outcome = await this._operation<{ readonly version: IKinguSkillVersion }>('skills:resolveShare', shareId);
		return outcome.kind === 'ok' ? { kind: 'ok', value: outcome.value.version } : outcome;
	}

	install(shareId: string, version: IKinguSkillVersion, skillIds: readonly string[]): Promise<KinguSkillOutcome<IKinguSkillInstallResult>> {
		const destination = { scope: 'global' };
		return version.manifest.skills
			? this._operation('skills:installBundleShare', { shareId, versionId: version.versionId, selectedSkillIds: skillIds, destination })
			: this._operation('skills:installShare', { shareId, versionId: version.versionId, destination });
	}

	async connect(): Promise<string | undefined> {
		await this._orca.invoke('kinguProfiles:connectCurrent');
		const status = await this._orca.invoke<IAuthStatus>('kinguProfiles:authStatus').catch(() => undefined);
		return status?.state === 'connected' ? status.cloud?.email : undefined;
	}

	private async _operation<T>(channel: string, ...args: unknown[]): Promise<KinguSkillOutcome<T>> {
		try {
			return readSkillOperation(await this._orca.invoke<KinguSkillCloudOperation<T>>(channel, ...args));
		} catch (error) {
			return readSkillOperation<T>(undefined, error);
		}
	}
}

registerSingleton(IKinguSkillSharingService, KinguSkillSharingService, InstantiationType.Delayed);

/** The ADE's Settings "Sign in to Kingu": connects this profile to Kingu cloud and says who it is signed in as. */
registerAction2(class ConnectKinguCloudAction extends Action2 {
	constructor() {
		super({ id: KINGU_CONNECT_CLOUD_COMMAND_ID, title: localize2('kingu.connectCloud', "Kingu: Connect to Kingu Cloud"), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const sharing = accessor.get(IKinguSkillSharingService);
		const notificationService = accessor.get(INotificationService);
		try {
			const email = await sharing.connect();
			notificationService.info(email
				? localize('kingu.connectCloud.done', "Connected to Kingu cloud as {0}.", email)
				: localize('kingu.connectCloud.notYet', "Kingu cloud did not finish signing in."));
		} catch (error) {
			notificationService.error(localize('kingu.connectCloud.failed', "Could not connect to Kingu cloud: {0}", skillErrorMessage(error)));
		}
	}
});
