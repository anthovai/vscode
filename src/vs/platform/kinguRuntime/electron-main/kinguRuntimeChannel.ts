/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../log/common/log.js';
import { IKinguRuntimePaths } from '../common/kinguRuntime.js';
import { KinguRuntimeServer } from '../node/kinguRuntimeServer.js';

export { KINGU_RUNTIME_CHANNEL_NAME } from '../common/kinguRuntime.js';

/**
 * The window's handle on the Kingu runtime.
 *
 * It lives in the main process because the runtime is a child process and a web
 * server, and the sessions renderer is sandboxed away from both. One runtime per
 * application, not per window: two windows asking for it get the same one.
 */
export class KinguRuntimeChannel extends Disposable implements IServerChannel {

	private readonly _server: KinguRuntimeServer;

	constructor(
		logService: ILogService,
		resolvePaths: () => Promise<IKinguRuntimePaths>,
	) {
		super();
		this._server = this._register(new KinguRuntimeServer(resolvePaths, logService));
	}

	listen<T>(_context: unknown, event: string): Event<T> {
		throw new Error(`No such event: ${event}`);
	}

	async call<T>(_context: unknown, command: string): Promise<T> {
		switch (command) {
			case 'start': return await this._server.start() as T;
			case 'stop': return await this._server.stop() as T;
			case 'status': return this._server.status() as T;
		}
		throw new Error(`No such command: ${command}`);
	}
}
