/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { JevAnswer, JevQuestion } from '../../../../platform/kinguHost/common/kinguJev.js';

/**
 * What an agent CLI in a terminal is doing, as Jev reads its latest output.
 *
 * The ADE learns this from hooks it installs into each agent. A terminal in
 * this window has no hook — only its output — so the output is what is asked
 * about, and only for terminals that are running an agent.
 */
export const enum KinguAgentTerminalStatus {
	Working = 'working',
	NeedsInput = 'needs_input',
	Done = 'done',
	Error = 'error',
}

/** The one question asked of each quiet agent terminal. */
export const AGENT_STATUS_QUESTION: JevQuestion = {
	type: 'choice',
	instructions: 'The state is the most recent output of a terminal running an AI coding agent CLI (such as Claude Code or Codex). What is the agent doing right now?',
	criteria: {
		[KinguAgentTerminalStatus.Working]: 'Still working: thinking, running tools, editing files or streaming output, and has not stopped to wait for the user.',
		[KinguAgentTerminalStatus.NeedsInput]: 'Stopped and waiting for the user: asking a question, asking for permission or approval, or showing a choice or confirmation prompt.',
		[KinguAgentTerminalStatus.Done]: 'Finished its task and returned to its idle input prompt with nothing pending.',
		[KinguAgentTerminalStatus.Error]: 'Stopped because of an error, a crash, an authentication failure or a rate limit.',
	},
};

/** Below this confidence the answer is not acted on: a wrong "needs input" is worse than none. */
export const AGENT_STATUS_MIN_CONFIDENCE = 0.6;

/** The status in an answer, when it is one of ours and confident enough. */
export function agentStatusFromAnswer(answer: JevAnswer | undefined, minConfidence = AGENT_STATUS_MIN_CONFIDENCE): KinguAgentTerminalStatus | undefined {
	if (answer?.type !== 'choice' || answer.confidence < minConfidence) {
		return undefined;
	}
	switch (answer.choice) {
		case KinguAgentTerminalStatus.Working:
		case KinguAgentTerminalStatus.NeedsInput:
		case KinguAgentTerminalStatus.Done:
		case KinguAgentTerminalStatus.Error:
			return answer.choice;
		default:
			return undefined;
	}
}

/**
 * The agent CLIs whose terminals are watched, by the name a terminal carries
 * (its title or its process). Nothing else is ever sent: a shell running a
 * build is not asked about, so its output never leaves the machine.
 */
const AGENT_NAMES = /(^|[\s/\\(\[:'"-])(claude|codex|gemini|kimi|grok|opencode|aider|amp|cursor-agent|qwen|goose)(\.exe|\.cmd)?($|[\s)\]:'".,-])/i;

export function isAgentTerminalName(...names: readonly (string | undefined)[]): boolean {
	return names.some(name => !!name && AGENT_NAMES.test(name));
}

/**
 * Input that only reports the terminal gaining or losing focus (`ESC [ I`,
 * `ESC [ O`, sent when the program asked for focus events): not the user typing.
 */
export function isFocusReport(data: string): boolean {
	return /^(\u001b\[[IO])+$/.test(data);
}

// ESC [ … final, ESC ] … (BEL | ESC \), other two-byte escapes.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** Terminal output as a person would read it: escapes removed, a line redrawn after `\r` kept only as its last draw. */
export function plainTerminalText(data: string): string {
	return data
		.replace(ANSI, '')
		.split('\n')
		.map(line => {
			const trimmed = line.replace(/\r+$/, '');
			const last = trimmed.lastIndexOf('\r');
			return last === -1 ? trimmed : trimmed.slice(last + 1);
		})
		.join('\n');
}

/** The last stretch of a terminal's output, bounded, as plain text. */
export class TerminalOutputTail {

	private _text = '';

	constructor(private readonly _maxChars = 6000) { }

	append(data: string): void {
		this._text = (this._text + data).slice(-this._maxChars * 2);
	}

	/** The tail as plain text, blank runs collapsed, at most `maxChars`. */
	read(): string {
		return plainTerminalText(this._text).replace(/\n{3,}/g, '\n\n').trim().slice(-this._maxChars);
	}

	clear(): void {
		this._text = '';
	}
}
