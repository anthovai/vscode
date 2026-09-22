/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import {
	IKinguRuntimeEndpoint,
	IKinguRuntimeService,
	KINGU_RUNTIME_CHANNEL_NAME,
	KinguRuntimeStatus,
} from '../../../../platform/kinguRuntime/common/kinguRuntime.js';

/**
 * The window's handle on the Kingu runtime.
 *
 * Thin by design. The runtime is a child process and a loopback web server,
 * neither of which a sandboxed renderer can own, so all this does is ask the
 * main process for them and hand back a URL.
 */
export class KinguRuntimeService extends Disposable implements IKinguRuntimeService {

	declare readonly _serviceBrand: undefined;

	private readonly _channel: IChannel;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
	) {
		super();
		this._channel = mainProcessService.getChannel(KINGU_RUNTIME_CHANNEL_NAME);
	}

	start(): Promise<IKinguRuntimeEndpoint> {
		return this._channel.call<IKinguRuntimeEndpoint>('start');
	}

	stop(): Promise<void> {
		return this._channel.call<void>('stop');
	}

	status(): Promise<KinguRuntimeStatus> {
		return this._channel.call<KinguRuntimeStatus>('status');
	}
}
