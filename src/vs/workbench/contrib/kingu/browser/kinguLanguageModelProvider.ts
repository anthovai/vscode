/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { AsyncIterableSource } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { nullExtensionDescription } from '../../../services/extensions/common/extensions.js';
import {
	IChatMessage,
	IChatResponsePart,
	ILanguageModelChatInfoOptions,
	ILanguageModelChatMetadataAndIdentifier,
	ILanguageModelChatProvider,
	ILanguageModelChatRequestOptions,
	ILanguageModelChatResponse,
} from '../../chat/common/languageModels.js';
import {
	IKinguEndpointConfiguration,
	KINGU_VENDOR_ID,
	KinguApiFormat,
	messageText,
	parseKinguEndpointConfiguration,
	readEndpointError,
	readModelIds,
	readStreamedText,
	toAnthropicRequestBody,
	toOpenAIMessages,
} from '../common/kinguLanguageModels.js';

/** The version header Anthropic's API requires on every request. */
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Bound when a request does not say otherwise. The API requires the field, and
 * a cap low enough to truncate real answers is worse than a generous one.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/** What we advertise as the context window when the endpoint does not tell us. */
const ASSUMED_MAX_INPUT_TOKENS = 128_000;

/**
 * Kingu's own models, brought by the user rather than by an account we resolve
 * for them.
 *
 * One provider serves every endpoint the user has configured: the models service
 * calls {@link provideLanguageModelChatInfo} once per configured group, so the
 * endpoint a model belongs to is remembered here, keyed by the identifier the
 * model was published under, and looked up again when a request arrives.
 */
export class KinguLanguageModelProvider extends Disposable implements ILanguageModelChatProvider {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	/** Model identifier -> the endpoint that serves it. */
	private readonly _endpoints = new Map<string, IKinguEndpointConfiguration>();

	constructor(
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	async provideLanguageModelChatInfo(options: ILanguageModelChatInfoOptions, token: CancellationToken): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		const endpoint = parseKinguEndpointConfiguration(options.configuration);
		if (!endpoint) {
			return [];
		}
		const modelIds = endpoint.modelIds.length > 0
			? endpoint.modelIds
			: await this._discoverModelIds(endpoint, options.silent, token);

		// The group name is part of the identifier because a user may configure the
		// same model id at two endpoints (a provider and a local gateway, say) and
		// both have to stay addressable.
		const groupPrefix = options.group ? options.group + '/' : '';
		return modelIds.map(id => {
			const identifier = KINGU_VENDOR_ID + ':' + groupPrefix + id;
			this._endpoints.set(identifier, endpoint);
			return {
				identifier,
				metadata: {
					extension: nullExtensionDescription.identifier,
					name: id,
					id,
					vendor: KINGU_VENDOR_ID,
					version: '1.0',
					family: id,
					maxInputTokens: ASSUMED_MAX_INPUT_TOKENS,
					maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
					isDefaultForLocation: {},
					isUserSelectable: true,
					isBYOK: true,
					capabilities: {
						vision: false,
						// Tool calling is not forwarded yet, and claiming it would let agent
						// mode select a model that silently ignores every tool it is given.
						toolCalling: false,
						agentMode: false,
					},
				},
			};
		});
	}

	/**
	 * Asks the endpoint what it serves.
	 *
	 * A failure here is reported and swallowed rather than thrown: an endpoint
	 * without model listing is still usable once the user names its models, and
	 * turning that into an error banner would bury the field that fixes it.
	 */
	private async _discoverModelIds(endpoint: IKinguEndpointConfiguration, silent: boolean, token: CancellationToken): Promise<string[]> {
		try {
			const response = await fetch(endpoint.baseUrl + '/v1/models', {
				method: 'GET',
				headers: this._headers(endpoint),
				signal: toAbortSignal(token),
			});
			if (!response.ok) {
				throw new Error(readEndpointError(response.status, response.statusText, await response.text()));
			}
			return readModelIds(await response.json());
		} catch (error) {
			if (!silent) {
				this._logService.warn('[Kingu] could not list models from ' + endpoint.baseUrl, error);
			}
			return [];
		}
	}

