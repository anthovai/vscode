/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

/** Setting: Arkai completes code as you type, on the user's own Ollama (`browser/kinguInlineCompletions.ts`). */
export const KINGU_COMPLETIONS_ENABLED_SETTING = 'kingu.arkai.completions.enabled';
/** Setting: the Ollama model that completes; empty picks Chyle, else the first coding model. */
export const KINGU_COMPLETIONS_MODEL_SETTING = 'kingu.arkai.completions.model';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'kingu.arkai.completions',
	title: localize('kingu.completions.configuration', "Arkai Completions"),
	type: 'object',
	properties: {
		[KINGU_COMPLETIONS_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			markdownDescription: localize('kingu.completions.enabled', "Suggest the rest of the code as you type, shown as grey text; `Tab` accepts it. Runs on your own models (Ollama), so nothing leaves this computer."),
		},
		[KINGU_COMPLETIONS_MODEL_SETTING]: {
			type: 'string',
			default: '',
			markdownDescription: localize('kingu.completions.model', "The Ollama model that completes code. Leave empty to use Chyle, or the first coding model installed. It must know fill-in-the-middle (Qwen coder models do)."),
		},
	},
});

/** Qwen's fill-in-the-middle tokens: the code before, the code after, then what goes between. */
const FIM_PREFIX = '<|fim_prefix|>';
const FIM_SUFFIX = '<|fim_suffix|>';
const FIM_MIDDLE = '<|fim_middle|>';

/** Where the model stops: the end of its fill, or the start of another file. */
export const FIM_STOP = ['<|endoftext|>', '<|fim_pad|>', '<|file_sep|>', '<|fim_prefix|>', '<|im_end|>'];

const MAX_PREFIX_CHARS = 4000;
const MAX_SUFFIX_CHARS = 1500;

/** The prompt for the text between `prefix` and `suffix`, each cut to what the model reads quickly, nearest the cursor kept. */
export function buildFimPrompt(prefix: string, suffix: string): string {
	return `${FIM_PREFIX}${prefix.slice(-MAX_PREFIX_CHARS)}${FIM_SUFFIX}${suffix.slice(0, MAX_SUFFIX_CHARS)}${FIM_MIDDLE}`;
}

/**
 * The completion as the editor should show it: stop tokens gone, not
 * repeating the code that already follows the cursor, and nothing when it is
 * only whitespace.
 */
export function cleanCompletion(text: string, suffix: string): string | undefined {
	let result = text;
	for (const stop of FIM_STOP) {
		const at = result.indexOf(stop);
		if (at >= 0) {
			result = result.slice(0, at);
		}
	}
	result = dropRepeats(result);
	// A model that closes a bracket the file already closes would double it.
	const nextLine = suffix.split(/\r?\n/, 1)[0].trim();
	if (nextLine && result.trimEnd().endsWith(nextLine)) {
		result = result.trimEnd().slice(0, -nextLine.length);
	}
	result = result.replace(/\s+$/, match => match.includes('\n') ? '' : match);
	return result.trim() ? result : undefined;
}

/** The shortest run a small model loops on that counts as a loop rather than code. */
const MIN_REPEAT = 6;

/**
 * The text up to where it starts repeating itself: a small model that loses
 * the thread writes the same few words again and again until it runs out of
 * tokens (`a + b;  // return a + b;  // return a + b;`). It is cut where
 * the first round of the loop ends a statement, else after that round.
 */
function dropRepeats(text: string): string {
	for (let start = 0; start < text.length; start++) {
		for (let length = MIN_REPEAT; start + length * 2 <= text.length; length++) {
			const unit = text.slice(start, start + length);
			if (unit.trim() && text.startsWith(unit, start + length)) {
				const statementEnd = unit.search(/[;})\]](?=\s|$)/);
				return text.slice(0, statementEnd >= 0 ? start + statementEnd + 1 : start + length);
			}
		}
	}
	return text;
}

/** Whether the cursor has code before it on its line, where only the rest of that line is wanted. */
export function isMidLine(prefix: string): boolean {
	return /\S/.test(prefix.slice(prefix.lastIndexOf('\n') + 1));
}
