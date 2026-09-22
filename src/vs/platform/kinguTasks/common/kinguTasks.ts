/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const KINGU_TASKS_CHANNEL_NAME = 'kinguTasks';

/**
 * The task trackers Kingu can pull work from.
 *
 * The set is the ADE's, not a subset chosen here: it already implements all four
 * and the Agents Window implements none, which is why this is the first
 * capability moved across.
 */
export const enum KinguTaskProviderId {
	GitHub = 'github',
	GitLab = 'gitlab',
	Jira = 'jira',
	Linear = 'linear',
}

/**
 * Whether a provider can currently be used, and if not, why not.
 *
 * `Unavailable` is not an error state and not "disconnected". It means this
 * build cannot yet ask the provider anything — the ADE reports GitHub's and
 * GitLab's authentication through a different shape than Linear's and Jira's,
 * and that adapter is not written. Kept as its own state so the page can say so
 * instead of showing a signed-out provider that would never sign in.
 */
export const enum KinguTaskProviderState {
	Connected = 'connected',
	Disconnected = 'disconnected',
	Unavailable = 'unavailable',
}

export interface IKinguTaskProvider {
	readonly id: KinguTaskProviderId;
	readonly label: string;
	readonly state: KinguTaskProviderState;
}

export interface IKinguTasksService {
	readonly _serviceBrand: undefined;

	/**
	 * What each provider reports right now.
	 *
	 * Always all four, in a stable order, whatever their state — the page is a
	 * list of what Kingu can connect to, so a provider that is signed out or not
	 * yet reachable still has a row.
	 */
	getProviders(): Promise<readonly IKinguTaskProvider[]>;
}

export const IKinguTasksService = createDecorator<IKinguTasksService>('kinguTasksService');

/** Display names, in the order the page lists them. */
export const KINGU_TASK_PROVIDER_LABELS: ReadonlyArray<{ id: KinguTaskProviderId; label: string }> = [
	{ id: KinguTaskProviderId.GitHub, label: 'GitHub' },
	{ id: KinguTaskProviderId.GitLab, label: 'GitLab' },
	{ id: KinguTaskProviderId.Jira, label: 'Jira' },
	{ id: KinguTaskProviderId.Linear, label: 'Linear' },
];
