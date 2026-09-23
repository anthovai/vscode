/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IKinguOrcaPush, KINGU_ORCA_CHANNEL_NAME } from '../../../../platform/kinguOrca/common/kinguOrca.js';
import { IKinguOrcaService } from '../common/kinguOrca.js';

class KinguOrcaService implements IKinguOrcaService {

	declare readonly _serviceBrand: undefined;

	private readonly _channel: IChannel;
	private readonly _onPush: Event<IKinguOrcaPush>;

	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		this._channel = mainProcessService.getChannel(KINGU_ORCA_CHANNEL_NAME);
		this._onPush = this._channel.listen<IKinguOrcaPush>('onPush');
	}

	invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
		return this._channel.call<T>('invoke', [channel, args]);
	}

	onPush(channel: string): Event<readonly unknown[]> {
		return Event.map(Event.filter(this._onPush, push => push.channel === channel), push => push.args);
	}
}

registerSingleton(IKinguOrcaService, KinguOrcaService, InstantiationType.Delayed);
