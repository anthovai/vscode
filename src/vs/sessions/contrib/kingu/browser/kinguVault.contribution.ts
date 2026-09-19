/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { IKinguVaultService, IKinguVaultSession } from '../common/kinguVault.js';
import { KinguVaultService } from './kinguVaultService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IAgentHostImportConversationStore } from '../../../../workbench/contrib/chat/browser/agentSessions/agentHost/agentHostImportConversationStore.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { continueVaultSession } from './kinguVaultContinue.js';
import { KINGU_VAULT_VIEW_ID, KinguVaultView } from './kinguVaultView.js';

registerSingleton(IKinguVaultService, KinguVaultService, InstantiationType.Delayed);

/** Publishes the vault as a full-surface view of the Agents window. */
class KinguVaultViewContribution extends Disposable {

	static readonly ID = 'kingu.contrib.vaultView';

	constructor(
		@ICustomViewService customViewService: ICustomViewService,
	) {
		super();
		this._register(customViewService.registerCustomView({
			id: KINGU_VAULT_VIEW_ID,
			ctor: new SyncDescriptor(KinguVaultView),
		}));
	}
}

registerWorkbenchContribution2(KinguVaultViewContribution.ID, KinguVaultViewContribution, WorkbenchPhase.BlockRestore);

/** Opens that view. Browsing by quick pick stays for when a name is already known. */
class OpenKinguVaultAction extends Action2 {

	static readonly ID = 'kingu.vault.open';

