/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as http from 'http';
import type { AddressInfo } from 'net';
import { cleanChyleText, IChyleOfferedTool, recoverChyleToolCalls } from '../../common/chyleToolText.js';

/**
 * Kingu: Chyle's gateway, an OpenAI-compatible endpoint in front of the local
 * model server (Ollama) that turns tool calls a model wrote as text into real
 * ones.
 *
 * A chat completion that offers tools is asked of the model server in full
 * (not streamed), repaired, and answered in the shape the client asked for:
 * one JSON body, or a short server-sent stream. Everything else passes
 * through untouched. Arkai's evaluation: Qwen3-Coder passed 8 of 12 tasks
 * without it and 10 with it.
 */

interface IChatMessage { role: string; content?: string | null; tool_calls?: unknown[]; reasoning?: unknown }
interface IChatChoice { index: number; message: IChatMessage; finish_reason: string | null }
export interface IChatCompletion { id: string; object: string; created: number; model: string; choices: IChatChoice[]; usage?: unknown }

function offeredTools(body: Record<string, unknown>): IChyleOfferedTool[] {
	const tools = Array.isArray(body.tools) ? body.tools : [];
	return tools.flatMap(tool => {
		const fn = (tool as { function?: { name?: unknown; parameters?: IChyleOfferedTool['parameters'] } }).function;
		return fn && typeof fn.name === 'string' ? [{ name: fn.name, parameters: fn.parameters }] : [];
	});
}

/** A completion with its text tool calls made real and stray wrappers dropped; the number of calls recovered. */
export function repairChyleCompletion(completion: IChatCompletion, tools: readonly IChyleOfferedTool[]): number {
	let repaired = 0;
	for (const choice of completion.choices ?? []) {
		const message = choice.message;
		if (!message || typeof message.content !== 'string' || (message.tool_calls && message.tool_calls.length > 0)) {
			if (message && typeof message.content === 'string') {
				message.content = cleanChyleText(message.content);
			}
			continue;
		}
		const recovered = recoverChyleToolCalls(message.content, tools);
		if (!recovered) {
			message.content = cleanChyleText(message.content);
			continue;
		}
		message.content = recovered.text || null;
		message.tool_calls = recovered.calls.map((call, index) => ({
			id: `call_chyle_${completion.id}_${index}`,
			type: 'function',
			function: { name: call.name, arguments: call.arguments },
		}));
		choice.finish_reason = 'tool_calls';
		repaired += recovered.calls.length;
	}
	return repaired;
}

/** The completion as the chunks a streaming client expects. */
export function chyleCompletionAsStream(completion: IChatCompletion, includeUsage: boolean): string {
	const frame = (choices: unknown[], extra: Record<string, unknown> = {}) =>
		`data: ${JSON.stringify({ id: completion.id, object: 'chat.completion.chunk', created: completion.created, model: completion.model, choices, ...extra })}\n\n`;
	let out = '';
	for (const choice of completion.choices) {
		const message = choice.message;
		const toolCalls = (message.tool_calls ?? []).map((call, index) => ({ index, ...(call as object) }));
		out += frame([{ index: choice.index, delta: { role: 'assistant', ...(message.content ? { content: message.content } : {}), ...(message.reasoning ? { reasoning: message.reasoning } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: null }]);
		out += frame([{ index: choice.index, delta: {}, finish_reason: choice.finish_reason ?? 'stop' }]);
	}
	if (includeUsage && completion.usage) {
		out += frame([], { usage: completion.usage });
	}
	return `${out}data: [DONE]\n\n`;
}

function readBody(request: http.IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		request.on('data', chunk => chunks.push(chunk));
		request.on('end', () => resolve(Buffer.concat(chunks)));
		request.on('error', reject);
	});
}

/** Headers safe to forward; hop-by-hop ones and the length (recomputed) are left out. */
function forwardHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
	const out: http.OutgoingHttpHeaders = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value !== undefined && !['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive'].includes(name)) {
			out[name] = value;
		}
	}
	return out;
}

/**
 * One request to the model server, on a connection of its own (`agent: false`).
 * Not `fetch`: its pooled keep-alive connections crash Node on Windows when the
 * process exits soon after the gateway closes.
 */
function askUpstream(httpModule: typeof http, url: string, method: string, headers: http.OutgoingHttpHeaders, body?: Buffer): Promise<http.IncomingMessage> {
	return new Promise((resolve, reject) => {
		const request = httpModule.request(url, { method, headers: body ? { ...headers, 'content-length': body.length } : headers, agent: false }, resolve);
		request.on('error', reject);
		request.end(body);
	});
}

export interface IChyleGateway {
	readonly port: number;
	close(): Promise<void>;
}

export interface IChyleGatewayOptions {
	/** Told how many tool calls were recovered from a reply. */
	readonly onRepair?: (model: string, count: number) => void;
	/** Awaited before each request is forwarded, while the model server is still starting. */
	readonly upstreamReady?: () => Promise<unknown>;
}

/** Starts the gateway on 127.0.0.1:`port` (0 for any free port), in front of `upstream`. */
export async function startChyleGateway(upstream: string, port: number, options: IChyleGatewayOptions = {}): Promise<IChyleGateway> {
	const httpModule = await import('http');
	const base = upstream.replace(/\/$/, '');
	const server = httpModule.createServer(async (request, response) => {
		try {
			const url = request.url ?? '/';
			const body = await readBody(request);
			await options.upstreamReady?.();
			let json: Record<string, unknown> | undefined;
			if (request.method === 'POST' && url.split('?')[0].endsWith('/chat/completions')) {
				try {
					json = JSON.parse(body.toString('utf8'));
				} catch {
					json = undefined;
				}
			}
			const tools = json ? offeredTools(json) : [];
			if (!json || tools.length === 0) {
				const passed = await askUpstream(httpModule, `${base}${url}`, request.method ?? 'GET', forwardHeaders(request.headers), request.method === 'GET' || request.method === 'HEAD' ? undefined : body);
				response.writeHead(passed.statusCode ?? 502, { 'content-type': passed.headers['content-type'] ?? 'application/json' });
				passed.pipe(response);
				return;
			}
			const wantsStream = json.stream === true;
			const includeUsage = !!(json.stream_options as { include_usage?: boolean } | undefined)?.include_usage;
			const { stream_options: _streamOptions, ...rest } = json;
			const asked = await askUpstream(httpModule, `${base}${url.split('?')[0]}`, 'POST', { 'content-type': 'application/json' }, Buffer.from(JSON.stringify({ ...rest, stream: false })));
			const answer = (await readBody(asked)).toString('utf8');
			if (asked.statusCode !== 200) {
				response.writeHead(asked.statusCode ?? 502, { 'content-type': asked.headers['content-type'] ?? 'application/json' });
				response.end(answer);
				return;
			}
			const completion = JSON.parse(answer) as IChatCompletion;
			const repaired = repairChyleCompletion(completion, tools);
			if (repaired) {
				options.onRepair?.(completion.model, repaired);
			}
			if (wantsStream) {
				response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
				response.end(chyleCompletionAsStream(completion, includeUsage));
			} else {
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end(JSON.stringify(completion));
			}
		} catch (error) {
			if (!response.headersSent) {
				response.writeHead(502, { 'content-type': 'application/json' });
			}
			response.end(JSON.stringify({ error: { message: `Chyle gateway: ${error instanceof Error ? error.message : String(error)}` } }));
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', () => resolve());
	});
	return {
		port: (server.address() as AddressInfo).port,
		close: () => new Promise<void>(resolve => {
			server.close(() => resolve());
			server.closeAllConnections();
		}),
	};
}
