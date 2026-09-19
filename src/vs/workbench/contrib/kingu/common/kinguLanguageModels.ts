/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { IJSONSchema } from '../../../../base/common/jsonSchema.js';
import { localize } from '../../../../nls.js';
import { ChatMessageRole, IChatMessage, ILanguageModelConfigurationSchema } from '../../chat/common/languageModels.js';

/**
 * The vendor every model Kingu supplies itself is registered under.
 *
 * Kingu is not a GitHub product, so this vendor exists to give the workbench a
 * model source that owes nothing to a Copilot account: the user brings a key for
 * an endpoint they already pay for, and chat works. It is deliberately not the
 * default vendor — that flag is Copilot's and carries picker rules we do not want.
 */
export const KINGU_VENDOR_ID = 'kingu';

/**
 * Adds a Kingu endpoint. Named here rather than in the browser layer so the chat
 * model picker can offer Kingu's setup route without importing Kingu's UI.
 */
export const KINGU_SETUP_COMMAND_ID = 'kingu.action.configureModels';

/** The wire dialect an endpoint speaks. Both are widely re-implemented by gateways and local runtimes. */
export type KinguApiFormat = 'anthropic' | 'openai';

/** One endpoint's resolved settings: everything needed to talk to it. */
export interface IKinguEndpointConfiguration {
	readonly apiKey: string;
	readonly baseUrl: string;
	readonly format: KinguApiFormat;
	/** Model ids the user pinned, or empty to ask the endpoint what it serves. */
	readonly modelIds: readonly string[];
}

export const KINGU_DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/**
 * The form the "Manage Models" UI renders when a user adds a Kingu endpoint.
 *
 * `secret` is what routes `apiKey` into secret storage instead of settings JSON,
 * which is the only reason this is a schema and not a plain setting: a key typed
 * here never lands in a file the user might commit.
 */
export const kinguVendorConfigurationSchema: ILanguageModelConfigurationSchema = {
	type: 'object',
	properties: {
		apiKey: {
			type: 'string',
			secret: true,
			description: localize('kingu.config.apiKey', "API key for this endpoint. Stored in the OS keychain, never in settings."),
		},
		baseUrl: {
			type: 'string',
			default: KINGU_DEFAULT_ANTHROPIC_BASE_URL,
			description: localize('kingu.config.baseUrl', "Base URL of the endpoint, without a trailing path. Point this at a provider, a gateway, or a model server on your own machine."),
		},
		format: {
			type: 'string',
			enum: ['anthropic', 'openai'],
			default: 'anthropic',
			description: localize('kingu.config.format', "Which API dialect the endpoint speaks."),
		},
		models: {
			type: 'string',
			description: localize('kingu.config.models', "Comma-separated model ids to offer. Leave empty to list whatever the endpoint reports."),
		},
	},
	required: ['apiKey'],
} satisfies IJSONSchema;

/**
 * Reads one endpoint's settings out of the untyped bag the models service hands
 * a provider, or `undefined` when it does not describe a usable endpoint.
 *
 * Returning `undefined` rather than throwing for a missing key is deliberate:
 * a group exists from the moment the user starts filling the form, and a
 * half-filled one should contribute no models, not an error banner.
 */
export function parseKinguEndpointConfiguration(configuration: Readonly<Record<string, unknown>> | undefined): IKinguEndpointConfiguration | undefined {
	const apiKey = typeof configuration?.apiKey === 'string' ? configuration.apiKey.trim() : '';
	if (!apiKey) {
		return undefined;
	}
	const rawBaseUrl = typeof configuration?.baseUrl === 'string' && configuration.baseUrl.trim()
		? configuration.baseUrl.trim()
		: KINGU_DEFAULT_ANTHROPIC_BASE_URL;
	return {
		apiKey,
		// Trailing slashes are the commonest paste error and would produce `//v1/messages`,
		// which some gateways 404 rather than normalize.
		baseUrl: rawBaseUrl.replace(/\/+$/, ''),
		format: configuration?.format === 'openai' ? 'openai' : 'anthropic',
		modelIds: parseModelIds(configuration?.models),
	};
}

function parseModelIds(value: unknown): readonly string[] {
	if (typeof value !== 'string') {
		return [];
	}
	const seen = new Set<string>();
	for (const id of value.split(',')) {
		const trimmed = id.trim();
		if (trimmed) {
			seen.add(trimmed);
		}
	}
	return Array.from(seen);
}

