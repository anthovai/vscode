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
import { IKinguVaultSearchOutcome, IKinguVaultService, IKinguVaultSession } from '../common/kinguVault.js';
import { formatTokens, IKinguUsage, totalTokens, uncachedTokens } from '../common/kinguVaultUsage.js';
import { KINGU_VAULT_SOURCES } from '../common/kinguVaultSources.js';
import { KinguVaultService } from './kinguVaultService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IAgentHostImportConversationStore } from '../../../../workbench/contrib/chat/browser/agentSessions/agentHost/agentHostImportConversationStore.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
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

/** The split behind a total, which is where the surprise usually is. */
function usageDetail(usage: IKinguUsage): string {
	return localize('kingu.vault.usage.detail', "in {0} · out {1} · cache read {2} · cache write {3} · {5} all in{4}",
		formatTokens(usage.inputTokens),
		formatTokens(usage.outputTokens),
		formatTokens(usage.cacheReadTokens),
		formatTokens(usage.cacheWriteTokens),
		usage.models.length > 0 ? ' · ' + usage.models.join(', ') : '',
		formatTokens(totalTokens(usage)));
}

/**
 * The path as the machine holding the file writes it.
 *
 * `fsPath` is this desktop's idea of a path, so a Linux host's
 * `/home/dev/.claude/…` came back with backslashes — a path that exists
 * nowhere, shown at the moment a person is deciding whether the thing they are
 * about to delete is the thing they meant.
 */
