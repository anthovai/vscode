/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { IKinguOrcaPush } from '../common/kinguOrca.js';
import { invokeOrca, onOrcaPush } from './kinguOrcaHost.js';

export { KINGU_ORCA_CHANNEL_NAME } from '../common/kinguOrca.js';

/**
 * The Agents Window's line to the ADE's engine.
 *
 * Two members and no more, because the ADE's backend already is an API: every
 * call its renderer makes is a named handler, and every update it sends is a
 * named push. `invoke` makes the first, `onPush` carries the second. What the
 * window builds on top — its status bar, its settings — calls the same handlers
 * the ADE's own UI does, so it gets the same behaviour, side effects included,
 * rather than a reimplementation of it.
 *
 * Channels prefixed `vscode:` are the host's and never reach here; the ADE's
 * handler map does not record them.
 */
export class KinguOrcaChannel extends Disposable implements IServerChannel {

	private readonly _onPush = this._register(new Emitter<IKinguOrcaPush>());

	constructor() {
		super();
		this._register(toDisposable(onOrcaPush(push => this._onPush.fire(push))));
	}

	listen<T>(_context: unknown, event: string): Event<T> {
		if (event === 'onPush') {
			return this._onPush.event as Event<T>;
		}
		throw new Error(`No such event: ${event}`);
	}

	async call<T>(_context: unknown, command: string, arg?: unknown): Promise<T> {
		if (command === 'invoke') {
			const [channel, args] = arg as [string, readonly unknown[]];
			return await invokeOrca(channel, args ?? []) as T;
		}
		throw new Error(`No such command: ${command}`);
	}
}
