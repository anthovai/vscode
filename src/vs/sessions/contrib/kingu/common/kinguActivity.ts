/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { SessionStatus } from '../../../services/sessions/common/session.js';

/**
 * What a session is doing, as the activity view ranks it.
 *
 * Ported from the ADE's activity status ids. Theirs come from a hook each agent
 * reports through, and carry states this window cannot have — `monitoring`,
 * `unverifiable`, `interrupted` — because a CLI in a PTY can stop being
 * observable. Here the status arrives over the agent host protocol, so the set
 * is smaller and every member of it is something the session actually said.
 */
export const enum KinguActivityStatus {
	NeedsInput = 'needsInput',
	Working = 'working',
	Failed = 'failed',
	Done = 'done',
	Draft = 'draft',
	Archived = 'archived',
}

/**
 * The order the groups appear in: attention first.
 *
 * An exhaustive record rather than a lookup with a fallback, so a status added
 * later is a type error here instead of silently sorting to the top. The ranks
 * are unique, so header order never falls back to whichever session happened to
 * be touched last.
 *
 * `failed` sits below `working` — the ADE's ordering, and right: a run that
 * failed has already stopped and will wait, while a run in progress is the one
 * whose output is still moving.
 */
const STATUS_RANK: Record<KinguActivityStatus, number> = {
	[KinguActivityStatus.NeedsInput]: 0,
	[KinguActivityStatus.Working]: 1,
	[KinguActivityStatus.Failed]: 2,
	[KinguActivityStatus.Done]: 3,
	[KinguActivityStatus.Draft]: 4,
	[KinguActivityStatus.Archived]: 5,
};

export function kinguActivityStatusRank(status: KinguActivityStatus): number {
	return STATUS_RANK[status];
}

export function kinguActivityStatusLabel(status: KinguActivityStatus): string {
	switch (status) {
		case KinguActivityStatus.NeedsInput: return localize('kingu.activity.status.needsInput', "Needs input");
		case KinguActivityStatus.Working: return localize('kingu.activity.status.working', "Working");
		case KinguActivityStatus.Failed: return localize('kingu.activity.status.failed', "Failed");
		case KinguActivityStatus.Done: return localize('kingu.activity.status.done', "Done");
		case KinguActivityStatus.Draft: return localize('kingu.activity.status.draft', "Not sent yet");
		case KinguActivityStatus.Archived: return localize('kingu.activity.status.archived', "Archived");
	}
}

/**
 * The status a session's row carries.
 *
 * Archived wins over everything: an archived session is not waiting on anyone,
 * whatever it was doing when it was put away, and letting it keep a
 * `needs input` badge would put it at the top of the page for ever.
 */
export function kinguActivityStatus(status: SessionStatus, isArchived: boolean): KinguActivityStatus {
	if (isArchived) {
		return KinguActivityStatus.Archived;
	}
	switch (status) {
		case SessionStatus.NeedsInput: return KinguActivityStatus.NeedsInput;
		case SessionStatus.InProgress: return KinguActivityStatus.Working;
		case SessionStatus.Error: return KinguActivityStatus.Failed;
		case SessionStatus.Untitled: return KinguActivityStatus.Draft;
		case SessionStatus.Completed: return KinguActivityStatus.Done;
	}
}

/** One session, flattened to what the activity view draws and searches. */
export interface IKinguActivityRow {
	readonly sessionId: string;
	/** What opening the row opens. */
	readonly resource: URI;
	readonly title: string;
	readonly status: KinguActivityStatus;
	/** The agent behind it, named as the user would recognise it. */
	readonly agentLabel: string;
	/** The project it is working in, or undefined for a session with no workspace. */
	readonly projectLabel: string | undefined;
	/** What it is doing right now, when the provider says. */
	readonly detail: string | undefined;
	readonly updatedAt: number;
	readonly isRead: boolean;
}

export type KinguActivityGroupBy = 'status' | 'project' | 'agent' | 'none';

export function kinguActivityGroupByLabel(groupBy: KinguActivityGroupBy): string {
	switch (groupBy) {
		case 'status': return localize('kingu.activity.groupBy.status', "Status");
		case 'project': return localize('kingu.activity.groupBy.project', "Project");
		case 'agent': return localize('kingu.activity.groupBy.agent', "Agent");
		case 'none': return localize('kingu.activity.groupBy.none', "Nothing");
	}
}

