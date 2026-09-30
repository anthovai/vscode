/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ChatAgentLocation } from '../../chat/common/constants.js';
import {
	IChatMessage,
	ILanguageModelChatInfoOptions,
	ILanguageModelChatMetadataAndIdentifier,
	ILanguageModelChatProvider,
	ILanguageModelChatRequestOptions,
	ILanguageModelChatResponse,
} from '../../chat/common/languageModels.js';
import { KINGU_LOCAL_OLLAMA_URL, kinguLocalChatModels } from '../common/kinguLocalModels.js';
import { KinguLanguageModelProvider } from './kinguLanguageModelProvider.js';

/** How often, and how long, to look again for Ollama when it was not running (it is started in the background). */
const OLLAMA_RETRY_MS = 10_000;
const OLLAMA_RETRY_FOR_MS = 5 * 60_000;

/** The vendor of the models on the user's own Ollama. */
export const KINGU_LOCAL_VENDOR_ID = 'kingu-local';

/**
 * Arkai's models on this computer, as the workbench's language models: the
 * chat models on the user's Ollama, found without any setup. The IDE's inline
 * chat and the other places that ask a model directly (rather than an agent
 * session) had nothing to ask once Copilot left the product; Arkai's own
 * model, Chyle, is the default there.
 *
 * Requests go through Kingu's endpoint provider (OpenAI format against
 * Ollama's `/v1`), so the wire code is the one users already configure for
 * their own endpoints.
 */
export class KinguLocalModelProvider extends Disposable implements ILanguageModelChatProvider {

	private readonly _endpoint: KinguLanguageModelProvider;
	private readonly _onDidFindOllama = this._register(new Emitter<void>());
	readonly onDidChange: Event<void>;
	private readonly _retry = this._register(new MutableDisposable());
	private _retryUntil: number | undefined;

	/** This vendor's model identifier → the endpoint provider's. */
	private readonly _inner = new Map<string, string>();

	constructor(@IInstantiationService instantiationService: IInstantiationService) {
		super();
		this._endpoint = this._register(instantiationService.createInstance(KinguLanguageModelProvider));
		this.onDidChange = Event.any(this._endpoint.onDidChange, this._onDidFindOllama.event);
	}

	async provideLanguageModelChatInfo(options: ILanguageModelChatInfoOptions, token: CancellationToken): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		let names: string[];
		try {
			const response = await fetch(`${KINGU_LOCAL_OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2_000) });
			const tags = await response.json() as { models?: { name?: unknown }[] };
			names = kinguLocalChatModels((tags.models ?? []).map(model => model.name).filter((name): name is string => typeof name === 'string'));
		} catch {
			// Ollama is not running (yet: Kingu starts it in the background): no
			// models and no error, and a look again until it answers.
			this._lookAgain();
			return [];
		}
		this._retryUntil = undefined;
		if (!names.length) {
			return [];
		}
		const models = await this._endpoint.provideLanguageModelChatInfo({
			silent: options.silent,
			group: 'ollama',
			// Ollama ignores the key; the endpoint provider wants one to count an endpoint as set up.
			configuration: { apiKey: 'ollama', baseUrl: KINGU_LOCAL_OLLAMA_URL, format: 'openai', models: names.join(',') },
		}, token);
		const defaultModel = names[0];
		return models.map(model => {
			const identifier = `${KINGU_LOCAL_VENDOR_ID}:${model.metadata.id}`;
			this._inner.set(identifier, model.identifier);
			const isDefault = model.metadata.id === defaultModel;
			return {
				identifier,
				metadata: {
					...model.metadata,
					vendor: KINGU_LOCAL_VENDOR_ID,
					isDefaultForLocation: isDefault ? { [ChatAgentLocation.EditorInline]: true, [ChatAgentLocation.Terminal]: true, [ChatAgentLocation.Notebook]: true } : {},
				},
			};
		});
	}

	/** Asks the workbench to list the models again shortly, while Ollama may still be starting. */
	private _lookAgain(): void {
		this._retryUntil ??= Date.now() + OLLAMA_RETRY_FOR_MS;
		if (Date.now() > this._retryUntil || this._retry.value) {
			return;
		}
		this._retry.value = disposableTimeout(() => {
			this._retry.clear();
			this._onDidFindOllama.fire();
		}, OLLAMA_RETRY_MS);
	}

	sendChatRequest(modelId: string, messages: IChatMessage[], from: ExtensionIdentifier | undefined, options: ILanguageModelChatRequestOptions, token: CancellationToken): Promise<ILanguageModelChatResponse> {
		return this._endpoint.sendChatRequest(this._inner.get(modelId) ?? modelId, messages, from, options, token);
	}

	provideTokenCount(modelId: string, message: string | IChatMessage, token: CancellationToken): Promise<number> {
		return this._endpoint.provideTokenCount(this._inner.get(modelId) ?? modelId, message, token);
	}
}
