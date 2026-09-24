/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/*
 * The ADE's Tasks page model, ported from `shared/task-providers.ts`,
 * `task-source-provider-availability.ts` and `task-source-context-summary.ts`.
 * Pure data in and out so the page and the sessions list can share it.
 */

import { localize } from '../../../../nls.js';

export const KINGU_TASKS_VIEW_ID = 'kingu.customView.tasks';
export const KINGU_SHOW_TASKS_COMMAND_ID = 'kingu.tasks.show';

export type KinguTaskProvider = 'github' | 'gitlab' | 'linear' | 'jira';

export const KINGU_TASK_PROVIDERS: readonly KinguTaskProvider[] = ['github', 'gitlab', 'linear', 'jira'];

/** The part of the ADE's `PreflightStatus` the Tasks page reads. */
export interface IKinguPreflightStatus {
	readonly gh: { readonly installed: boolean; readonly authenticated: boolean };
	/** Absent on hosts that predate GitLab support. */
	readonly glab?: { readonly installed: boolean; readonly authenticated: boolean };
}

export interface IKinguLinearWorkspace {
	readonly id: string;
	readonly displayName?: string;
	readonly organizationName?: string;
}

/** The ADE's `LinearConnectionStatus`. */
export interface IKinguLinearStatus {
	readonly connected: boolean;
	readonly workspaces?: readonly IKinguLinearWorkspace[];
	readonly activeWorkspaceId?: string | null;
	readonly selectedWorkspaceId?: string | null;
	readonly credentialError?: string;
}

export interface IKinguJiraSite {
	readonly id: string;
	readonly siteUrl: string;
	readonly displayName: string;
}

/** The ADE's `JiraConnectionStatus`. */
export interface IKinguJiraStatus {
	readonly connected: boolean;
	readonly sites?: readonly IKinguJiraSite[];
	readonly activeSiteId?: string | null;
	readonly selectedSiteId?: string | null;
	readonly credentialError?: string;
}

export type KinguTaskSourceReason = 'missing-provider-auth' | 'unavailable-source-tool' | 'unsupported-provider';

export interface IKinguTaskSourceNotice {
	readonly label: string;
	readonly title: string;
	readonly blocking: boolean;
}

export interface IKinguTaskSourceSummary {
	readonly label: string;
	readonly title: string;
}

function isTaskProvider(value: unknown): value is KinguTaskProvider {
	return typeof value === 'string' && (KINGU_TASK_PROVIDERS as readonly string[]).includes(value);
}

export function normalizeVisibleTaskProviders(value: unknown): KinguTaskProvider[] {
	if (!Array.isArray(value)) {
		return [...KINGU_TASK_PROVIDERS];
	}
	const normalized: KinguTaskProvider[] = [];
	for (const provider of value) {
		if (isTaskProvider(provider) && !normalized.includes(provider)) {
			normalized.push(provider);
		}
	}
	// At least one must remain, so the page always has a source to select.
	return normalized.length > 0 ? normalized : [...KINGU_TASK_PROVIDERS];
}

function isTaskProviderAvailable(provider: KinguTaskProvider, availability: { gitlabInstalled: boolean; linearConnected: boolean }): boolean {
	switch (provider) {
		case 'github':
		// Jira connects from the page itself, so hiding it would remove the way in.
		case 'jira':
			return true;
		case 'gitlab':
			return availability.gitlabInstalled;
		case 'linear':
			return availability.linearConnected;
	}
}

/** The ADE's `restoreAvailableDefaultTaskProvider`: the sources the bar shows. */
export function getVisibleTaskProviders(settings: { visibleTaskProviders?: unknown; defaultTaskSource?: unknown } | undefined, availability: { gitlabInstalled: boolean; linearConnected: boolean }): KinguTaskProvider[] {
	const visible = normalizeVisibleTaskProviders(settings?.visibleTaskProviders);
	const filtered = visible.filter(provider => isTaskProviderAvailable(provider, availability));
	const available: KinguTaskProvider[] = filtered.length > 0 ? filtered : ['github'];
	const preferred = settings?.defaultTaskSource;
	// A drifted setting can hide the saved default while it is usable; keep it reachable.
	if (isTaskProvider(preferred) && isTaskProviderAvailable(preferred, availability) && !available.includes(preferred)) {
		return KINGU_TASK_PROVIDERS.filter(provider => provider === preferred || available.includes(provider));
	}
	return available;
}

export function resolveVisibleTaskProvider(preferred: unknown, visible: readonly KinguTaskProvider[]): KinguTaskProvider {
	return isTaskProvider(preferred) && visible.includes(preferred) ? preferred : visible[0] ?? 'github';
}

