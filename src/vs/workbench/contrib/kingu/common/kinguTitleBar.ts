/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';

/**
 * A status count in the pill, said in words: the agent's name when one
 * session is in that state ("Claude working"), the count when several are
 * ("3 working"). VS Code shows the bare number.
 */
export function kinguAgentStatusText(state: 'working' | 'waiting', sessions: readonly { readonly providerLabel: string }[]): string {
	if (sessions.length === 1) {
		return state === 'working'
			? localize('kingu.titleBar.agentWorking', "{0} working", sessions[0].providerLabel)
			: localize('kingu.titleBar.agentWaiting', "{0} waiting for you", sessions[0].providerLabel);
	}
	return state === 'working'
		? localize('kingu.titleBar.working', "{0} working", sessions.length)
		: localize('kingu.titleBar.waiting', "{0} waiting for you", sessions.length);
}
