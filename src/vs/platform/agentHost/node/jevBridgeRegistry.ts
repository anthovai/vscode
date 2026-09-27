/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { JevResult } from '../../kinguHost/common/kinguJev.js';
import { AgentHostJevRequest, IJevBridgeConnection } from '../common/agentHostClientJevChannel.js';

export const IJevBridgeRegistry = createDecorator<IJevBridgeRegistry>('jevBridgeRegistry');

/** Kingu: the windows the agent host can ask Jev through. */
export interface IJevBridgeRegistry {
	readonly _serviceBrand: undefined;

	/** Register a window's connection. Disposing the result removes it. */
	register(clientId: string, connection: IJevBridgeConnection): IDisposable;

	/**
	 * Jev's answer through the most recently connected window that has it on,
	 * or `no-key` when none does. Every window shares one key and one setting,
	 * so the first window that answers is as good as any.
	 */
	decide(request: AgentHostJevRequest): Promise<JevResult>;
}

export class JevBridgeRegistry implements IJevBridgeRegistry {

	declare readonly _serviceBrand: undefined;

	private readonly _connections = new Map<string, IJevBridgeConnection>();

	register(clientId: string, connection: IJevBridgeConnection): IDisposable {
		this._connections.delete(clientId);
		this._connections.set(clientId, connection);
		return toDisposable(() => {
			if (this._connections.get(clientId) === connection) {
				this._connections.delete(clientId);
			}
		});
	}

	async decide(request: AgentHostJevRequest): Promise<JevResult> {
		let result: JevResult = { ok: false, problem: 'no-key' };
		for (const connection of [...this._connections.values()].reverse()) {
			try {
				result = await connection.decide(request);
			} catch {
				// A window closing mid-call; the next one may still answer.
				continue;
			}
			if (result.ok || result.problem !== 'no-key') {
				return result;
			}
		}
		return result;
	}
}
