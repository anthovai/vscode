/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IStatusbarService } from '../../../services/statusbar/browser/statusbar.js';

/** Set once the entries below were hidden, so a user who shows them again keeps them. */
const DONE_KEY = 'kingu.statusBar.scmEntriesHidden';

/**
 * The branch and its sync button (`status.scm.*`) go from the status bar: the
 * title bar names the branch and switches it (`kinguTitleBarContext.ts`), and
 * the ADE's footer has the status bar's room. They are hidden the way a user
 * hides an entry, once, so right-clicking the status bar brings them back.
 */
export class KinguStatusBarCleanup implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.kinguStatusBarCleanup';

	constructor(
		@IStatusbarService statusbarService: IStatusbarService,
		@IStorageService storageService: IStorageService,
	) {
		if (storageService.getBoolean(DONE_KEY, StorageScope.PROFILE, false)) {
			return;
		}
		for (const id of ['status.scm.0', 'status.scm.1', 'status.scm.2', 'status.scm.provider']) {
			statusbarService.updateEntryVisibility(id, false);
		}
		storageService.store(DONE_KEY, true, StorageScope.PROFILE, StorageTarget.USER);
	}
}
