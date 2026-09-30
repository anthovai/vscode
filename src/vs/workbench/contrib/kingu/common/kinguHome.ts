/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ChatSessionStatus } from '../../chat/common/chatSessionsService.js';

/** Setting: Kingu's home in the empty editor area (`browser/kinguHome.ts`). */
export const KINGU_HOME_SETTING = 'kingu.home.enabled';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'kingu.home',
	title: localize('kingu.home.configuration', "Kingu Home"),
	type: 'object',
	properties: {
		[KINGU_HOME_SETTING]: {
			type: 'boolean',
			default: true,
			markdownDescription: localize('kingu.home.enabled', "Show your recent agent chats, across every project, and your recent projects in the editor area while no editor is open."),
		},
	},
});

/** What the home needs of an agent session. */
export interface IKinguHomeSession {
	readonly status: ChatSessionStatus;
	isArchived(): boolean;
	readonly timing: { readonly created: number; readonly lastRequestStarted?: number; readonly lastRequestEnded?: number };
}

/** Chats an agent is on, or waits in. */
const ACTIVE_STATUSES = new Set([ChatSessionStatus.InProgress, ChatSessionStatus.NeedsInput]);

/**
 * The chats to pick up again: begun (a chat view's fresh, empty chat is not
 * one) and not archived, the ones an agent is working on or waiting in first,
 * then the most recently active.
 */
export function kinguHomeSessions<T extends IKinguHomeSession>(sessions: readonly T[], max: number): T[] {
	const lastActive = (session: T) => session.timing.lastRequestEnded ?? session.timing.lastRequestStarted ?? session.timing.created;
	return sessions
		.filter(session => session.timing.lastRequestStarted !== undefined && !session.isArchived())
		.sort((a, b) => Number(ACTIVE_STATUSES.has(b.status)) - Number(ACTIVE_STATUSES.has(a.status)) || lastActive(b) - lastActive(a))
		.slice(0, max);
}
