/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/*
 * The ADE's GitHub Projects model, ported from `shared/github/project-types.ts`,
 * `project-identity.ts` and the row grouping and sorting of
 * `github-project/ProjectViewList.tsx`.
 */

import { localize } from '../../../../nls.js';

export type KinguProjectOwnerType = 'organization' | 'user';

export interface IKinguProjectRef {
	readonly owner: string;
	readonly ownerType: KinguProjectOwnerType;
	readonly number: number;
	readonly host?: string;
}

export interface IKinguProjectSummary extends IKinguProjectRef {
	readonly id: string;
	readonly title: string;
	readonly url: string;
}

export interface IKinguProjectViewSummary {
	readonly id: string;
	readonly number: number;
	readonly name: string;
	readonly layout: 'TABLE_LAYOUT' | 'BOARD_LAYOUT' | 'ROADMAP_LAYOUT';
}

export type IKinguProjectField =
	| { readonly kind: 'field'; readonly id: string; readonly name: string; readonly dataType: string }
	| { readonly kind: 'single-select'; readonly id: string; readonly name: string; readonly dataType: 'SINGLE_SELECT'; readonly options: readonly { readonly id: string; readonly name: string; readonly color: string }[] }
	| { readonly kind: 'iteration'; readonly id: string; readonly name: string; readonly dataType: 'ITERATION'; readonly iterations: readonly { readonly id: string; readonly title: string; readonly startDate: string; readonly duration: number; readonly completed: boolean }[] };

export interface IKinguProjectUser {
	readonly login: string;
	readonly name: string | null;
	readonly avatarUrl: string | null;
}

export interface IKinguProjectLabel {
	readonly name: string;
	readonly color: string;
}

export type IKinguProjectFieldValue =
	| { readonly kind: 'single-select'; readonly fieldId: string; readonly optionId: string; readonly name: string; readonly color: string }
	| { readonly kind: 'iteration'; readonly fieldId: string; readonly iterationId: string; readonly title: string; readonly startDate: string; readonly duration: number }
	| { readonly kind: 'text'; readonly fieldId: string; readonly text: string }
	| { readonly kind: 'number'; readonly fieldId: string; readonly number: number }
	| { readonly kind: 'date'; readonly fieldId: string; readonly date: string }
	| { readonly kind: 'labels'; readonly fieldId: string; readonly labels: readonly IKinguProjectLabel[] }
	| { readonly kind: 'users'; readonly fieldId: string; readonly users: readonly IKinguProjectUser[] };

export interface IKinguProjectRow {
	readonly id: string;
	readonly itemType: 'ISSUE' | 'PULL_REQUEST' | 'DRAFT_ISSUE' | 'REDACTED';
	readonly content: {
		readonly number: number | null;
		readonly title: string;
		readonly url: string | null;
		readonly state: string | null;
		readonly isDraft: boolean | null;
		readonly repository: string | null;
		readonly assignees: readonly IKinguProjectUser[];
		readonly labels: readonly IKinguProjectLabel[];
		readonly parentIssue: { readonly number: number; readonly title: string; readonly url: string } | null;
	};
	readonly fieldValuesByFieldId: Readonly<Record<string, IKinguProjectFieldValue>>;
	readonly updatedAt: string;
	readonly position: number;
}

export interface IKinguProjectTable {
	readonly project: IKinguProjectSummary;
	readonly selectedView: IKinguProjectViewSummary & {
		readonly filter: string;
		readonly fields: readonly IKinguProjectField[];
		readonly groupByFields: readonly IKinguProjectField[];
		readonly sortByFields: readonly { readonly direction: 'ASC' | 'DESC'; readonly field: IKinguProjectField }[];
	};
	readonly rows: readonly IKinguProjectRow[];
	readonly totalCount: number;
	readonly parentFieldDropped: boolean;
}

/** The ADE's `GitHubProjectSettings`, kept in its `githubProjects` setting. */
export interface IKinguProjectSettings {
	readonly pinned: readonly IKinguProjectRef[];
	readonly recent: readonly (IKinguProjectRef & { readonly lastOpenedAt: string })[];
	readonly lastViewByProject: Readonly<Record<string, { readonly viewId: string }>>;
	readonly activeProject: IKinguProjectRef | null;
}

