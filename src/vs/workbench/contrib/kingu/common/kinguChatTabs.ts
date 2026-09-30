/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

/** Setting: the chat view's header is a row of agent tabs (`browser/kinguChatTabs.ts`). */
export const KINGU_CHAT_TABS_SETTING = 'kingu.chat.tabs';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'kingu.chat',
	title: localize('kingu.chat.configuration', "Kingu Chat"),
	type: 'object',
	properties: {
		[KINGU_CHAT_TABS_SETTING]: {
			type: 'boolean',
			default: true,
			markdownDescription: localize('kingu.chat.tabs', "Show the chats you have open as tabs at the top of the chat view, with each agent's status. Chats an agent is working on, or that wait for you, open a tab of their own."),
		},
	},
});

/** `tabs` with each of `resources` it lacks added at the end, in order. */
export function kinguChatTabsWith(tabs: readonly URI[], resources: readonly URI[]): URI[] {
	const result = [...tabs];
	for (const resource of resources) {
		if (!result.some(tab => isEqual(tab, resource))) {
			result.push(resource);
		}
	}
	return result;
}

/**
 * The tabs once `closed` is closed, and the chat to show instead when it was
 * the active one: the tab after it, else the one before, as the editor does;
 * `undefined` when none is left.
 */
export function kinguChatTabsAfterClose(tabs: readonly URI[], closed: URI, active: URI | undefined): { tabs: URI[]; next: URI | undefined } {
	const index = tabs.findIndex(tab => isEqual(tab, closed));
	const rest = tabs.filter(tab => !isEqual(tab, closed));
	if (index < 0 || !isEqual(closed, active)) {
		return { tabs: rest, next: undefined };
	}
	return { tabs: rest, next: rest[index] ?? rest[index - 1] };
}
