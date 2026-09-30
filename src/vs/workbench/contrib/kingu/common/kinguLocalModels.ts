/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

/** Setting: start Ollama and load Chyle when Kingu opens (`electron-browser/kinguLocalModels.contribution.ts`). */
export const KINGU_LOCAL_MODELS_AUTO_START_SETTING = 'kingu.arkai.localModels.autoStart';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'kingu.arkai.localModels',
	title: localize('kingu.localModels.configuration', "Arkai Local Models"),
	type: 'object',
	properties: {
		[KINGU_LOCAL_MODELS_AUTO_START_SETTING]: {
			type: 'boolean',
			default: true,
			markdownDescription: localize('kingu.localModels.autoStart', "Start Ollama and load Chyle in the background when Kingu opens, so completions, inline chat and semantic search answer without waiting for the model to load. Turn off to start them only when an Arkai session needs them."),
		},
	},
});

/** The user's own Ollama, where Arkai's local models run. */
export const KINGU_LOCAL_OLLAMA_URL = 'http://127.0.0.1:11434';

/** Models that embed, read images or transcribe rather than chat. */
const NOT_CHAT = /embed|bge|minilm|ocr|whisper|clip|rerank|tts/i;

/**
 * The installed models worth chatting with, Chyle (Arkai's own) first, then
 * coding models, then the rest in the order Ollama lists them.
 */
export function kinguLocalChatModels(installed: readonly string[]): string[] {
	const chat = installed.filter(name => !NOT_CHAT.test(name));
	const rank = (name: string) => /^chyle/i.test(name) ? 0 : /coder|code/i.test(name) ? 1 : 2;
	return chat
		.map((name, index) => ({ name, index }))
		.sort((a, b) => rank(a.name) - rank(b.name) || a.index - b.index)
		.map(entry => entry.name);
}
