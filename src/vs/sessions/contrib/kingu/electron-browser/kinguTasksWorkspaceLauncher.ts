/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { WorkspaceSelectionOrigin } from '../../../common/workspaceSelection.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { ISessionsPartService } from '../../../services/sessions/browser/sessionsPartService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { AgentsWindowWorkspaceHandoff } from '../../chat/browser/agentsWindowWorkspaceHandoff.js';
import { INewSessionComposerService } from '../../chat/browser/newSessionComposerService.js';
import { getRepoHostId } from '../common/kinguTasksGitHub.js';
import { getStartWorkspacePrompt, getTaskReference, getTaskRepo, IKinguTaskRef } from '../common/kinguTasksDetail.js';

/** How long the new-session page gets to mount its input before the prompt is given up on. */
const COMPOSER_READY_TIMEOUT_MS = 10_000;

export const IKinguTasksWorkspaceLauncher = createDecorator<IKinguTasksWorkspaceLauncher>('kinguTasksWorkspaceLauncher');

export interface IKinguTasksWorkspaceLauncher {
	readonly _serviceBrand: undefined;
	/** Closes Tasks and opens the new-session page with the task's prompt waiting in it. */
	start(ref: IKinguTaskRef): Promise<void>;
}

/**
 * The ADE's "Start workspace" from a task (`launchWorkItemDirect` opening the
 * new-workspace composer): the Tasks page closes, the new-session page opens on
 * the task's project, and the ADE's prompt waits in its input, so the reader
 * picks the agent and isolation and sends it themselves.
 *
 * It goes through the handoff the editor's "Continue in Agents" uses. That
 * handoff keeps a draft the reader was already writing; here the reader asked
 * for this task, so the prompt goes in anyway and the earlier text can be put
 * back from the notification.
 *
 * A service rather than part of the Tasks page: closing the page disposes it,
 * and the hand-off has to outlive that.
 */
class KinguTasksWorkspaceLauncher extends Disposable implements IKinguTasksWorkspaceLauncher {

	declare readonly _serviceBrand: undefined;

	private readonly _handoff: AgentsWindowWorkspaceHandoff;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@ICustomViewService private readonly _customViewService: ICustomViewService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ISessionsService private readonly _sessionsService: ISessionsService,
		@ISessionsPartService private readonly _sessionsPartService: ISessionsPartService,
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
		@INewSessionComposerService private readonly _composerService: INewSessionComposerService,
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
		let kept = false;
		await this._handoff.selectWorkspace({
			folderUri,
			preferDevContainer: false,
			isDefault: false,
			draft: { inputText: prompt, attachments: '[]' },
		}, state => {
			if (state === 'preservedSession') {
				kept = true;
			}
		});
		if (kept) {
			await this._replaceDraft(ref, prompt, folderUri);
		}
	}

	/** Opens the new-session page and puts the task's prompt in its input, over whatever was there. */
	private async _replaceDraft(ref: IKinguTaskRef, prompt: string, folderUri: URI | undefined): Promise<void> {
		await this._sessionsService.openNewSession({ cancelRestore: true }, CancellationToken.None);
		const deadline = Date.now() + COMPOSER_READY_TIMEOUT_MS;
		while (!this._store.isDisposed) {
			const view = this._sessionsPartService.getSessionView(this._sessionsService.activeSession.get()?.sessionId);
			const resolved = folderUri ? this._sessionsManagementService.resolveWorkspace(folderUri) : undefined;
			const composer = this._composerService.activeComposer.get();
			if (view && composer?.isInputReady && (!folderUri || resolved)) {
				const earlier = composer.getInputValue?.().trim();
				if (folderUri) {
					view.selectWorkspace(folderUri, { providerId: resolved?.providerId, selectionOrigin: WorkspaceSelectionOrigin.WindowOpen });
				}
				view.prefillInput(prompt);
				if (earlier && earlier !== prompt) {
					this._notificationService.prompt(Severity.Info,
						localize('kingu.tasks.start.draftReplaced', "The new session now has the prompt for {0}. Your earlier draft was replaced.", getTaskReference(ref)),
						[{ label: localize('kingu.tasks.start.restoreDraft', "Restore Earlier Draft"), run: () => view.prefillInput(earlier) }]);
				}
				return;
			}
			if (Date.now() >= deadline) {
				this._notificationService.warn(localize('kingu.tasks.start.notReady', "The new session page did not open in time. Try Start Workspace on {0} again.", getTaskReference(ref)));
				return;
			}
			await timeout(100);
		}
	}
}

registerSingleton(IKinguTasksWorkspaceLauncher, KinguTasksWorkspaceLauncher, InstantiationType.Delayed);
