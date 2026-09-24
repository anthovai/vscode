/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/*
 * The ADE's Linear issue list model, ported from `shared/linear/issue-types.ts`,
 * `compareLinearIssues`, `linear-priority-icon.tsx` and `getLinearIssueGridTemplate`.
 */

import { localize } from '../../../../nls.js';

/** The ADE's `LINEAR_ITEM_LIMIT`. */
export const LINEAR_ITEM_LIMIT = 36;

/** The part of the ADE's `LinearIssue` the list reads. */
export interface IKinguLinearIssue {
	readonly id: string;
	readonly identifier: string;
	readonly title: string;
	readonly url: string;
	readonly state: { readonly name: string; readonly type?: string; readonly color: string };
	/** 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
	readonly priority: number;
	readonly assignee?: { readonly displayName: string; readonly avatarUrl?: string };
	readonly team: { readonly id: string; readonly name: string };
	readonly labels: readonly string[];
	readonly updatedAt: string;
	readonly workspaceName?: string;
}

/** The ADE's `LinearCollectionResult`; a bare array is the same with no errors. */
export interface IKinguLinearCollection {
	readonly items: readonly IKinguLinearIssue[];
	readonly hasMore?: boolean;
}

export function normalizeLinearCollection(result: IKinguLinearCollection | readonly IKinguLinearIssue[] | undefined): IKinguLinearCollection {
	if (!result) {
		return { items: [] };
	}
	return Array.isArray(result) ? { items: result } : result as IKinguLinearCollection;
}

/**
 * The ADE's default grid with its default display properties: key, title,
 * labels, state, assignee, updated, actions. Team drops out while one team or
 * fewer is selected, which is every case until team selection is ported.
 */
export const LINEAR_GRID_TEMPLATE = '96px minmax(240px,1.55fr) minmax(168px,0.9fr) 138px 64px 104px 64px';

function priorityRank(priority: number): number {
	return priority === 0 ? 5 : priority;
}

/** The ADE's `compareLinearIssues` for its default order, priority: urgent first, none last, then newest. */
export function sortLinearIssuesByPriority(issues: readonly IKinguLinearIssue[]): IKinguLinearIssue[] {
	return [...issues].sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function getLinearPriorityLabel(priority: number): string {
	switch (priority) {
		case 0: return localize('kingu.tasks.linear.priority0', "No priority");
		case 1: return localize('kingu.tasks.linear.priority1', "Urgent");
		case 2: return localize('kingu.tasks.linear.priority2', "High");
		case 3: return localize('kingu.tasks.linear.priority3', "Medium");
		case 4: return localize('kingu.tasks.linear.priority4', "Low");
		default: return `P${priority}`;
	}
}

/** How many of the three bars a priority lights: high 3, medium 2, low 1. */
export function getLinearPriorityBars(priority: number): number {
	return priority >= 2 && priority <= 4 ? 5 - priority : 0;
}
