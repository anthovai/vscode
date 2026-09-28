/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type * as http from 'http';
import type { AddressInfo } from 'net';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IChyleGateway, startChyleGateway } from '../../node/acp/chyleGateway.js';

suite('chyleGateway', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let upstream: http.Server;
	let gateway: IChyleGateway;
	const asked: Record<string, unknown>[] = [];

	/** A model server that writes its tool call as Qwen XML text, as Qwen3-Coder does. */
	setup(async () => {
		asked.length = 0;
		const httpModule = await import('http');
		upstream = httpModule.createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on('data', chunk => chunks.push(chunk));
			request.on('end', () => {
				if (request.url === '/v1/models') {
					response.writeHead(200, { 'content-type': 'application/json' });
					response.end('{"data":[{"id":"chyle-1-coder"}]}');
					return;
				}
				asked.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end(JSON.stringify({
					id: 'c1', object: 'chat.completion', created: 1, model: 'chyle-1-coder',
					choices: [{ index: 0, message: { role: 'assistant', content: 'Writing.\n<function=write><parameter=path>a.js</parameter></function>' }, finish_reason: 'stop' }],
					usage: { prompt_tokens: 10, completion_tokens: 5 },
				}));
			});
		});
		await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()));
		gateway = await startChyleGateway(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, 0);
	});

	teardown(async () => {
		await gateway.close();
		await new Promise<void>(resolve => {
			upstream.close(() => resolve());
			upstream.closeAllConnections();
		});
	});

	const tools = [{ type: 'function', function: { name: 'write', parameters: { properties: { path: { type: 'string' } } } } }];

	interface IAnswer { readonly type: string | undefined; readonly text: string }

	/** A request to the gateway on a connection of its own; `fetch`'s pooled ones crash Node on Windows at exit. */
	async function ask(path: string, body?: unknown): Promise<IAnswer> {
		const httpModule = await import('http');
		const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
		return new Promise((resolve, reject) => {
			const request = httpModule.request(`http://127.0.0.1:${gateway.port}${path}`, { method: payload ? 'POST' : 'GET', headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}, agent: false }, response => {
				const chunks: Buffer[] = [];
				response.on('data', chunk => chunks.push(chunk));
				response.on('end', () => resolve({ type: response.headers['content-type'], text: Buffer.concat(chunks).toString('utf8') }));
			});
			request.on('error', reject);
			request.end(payload);
		});
	}

	test('turns a text tool call into a real one, asking the model server without streaming', async () => {
		const completion = JSON.parse((await ask('/v1/chat/completions', { model: 'chyle-1-coder', messages: [], tools })).text);
		assert.deepStrictEqual({ stream: asked[0].stream, choice: completion.choices[0] }, {
			stream: false,
			choice: {
				index: 0,
				message: { role: 'assistant', content: 'Writing.', tool_calls: [{ id: 'call_chyle_c1_0', type: 'function', function: { name: 'write', arguments: '{"path":"a.js"}' } }] },
				finish_reason: 'tool_calls',
			},
		});
	});

	test('answers a streaming client with server-sent chunks, usage included when asked', async () => {
		const response = await ask('/v1/chat/completions', { model: 'chyle-1-coder', messages: [], tools, stream: true, stream_options: { include_usage: true } });
		const frames = response.text.split('\n\n').filter(Boolean).map(frame => frame.slice('data: '.length));
		assert.deepStrictEqual({
			type: response.type,
			forwardedStreamOptions: asked[0].stream_options !== undefined,
			deltas: frames.slice(0, -1).map(frame => { const chunk = JSON.parse(frame); return chunk.usage ?? chunk.choices[0]; }),
			last: frames.at(-1),
		}, {
			type: 'text/event-stream',
			forwardedStreamOptions: false,
			deltas: [
				{ index: 0, delta: { role: 'assistant', content: 'Writing.', tool_calls: [{ index: 0, id: 'call_chyle_c1_0', type: 'function', function: { name: 'write', arguments: '{"path":"a.js"}' } }] }, finish_reason: null },
				{ index: 0, delta: {}, finish_reason: 'tool_calls' },
				{ prompt_tokens: 10, completion_tokens: 5 },
			],
			last: '[DONE]',
		});
	});

	test('holds requests until the model server is ready', async () => {
		await gateway.close();
		let ready!: () => void;
		const upstreamReady = new Promise<void>(resolve => ready = resolve);
		gateway = await startChyleGateway(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, 0, { upstreamReady: () => upstreamReady });
		const answer = ask('/v1/chat/completions', { model: 'chyle-1-coder', messages: [], tools });
		await new Promise(resolve => setTimeout(resolve, 50));
		const askedBeforeReady = asked.length;
		ready();
		assert.deepStrictEqual({ askedBeforeReady, finish: JSON.parse((await answer).text).choices[0].finish_reason }, { askedBeforeReady: 0, finish: 'tool_calls' });
	});

	test('reports the tokens each answer used', async () => {
		await gateway.close();
		const usages: unknown[] = [];
		gateway = await startChyleGateway(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, 0, { onUsage: usage => usages.push(usage) });
		await ask('/v1/chat/completions', { model: 'chyle-1-coder', messages: [], tools });
		assert.deepStrictEqual(usages, [{ promptTokens: 10, completionTokens: 5 }]);
	});

	test('passes other requests through', async () => {
		assert.deepStrictEqual(JSON.parse((await ask('/v1/models')).text), { data: [{ id: 'chyle-1-coder' }] });
	});
});
