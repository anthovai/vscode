/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { InlineCompletionContext, InlineCompletions, InlineCompletionsProvider } from '../../../../editor/common/languages.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { buildFimPrompt, cleanCompletion, FIM_STOP, isMidLine, KINGU_COMPLETIONS_ENABLED_SETTING, KINGU_COMPLETIONS_MODEL_SETTING } from '../common/kinguCompletions.js';
import { KINGU_LOCAL_OLLAMA_URL, kinguLocalChatModels } from '../common/kinguLocalModels.js';

/** Typing on within this long cancels the request before it is sent. */
const DEBOUNCE_MS = 300;
const MAX_TOKENS = 64;
/** How long the installed model list is trusted before Ollama is asked again. */
const MODEL_CACHE_MS = 60_000;

/**
 * Arkai completes code as you type, as grey text that `Tab` accepts, the way
 * Copilot did before it left the product. The model is the user's own, on
 * Ollama (Chyle by default), asked for the text between the code before and
 * after the cursor.
 */
class KinguInlineCompletionsProvider implements InlineCompletionsProvider {

	readonly groupId = 'kingu.arkai';

	private _model: { name: string | undefined; at: number } | undefined;

	constructor(
		private readonly _configurationService: IConfigurationService,
		private readonly _logService: ILogService,
	) { }

	async provideInlineCompletions(model: ITextModel, position: Position, _context: InlineCompletionContext, token: CancellationToken): Promise<InlineCompletions | undefined> {
		if (this._configurationService.getValue<boolean>(KINGU_COMPLETIONS_ENABLED_SETTING) === false) {
			return undefined;
		}
		await timeout(DEBOUNCE_MS);
		if (token.isCancellationRequested) {
			return undefined;
		}
		const modelName = await this._modelName();
		if (!modelName || token.isCancellationRequested) {
			return undefined;
		}

		const lastLine = model.getLineCount();
		const prefix = model.getValueInRange(new Range(Math.max(1, position.lineNumber - 80), 1, position.lineNumber, position.column));
		const suffix = model.getValueInRange(new Range(position.lineNumber, position.column, Math.min(lastLine, position.lineNumber + 30), model.getLineMaxColumn(Math.min(lastLine, position.lineNumber + 30))));

		const abort = new AbortController();
		const listener = token.onCancellationRequested(() => abort.abort());
		try {
			const response = await fetch(`${KINGU_LOCAL_OLLAMA_URL}/api/generate`, {
				method: 'POST',
				signal: abort.signal,
				body: JSON.stringify({
					model: modelName,
					raw: true,
					stream: false,
					keep_alive: '30m',
					prompt: buildFimPrompt(prefix, suffix),
					// Mid-line, only the rest of the line is wanted.
					options: { num_predict: MAX_TOKENS, temperature: 0.1, repeat_penalty: 1.2, stop: isMidLine(prefix) ? [...FIM_STOP, '\n'] : FIM_STOP },
				}),
			});
			const reply = await response.json() as { response?: unknown; error?: unknown };
			if (!response.ok || typeof reply.response !== 'string') {
				if (typeof reply.error === 'string') {
					this._logService.trace('[Kingu] completions:', reply.error);
				}
				return undefined;
			}
			const text = cleanCompletion(reply.response, suffix);
			if (!text || token.isCancellationRequested) {
				return undefined;
			}
			return { items: [{ insertText: text, range: Range.fromPositions(position) }] };
		} catch {
			return undefined; // Cancelled by typing on, or Ollama is not running.
		} finally {
			listener.dispose();
		}
	}

	disposeInlineCompletions(): void {
		// Nothing is held per completion.
	}

	private async _modelName(): Promise<string | undefined> {
		const configured = this._configurationService.getValue<string>(KINGU_COMPLETIONS_MODEL_SETTING)?.trim();
		if (configured) {
			return configured;
		}
		if (this._model && Date.now() - this._model.at < MODEL_CACHE_MS) {
			return this._model.name;
		}
		let name: string | undefined;
		try {
			const response = await fetch(`${KINGU_LOCAL_OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2_000) });
			const tags = await response.json() as { models?: { name?: unknown }[] };
			const chat = kinguLocalChatModels((tags.models ?? []).map(entry => entry.name).filter((entry): entry is string => typeof entry === 'string'));
			name = chat.find(entry => /^chyle|coder|code/i.test(entry));
		} catch {
			name = undefined;
		}
		this._model = { name, at: Date.now() };
		return name;
	}
}

class KinguInlineCompletionsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.kinguInlineCompletions';

	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
	) {
		super();
		this._register(languageFeaturesService.inlineCompletionsProvider.register(
			[{ scheme: Schemas.file }, { scheme: Schemas.untitled }, { scheme: Schemas.vscodeRemote }],
			new KinguInlineCompletionsProvider(configurationService, logService),
		));
	}
}

registerWorkbenchContribution2(KinguInlineCompletionsContribution.ID, KinguInlineCompletionsContribution, WorkbenchPhase.AfterRestored);