/** Why a repo-backed provider cannot load on this host, or `undefined` when it can (or the check has not run). */
export function getRepoBackedProviderReason(provider: 'github' | 'gitlab', preflight: IKinguPreflightStatus | undefined): KinguTaskSourceReason | undefined {
	if (!preflight) {
		return undefined;
	}
	const status = provider === 'github'
		? preflight.gh
		// A host that predates GitLab preflight lacks the capability; that is not a missing install.
		: Object.hasOwn(preflight, 'glab') ? preflight.glab ?? { installed: false, authenticated: false } : 'unsupported';
	if (status === 'unsupported') {
		return 'unsupported-provider';
	}
	if (!status.installed) {
		return 'unavailable-source-tool';
	}
	return status.authenticated ? undefined : 'missing-provider-auth';
}

function reasonLabel(reason: KinguTaskSourceReason): string {
	switch (reason) {
		case 'missing-provider-auth': return localize('kingu.tasks.reason.auth', "provider auth needed");
		case 'unavailable-source-tool': return localize('kingu.tasks.reason.tool', "source tool unavailable");
		case 'unsupported-provider': return localize('kingu.tasks.reason.unsupported', "provider unsupported on this host");
	}
}

/**
 * The ADE's `getTaskSourceAvailabilityNotice` for one host. With a single
 * source the notice is always blocking: the only host cannot load it.
 */
export function getTaskSourceNotice(providerLabel: string, hostLabel: string, reason: KinguTaskSourceReason | undefined): IKinguTaskSourceNotice | undefined {
	if (!reason) {
		return undefined;
	}
	const target = `${hostLabel} ${reasonLabel(reason)}`;
	return {
		label: localize('kingu.tasks.sourceUnavailable', "{0} source unavailable: {1}", providerLabel, target),
		title: localize('kingu.tasks.reconnectOrUpdate', "Reconnect or update {0} to load this source.", target),
		blocking: true,
	};
}

/** The ADE's `getTaskSourceContextSummary`: the chip beside the source buttons. */
export function getTaskSourceSummary(args: {
	readonly provider: KinguTaskProvider;
	readonly providerLabel: string;
	readonly hostLabel: string;
	readonly reason?: KinguTaskSourceReason;
	readonly accountLabel?: string | null;
}): IKinguTaskSourceSummary {
	const availability = args.reason ? reasonLabel(args.reason) : undefined;
	if (args.provider === 'github' || args.provider === 'gitlab') {
		const titleParts = [
			args.providerLabel,
			localize('kingu.tasks.summary.host', "Host: {0}", args.hostLabel),
			availability ? localize('kingu.tasks.summary.availability', "Availability: {0}", `${args.hostLabel} ${availability}`) : undefined,
		];
		return {
			label: [args.providerLabel, args.hostLabel, availability].filter(isString).join(' · '),
			title: titleParts.filter(isString).join(' · '),
		};
	}
	const target = args.accountLabel?.trim() || localize('kingu.tasks.summary.currentAccount', "Current account");
	return {
		label: [args.providerLabel, args.hostLabel, availability, target].filter(isString).join(' · '),
		title: [
			localize('kingu.tasks.summary.source', "{0} source", args.providerLabel),
			localize('kingu.tasks.summary.host', "Host: {0}", args.hostLabel),
			localize('kingu.tasks.summary.account', "Account: {0}", target),
		].join(' · '),
	};
}

function isString(value: string | undefined): value is string {
	return !!value;
}

/** The workspace the ADE reads Linear from: the selection, then the active one, then the first. */
export function getSelectedLinearWorkspace(status: IKinguLinearStatus | undefined): IKinguLinearWorkspace | undefined {
	const workspaces = status?.workspaces ?? [];
	const id = status?.selectedWorkspaceId ?? status?.activeWorkspaceId ?? workspaces[0]?.id;
	return id && id !== 'all' ? workspaces.find(workspace => workspace.id === id) : undefined;
}

/** The ADE's `selectedJiraSiteId`: `'all'` when every site is read together. */
export function getSelectedJiraSiteId(status: IKinguJiraStatus | undefined): string | undefined {
	return status?.selectedSiteId ?? status?.activeSiteId ?? status?.sites?.[0]?.id ?? undefined;
}

/** The host label the ADE shows for this machine. */
export function getLocalHostLabel(platform: 'mac' | 'windows' | 'linux' | 'other'): string {
	switch (platform) {
		case 'mac': return localize('kingu.tasks.host.mac', "Local Mac");
		case 'windows': return localize('kingu.tasks.host.windows', "Local Windows");
		case 'linux': return localize('kingu.tasks.host.linux', "Local Linux");
		case 'other': return localize('kingu.tasks.host.other', "This computer");
	}
}
