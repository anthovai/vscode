/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/*
 * The ADE's Jira issue list model, ported from `jira-issue-sorter.ts`,
 * `task-page-jira-issue-list.tsx` (grouping), `task-page-jira-status-order.ts`,
 * `task-page-jira-status-tone.ts` and `task-page-jira-load-state.ts`.
 */

import { localize } from '../../../../nls.js';

/** The ADE's `JIRA_ITEM_LIMIT`. */
export const JIRA_ITEM_LIMIT = 50;

export type KinguJiraPreset = 'assigned' | 'reported' | 'all' | 'done';

export type KinguJiraSortColumn = 'key' | 'title' | 'status' | 'priority' | 'assignee' | 'updated';

export type KinguSortDirection = 'asc' | 'desc';

/** The part of the ADE's `JiraIssue` the list reads. */
export interface IKinguJiraIssue {
	readonly id: string;
	readonly key: string;
	readonly siteId?: string;
	readonly siteName?: string;
	readonly title: string;
	readonly url: string;
	readonly project: { readonly key: string; readonly siteId?: string };
	readonly status: { readonly id: string; readonly name: string; readonly categoryKey: string };
	readonly labels: readonly string[];
	readonly assignee?: { readonly displayName: string; readonly avatarUrl?: string };
	readonly priority?: { readonly id: string; readonly name: string };
	readonly updatedAt: string;
}

/** The ADE's `JiraProjectStatusOrder`: status ids per board column. */
export interface IKinguJiraStatusOrder {
	readonly statusIdsByColumn: readonly (readonly string[])[];
}

export interface IKinguJiraSection {
	readonly key: string;
	readonly label: string;
	readonly issues: IKinguJiraIssue[];
}

export function getJiraPresets(): readonly { id: KinguJiraPreset; label: string }[] {
	return [
		{ id: 'assigned', label: localize('kingu.tasks.jira.assigned', "Assigned") },
		{ id: 'reported', label: localize('kingu.tasks.jira.reported', "Reported") },
		{ id: 'all', label: localize('kingu.tasks.jira.allOpen', "All Open") },
		{ id: 'done', label: localize('kingu.tasks.jira.done', "Done") },
	];
}

export function getJiraSortColumns(): readonly { id: KinguJiraSortColumn; label: string; wide?: boolean }[] {
	return [
		{ id: 'key', label: localize('kingu.tasks.jira.key', "Key") },
		{ id: 'title', label: localize('kingu.tasks.jira.issue', "Issue") },
		{ id: 'status', label: localize('kingu.tasks.jira.status', "Status") },
		{ id: 'priority', label: localize('kingu.tasks.jira.priority', "Priority") },
		{ id: 'assignee', label: localize('kingu.tasks.jira.assignee', "Assignee"), wide: true },
		{ id: 'updated', label: localize('kingu.tasks.jira.updated', "Updated") },
	];
}

/** The ADE's `handleJiraSort`: the same column flips direction, a new one starts at its natural end. */
export function nextJiraSort(current: { orderBy: KinguJiraSortColumn; direction: KinguSortDirection }, column: KinguJiraSortColumn): { orderBy: KinguJiraSortColumn; direction: KinguSortDirection } {
	if (current.orderBy === column) {
		return { orderBy: column, direction: current.direction === 'asc' ? 'desc' : 'asc' };
	}
	return { orderBy: column, direction: column === 'updated' || column === 'status' ? 'desc' : 'asc' };
}

/** Synonymous names for the same standard tier, as Jira instances use them. */
const JIRA_PRIORITY_ORDER: Readonly<Record<string, number>> = {
	blocker: 99, highest: 99, critical: 99,
	high: 75, major: 75,
	medium: 50, normal: 50,
	low: 25, minor: 25,
	lowest: 1, trivial: 1,
};

function priorityWeight(name: string | undefined): number {
	if (!name) {
		return 0;
	}
	// Custom priorities have opaque ids, not ranks; they sit in the middle.
	return JIRA_PRIORITY_ORDER[name.toLowerCase()] ?? 50;
}

const numericCollator = new Intl.Collator(undefined, { numeric: true });

export function sortJiraIssues(issues: readonly IKinguJiraIssue[], orderBy: KinguJiraSortColumn, direction: KinguSortDirection): IKinguJiraIssue[] {
	const compare = (a: IKinguJiraIssue, b: IKinguJiraIssue): number => {
		switch (orderBy) {
			case 'key': return numericCollator.compare(a.key, b.key);
			case 'title': return a.title.localeCompare(b.title);
			// Status order is the grouping's job.
			case 'status': return 0;
			case 'priority': return priorityWeight(a.priority?.name) - priorityWeight(b.priority?.name);
			case 'assignee': return (a.assignee?.displayName ?? '').localeCompare(b.assignee?.displayName ?? '');
			case 'updated': return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
		}
	};
	return [...issues].sort((a, b) => direction === 'asc' ? compare(a, b) : -compare(a, b));
}