/** Flattens a message's parts to the plain text the wire formats below carry. */
export function messageText(message: IChatMessage): string {
	return message.content
		.map(part => part.type === 'text' ? part.value : '')
		.join('');
}

export interface IAnthropicTurn {
	role: 'user' | 'assistant';
	content: string;
}

export interface IAnthropicRequestBody {
	readonly system?: string;
	readonly messages: IAnthropicTurn[];
}

/**
 * Splits a conversation into Anthropic's shape: system prompts are a top-level
 * field there rather than a message, and consecutive same-role turns are merged
 * because the API rejects them.
 */
export function toAnthropicRequestBody(messages: readonly IChatMessage[]): IAnthropicRequestBody {
	const system: string[] = [];
	const turns: IAnthropicTurn[] = [];
	for (const message of messages) {
		const text = messageText(message);
		if (message.role === ChatMessageRole.System) {
			if (text) {
				system.push(text);
			}
			continue;
		}
		const role = message.role === ChatMessageRole.Assistant ? 'assistant' : 'user';
		const last = turns.at(-1);
		if (last?.role === role) {
			last.content += '\n' + text;
		} else {
			turns.push({ role, content: text });
		}
	}
	// The API also rejects an empty message list, and an assistant-led one reads as a
	// prefill the caller did not ask for.
	if (turns.length === 0 || turns[0].role === 'assistant') {
		turns.unshift({ role: 'user', content: '' });
	}
	return { ...(system.length > 0 && { system: system.join('\n\n') }), messages: turns };
}

export interface IOpenAIMessage {
	readonly role: 'system' | 'user' | 'assistant';
	readonly content: string;
}

/** The OpenAI shape, which keeps system prompts inline and tolerates repeated roles. */
export function toOpenAIMessages(messages: readonly IChatMessage[]): IOpenAIMessage[] {
	return messages.map(message => ({
		role: message.role === ChatMessageRole.System
			? 'system' as const
			: message.role === ChatMessageRole.Assistant
				? 'assistant' as const
				: 'user' as const,
		content: messageText(message),
	}));
}

/**
 * Pulls the text out of one server-sent event's `data:` payload, or `undefined`
 * when the event carries none.
 *
 * Both dialects are handled here rather than in two near-identical loops: they
 * differ only in where the delta sits, and one reader is what keeps the streaming
 * code in the provider down to "append whatever this returns".
 */
export function readStreamedText(format: KinguApiFormat, data: string): string | undefined {
	if (data === '[DONE]') {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(data);
	} catch {
		// A truncated or non-JSON keep-alive frame is not worth failing a response over.
		return undefined;
	}
	const event = parsed as Record<string, unknown>;
	if (format === 'anthropic') {
		if (event?.type !== 'content_block_delta') {
			return undefined;
		}
		const text = (event.delta as Record<string, unknown> | undefined)?.text;
		return typeof text === 'string' ? text : undefined;
	}
	const choices = event?.choices as { delta?: { content?: unknown } }[] | undefined;
	const delta = choices?.[0]?.delta?.content;
	return typeof delta === 'string' ? delta : undefined;
}

/**
 * The model ids an endpoint reported, from either dialect's `/v1/models` body.
 *
 * Unknown shapes yield an empty list rather than an error: an endpoint that does
 * not implement model listing is still usable, the user just has to name the
 * models themselves in the group's `models` field.
 */
export function readModelIds(body: unknown): string[] {
	const data = (body as { data?: unknown })?.data;
	if (!Array.isArray(data)) {
		return [];
	}
	const ids: string[] = [];
	for (const entry of data) {
		const id = (entry as { id?: unknown })?.id;
		if (typeof id === 'string' && id) {
			ids.push(id);
		}
	}
	return ids;
}

/**
 * The error text an endpoint returned, reduced to one line for a notification.
 *
 * Endpoints disagree on where the message sits and some return HTML, so this
 * falls back to the status line rather than rendering a page into a toast.
 */
export function readEndpointError(status: number, statusText: string, body: string): string {
	try {
		const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
		const message = parsed?.error?.message ?? parsed?.message;
		if (typeof message === 'string' && message.trim()) {
			return message.trim();
		}
	} catch {
		// Not JSON; fall through to the status line.
	}
	return localize('kingu.endpointError', "Kingu endpoint returned {0} {1}", status, statusText || 'error');
}
