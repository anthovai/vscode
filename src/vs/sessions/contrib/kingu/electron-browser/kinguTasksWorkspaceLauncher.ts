/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { AgentsWindowWorkspaceHandoff } from '../../chat/browser/agentsWindowWorkspaceHandoff.js';
import { getRepoHostId } from '../common/kinguTasksGitHub.js';
import { getStartWorkspacePrompt, getTaskReference, getTaskRepo, IKinguTaskRef } from '../common/kinguTasksDetail.js';

/**
 * The ADE's "Start workspace" from a task (`launchWorkItemDirect` opening the
 * new-workspace composer): the Tasks page closes and the Agents composer opens
 * on the task's project with the ADE's prompt typed in, so the reader picks
 * the agent and isolation and sends it themselves. It goes through the same
 * handoff the editor's "Continue in Agents" uses, which never overwrites a
 * draft the reader is writing.
 */
export class KinguTasksWorkspaceLauncher extends Disposable {

	private readonly _handoff: AgentsWindowWorkspaceHandoff;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@ICustomViewService private readonly _customViewService: ICustomViewService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
	) {
		super();
		this._handoff = this._register(instantiationService.createInstance(AgentsWindowWorkspaceHandoff));
	}

	async start(ref: IKinguTaskRef): Promise<void> {
		const prompt = getStartWorkspacePrompt(ref);
		const repo = getTaskRepo(ref);
		// Only a project on this machine is a folder the composer can open; a remote one is picked there.
		const folderUri = repo && getRepoHostId(repo) === 'local' ? URI.file(repo.path) : undefined;
		this._customViewService.hideCustomView();
		await this._handoff.selectWorkspace({
			folderUri,
			preferDevContainer: false,
			isDefault: false,
			draft: { inputText: prompt, attachments: '[]' },
		}, state => {
			if (state === 'preservedSession') {
				this._notificationService.prompt(Severity.Info,
					localize('kingu.tasks.start.draftKept', "The Agents composer already has a draft, so it was kept. Clear it and start {0} again, or copy the task's prompt.", getTaskReference(ref)),
					[{ label: localize('kingu.tasks.start.copyPrompt', "Copy Prompt"), run: () => this._clipboardService.writeText(prompt) }]);
			}
		});
	}
}