/** The ADE's `groupJiraIssuesByStatus`: sections by status, in board-column order, then by name. */
export function groupJiraIssuesByStatus(issues: readonly IKinguJiraIssue[], statusOrder: IKinguJiraStatusOrder | undefined, direction: KinguSortDirection = 'asc'): IKinguJiraSection[] {
	const sections = new Map<string, IKinguJiraSection>();
	for (const issue of issues) {
		const key = `status:${issue.status.name}`;
		const section = sections.get(key);
		if (section) {
			section.issues.push(issue);
		} else {
			sections.set(key, { key, label: issue.status.name, issues: [issue] });
		}
	}
	const ranks = new Map<string, number>();
	for (const [column, statusIds] of (statusOrder?.statusIdsByColumn ?? []).entries()) {
		for (const statusId of statusIds) {
			if (!ranks.has(statusId)) {
				ranks.set(statusId, column);
			}
		}
	}
	const rankOf = (section: IKinguJiraSection) => Math.min(...section.issues.map(issue => ranks.get(issue.status.id) ?? Number.POSITIVE_INFINITY));
	const sorted = [...sections.values()].sort((a, b) => {
		const rankA = rankOf(a);
		const rankB = rankOf(b);
		return rankA === rankB ? a.label.localeCompare(b.label) : rankA - rankB;
	});
	return direction === 'desc' ? sorted.reverse() : sorted;
}

/** The ADE's `getSingleJiraProjectScope`: the one project every issue is in, if there is one. */
export function getSingleJiraProjectScope(issues: readonly IKinguJiraIssue[]): { projectKey: string; siteId: string } | undefined {
	let only: { projectKey: string; siteId: string } | undefined;
	for (const issue of issues) {
		const projectKey = issue.project.key.trim();
		const siteId = issue.siteId?.trim() || issue.project.siteId?.trim();
		if (!projectKey || !siteId || (only && (only.projectKey !== projectKey || only.siteId !== siteId))) {
			return undefined;
		}
		only = { projectKey, siteId };
	}
	return only;
}

/** The ADE's `getJiraStatusTone`, as a class name. */
export function getJiraStatusTone(categoryKey: string): 'done' | 'indeterminate' | 'default' {
	return categoryKey === 'done' || categoryKey === 'indeterminate' ? categoryKey : 'default';
}

export interface IKinguJiraLoadError {
	readonly title: string;
	readonly details: string | undefined;
}

function errorCode(message: string): number | undefined {
	const explicit = /^Error\s+(?<code>\d{3})\b/i.exec(message)?.groups?.code;
	if (explicit) {
		return Number(explicit);
	}
	if (/\bforbidden\b/i.test(message)) {
		return 403;
	}
	if (/\bunauthorized\b|\bunauthenticated\b/i.test(message)) {
		return 401;
	}
	if (/\btoo many requests\b|\brate limit\b/i.test(message)) {
		return 429;
	}
	if (/\bservice unavailable\b/i.test(message)) {
		return 503;
	}
	return undefined;
}

function errorSummary(message: string, code: number | undefined): string {
	if (code === 401) {
		return localize('kingu.tasks.jira.error401', "Jira authentication failed. Reconnect Jira in Settings, then try again.");
	}
	if (code === 403) {
		return localize('kingu.tasks.jira.error403', "Jira denied access to this issue search. Check project permissions or try a different JQL query.");
	}
	if (code === 429) {
		return localize('kingu.tasks.jira.error429', "Jira rate-limited this issue search. Try again in a moment.");
	}
	if (code !== undefined && code >= 500) {
		return localize('kingu.tasks.jira.error5xx', "Jira had a server error while loading issues. Try again in a moment.");
	}
	if (/\bjql\b|\bsyntax\b/i.test(message)) {
		return localize('kingu.tasks.jira.errorJql', "Jira couldn't run this JQL query. Check the syntax and try again.");
	}
	if (/\bnetwork\b|\bfetch failed\b|\btimed? ?out\b|\beconn/i.test(message)) {
		return localize('kingu.tasks.jira.errorNetwork', "Couldn't reach Jira. Check your connection and try again.");
	}
	return localize('kingu.tasks.jira.errorOther', "Couldn't load Jira issues. Try again in a moment.");
}

/** The ADE's `createTaskPageJiraLoadFailureState`. */
export function getJiraLoadError(error: unknown): IKinguJiraLoadError {
	const message = error instanceof Error ? error.message : localize('kingu.tasks.jira.loadFailed', "Failed to load Jira issues.");
	const code = errorCode(message);
	const summary = errorSummary(message, code);
	const details = (code === undefined ? message : message.replace(new RegExp(`^Error\\s+${code}:\\s*`, 'i'), '')).trim();
	return {
		title: code === undefined ? summary : localize('kingu.tasks.jira.errorWithCode', "Error {0}: {1}", code, summary),
		details: details || undefined,
	};
}
