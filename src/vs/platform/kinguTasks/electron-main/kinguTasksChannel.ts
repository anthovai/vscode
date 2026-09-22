/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../log/common/log.js';
import { loadOrcaStartup } from '../../kinguOrca/electron-main/kinguOrcaHost.js';
import {
	IKinguTaskProvider,
	KINGU_TASK_PROVIDER_LABELS,
	KinguTaskProviderId,
	KinguTaskProviderState,
} from '../common/kinguTasks.js';

export { KINGU_TASKS_CHANNEL_NAME } from '../common/kinguTasks.js';

/**
 * The window's handle on the ADE's task providers.
 *
 * It lives in the main process because that is where the ADE lives: its bundle
 * is required into this process at startup, and its providers hold connections
 * and credentials that the sandboxed sessions renderer cannot reach.
 *
 * There is no HTTP client, no token store and no provider API in this file, and
 * there should never be one. The ADE already implements all four providers; the
 * point of the merge is that the fork asks it rather than growing a second
 * implementation that then has to be kept in step.
 */
export class KinguTasksChannel implements IServerChannel {

	constructor(
		@ILogService private readonly logService: ILogService,
	) { }

	listen<T>(_context: unknown, event: string): Event<T> {
		throw new Error(`No such event: ${event}`);
	}

	async call<T>(_context: unknown, command: string): Promise<T> {
		switch (command) {
			case 'getProviders': return this.getProviders() as T;
		}
		throw new Error(`No such command: ${command}`);
	}

	private getProviders(): readonly IKinguTaskProvider[] {
		const orca = loadOrcaStartup();

		return KINGU_TASK_PROVIDER_LABELS.map(({ id, label }) => ({
			id,
			label,
			state: orca ? this.readState(id, orca) : KinguTaskProviderState.Unavailable,
		}));
	}

	/**
	 * Ask one provider how it is doing.
	 *
	 * Wrapped because these are the ADE's functions, not the fork's: a provider
	 * that throws while reporting its own status must cost this page a row, not
	 * the whole list.
	 */
	private readState(id: KinguTaskProviderId, orca: { getLinearStatus(): { connected: boolean }; getJiraStatus(): { connected: boolean } }): KinguTaskProviderState {
		try {
			switch (id) {
				case KinguTaskProviderId.Linear:
					return orca.getLinearStatus().connected ? KinguTaskProviderState.Connected : KinguTaskProviderState.Disconnected;
				case KinguTaskProviderId.Jira:
					return orca.getJiraStatus().connected ? KinguTaskProviderState.Connected : KinguTaskProviderState.Disconnected;
				// GitHub and GitLab report authentication through `auth-diagnose`
				// and `gitlab-auth-and-rate-limit`, which is a different shape and
				// a separate piece of work. Reported as unavailable rather than
				// disconnected so the page does not offer a sign-in that leads
				// nowhere.
				default:
					return KinguTaskProviderState.Unavailable;
			}
		} catch (error) {
			this.logService.warn(`[kingu-tasks] ${id} failed to report status`, error);
			return KinguTaskProviderState.Unavailable;
		}
	}
}
