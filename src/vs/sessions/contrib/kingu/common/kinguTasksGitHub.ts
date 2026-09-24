/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/*
 * The ADE's GitHub task source model, ported from `task-page-default-repo-selection.ts`,
 * `shared/project-host-setup-projection.ts` (provider identity), `shared/task-preset-query.ts`,
 * `task-page-github-task-kind.ts`, `shared/work-items.ts`, `task-page-work-item-pagination.ts`,
 * `task-page-pagination-page-numbers.ts` and `task-page-github-work-item-status.ts`.
 */

import { localize } from '../../../../nls.js';

/** The part of the ADE's `Repo` (`repos:list`) the Tasks page reads. */
export interface IKinguRepo {
	readonly id: string;
	readonly path: string;
	readonly displayName: string;
	readonly badgeColor?: string;
	readonly addedAt?: number;
	readonly kind?: 'git' | 'folder';
	readonly connectionId?: string | null;
	readonly executionHostId?: string | null;
	readonly upstream?: { readonly owner: string; readonly repo: string; readonly host?: string } | null;
	readonly repoIcon?: { readonly type?: string; readonly source?: string; readonly label?: string } | null;
	readonly gitRemoteIdentity?: { readonly canonicalKey?: string; readonly remoteName?: string; readonly remoteUrl?: string } | null;
}

export interface IKinguGitHubSlug {
	readonly owner: string;
	readonly repo: string;
	readonly host?: string;
}

/** The part of the ADE's `GitHubWorkItem` a row reads. */
export interface IKinguGitHubWorkItem {
	readonly id: string;
	readonly type: 'issue' | 'pr';
	readonly number: number;
	readonly title: string;
	readonly state: 'open' | 'closed' | 'merged' | 'draft';
	readonly url: string;
	readonly labels: readonly string[];
	readonly updatedAt: string;
	readonly author?: string | null;
	readonly assignees?: readonly { readonly login: string; readonly name?: string; readonly avatarUrl?: string }[];
	repoId?: string;
}

/** The ADE's `ListWorkItemsResult`. */
export interface IKinguListWorkItemsResult {
	readonly items: readonly IKinguGitHubWorkItem[];
	readonly sources?: { readonly issues?: IKinguGitHubSlug | null; readonly prs?: IKinguGitHubSlug | null };
	readonly errors?: { readonly issues?: { readonly message?: string }; readonly prs?: { readonly message?: string } };
}

export type KinguGitHubTaskKind = 'issues' | 'prs';

export type KinguGitHubPreset = 'issues' | 'my-issues' | 'prs' | 'my-prs' | 'review';

/** The ADE's `PER_REPO_FETCH_LIMIT` and `CROSS_REPO_DISPLAY_LIMIT`. */
const PER_REPO_FETCH_LIMIT = 36;
const CROSS_REPO_DISPLAY_LIMIT = 100;
/** GitHub search stops at the first thousand results. */
const GITHUB_SEARCH_RESULT_CAP = 1000;

export function isGitHubHost(host: string): boolean {
	const lower = host.toLowerCase();
	return lower === 'github.com' || lower.startsWith('github.') || lower.startsWith('github-') || lower.startsWith('ghe.') || lower.startsWith('ghe-');
}

function slug(owner: string | undefined, repo: string | undefined, host: string | undefined): IKinguGitHubSlug | undefined {
	const cleanRepo = repo?.replace(/\.git$/i, '');
	if (!owner || !cleanRepo) {
		return undefined;
	}
	return host && host.toLowerCase() !== 'github.com' ? { owner, repo: cleanRepo, host } : { owner, repo: cleanRepo };
}

/** `git@host:o/r(.git)` or a URL with a two-segment path, on a GitHub host. */
export function parseGitHubRemoteUrl(url: string | undefined): IKinguGitHubSlug | undefined {
	if (!url) {
		return undefined;
	}
	const scp = /^[^@\s]+@(?<host>[^:\s]+):(?<owner>[^/\s]+)\/(?<repo>[^/\s]+?)\/?$/.exec(url.trim());
	if (scp?.groups) {
		return isGitHubHost(scp.groups.host) ? slug(scp.groups.owner, scp.groups.repo, scp.groups.host) : undefined;
	}
	try {
		const parsed = new URL(url.trim());
		const segments = parsed.pathname.split('/').filter(Boolean);
		return segments.length === 2 && isGitHubHost(parsed.hostname) ? slug(segments[0], segments[1], parsed.hostname) : undefined;
	} catch {
		return undefined;
	}
}

/** `host/owner/repo` canonical keys, on a GitHub host. */
function parseGitHubCanonicalKey(key: string | undefined): IKinguGitHubSlug | undefined {
	const segments = key?.split('/').filter(Boolean) ?? [];
	return segments.length === 3 && isGitHubHost(segments[0]) ? slug(segments[1], segments[2], segments[0]) : undefined;
}

