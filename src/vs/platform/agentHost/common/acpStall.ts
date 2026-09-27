/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { JevQuestion, JevResult } from '../../kinguHost/common/kinguJev.js';

/**
 * Kingu: why an ACP agent's CLI has gone quiet in the middle of a turn. CLIs
 * retry rate limits and quota errors on their own, for minutes, with nothing
 * on the protocol to say so; what they write to stderr or their own log is the
 * only evidence.
 */
export const enum AcpStallReason {
	QuotaExhausted = 'quota_exhausted',
	RateLimited = 'rate_limited',
	SignedOut = 'signed_out',
	Network = 'network',
	Overloaded = 'overloaded',
	Working = 'working',
	Unknown = 'unknown',
}

/** A line that explains a wait: a retry, a rate limit, or a quota. */
const RETRY_HINT = /\b(429|retry|retrying|rate.?limit|quota|resource.?exhausted|overloaded|503|529|capacity)\b/i;

/** How much of a CLI's recent output is kept as evidence, from the end. */
export const ACP_STALL_EVIDENCE_CHARS = 6000;

/** Levels of a structured log line that say nothing about a failure; such lines are left out. */
const QUIET_LEVELS = /^(trace|debug|verbose|info)$/i;

/**
 * A CLI's output as readable lines. A structured log line (one JSON object, as
 * OMP writes) is read for its error or message, so the evidence is the words
 * and not the envelope, and only when it is a warning or an error.
 */
export function acpOutputLines(text: string): string[] {
	const lines: string[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) {
			continue;
		}
		if (line.startsWith('{')) {
			try {
				const entry = JSON.parse(line) as Record<string, unknown>;
				if (typeof entry.level === 'string' && QUIET_LEVELS.test(entry.level)) {
					continue;
				}
				const words = [entry.errorMessage, entry.error, entry.message].find((value): value is string => typeof value === 'string' && value.length > 0);
				if (words) {
					// A provider's error can span lines; kept as one, since it is shown in a sentence.
					lines.push(words.replace(/\s+/g, ' ').trim());
				}
				continue;
			} catch {
				// Not JSON after all; kept as written.
			}
		}
		lines.push(line);
	}
	return lines;
}

/** The last line that explains a wait, cut to a readable length. */
export function acpRetryHint(lines: readonly string[]): string | undefined {
	for (let i = lines.length - 1; i >= 0; i--) {
		if (RETRY_HINT.test(lines[i])) {
			return lines[i].length > 300 ? `${lines[i].slice(0, 300)}...` : lines[i];
		}
	}
	return undefined;
}

/** The one question Jev is asked about a quiet turn. */
export const ACP_STALL_QUESTIONS: Readonly<Record<string, JevQuestion>> = {
	reason: {
		type: 'choice',
		instructions: 'A coding agent CLI has sent nothing to its editor for a while in the middle of a turn. From its latest output, why is it quiet?',
		criteria: {
			[AcpStallReason.QuotaExhausted]: 'A quota or billing limit is used up (for example "exceeded your current quota", "insufficient credits", "check your plan and billing"); waiting will not help until it resets.',
			[AcpStallReason.RateLimited]: 'Requests are being throttled for a short time (429 "rate limit", "too many requests", "retry after N seconds") and the CLI is retrying.',
			[AcpStallReason.SignedOut]: 'The credentials are missing, expired or refused (401, 403, "invalid API key", "please log in").',
			[AcpStallReason.Network]: 'The provider cannot be reached (DNS, connection refused or reset, timeout, proxy or TLS errors).',
			[AcpStallReason.Overloaded]: 'The provider is overloaded or down (500, 502, 503, 529, "overloaded", "capacity").',
			[AcpStallReason.Working]: 'Nothing is wrong: the output shows ordinary progress, or there is no error at all.',
			[AcpStallReason.Unknown]: 'There is an error, but none of the other descriptions fits it.',
		},
	},
};

/** How sure Jev must be before its reason replaces the general notice. */
const MIN_CONFIDENCE = 0.6;

/** What Jev can be told about a quiet turn: the agent, how long it has been quiet, and its latest output. */
export function acpStallState(agent: string, secondsQuiet: number, lines: readonly string[]): string {
	let output = lines.join('\n');
	if (output.length > ACP_STALL_EVIDENCE_CHARS) {
		output = output.slice(-ACP_STALL_EVIDENCE_CHARS);
	}
	return JSON.stringify({ agent, secondsQuiet, latestOutput: output });
}

/** The reason Jev gave, when it gave a known one with confidence; `undefined` otherwise. */
export function acpStallReason(result: JevResult): AcpStallReason | undefined {
	if (!result.ok) {
		return undefined;
	}
	const answer = result.answers.reason;
	if (answer?.type !== 'choice' || answer.confidence < MIN_CONFIDENCE) {
		return undefined;
	}
	const known: readonly string[] = [AcpStallReason.QuotaExhausted, AcpStallReason.RateLimited, AcpStallReason.SignedOut, AcpStallReason.Network, AcpStallReason.Overloaded, AcpStallReason.Working];
	return known.includes(answer.choice) ? answer.choice as AcpStallReason : undefined;
}