	constructor() {
		super({
			id: OpenKinguVaultAction.ID,
			title: localize2('kingu.vault.open', "Kingu: Open Vault"),
			category: Categories.View,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		accessor.get(ICustomViewService).showCustomView(KINGU_VAULT_VIEW_ID);
	}
}

interface IVaultPick extends IQuickPickItem {
	readonly session: IKinguVaultSession;
}

function toPick(session: IKinguVaultSession, detail?: string): IVaultPick {
	return {
		session,
		label: session.title,
		description: session.workingDirectory
			? localize('kingu.vault.pick.description', "{0} · {1}", session.sourceLabel, session.workingDirectory)
			: session.sourceLabel,
		detail,
	};
}

/**
 * Browses the sessions other agents have left on this machine.
 *
 * Deliberately the workbench's own quick pick rather than a view: the ADE's
 * vault UI is not what is being brought across, only what it knew how to read.
 */
class BrowseKinguVaultAction extends Action2 {

	static readonly ID = 'kingu.vault.browse';

	constructor() {
		super({
			id: BrowseKinguVaultAction.ID,
			title: localize2('kingu.vault.browse', "Kingu: Browse Vault"),
			category: Categories.View,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const vaultService = accessor.get(IKinguVaultService);
		const editorService = accessor.get(IEditorService);

		const picked = await quickInputService.pick(
			vaultService.getSessions().then(sessions => sessions.map(session => toPick(session))),
			{
				title: localize('kingu.vault.browse.title', "Kingu Vault"),
				placeHolder: localize('kingu.vault.browse.placeholder', "Sessions from every agent on this machine"),
				matchOnDescription: true,
			});
		if (picked) {
			await editorService.openEditor({ resource: picked.session.resource, options: { pinned: true } });
		}
	}
}

/**
 * Searches inside those transcripts.
 *
 * Separate from browsing because the search reads every transcript, which the
 * list does not: paying that cost to filter titles would make opening the list
 * as slow as the rarer thing.
 */
class SearchKinguVaultAction extends Action2 {

	static readonly ID = 'kingu.vault.search';

	constructor() {
		super({
			id: SearchKinguVaultAction.ID,
			title: localize2('kingu.vault.search', "Kingu: Search Vault"),
			category: Categories.View,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const vaultService = accessor.get(IKinguVaultService);
		const editorService = accessor.get(IEditorService);

		const query = await quickInputService.input({
			title: localize('kingu.vault.search.title', "Search Kingu Vault"),
			prompt: localize('kingu.vault.search.prompt', "Text to find in past sessions from any agent."),
		});
		if (!query?.trim()) {
			return;
		}

		const source = new CancellationTokenSource();
		try {
			const picked = await quickInputService.pick(
				vaultService.search(query, source.token).then(results => results.map(result => toPick(result.session, result.excerpt))),
				{
					title: localize('kingu.vault.search.resultsTitle', "Kingu Vault: {0}", query),
					placeHolder: localize('kingu.vault.search.resultsPlaceholder', "Matching sessions"),
					matchOnDescription: true,
					matchOnDetail: true,
				});
			if (picked) {
				await editorService.openEditor({ resource: picked.session.resource, options: { pinned: true } });
			}
		} finally {
			// The search reads every transcript, so a dismissed picker has to stop it.
			source.dispose(true);
		}
	}
}

/** Forces the next read to re-scan, for a vault that changed outside this window. */
class RefreshKinguVaultAction extends Action2 {

	static readonly ID = 'kingu.vault.refresh';

	constructor() {
		super({
			id: RefreshKinguVaultAction.ID,
			title: localize2('kingu.vault.refresh', "Kingu: Refresh Vault"),
			category: Categories.View,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		accessor.get(IKinguVaultService).invalidate();
	}
}

/**
 * Continues a past session from another agent here.
 *
 * Separate from browsing because the two answer different questions: browsing
 * opens the file to read, this opens a live session that carries its history.
 */
class ContinueKinguVaultSessionAction extends Action2 {

	static readonly ID = 'kingu.vault.continue';

	constructor() {
		super({
			id: ContinueKinguVaultSessionAction.ID,
			title: localize2('kingu.vault.continue', "Kingu: Continue Vault Session"),
			category: Categories.View,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor, session?: IKinguVaultSession): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const vaultService = accessor.get(IKinguVaultService);

		// Invoked from a row, the session is already chosen; from the palette it
		// is not, so the same picker as Browse selects one.
		const chosen = session ?? (await quickInputService.pick(
			vaultService.getSessions().then(sessions => sessions.map(candidate => toPick(candidate))),
			{
				title: localize('kingu.vault.continue.pickTitle', "Continue a Session"),
				placeHolder: localize('kingu.vault.continue.pickPlaceholder', "Sessions from every agent on this machine"),
				matchOnDescription: true,
			}))?.session;
		if (!chosen) {
			return;
		}

		await continueVaultSession(chosen, {
			fileService: accessor.get(IFileService),
			quickInputService,
			notificationService: accessor.get(INotificationService),
			logService: accessor.get(ILogService),
			sessionsService: accessor.get(ISessionsService),
			sessionsManagementService: accessor.get(ISessionsManagementService),
			importConversationStore: accessor.get(IAgentHostImportConversationStore),
		});
	}
}

/**
 * Deletes a session's files from disk.
 *
 * Confirmed first and never undone by us: these are the user's own transcripts,
 * and the vault is a view of their disk rather than a store we own. The dialog
 * names the file so the confirmation is about a specific thing rather than a
 * count.
 */
class DeleteKinguVaultSessionAction extends Action2 {

	static readonly ID = 'kingu.vault.delete';

	constructor() {
		super({
			id: DeleteKinguVaultSessionAction.ID,
			title: localize2('kingu.vault.delete', "Kingu: Delete Vault Session"),
			category: Categories.View,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor, session?: IKinguVaultSession): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const vaultService = accessor.get(IKinguVaultService);
		const dialogService = accessor.get(IDialogService);
		const notificationService = accessor.get(INotificationService);

		const chosen = session ?? (await quickInputService.pick(
			vaultService.getSessions().then(sessions => sessions.map(candidate => toPick(candidate))),
			{
				title: localize('kingu.vault.delete.pickTitle', "Delete a Session"),
				placeHolder: localize('kingu.vault.delete.pickPlaceholder', "The transcript is moved to the recycle bin"),
				matchOnDescription: true,
			}))?.session;
		if (!chosen) {
			return;
		}

		const { confirmed } = await dialogService.confirm({
			type: 'warning',
			message: localize('kingu.vault.delete.confirm', "Delete this {0} session?", chosen.sourceLabel),
			detail: localize('kingu.vault.delete.detail', "{0}\n\n{1}\n\nThe transcript and any worker transcripts go to the recycle bin. {2} keeps its own copy of nothing — this is the only one.", chosen.title, chosen.resource.fsPath, chosen.sourceLabel),
			primaryButton: localize('kingu.vault.delete.confirmButton', "Delete"),
		});
		if (!confirmed) {
			return;
		}

		try {
			await vaultService.deleteSession(chosen);
		} catch (error) {
			notificationService.notify({
				severity: Severity.Error,
				message: localize('kingu.vault.delete.failed', "Could not delete this session: {0}", error instanceof Error ? error.message : String(error)),
			});
		}
	}
}

registerAction2(DeleteKinguVaultSessionAction);
registerAction2(ContinueKinguVaultSessionAction);
registerAction2(OpenKinguVaultAction);
registerAction2(BrowseKinguVaultAction);
registerAction2(SearchKinguVaultAction);
registerAction2(RefreshKinguVaultAction);
