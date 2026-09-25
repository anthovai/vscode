/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import type { AgentSignal } from '../../common/agent.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { ResponsePartKind } from '../../common/state/sessionState.js';

/**
 * Kingu: the SDK waits out a failed API request (`api_retry`) and a used-up
 * subscription limit (`rate_limit_event` with `rejected`) on its own, which
 * reads as a turn doing nothing. Each becomes a notice in the turn saying what
 * it waits for and how long, as the ADE shows a blocked agent's reason.
 */
export function mapClaudeWaitNotice(message: SDKMessage, chat: URI, turnId: string): AgentSignal[] {
	if (message.type === 'system' && message.subtype === 'api_retry') {
		const seconds = Math.max(1, Math.round(message.retry_delay_ms / 1000));
		const cause = message.error_status === null
			? localize('claude.retry.connection', "a connection error")
			: localize('claude.retry.status', "an API error ({0})", message.error_status);
		return [notice(chat, turnId, localize('claude.retry', "Claude hit {0} and retries in {1} seconds (attempt {2} of {3}).", cause, seconds, message.attempt, message.max_retries))];
	}
	if (message.type === 'rate_limit_event' && message.rate_limit_info.status === 'rejected') {
		const resetsAt = message.rate_limit_info.resetsAt;
		return [notice(chat, turnId, resetsAt
			? localize('claude.limit.resets', "Claude's usage limit is reached; it resets at {0}.", new Date(resetsAt * 1000).toLocaleString())
			: localize('claude.limit', "Claude's usage limit is reached."))];
	}
	return [];
}

function notice(chat: URI, turnId: string, content: string): AgentSignal {
	return { kind: 'action', resource: chat, action: { type: ActionType.ChatResponsePart, turnId, part: { kind: ResponsePartKind.SystemNotification, content } } };
}