/** The ADE's `getProjectProviderIdentity` for GitHub: the first source that names one wins. */
export function getRepoGitHubSlug(repo: IKinguRepo): IKinguGitHubSlug | undefined {
	if (repo.upstream?.owner && repo.upstream.repo && (!repo.upstream.host || isGitHubHost(repo.upstream.host))) {
		return slug(repo.upstream.owner, repo.upstream.repo, repo.upstream.host);
	}
	if (repo.repoIcon?.type === 'image' && repo.repoIcon.source === 'github' && repo.repoIcon.label?.includes('/')) {
		const [owner, name] = repo.repoIcon.label.split('/');
		const fromIcon = slug(owner, name, undefined);
		if (fromIcon) {
			return fromIcon;
		}
	}
	return parseGitHubRemoteUrl(repo.gitRemoteIdentity?.remoteUrl) ?? parseGitHubCanonicalKey(repo.gitRemoteIdentity?.canonicalKey);
}

/** The ADE's `getRepoExecutionHostId`. */
export function getRepoHostId(repo: IKinguRepo): string {
	return repo.executionHostId || (repo.connectionId ? `ssh:${repo.connectionId}` : 'local');
}

function projectKey(repo: IKinguRepo): string {
	const github = getRepoGitHubSlug(repo);
	if (github) {
		return `github:${(github.host ?? 'github.com').toLowerCase()}/${github.owner.toLowerCase()}/${github.repo.toLowerCase()}`;
	}
	return repo.gitRemoteIdentity?.canonicalKey ? `git:${repo.gitRemoteIdentity.canonicalKey}` : `repo:${repo.id}`;
}

/** Eligible: a git project with a remote identity, or one whose identity is still resolving. */
export function isTaskEligibleRepo(repo: IKinguRepo): boolean {
	if (repo.kind === 'folder') {
		return false;
	}
	return repo.gitRemoteIdentity === undefined || !!repo.gitRemoteIdentity?.canonicalKey || !!getRepoGitHubSlug(repo);
}

/** The ADE's `getDefaultTaskRepoSelection`: one repo per project, local first, then oldest. */
export function getDefaultRepoSelection(repos: readonly IKinguRepo[]): string[] {
	const best = new Map<string, IKinguRepo>();
	for (const repo of repos) {
		const key = projectKey(repo);
		const current = best.get(key);
		if (!current || compareDefaultCandidates(repo, current) < 0) {
			best.set(key, repo);
		}
	}
	return repos.filter(repo => best.get(projectKey(repo)) === repo).map(repo => repo.id);
}

function compareDefaultCandidates(a: IKinguRepo, b: IKinguRepo): number {
	const localA = getRepoHostId(a) === 'local' ? 0 : 1;
	const localB = getRepoHostId(b) === 'local' ? 0 : 1;
	return localA - localB || (a.addedAt ?? 0) - (b.addedAt ?? 0) || a.id.localeCompare(b.id);
}

/** The saved selection kept to repos that still exist and are eligible; the default when none remain. */
export function resolveRepoSelection(eligible: readonly IKinguRepo[], saved: unknown): string[] {
	if (Array.isArray(saved)) {
		const ids = new Set(eligible.map(repo => repo.id));
		const kept = saved.filter((id): id is string => typeof id === 'string' && ids.has(id));
		if (kept.length > 0) {
			return [...new Set(kept)];
		}
	}
	if (saved === null) {
		// `null` is the ADE's "All projects".
		return eligible.map(repo => repo.id);
	}
	return getDefaultRepoSelection(eligible);
}

export function getGitHubPresets(kind: KinguGitHubTaskKind): readonly { id: KinguGitHubPreset; label: string }[] {
	return kind === 'prs'
		? [
			{ id: 'prs', label: localize('kingu.tasks.github.openPrs', "Open") },
			{ id: 'my-prs', label: localize('kingu.tasks.github.mine', "Mine") },
			{ id: 'review', label: localize('kingu.tasks.github.review', "Needs review") },
		]
		: [
			{ id: 'issues', label: localize('kingu.tasks.github.openIssues', "Open") },
			{ id: 'my-issues', label: localize('kingu.tasks.github.assignedToMe', "Assigned to me") },
		];
}

/** The ADE's `getTaskPresetQuery`. */
export function getPresetQuery(preset: KinguGitHubPreset): string {
	switch (preset) {
		case 'issues': return 'is:issue is:open';
		case 'my-issues': return 'assignee:@me is:issue is:open';
		case 'prs': return 'is:pr is:open';
		case 'my-prs': return 'author:@me is:pr is:open';
		case 'review': return 'review-requested:@me is:pr is:open';
	}
}

export function getDefaultPreset(kind: KinguGitHubTaskKind): KinguGitHubPreset {
	return kind === 'prs' ? 'prs' : 'issues';
}

/** The ADE's `scopeGitHubTaskSearch`: free text is scoped to the current kind. */
export function scopeGitHubTaskSearch(query: string, kind: KinguGitHubTaskKind): string {
	const trimmed = query.trim();
	if (!trimmed) {
		return getPresetQuery(getDefaultPreset(kind));
	}
	if (/\bis:(?:issue|pr|pull-request)\b/i.test(trimmed)) {
		return trimmed;
	}
	return `${kind === 'prs' ? 'is:pr' : 'is:issue'} ${trimmed}`;
}