	async sendChatRequest(modelId: string, messages: IChatMessage[], _from: unknown, options: ILanguageModelChatRequestOptions, token: CancellationToken): Promise<ILanguageModelChatResponse> {
		const endpoint = this._endpoints.get(modelId);
		if (!endpoint) {
			throw new Error('No Kingu endpoint is configured for ' + modelId);
		}
		const source = new AsyncIterableSource<IChatResponsePart>();
		const result = this._pump(endpoint, modelId, messages, options, token, source).then(
			() => {
				source.resolve();
				return {};
			},
			(error: Error) => {
				source.reject(error);
				throw error;
			});
		return { stream: source.asyncIterable, result };
	}

	/** Runs one request to completion, emitting text as it arrives. */
	private async _pump(
		endpoint: IKinguEndpointConfiguration,
		modelId: string,
		messages: IChatMessage[],
		options: ILanguageModelChatRequestOptions,
		token: CancellationToken,
		source: AsyncIterableSource<IChatResponsePart>,
	): Promise<void> {
		// The identifier carries the vendor and group so it stays unique across
		// endpoints; the wire wants the bare model id the endpoint knows.
		const wireModelId = modelId.slice(modelId.lastIndexOf('/') + 1).replace(KINGU_VENDOR_ID + ':', '');
		const maxTokens = typeof options.modelOptions?.max_tokens === 'number'
			? options.modelOptions.max_tokens
			: DEFAULT_MAX_OUTPUT_TOKENS;

		const response = await fetch(this._chatUrl(endpoint), {
			method: 'POST',
			headers: { ...this._headers(endpoint), 'Content-Type': 'application/json' },
			body: JSON.stringify(this._chatBody(endpoint.format, wireModelId, messages, maxTokens)),
			signal: toAbortSignal(token),
		});
		if (!response.ok) {
			throw new Error(readEndpointError(response.status, response.statusText, await response.text()));
		}
		if (!response.body) {
			throw new Error('Kingu endpoint returned no response body');
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		try {
			while (true) {
				if (token.isCancellationRequested) {
					throw new CancellationError();
				}
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				// Events are newline-delimited; the tail is held back because a frame
				// can be split across two network chunks.
				let newline = buffer.indexOf('\n');
				while (newline !== -1) {
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf('\n');
					if (!line.startsWith('data:')) {
						continue;
					}
					const text = readStreamedText(endpoint.format, line.slice('data:'.length).trim());
					if (text) {
						source.emitOne({ type: 'text', value: text });
					}
				}
			}
		} finally {
			reader.cancel().catch(() => { /* the response is already finished or aborted */ });
		}
	}

	private _chatUrl(endpoint: IKinguEndpointConfiguration): string {
		return endpoint.format === 'anthropic'
			? endpoint.baseUrl + '/v1/messages'
			: endpoint.baseUrl + '/v1/chat/completions';
	}

	private _chatBody(format: KinguApiFormat, model: string, messages: IChatMessage[], maxTokens: number): object {
		if (format === 'anthropic') {
			return { model, max_tokens: maxTokens, stream: true, ...toAnthropicRequestBody(messages) };
		}
		return { model, max_tokens: maxTokens, stream: true, messages: toOpenAIMessages(messages) };
	}

	private _headers(endpoint: IKinguEndpointConfiguration): Record<string, string> {
		return endpoint.format === 'anthropic'
			? { 'x-api-key': endpoint.apiKey, 'anthropic-version': ANTHROPIC_VERSION }
			: { Authorization: 'Bearer ' + endpoint.apiKey };
	}

	/**
	 * A count good enough for the picker's budget hints, not for billing.
	 *
	 * Neither dialect offers a free local tokenizer, and calling the remote
	 * counting endpoint on every keystroke would cost a request per character.
	 */
	async provideTokenCount(_modelId: string, message: string | IChatMessage, _token: CancellationToken): Promise<number> {
		const text = typeof message === 'string' ? message : messageText(message);
		return Math.ceil(text.length / 4);
	}
}

/** Bridges a {@link CancellationToken} to the `AbortSignal` `fetch` understands. */
function toAbortSignal(token: CancellationToken): AbortSignal {
	const controller = new AbortController();
	if (token.isCancellationRequested) {
		controller.abort();
	} else {
		token.onCancellationRequested(() => controller.abort());
	}
	return controller.signal;
}
