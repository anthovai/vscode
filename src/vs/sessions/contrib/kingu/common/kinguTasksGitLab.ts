/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';

/**
 * The ADE's GitLab task source (`task-page/gitlab/*`), its data side. The
 * shapes are the ADE's `shared/gitlab-types.ts`, read through its `gitlab:*`
 * channels; the rules — which view, which filter chips, how the lists of
 * several projects merge — are the ADE's own.
 */

/** `GitLabProjectRef`. */
export interface IKinguGitLabProjectRef {
	readonly host: string;
	readonly path: string;
}

/** `GitLabWorkItem`, as far as the list reads it. */
export interface IKinguGitLabWorkItem {
	readonly id: string;
	readonly type: 'issue' | 'mr';
	readonly number: number;
	readonly title: string;
	readonly state: 'opened' | 'closed' | 'merged' | 'locked' | 'draft';
	readonly url: string;
	readonly labels: readonly string[];
	readonly updatedAt: string;
	readonly author: string | null;
	readonly repoId: string;
	readonly projectRef?: IKinguGitLabProjectRef;
}

/** `ClassifiedError`. */
export interface IKinguGitLabError {
	readonly type: 'permission_denied' | 'not_found' | 'issues_disabled' | 'validation_error' | 'rate_limited' | 'network_error' | 'unknown';
	readonly message: string;
}

/** `ListMergeRequestsResult` (`GitLabPagedResult<GitLabWorkItem>`) and the `listIssues` result. */
export interface IKinguGitLabListResult {
	readonly items?: readonly IKinguGitLabWorkItem[];
	readonly totalPages?: number;
	readonly error?: IKinguGitLabError;
}

/** `GitLabTodo`, as far as the list reads it. */
export interface IKinguGitLabTodo {
	readonly id: number;
	readonly actionName: string;
	readonly targetType: string;
	readonly targetIid: number | null;
	readonly targetTitle: string;
	readonly targetUrl: string;
	readonly projectPath: string;
	readonly authorUsername: string;
	readonly authorAvatarUrl: string;
	readonly updatedAt: string;
}

/** The ADE's `gitlabView`, `'mrs'` by default. */
export type KinguGitLabView = 'issues' | 'mrs' | 'todos';

/** `GitLabTaskFilter`: the merge-request chips. */
export type KinguGitLabMrFilter = 'opened' | 'merged' | 'closed' | 'all';

/** `GitLabIssueFilter`: the issue chips. */
export type KinguGitLabIssueFilter = 'opened' | 'assigned-to-me';

/** How many items each project is asked for, as the ADE asks. */
export const GITLAB_PER_PROJECT_LIMIT = 50;

export function getGitLabViews(): readonly { id: KinguGitLabView; label: string }[] {
	return [
		{ id: 'issues', label: localize('kingu.tasks.gitlab.issues', "Issues") },
		{ id: 'mrs', label: localize('kingu.tasks.gitlab.mrs', "MRs") },
		{ id: 'todos', label: localize('kingu.tasks.gitlab.todos', "My Todos") },
	];
}

export function getGitLabMrFilters(): readonly { id: KinguGitLabMrFilter; label: string }[] {
	return [
		{ id: 'opened', label: localize('kingu.tasks.gitlab.open', "Open") },
		{ id: 'merged', label: localize('kingu.tasks.gitlab.merged', "Merged") },
		{ id: 'closed', label: localize('kingu.tasks.gitlab.closed', "Closed") },
		{ id: 'all', label: localize('kingu.tasks.gitlab.all', "All") },
	];
}

export function getGitLabIssueFilters(): readonly { id: KinguGitLabIssueFilter; label: string }[] {
	return [
		{ id: 'opened', label: localize('kingu.tasks.gitlab.open', "Open") },
		{ id: 'assigned-to-me', label: localize('kingu.tasks.gitlab.assignedToMe', "Assigned to me") },
	];
}

/** The arguments `gitlab:listIssues` takes for an issue chip: "Assigned to me" is the open issues assigned to `@me`. */
export function getGitLabIssueQuery(filter: KinguGitLabIssueFilter): { state: 'opened'; assignee?: string; limit: number } {
	return filter === 'assigned-to-me'
		? { state: 'opened', assignee: '@me', limit: GITLAB_PER_PROJECT_LIMIT }
		: { state: 'opened', limit: GITLAB_PER_PROJECT_LIMIT };
}

/**
 * Several projects' answers as one list, as the ADE merges them: newest
 * update first. A project that is not on GitLab answers `not_found`; that is
 * not a failure, it simply adds nothing, so only the other errors are kept.
 */
export function mergeGitLabResults(results: readonly { readonly repoId: string; readonly result: IKinguGitLabListResult | undefined; readonly thrown?: string }[]): { items: IKinguGitLabWorkItem[]; errors: { repoId: string; message: string }[] } {
	const items: IKinguGitLabWorkItem[] = [];
	const errors: { repoId: string; message: string }[] = [];
	for (const { repoId, result, thrown } of results) {
		if (thrown) {
			errors.push({ repoId, message: thrown });
			continue;
		}
		if (result?.error && result.error.type !== 'not_found') {
			errors.push({ repoId, message: result.error.message });
		}
		for (const item of result?.items ?? []) {
			items.push({ ...item, repoId });
		}
	}
	items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
	return { items, errors };
}

/** The ID column: `!N` for a merge request, `#N` for an issue. */
export function formatGitLabReference(item: Pick<IKinguGitLabWorkItem, 'type' | 'number'>): string {
	return `${item.type === 'mr' ? '!' : '#'}${item.number}`;
}

/** The Type / State column, as the ADE writes it: `MR · opened`. */
export function formatGitLabTypeState(item: Pick<IKinguGitLabWorkItem, 'type' | 'state'>): string {
	return `${item.type === 'mr' ? localize('kingu.tasks.gitlab.typeMr', "MR") : localize('kingu.tasks.gitlab.typeIssue', "Issue")} · ${item.state}`;
}

/** The tone the state is drawn in, on the GitHub list's status palette. */
export function getGitLabStateTone(state: IKinguGitLabWorkItem['state']): 'open' | 'closed' | 'merged' | 'draft' {
	switch (state) {
		case 'opened': return 'open';
		case 'merged': return 'merged';
		case 'draft': return 'draft';
		default: return 'closed';
	}
}

/** The empty state of each view, in the ADE's words. */
export function getGitLabEmptyState(view: KinguGitLabView): { title: string; description: string } {
	switch (view) {
		case 'issues':
			return { title: localize('kingu.tasks.gitlab.noIssues', "No GitLab issues"), description: localize('kingu.tasks.gitlab.noIssuesDescription', "No GitLab issues match this filter.") };
		case 'mrs':
			return { title: localize('kingu.tasks.gitlab.noMrs', "No GitLab merge requests"), description: localize('kingu.tasks.gitlab.noMrsDescription', "No GitLab MRs match this filter.") };
		case 'todos':
			return { title: localize('kingu.tasks.gitlab.noTodos', "No pending todos"), description: localize('kingu.tasks.gitlab.noTodosDescription', "No pending todos. You're all caught up!") };
	}
}

/** A todo's action as a reader says it: `review_requested` reads "review requested". */
export function formatGitLabTodoAction(actionName: string): string {
	return actionName.replace(/_/g, ' ');
}