export interface IKinguActivityGroup {
	readonly key: string;
	readonly label: string;
	/** Set when the group is a status, so its header can carry the same dot the rows do. */
	readonly status: KinguActivityStatus | undefined;
	readonly rows: IKinguActivityRow[];
}

function groupOf(row: IKinguActivityRow, groupBy: KinguActivityGroupBy): { key: string; label: string; status: KinguActivityStatus | undefined } {
	switch (groupBy) {
		case 'status':
			return { key: `status:${row.status}`, label: kinguActivityStatusLabel(row.status), status: row.status };
		case 'project':
			return row.projectLabel === undefined
				? { key: 'project:none', label: localize('kingu.activity.noProject', "No project"), status: undefined }
				: { key: `project:${row.projectLabel}`, label: row.projectLabel, status: undefined };
		case 'agent':
			return { key: `agent:${row.agentLabel}`, label: row.agentLabel, status: undefined };
		case 'none':
			return { key: 'all', label: '', status: undefined };
	}
}

/**
 * The rows, bucketed.
 *
 * Insertion order is kept within a group, so the caller's sort (most recently
 * touched first) survives grouping. Only the status grouping reorders its
 * headers, and it does so by rank rather than by the recency of whichever row
 * landed first — otherwise "needs input" could sit below "done" purely because
 * nothing had been said to it lately, which is the opposite of the point.
 */
export function buildKinguActivityGroups(rows: readonly IKinguActivityRow[], groupBy: KinguActivityGroupBy): IKinguActivityGroup[] {
	if (groupBy === 'none') {
		return rows.length > 0 ? [{ key: 'all', label: '', status: undefined, rows: [...rows] }] : [];
	}
	const groups: IKinguActivityGroup[] = [];
	const indexByKey = new Map<string, number>();
	for (const row of rows) {
		const group = groupOf(row, groupBy);
		const existing = indexByKey.get(group.key);
		if (existing === undefined) {
			indexByKey.set(group.key, groups.length);
			groups.push({ ...group, rows: [row] });
			continue;
		}
		groups[existing].rows.push(row);
	}
	if (groupBy !== 'status') {
		return groups;
	}
	return groups.sort((a, b) => kinguActivityStatusRank(a.rows[0].status) - kinguActivityStatusRank(b.rows[0].status));
}

/**
 * How long a query may be before it stops being a search.
 *
 * The same bound the skills page uses, and for the same reason: a pasted file
 * is not a query, and matching one costs a pass over every row to return
 * nothing.
 */
export const KINGU_ACTIVITY_QUERY_MAX_LENGTH = 2048;

function buildSearchText(row: IKinguActivityRow): string {
	return [
		row.title,
		row.agentLabel,
		row.projectLabel ?? '',
		row.detail ?? '',
		kinguActivityStatusLabel(row.status),
	].join(' ').toLowerCase();
}

/**
 * The searchable text of a row, built once per row object.
 *
 * A row is rebuilt only when the session behind it changed, so its identity is
 * a correct cache key. Without this, every keystroke lowercases every row's
 * text again — the ADE hit exactly this and solved it the same way. A WeakMap
 * so a row that falls out of the list takes its string with it.
 */
const searchTextCache = new WeakMap<IKinguActivityRow, string>();

export function kinguActivityMatchesQuery(row: IKinguActivityRow, query: string): boolean {
	if (query.length > KINGU_ACTIVITY_QUERY_MAX_LENGTH) {
		return false;
	}
	const trimmed = query.trim().toLowerCase();
	if (!trimmed) {
		return true;
	}
	let text = searchTextCache.get(row);
	if (text === undefined) {
		text = buildSearchText(row);
		searchTextCache.set(row, text);
	}
	return text.includes(trimmed);
}

/** Most recently touched first, which is what "activity" means. */
export function sortKinguActivityRows(rows: IKinguActivityRow[]): IKinguActivityRow[] {
	return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** How many rows in this set nobody has looked at yet. */
export function countUnreadKinguActivity(rows: readonly IKinguActivityRow[]): number {
	return rows.reduce((count, row) => row.isRead ? count : count + 1, 0);
}