export const EMPTY_PROJECT_SETTINGS: IKinguProjectSettings = { pinned: [], recent: [], lastViewByProject: {}, activeProject: null };

export function normalizeProjectSettings(value: unknown): IKinguProjectSettings {
	if (!value || typeof value !== 'object') {
		return EMPTY_PROJECT_SETTINGS;
	}
	const settings = value as Partial<IKinguProjectSettings>;
	return {
		pinned: Array.isArray(settings.pinned) ? settings.pinned : [],
		recent: Array.isArray(settings.recent) ? settings.recent : [],
		lastViewByProject: settings.lastViewByProject && typeof settings.lastViewByProject === 'object' ? settings.lastViewByProject : {},
		activeProject: settings.activeProject ?? null,
	};
}

function isDefaultHost(host: string | undefined): boolean {
	const lower = host?.trim().toLowerCase();
	return !lower || lower === 'github.com';
}

/** The ADE's `githubProjectIdentityKey`: default-host keys keep their legacy shape. */
export function projectKey(project: IKinguProjectRef): string {
	const key = `${project.ownerType}:${project.owner.toLowerCase()}:${project.number}`;
	return isDefaultHost(project.host) ? key : `${project.host!.trim().toLowerCase()}:${key}`;
}

/** The ADE's `githubProjectHost`: calls always name the host. */
export function projectHost(host: string | undefined): string {
	return host?.trim() || 'github.com';
}

export function sameProject(a: IKinguProjectRef, b: IKinguProjectRef): boolean {
	return projectKey(a) === projectKey(b);
}

/** Opening a project records it first among the recent, at most ten, and as the view to reopen. */
export function recordOpenedProject(settings: IKinguProjectSettings, project: IKinguProjectRef, viewId: string, now: string): IKinguProjectSettings {
	const ref: IKinguProjectRef = { owner: project.owner, ownerType: project.ownerType, number: project.number, ...(project.host ? { host: project.host } : {}) };
	return {
		...settings,
		recent: [{ ...ref, lastOpenedAt: now }, ...settings.recent.filter(entry => !sameProject(entry, ref))].slice(0, 10),
		lastViewByProject: { ...settings.lastViewByProject, [projectKey(ref)]: { viewId } },
		activeProject: ref,
	};
}

/** A project URL (`…/orgs|users/<owner>/projects/<n>`) or `owner/number`, for Add. */
export function isProjectRefInput(input: string): boolean {
	const trimmed = input.trim();
	return /^https?:\/\/[^/]+\/(?:orgs|users)\/[^/]+\/projects\/\d+/i.test(trimmed) || /^[\w.-]+\/\d+$/.test(trimmed);
}

export function layoutLabel(layout: IKinguProjectViewSummary['layout']): string {
	switch (layout) {
		case 'TABLE_LAYOUT': return localize('kingu.tasks.projects.table', "Table");
		case 'ROADMAP_LAYOUT': return localize('kingu.tasks.projects.roadmap', "Roadmap");
		case 'BOARD_LAYOUT': return localize('kingu.tasks.projects.boardUnsupported', "Board (unsupported)");
		default: return localize('kingu.tasks.projects.unsupported', "Unsupported");
	}
}

/** Kingu renders table and roadmap views, as the ADE does. */
export function isSupportedLayout(layout: string): boolean {
	return layout === 'TABLE_LAYOUT' || layout === 'ROADMAP_LAYOUT';
}

function sortValue(row: IKinguProjectRow, field: IKinguProjectField): string | number | undefined {
	if (field.dataType === 'TITLE') {
		return row.content.title.toLowerCase();
	}
	const value = row.fieldValuesByFieldId[field.id];
	switch (value?.kind) {
		case 'single-select': {
			const index = field.kind === 'single-select' ? field.options.findIndex(option => option.id === value.optionId) : -1;
			return index >= 0 ? index : value.name.toLowerCase();
		}
		case 'iteration': return value.startDate;
		case 'text': return value.text.toLowerCase();
		case 'number': return value.number;
		case 'date': return value.date;
		default: return undefined;
	}
}

