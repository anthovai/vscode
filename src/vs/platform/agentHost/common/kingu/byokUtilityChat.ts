/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { IByokLmChatResult, IByokLmInputItem, IByokLmModelInfo } from '../agentHostByokLm.js';

/**
 * A short, one-shot request — a pull request title, a commit message — sent to
 * whatever model the window has.
 *
 * The agent host's own utility completions go to Copilot, and throw when the
 * user is not signed into it. That is the right default and the wrong only
 * option: a person running Claude or Codex through this window has a perfectly
 * good model and is told to sign into a third one to get a sentence written.
 *
 * The BYOK bridge is how the host reaches the window's models, and it already
 * exists for the agent SDK. This is the same road for a utility call.
 */

/** A system instruction and a user message, which is all a utility call is. */
export interface IKinguUtilityPrompt {
	readonly instructions: string;
	readonly prompt: string;
}

/** The names that mark a provider's small, fast tier. */
const SMALL_MODEL_HINTS = ['haiku', 'mini', 'nano', 'flash', 'small', 'lite', 'turbo'];

/**
 * Which model to ask.
 *
 * A utility call wants the cheapest model that can write a paragraph, not the
 * best one: the user is paying for it and did not ask for it. The small tiers
 * are recognised by name, which is a heuristic — and a heuristic is acceptable
 * here precisely because being wrong costs a slightly more expensive call
 * rather than a wrong answer.
 *
 * `undefined` when the window has no models at all, which is the caller's cue
 * to say so rather than to fail obscurely.
 */
export function pickUtilityModel(models: readonly IByokLmModelInfo[]): IByokLmModelInfo | undefined {
	const named = (model: IByokLmModelInfo) => `${model.id} ${model.name ?? ''}`.toLowerCase();
	return models.find(model => SMALL_MODEL_HINTS.some(hint => named(model).includes(hint))) ?? models[0];
}

/** The prompt as the bridge's wire shape. */
export function toByokInput(prompt: IKinguUtilityPrompt): IByokLmInputItem[] {
	return [{
		type: 'message',
		role: 'user',
		content: [{ type: 'text', text: prompt.prompt }],
	}];
}

/**
 * The text a model replied with, or `undefined` when it replied with none.
 *
 * A result can carry reasoning and tool calls beside the message; only the
 * message parts are the answer. An empty string is treated as no answer,
 * because a caller that parses a title out of it would otherwise produce an
 * empty title rather than an error.
 */
export function readByokText(result: IByokLmChatResult): string | undefined {
	if (result.error) {
		return undefined;
	}
	const text = result.output
		.filter(item => item.type === 'message')
		.flatMap(item => item.content)
		.filter(part => part.type === 'text')
		.map(part => part.text)
		.join('')
		.trim();
	return text || undefined;
}
