/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IKinguVaultService, IKinguVaultSession, KinguVaultSource } from '../common/kinguVault.js';
import { KinguVaultService } from './kinguVaultService.js';

registerSingleton(IKinguVaultService, KinguVaultService, InstantiationType.Delayed);

interface IVaultPick extends IQuickPickItem {
	readonly session: IKinguVaultSession;
}

function sourceLabel(source: KinguVaultSource): string {
	return source === KinguVaultSource.Claude
		? localize('kingu.vault.source.claude', "Claude")
		: localize('kingu.vault.source.codex', "Codex");
}

function toPick(session: IKinguVaultSession, detail?: string): IVaultPick {
	return {
		session,
		label: session.title,
		description: session.workingDirectory
			? localize('kingu.vault.pick.description', "{0} · {1}", sourceLabel(session.source), session.workingDirectory)
			: sourceLabel(session.source),
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

registerAction2(BrowseKinguVaultAction);
registerAction2(SearchKinguVaultAction);
registerAction2(RefreshKinguVaultAction);