/** The kind a query reads as: PRs for PR-only qualifiers, else issues. */
export function getQueryKind(query: string, fallback: KinguGitHubTaskKind): KinguGitHubTaskKind {
	if (/\bis:(?:pr|pull-request)\b|\bis:merged\b|\bis:draft\b|\breview-requested:|\breviewed-by:/i.test(query)) {
		return 'prs';
	}
	return /\bis:issue\b/i.test(query) ? 'issues' : fallback;
}

/** The ADE's `stripRepoQualifiers`: the project picker, not the query, names the repos. */
export function stripRepoQualifiers(query: string): string {
	return query.split(/\s+/).filter(token => token && !/^repo:\S+$/i.test(token)).join(' ');
}

/** Per-repo page size: the display cap shared across the selected repos, at most the per-repo limit. */
export function getPerRepoLimit(repoCount: number): number {
	return Math.max(1, Math.min(PER_REPO_FETCH_LIMIT, Math.floor(CROSS_REPO_DISPLAY_LIMIT / Math.max(1, repoCount))));
}

/** Pages across repos: the most any one repo needs, within GitHub's search cap. */
export function getTotalPages(counts: readonly (number | undefined)[], perRepo: number): number | undefined {
	let pages = 0;
	for (const count of counts) {
		if (count === undefined) {
			return undefined;
		}
		pages = Math.max(pages, Math.min(Math.ceil(count / perRepo), Math.ceil(GITHUB_SEARCH_RESULT_CAP / perRepo)));
	}
	return Math.max(1, pages);
}

/** The ADE's page list: all of up to nine, else first, last and the current ±2, with gaps. */
export function getPageNumbers(current: number, total: number): (number | 'gap')[] {
	if (total <= 9) {
		return Array.from({ length: total }, (_, index) => index + 1);
	}
	const pages = new Set([1, total]);
	for (let page = current - 2; page <= current + 2; page++) {
		if (page >= 1 && page <= total) {
			pages.add(page);
		}
	}
	const sorted = [...pages].sort((a, b) => a - b);
	const result: (number | 'gap')[] = [];
	for (const [index, page] of sorted.entries()) {
		if (index > 0 && page - sorted[index - 1] > 1) {
			result.push('gap');
		}
		result.push(page);
	}
	return result;
}

export function sortWorkItemsByNumber<T extends { number: number }>(items: readonly T[]): T[] {
	return [...items].sort((left, right) => right.number - left.number);
}

/** The row's status badge: its tone and label. */
export function getWorkItemStatus(item: IKinguGitHubWorkItem): { tone: 'open' | 'closed' | 'merged' | 'draft'; label: string } {
	switch (item.state) {
		case 'open': return { tone: 'open', label: localize('kingu.tasks.github.stateOpen', "Open") };
		case 'closed': return { tone: 'closed', label: localize('kingu.tasks.github.stateClosed', "Closed") };
		case 'merged': return { tone: 'merged', label: localize('kingu.tasks.github.stateMerged', "Merged") };
		case 'draft': return { tone: 'draft', label: localize('kingu.tasks.github.stateDraft', "Draft") };
	}
}

/** The repo-backed summary chip (`getRepoBackedTaskSourceSummary`). */
export function getRepoBackedSummary(providerLabel: string, hostLabels: readonly string[], availability: string | undefined, selected: readonly IKinguRepo[], sourceOf: (repo: IKinguRepo) => IKinguGitHubSlug | undefined = getRepoGitHubSlug): { label: string; title: string } {
	const identities = [...new Set(selected.map(repo => {
		const github = sourceOf(repo);
		return github ? `${github.owner}/${github.repo}` : undefined;
	}).filter((value): value is string => !!value))];
	const hostLabel = hostLabels.length === 0
		? localize('kingu.tasks.summary.noHost', "No host")
		: hostLabels.length <= 2 ? hostLabels.join(', ') : `${hostLabels[0]} +${hostLabels.length - 1}`;
	const target = selected.length > 1
		? localize('kingu.tasks.summary.projects', "{0} projects", selected.length)
		: identities[0] ?? localize('kingu.tasks.summary.selectedProject', "Selected project");
	const title = [
		providerLabel,
		hostLabels.length > 0 ? localize('kingu.tasks.summary.host', "Host: {0}", hostLabels.join(', ')) : undefined,
		availability ? localize('kingu.tasks.summary.availability', "Availability: {0}", availability) : undefined,
		identities.length > 0 ? localize('kingu.tasks.summary.sourceList', "Source: {0}", identities.join(', ')) : undefined,
		selected.length > 1 ? localize('kingu.tasks.summary.selectedProjects', "{0} selected projects", selected.length) : undefined,
	].filter((part): part is string => !!part);
	return {
		label: [providerLabel, hostLabel, availability, target].filter((part): part is string => !!part).join(' · '),
		title: title.join(' · '),
	};
}
