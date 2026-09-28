/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IAgentHostEnablementService } from '../../../../platform/agentHost/common/agentHostEnablementService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ChatViewId } from '../../chat/browser/chat.js';
import { ChatViewPane } from '../../chat/browser/widgetHosts/viewPane/chatViewPane.js';
import { IChatSessionsService, localChatSessionType } from '../../chat/common/chatSessionsService.js';
import { getDefaultNewChatSessionTypeAndReasonFromServices } from '../../chat/common/constants.js';
import { getChatSessionType, getNewChatSessionResource } from '../../chat/common/model/chatUri.js';

/**
 * Kingu: moves the IDE's first, untouched chat onto Arkai once Arkai is there.
 *
 * The chat view opens its first chat before the agent host has registered its
 * agents, so that chat starts on the Local harness, which in Kingu has no
 * models until the user adds some. When the agents arrive and the default
 * becomes one of them (Arkai first), a chat nobody has typed in yet is
 * replaced by a new one on that default. Once the user has used the chat, or
 * it has moved, this does nothing more.
 */
export class KinguDefaultChatSessionContribution extends Disposable {

	static readonly ID = 'workbench.contrib.kingu.defaultChatSession';

	private readonly _listener = this._register(new MutableDisposable());

	constructor(
		@IProductService productService: IProductService,
		@IChatSessionsService private readonly _chatSessionsService: IChatSessionsService,
		@IViewsService private readonly _viewsService: IViewsService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IStorageService private readonly _storageService: IStorageService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IAgentHostEnablementService private readonly _agentHostEnablementService: IAgentHostEnablementService,
	) {
		super();
		if (!productService.kinguDisableCopilot) {
			return;
		}
		this._listener.value = this._chatSessionsService.onDidChangeAvailability(() => this._moveUntouchedLocalChat());
		this._moveUntouchedLocalChat();
	}

	private _moveUntouchedLocalChat(): void {
		const view = this._viewsService.getViewWithId<ChatViewPane>(ChatViewId);
		const widget = view?.widget;
		const model = widget?.viewModel?.model;
		if (!view || !widget || !model) {
			return;
		}
		if (getChatSessionType(model.sessionResource) !== localChatSessionType || model.hasRequests || widget.getInput().length > 0) {
			// The chat is already on an agent, or the user has started on it.
			this._listener.clear();
			return;
		}
		const resolved = getDefaultNewChatSessionTypeAndReasonFromServices(
			this._configurationService,
			this._chatSessionsService,
			this._storageService,
			this._workspaceContextService.getWorkspace(),
			this._agentHostEnablementService.enabled.get(),
			undefined,
			this._agentHostEnablementService.managedSandboxEnforced.get(),
		);
		if (resolved.sessionType === localChatSessionType) {
			return;
		}
		this._listener.clear();
		void view.loadSession(getNewChatSessionResource(resolved.sessionType), resolved.selectionReason);
	}
}
