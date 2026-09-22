/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import {
	IKinguTaskProvider,
	IKinguTasksService,
	KINGU_TASKS_CHANNEL_NAME,
} from '../../../../platform/kinguTasks/common/kinguTasks.js';

/**
 * The window's side of the task providers.
 *
 * A thin pass-through, and deliberately so: the providers themselves are the
 * ADE's and run in the main process, where their credentials and connections
 * live. Nothing about GitHub, GitLab, Jira or Linear is known in this file.
 *
 * In `electron-browser` rather than `browser` because `IMainProcessService` is
 * an Electron-only service — a browser-layer file may not reach it.
 */
export class KinguTasksService implements IKinguTasksService {

	declare readonly _serviceBrand: undefined;

	private readonly _channel: IChannel;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
	) {
		this._channel = mainProcessService.getChannel(KINGU_TASKS_CHANNEL_NAME);
	}

	getProviders(): Promise<readonly IKinguTaskProvider[]> {
		return this._channel.call<readonly IKinguTaskProvider[]>('getProviders');
	}
}
