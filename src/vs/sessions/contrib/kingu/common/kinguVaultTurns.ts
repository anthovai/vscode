/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { MessageKind, ResponsePartKind, TurnState, type Turn } from '../../../../platform/agentHost/common/state/sessionState.js';
import { readTranscriptExchanges } from './kinguVault.js';

/**
 * How many past exchanges are carried into a continued session.
 *
 * The whole history of a long session is far more context than the agent will
 * accept, and the oldest turns are the least useful; the most recent ones are
 * what the user means by "continue this". A bound here is also what keeps the
 * import from depending on how much work the session happened to contain.
 */
export const MAX_IMPORTED_EXCHANGES = 40;

/**
 * Turns the vault can hand to the agent host to continue a past session.
 *
 * The agent host imports these as real, editable turns rather than as a pasted
 * transcript, so the continued session can be forked and truncated like any
 * other. What crosses is the conversation — the user asked this, the agent
 * answered that.
 *
 * Tool calls are deliberately left behind. Their results describe a working
 * tree as it was at the time, and replaying them as if they were this session's
 * own would state things about the repository that may no longer be true. The
 * agent re-reads what it needs.
 */
export function transcriptToTurns(transcript: string, newId: () => string): Turn[] {
	const exchanges = readTranscriptExchanges(transcript);
	const recent = exchanges.length > MAX_IMPORTED_EXCHANGES
		? exchanges.slice(-MAX_IMPORTED_EXCHANGES)
		: exchanges;
	return recent.map(exchange => ({
		id: newId(),
		...(exchange.startedAt !== undefined && { startedAt: exchange.startedAt }),
		message: {
			text: exchange.prompt,
			origin: { kind: MessageKind.User },
		},
		responseParts: exchange.response
			? [{ kind: ResponsePartKind.Markdown as const, id: newId(), content: exchange.response }]
			: [],
		usage: undefined,
		// Every turn being imported already finished, however it finished. The
		// distinction between a completed and a cancelled past turn is not
		// recoverable from these formats and does not change what continues.
		state: TurnState.Complete,
	}));
}