function sessionPath(session: IKinguVaultSession): string {
	return session.hostLabel ? session.resource.path : session.resource.fsPath;
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
 * How many matches a search collects before it stops reading.
 *
 * A person searching their history is looking for one session. Past a screenful
 * the extra results are not what makes the search useful, and every one of them
 * cost a transcript read — over a remote host, a read across the wire.
 */
const MAX_SEARCH_RESULTS = 50;

/**
 * What a search has to admit about itself, or nothing when it read everything.
 *
 * Shown because the alternative is a list that looks complete and is not: a
 * remote host whose allowance ran out returns no matches from the transcripts
 * it never opened, which is indistinguishable from having none.
 */
function searchFootnote(outcome: IKinguVaultSearchOutcome): string | undefined {
	if (outcome.stopped === 'maxResults') {
		return localize('kingu.vault.search.capped', "First {0} matches, from {1} of {2} sessions.", outcome.results.length, outcome.searched, outcome.total);
	}
	if (outcome.stopped === 'budget') {
		return localize('kingu.vault.search.truncated', "{0} matches. Not every session on {1} was read.", outcome.results.length, outcome.truncatedHosts.join(', '));
	}
	if (outcome.stopped === 'cancelled') {
		return localize('kingu.vault.search.cancelled', "Stopped after {0} of {1} sessions.", outcome.searched, outcome.total);
	}
	return undefined;
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
		const picker = quickInputService.createQuickPick<IVaultPick>();
		try {
			picker.title = localize('kingu.vault.search.resultsTitle', "Kingu Vault: {0}", query);
			picker.placeholder = localize('kingu.vault.search.resultsPlaceholder', "Matching sessions");
			picker.matchOnDescription = true;
			picker.matchOnDetail = true;
			picker.busy = true;
			picker.show();

			// One promise for the whole picker, settled by whichever comes first.
			// Written this way rather than awaited in two steps because hiding can
			// happen during the walk, and an `onDidHide` registered afterwards would
			// be waiting for an event that has already gone by.
			let settle!: (picked: IVaultPick | undefined) => void;
			const chosen = new Promise<IVaultPick | undefined>(resolve => { settle = resolve; });
			picker.onDidAccept(() => settle(picker.selectedItems[0]));
			// Dismissing the picker is the user saying they are done waiting, and the
			// walk is reading transcripts across every machine until it is told so.
			picker.onDidHide(() => { source.cancel(); settle(undefined); });

			// Filled as matches arrive rather than at the end. Over a remote host most
			// of the wait is the last transcripts, and a list that is usable while
			// they are still being read is the difference between a search and a stall.
			const found: IVaultPick[] = [];
			void vaultService.search(query, {
				maxResults: MAX_SEARCH_RESULTS,
				onResult: result => {
					found.push(toPick(result.session, result.excerpt));
					picker.items = found;
				},
			}, source.token).then(outcome => {
				if (source.token.isCancellationRequested) {
					return;
				}
				picker.busy = false;
				// Re-set from the outcome rather than left in arrival order: the walk
				// finishes out of order, and newest-first is the order a person reads
				// their own history in.
				picker.items = outcome.results.map(result => toPick(result.session, result.excerpt));
				picker.placeholder = searchFootnote(outcome) ?? picker.placeholder;
			});

			const picked = await chosen;
			if (picked) {
				await editorService.openEditor({ resource: picked.session.resource, options: { pinned: true } });
			}
		} finally {
			picker.dispose();
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
				placeHolder: localize('kingu.vault.delete.pickPlaceholder', "The transcript is deleted from the machine it is on"),
				matchOnDescription: true,
			}))?.session;
		if (!chosen) {
			return;
		}

		const { confirmed } = await dialogService.confirm({
			type: 'warning',
			message: chosen.hostLabel
				? localize('kingu.vault.delete.confirmRemote', "Delete this {0} session on {1}?", chosen.sourceLabel, chosen.hostLabel)
				: localize('kingu.vault.delete.confirm', "Delete this {0} session?", chosen.sourceLabel),
			// A remote session says so twice — in the question and in the warning —
			// because the one thing a person must not do here is delete a file on a
			// machine they thought was this one. The promise differs by machine too:
			// a recycle bin belongs to this desktop, and a host reached over the
			// agent connection has none, so the file is simply gone.
			detail: chosen.hostLabel
				? localize('kingu.vault.delete.detailRemote', "{0}\n\n{1}\n\nThis file is on {2}, which has no recycle bin: it and any worker transcripts are deleted outright and cannot be recovered.", chosen.title, sessionPath(chosen), chosen.hostLabel)
				: localize('kingu.vault.delete.detail', "{0}\n\n{1}\n\nThe transcript and any worker transcripts go to the recycle bin. {2} keeps its own copy of nothing — this is the only one.", chosen.title, sessionPath(chosen), chosen.sourceLabel),
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

/**
 * Totals what every indexed session spent.
 *
 * A full pass over the vault — every transcript read whole — so it runs behind
 * a cancellable progress notification rather than pretending to be instant.
 */
class KinguVaultUsageReportAction extends Action2 {

	static readonly ID = 'kingu.vault.usage';

	constructor() {
		super({
			id: KinguVaultUsageReportAction.ID,
			title: localize2('kingu.vault.usage', "Kingu: Vault Usage Report"),
			category: Categories.View,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const vaultService = accessor.get(IKinguVaultService);
		const progressService = accessor.get(IProgressService);
		const quickInputService = accessor.get(IQuickInputService);

		const summary = await progressService.withProgress({
			location: ProgressLocation.Notification,
			title: localize('kingu.vault.usage.progressTitle', "Reading vault usage"),
			cancellable: true,
		}, progress => vaultService.getUsageSummary(undefined, (done, total) => {
			progress.report({
				message: localize('kingu.vault.usage.progress', "{0} of {1} sessions", done, total),
				increment: total > 0 ? 100 / total : undefined,
			});
		}), () => { /* cancelled: the partial total is not worth showing */ });

		if (!summary) {
			return;
		}
		const rows: IQuickPickItem[] = [{
			label: localize('kingu.vault.usage.total', "All agents"),
			description: formatTokens(uncachedTokens(summary.total)),
			detail: usageDetail(summary.total),
		}];
		for (const [source, usage] of summary.bySource) {
			rows.push({
				label: KINGU_VAULT_SOURCES.find(candidate => candidate.id === source)?.label ?? source,
				description: formatTokens(uncachedTokens(usage)),
				detail: usageDetail(usage),
			});
		}
		await quickInputService.pick(rows, {
			title: localize('kingu.vault.usage.title', "Vault usage — {0} of {1} sessions recorded tokens", summary.sessionsRead, summary.sessionsTotal),
			placeHolder: localize('kingu.vault.usage.placeholder', "Input and output tokens; cache reads are listed separately because they dwarf both. Tokens, not cost."),
		});
	}
}

registerAction2(KinguVaultUsageReportAction);
registerAction2(DeleteKinguVaultSessionAction);
registerAction2(ContinueKinguVaultSessionAction);
registerAction2(OpenKinguVaultAction);
registerAction2(BrowseKinguVaultAction);
registerAction2(SearchKinguVaultAction);
registerAction2(RefreshKinguVaultAction);