/** The view's own order: its sort fields, empty values last, then GitHub's rank. */
export function sortProjectRows(rows: readonly IKinguProjectRow[], sorts: IKinguProjectTable['selectedView']['sortByFields']): IKinguProjectRow[] {
	return [...rows].sort((a, b) => {
		for (const sort of sorts) {
			const left = sortValue(a, sort.field);
			const right = sortValue(b, sort.field);
			if (left === right) {
				continue;
			}
			if (left === undefined) {
				return 1;
			}
			if (right === undefined) {
				return -1;
			}
			const order = left < right ? -1 : 1;
			return sort.direction === 'DESC' ? -order : order;
		}
		return a.position - b.position;
	});
}

export interface IKinguProjectGroup {
	readonly key: string;
	readonly label: string;
	readonly rows: IKinguProjectRow[];
	readonly iteration?: { readonly startDate: string; readonly duration: number; readonly current: boolean };
}

function groupValue(row: IKinguProjectRow, field: IKinguProjectField): { key: string; label: string } | undefined {
	const value = row.fieldValuesByFieldId[field.id];
	switch (value?.kind) {
		case 'single-select': return { key: value.optionId, label: value.name };
		case 'iteration': return { key: value.iterationId, label: value.title };
		case 'text': return value.text ? { key: value.text, label: value.text } : undefined;
		case 'number': return { key: String(value.number), label: String(value.number) };
		case 'date': return { key: value.date, label: value.date };
		case 'labels': return value.labels.length ? { key: value.labels.map(label => label.name).join(','), label: value.labels.map(label => label.name).join(', ') } : undefined;
		case 'users': return value.users.length ? { key: value.users.map(user => user.login).join(','), label: value.users.map(user => user.login).join(', ') } : undefined;
		default: return undefined;
	}
}

function isCurrentIteration(startDate: string, duration: number, now: Date): boolean {
	const start = new Date(`${startDate}T00:00:00`);
	const end = new Date(start.getTime() + duration * 86_400_000);
	return now >= start && now < end;
}

/**
 * The view's grouping: rows bucketed by the group field, single-select and
 * iteration groups in the field's own order, others alphabetical, and the
 * empty value last as `No <field>`.
 */
export function groupProjectRows(rows: readonly IKinguProjectRow[], field: IKinguProjectField | undefined, now = new Date()): IKinguProjectGroup[] {
	if (!field) {
		return [{ key: 'all', label: localize('kingu.tasks.projects.all', "All"), rows: [...rows] }];
	}
	const groups = new Map<string, { key: string; label: string; rows: IKinguProjectRow[] }>();
	const empty: IKinguProjectRow[] = [];
	for (const row of rows) {
		const value = groupValue(row, field);
		if (!value) {
			empty.push(row);
			continue;
		}
		const group = groups.get(value.key) ?? { ...value, rows: [] };
		group.rows.push(row);
		groups.set(value.key, group);
	}
	const order = field.kind === 'single-select' ? field.options.map(option => option.id)
		: field.kind === 'iteration' ? [...field.iterations].sort((a, b) => a.startDate.localeCompare(b.startDate)).map(iteration => iteration.id)
			: undefined;
	const sorted = [...groups.values()].sort((a, b) => {
		if (order) {
			const left = order.indexOf(a.key);
			const right = order.indexOf(b.key);
			return (left < 0 ? Number.MAX_SAFE_INTEGER : left) - (right < 0 ? Number.MAX_SAFE_INTEGER : right);
		}
		return a.label.localeCompare(b.label);
	});
	const result: IKinguProjectGroup[] = sorted.map(group => {
		const iteration = field.kind === 'iteration' ? field.iterations.find(candidate => candidate.id === group.key) : undefined;
		return iteration
			? { ...group, iteration: { startDate: iteration.startDate, duration: iteration.duration, current: isCurrentIteration(iteration.startDate, iteration.duration, now) } }
			: group;
	});
	if (empty.length > 0) {
		result.push({ key: '__none__', label: localize('kingu.tasks.projects.noValue', "No {0}", field.name), rows: empty });
	}
	return result;
}
