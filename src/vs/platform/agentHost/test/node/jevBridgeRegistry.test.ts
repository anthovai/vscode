/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../base/common/event.js';
import type { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { JevResult } from '../../../kinguHost/common/kinguJev.js';
import { AgentHostClientJevChannel, AgentHostJevRequest, createAgentHostClientJevConnection, IAgentHostJevHandler, IJevBridgeConnection, NullAgentHostClientJevChannel } from '../../common/agentHostClientJevChannel.js';
import { JevBridgeRegistry } from '../../node/jevBridgeRegistry.js';

suite('JevBridgeRegistry', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const request: AgentHostJevRequest = { state: '{"agent":"OMP"}', questions: { reason: { type: 'noul', instructions: 'Is it quiet?' } } };
	const answered: JevResult = { ok: true, model: 'jev-1.13.0', answers: { reason: { type: 'noul', probability: 0.9, confidence: 0.9 } } };

	function connection(answer: () => Promise<JevResult>): IJevBridgeConnection {
		return { decide: () => answer() };
	}

	/** A window's server channel reached the way the agent host reaches it, without the transport. */
	function viaChannel(server: AgentHostClientJevChannel | NullAgentHostClientJevChannel): IJevBridgeConnection {
		const channel: IChannel = {
			call: <T>(command: string, arg?: unknown) => server.call<T>(null, command, arg),
			listen: <T>() => Event.None as Event<T>,
		};
		return createAgentHostClientJevConnection(channel);
	}

	test('asks the newest window first and falls back past windows without Jev or gone mid-call', async () => {
		const registry = new JevBridgeRegistry();
		const asked: string[] = [];
		store.add(registry.register('with-jev', connection(async () => { asked.push('with-jev'); return answered; })));
		store.add(registry.register('closing', connection(async () => { asked.push('closing'); throw new Error('gone'); })));
		store.add(registry.register('without-jev', viaChannel(new NullAgentHostClientJevChannel())));
		assert.deepStrictEqual([await registry.decide(request), asked], [answered, ['closing', 'with-jev']]);
	});

	test('passes a refusal through rather than asking another window, and says no-key when nothing is registered', async () => {
		const registry = new JevBridgeRegistry();
		assert.deepStrictEqual(await registry.decide(request), { ok: false, problem: 'no-key' });
		const handler: IAgentHostJevHandler = { _serviceBrand: undefined, decide: async () => ({ ok: false, problem: 'rate-limited' }) };
		const registration = registry.register('limited', viaChannel(new AgentHostClientJevChannel(handler)));
		assert.deepStrictEqual(await registry.decide(request), { ok: false, problem: 'rate-limited' });
		registration.dispose();
		assert.deepStrictEqual(await registry.decide(request), { ok: false, problem: 'no-key' });
	});

	test('carries the question to the window unchanged', async () => {
		let received: AgentHostJevRequest | undefined;
		const handler: IAgentHostJevHandler = { _serviceBrand: undefined, decide: async question => { received = question; return answered; } };
		const registry = new JevBridgeRegistry();
		store.add(registry.register('window', viaChannel(new AgentHostClientJevChannel(handler))));
		assert.deepStrictEqual([await registry.decide(request), received], [answered, request]);
	});
});
