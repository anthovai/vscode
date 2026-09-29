/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { AgentSessionsPicker } from '../../chat/browser/agentSessions/agentSessionsPicker.js';
import { ChatContextKeys } from '../../chat/common/actions/chatContextKeys.js';

/**
 * Kingu: the chat history, every past chat of every agent, searchable by name,
 * from the new-chat menu and the command palette. It is the list the chat
 * title opens, which is easy to miss.
 */
registerAction2(class KinguChatHistoryAction extends Action2 {
	constructor() {
		super({
			id: 'kingu.chat.showHistory',
			title: localize2('kingu.chat.showHistory', "Chat History"),
			icon: Codicon.history,
			f1: true,
			category: localize2('kingu.chat.category', "Chat"),
			precondition: ChatContextKeys.enabled,
			menu: [{
				id: MenuId.ChatNewMenu,
				group: '3_history',
				order: 1,
			}],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IInstantiationService).createInstance(AgentSessionsPicker, undefined, undefined).pickAgentSession();
	}
});
