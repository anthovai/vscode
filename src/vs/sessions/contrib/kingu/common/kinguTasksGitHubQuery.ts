/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/*
 * The ADE's GitHub task query, ported from `shared/task-query.ts`
 * (`parseTaskQuery`, `withQualifier` and its serializer): the Filters menu
 * edits the search by rewriting one qualifier at a time.
 */

export type KinguGitHubQueryState = 'open' | 'closed' | 'merged' | 'all';

export interface IKinguGitHubQuery {
	readonly scope: 'issue' | 'pr' | null;
	readonly state: KinguGitHubQueryState | null;
	readonly draft: boolean;
	readonly author: string | null;
	readonly assignee: string | null;
	readonly reviewRequested: string | null;
	readonly reviewedBy: string | null;
	readonly labels: readonly string[];
	readonly freeText: string;
}

/** Whitespace-separated tokens, keeping a quoted value (`label:"needs review"`) whole. */
function tokenize(query: string): string[] {
	const tokens: string[] = [];
	let current = '';
	let quoted = false;
	for (const char of query) {
		if (char === '"') {
			quoted = !quoted;
			continue;
		}
		if (!quoted && /\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = '';
			}
			continue;
		}
		current += char;
	}
	if (current) {
		tokens.push(current);
	}
	return tokens;
}

export function parseTaskQuery(query: string): IKinguGitHubQuery {
	let scope: IKinguGitHubQuery['scope'] = null;
	let state: KinguGitHubQueryState | null = null;
	let draft = false;
	let author: string | null = null;
	let assignee: string | null = null;
	let reviewRequested: string | null = null;
	let reviewedBy: string | null = null;
	const labels: string[] = [];
	const free: string[] = [];
	for (const token of tokenize(query.trim())) {
		const colon = token.indexOf(':');
		const key = colon > 0 ? token.slice(0, colon).toLowerCase() : '';
		const value = colon > 0 ? token.slice(colon + 1) : '';
		if (key === 'is') {
			const lower = value.toLowerCase();
			if (lower === 'issue') { scope = 'issue'; continue; }
			if (lower === 'pr' || lower === 'pull-request') { scope = 'pr'; continue; }
			if (lower === 'open' || lower === 'closed' || lower === 'merged') { state = lower; continue; }
			if (lower === 'draft') { draft = true; continue; }
		} else if (key === 'state' && /^(open|closed|merged|all)$/i.test(value)) {
			state = value.toLowerCase() as KinguGitHubQueryState;
			continue;
		} else if (value) {
			switch (key) {
				case 'author': author = value; continue;
				case 'assignee': assignee = value; continue;
				case 'review-requested': reviewRequested = value; continue;
				case 'reviewed-by': reviewedBy = value; continue;
				case 'label': labels.push(value); continue;
			}
		}
		free.push(/\s/.test(token) ? `"${token}"` : token);
	}
	return { scope, state, draft, author, assignee, reviewRequested, reviewedBy, labels, freeText: free.join(' ') };
}

function quote(value: string): string {
	return /\s/.test(value) ? `"${value}"` : value;
}

/** The serializer: scope, state, draft, people, labels, then the free text. */
export function serializeTaskQuery(query: IKinguGitHubQuery): string {
	const parts: string[] = [];
	if (query.scope) {
		parts.push(query.scope === 'pr' ? 'is:pr' : 'is:issue');
	}
	if (query.state) {
		parts.push(query.state === 'all' ? 'state:all' : `is:${query.state}`);
	}
	if (query.draft) {
		parts.push('is:draft');
	}
	if (query.author) {
		parts.push(`author:${quote(query.author)}`);
	}
	if (query.assignee) {
		parts.push(`assignee:${quote(query.assignee)}`);
	}
	if (query.reviewRequested) {
		parts.push(`review-requested:${quote(query.reviewRequested)}`);
	}
	if (query.reviewedBy) {
		parts.push(`reviewed-by:${quote(query.reviewedBy)}`);
	}
	for (const label of query.labels) {
		parts.push(`label:${quote(label)}`);
	}
	if (query.freeText) {
		parts.push(query.freeText);
	}
	return parts.join(' ');
}

/** A Filters change, as the ADE's `applyPRFilterChange` receives it. */
export interface IKinguGitHubFilterChange {
	readonly state?: KinguGitHubQueryState;
	readonly draft?: boolean;
	readonly author?: string | null;
	readonly assignee?: string | null;
	readonly labels?: readonly string[];
	readonly reviewer?: { readonly kind: 'requested' | 'reviewed-by'; readonly login: string } | null;
}

/**
 * The ADE's `withQualifier` over a whole change: merged, draft and reviewers
 * force the PR scope, draft forces open, and any state but open clears draft.
 */
export function applyFilterChange(query: string, change: IKinguGitHubFilterChange): string {
	const parsed = parseTaskQuery(query);
	let next: { -readonly [K in keyof IKinguGitHubQuery]: IKinguGitHubQuery[K] } = { ...parsed, labels: [...parsed.labels] };
	if (change.author !== undefined) {
		next.author = change.author;
	}
	if (change.assignee !== undefined) {
		next.assignee = change.assignee;
	}
	if (change.labels !== undefined) {
		next.labels = [...change.labels];
	}
	if (change.state !== undefined) {
		next.state = change.state;
		if (change.state !== 'open') {
			next.draft = false;
		}
	}
	if (change.draft !== undefined) {
		next.draft = change.draft;
		if (change.draft) {
			next.state = 'open';
		}
	}
	if (change.reviewer !== undefined) {
		next.reviewRequested = change.reviewer?.kind === 'requested' ? change.reviewer.login : null;
		next.reviewedBy = change.reviewer?.kind === 'reviewed-by' ? change.reviewer.login : null;
	}
	if (next.state === 'merged' || next.draft || next.reviewRequested || next.reviewedBy) {
		next = { ...next, scope: 'pr' };
	}
	return serializeTaskQuery(next);
}

/** How many filters are set, as the Filters button's badge counts them. */
export function countActiveFilters(query: IKinguGitHubQuery): number {
	return [
		(query.state !== null && query.state !== 'open') || query.draft,
		!!query.author,
		!!query.assignee,
		!!(query.reviewRequested ?? query.reviewedBy),
		query.labels.length > 0,
	].filter(Boolean).length;
}
