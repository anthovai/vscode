/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { IChannel, IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { IJevRequest, JevResult } from '../../kinguHost/common/kinguJev.js';

/**
 * Kingu: the agent host asking TypeSafe's Jev through a window. The key stays
 * in the window's secret storage and the call is made where the window makes
 * its own; the agent host sends only the question.
 */
export const AGENT_HOST_CLIENT_JEV_CHANNEL = 'agentHostClientJev';

/** A Jev question without the model or endpoint, which the window's settings choose. */
export type AgentHostJevRequest = Omit<IJevRequest, 'model' | 'endpoint'>;

export const IAgentHostJevHandler = createDecorator<IAgentHostJevHandler>('agentHostJevHandler');

/** A window's side of the bridge: Jev when it is on and has a key, `no-key` otherwise. */
export interface IAgentHostJevHandler {
	readonly _serviceBrand: undefined;
	decide(request: AgentHostJevRequest): Promise<JevResult>;
}

/** The agent host's side of one window's bridge. */
export interface IJevBridgeConnection {
	decide(request: AgentHostJevRequest): Promise<JevResult>;
}

export function createAgentHostClientJevConnection(channel: IChannel): IJevBridgeConnection {
	return {
		decide: request => channel.call<JevResult>('decide', request),
	};
}

/** Serves a window's Jev to the agent host. */
export class AgentHostClientJevChannel implements IServerChannel {

	constructor(
		@IAgentHostJevHandler private readonly _handler: IAgentHostJevHandler,
	) { }

	listen<T>(_ctx: unknown, event: string): Event<T> {
		throw new Error(`No event '${event}' on AgentHostClientJevChannel`);
	}

	async call<T>(_ctx: unknown, command: string, arg?: unknown): Promise<T> {
		if (command === 'decide') {
			return await this._handler.decide(arg as AgentHostJevRequest) as T;
		}
		throw new Error(`Unknown command '${command}' on AgentHostClientJevChannel`);
	}
}

/** The bridge in a window without Jev: every question goes unanswered. */
export class NullAgentHostClientJevChannel implements IServerChannel {

	listen<T>(_ctx: unknown, event: string): Event<T> {
		throw new Error(`No event '${event}' on NullAgentHostClientJevChannel`);
	}

	async call<T>(_ctx: unknown, command: string): Promise<T> {
		if (command === 'decide') {
			return { ok: false, problem: 'no-key' } satisfies JevResult as T;
		}
		throw new Error(`Unknown command '${command}' on NullAgentHostClientJevChannel`);
	}
}
