/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/kinguTasksList.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { fromNow } from '../../../../base/common/date.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IKinguOrcaService } from '../common/kinguOrca.js';
import { IKinguTaskActions } from '../common/kinguTasksDetail.js';
import {
	getLinearPriorityBars,
	getLinearPriorityLabel,
	IKinguLinearCollection,
	IKinguLinearIssue,
	LINEAR_GRID_TEMPLATE,
	LINEAR_ITEM_LIMIT,
	normalizeLinearCollection,
	sortLinearIssuesByPriority,
} from '../common/kinguTasksLinear.js';
import { lucideIcon } from './kinguOrcaFooterParts.js';
import { openExternalIssue } from './kinguTasksJiraList.js';
import { bindTaskRow } from './kinguTasksRow.js';

const SEARCH_DEBOUNCE_MS = 300;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** A colour Linear sent, used only if it is a plain hex value. */
function safeColor(color: string | undefined): string {
	return color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : 'var(--vscode-descriptionForeground)';
}

/** `LinearStateCell`, read only: a pill tinted by the state's colour. */
export function renderLinearStatePill(state: IKinguLinearIssue['state'], compact: boolean): HTMLElement {
	const pill = $('span.kingu-tasks-linear-state');
	pill.classList.toggle('compact', compact);
	pill.style.setProperty('--linear-state-color', safeColor(state.color));
	append(pill, $('span.kingu-tasks-linear-state-marker'));
	append(pill, $('span.truncate')).textContent = state.name;
	return pill;
}

/**
 * The ADE's Linear issue list in its default shape: Issues mode, list view,
 * no grouping, ordered by priority (`task-page/linear/Filters.tsx`,
 * `IssueList.tsx`, `IssueTable.tsx`, `IssueBoard.tsx`).
 * A row opens the issue's detail page; Projects, Views, the board, grouping
 * and paging follow.
 */
export class KinguTasksLinearList extends Disposable {

	readonly element: HTMLElement = $('.kingu-tasks-list-surface');

	private readonly _rendered = this._register(new DisposableStore());
	private readonly _refresh: HTMLButtonElement;
	private readonly _search: HTMLInputElement;
	private readonly _clear: HTMLButtonElement;
	private readonly _count: HTMLElement;
	private readonly _body: HTMLElement;

	private _appliedSearch = '';
	private _issues: readonly IKinguLinearIssue[] = [];
	private _loading = false;
	private _error: string | undefined;
	private _request = 0;
	private _debounce: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly _workspaceId: string | undefined,
		private readonly _credentialError: string | undefined,
		private readonly _actions: IKinguTaskActions,
		@IKinguOrcaService private readonly _orca: IKinguOrcaService,
		@IHoverService private readonly _hoverService: IHoverService,
		@IOpenerService private readonly _openerService: IOpenerService,
	) {
		super();
		this._register({ dispose: () => clearTimeout(this._debounce) });

		const filters = append(this.element, $('.kingu-tasks-filters'));
		const searchRow = append(filters, $('.kingu-tasks-search-row.first'));
		const searchBox = append(searchRow, $('.kingu-tasks-search'));
		searchBox.appendChild(lucideIcon('search', 14, 'kingu-tasks-search-icon'));
		this._search = append(searchBox, $('input.kingu-tasks-search-input')) as HTMLInputElement;
		this._search.type = 'text';
		this._search.spellcheck = false;
		this._search.placeholder = localize('kingu.tasks.linear.searchPlaceholder', "Search Linear issues...");
		this._search.setAttribute('aria-label', localize('kingu.tasks.linear.search', "Search Linear issues"));
		this._clear = append(searchBox, $('button.kingu-tasks-search-clear')) as HTMLButtonElement;
		this._clear.type = 'button';
		this._clear.setAttribute('aria-label', localize('kingu.tasks.clearSearch', "Clear search"));
		this._clear.appendChild(lucideIcon('x', 16));
		const actions = append(searchRow, $('.kingu-tasks-filters-actions'));
		this._refresh = append(actions, $('button.kingu-tasks-icon-button')) as HTMLButtonElement;
		this._refresh.type = 'button';
		const refreshLabel = localize('kingu.tasks.linear.refresh', "Refresh Linear");
		this._refresh.setAttribute('aria-label', refreshLabel);
		this._register(this._hoverService.setupDelayedHover(this._refresh, { content: refreshLabel, position: { hoverPosition: HoverPosition.BELOW } }));
		this._register(addDisposableListener(this._refresh, EventType.CLICK, () => this._load()));

		this._register(addDisposableListener(this._search, EventType.INPUT, () => {
			this._syncClear();
			clearTimeout(this._debounce);
			this._debounce = setTimeout(() => this._applySearch(), SEARCH_DEBOUNCE_MS);
		}));
		this._register(addDisposableListener(this._search, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Enter' && !event.isComposing && !event.shiftKey) {
				event.preventDefault();
				this._search.value = this._search.value.trim();
				this._applySearch(true);
			}
		}));
		this._register(addDisposableListener(this._clear, EventType.CLICK, () => {
			this._search.value = '';
			this._applySearch(true);
		}));

		const content = append(this.element, $('.kingu-tasks-list-card'));
		// `flex h-10 items-center justify-between gap-3 border-b bg-muted/35 px-3`
		const toolbar = append(content, $('.kingu-tasks-list-header'));
		append(toolbar, $('.kingu-tasks-list-title')).textContent = localize('kingu.tasks.linear.issues', "Linear issues");
		this._count = append(toolbar, $('.kingu-tasks-list-count'));

		const header = append(content, $('.kingu-tasks-sort-header.kingu-tasks-linear-grid.static'));
		header.style.setProperty('--linear-grid-template', LINEAR_GRID_TEMPLATE);
		for (const label of [
			localize('kingu.tasks.linear.key', "Key"),
			localize('kingu.tasks.linear.issue', "Issue"),
			localize('kingu.tasks.linear.labels', "Labels"),
			localize('kingu.tasks.linear.status', "Status"),
			localize('kingu.tasks.linear.assignee', "Assignee"),
			localize('kingu.tasks.linear.updated', "Updated"),
			localize('kingu.tasks.linear.workspaces', "Workspaces"),
		]) {
			append(header, $('span')).textContent = label;
		}
		this._body = append(content, $('.kingu-tasks-list-body'));

		this._syncClear();
		this._load();
	}

	private _syncClear(): void {
		this._clear.style.display = this._search.value ? '' : 'none';
	}

	private _applySearch(force = false): void {
		clearTimeout(this._debounce);
		const next = this._search.value.trim();
		this._syncClear();
		if (force || next !== this._appliedSearch) {
			this._appliedSearch = next;
			this._load();
		}
	}

	private async _load(): Promise<void> {
		if (this._credentialError) {
			this._render();
			return;
		}
		const request = ++this._request;
		this._loading = true;
		this._error = undefined;
		this._render();
		try {
			const result = this._appliedSearch
				? await this._orca.invoke<IKinguLinearIssue[]>('linear:searchIssues', { query: this._appliedSearch, limit: LINEAR_ITEM_LIMIT, workspaceId: this._workspaceId })
				: await this._orca.invoke<IKinguLinearCollection>('linear:listIssues', { filter: 'all', limit: LINEAR_ITEM_LIMIT, workspaceId: this._workspaceId });
			if (request !== this._request) {
				return;
			}
			this._issues = sortLinearIssuesByPriority(normalizeLinearCollection(result).items);
		} catch (error) {
			if (request !== this._request) {
				return;
			}
			this._issues = [];
			this._error = error instanceof Error && error.message ? error.message : localize('kingu.tasks.linear.loadFailed', "Failed to load Linear issues.");
		}
		this._loading = false;
		this._render();
	}

	private _render(): void {
		this._rendered.clear();
		this._refresh.disabled = this._loading;
		clearNode(this._refresh);
		this._refresh.appendChild(this._loading ? lucideIcon('loader-circle', 16, 'kingu-tasks-spin') : lucideIcon('refresh-cw', 16));
		this._count.textContent = localize('kingu.tasks.shownCount', "{0} shown", this._issues.length);

		const body = this._body;
		clearNode(body);
		const error = this._credentialError ?? this._error;
		if (error) {
			append(body, $('.kingu-tasks-credential-error')).textContent = error;
		}
		if (this._loading && this._issues.length === 0) {
			const skeleton = append(body, $('.kingu-tasks-skeleton'));
			for (let i = 0; i < 12; i++) {
				const row = append(skeleton, $('.kingu-tasks-skeleton-row'));
				append(row, $('.kingu-tasks-skeleton-line.primary'));
				append(row, $('.kingu-tasks-skeleton-line.secondary'));
			}
		}
		if (!this._loading && this._issues.length === 0 && !error) {
			const empty = append(body, $('.kingu-tasks-list-empty'));
			append(empty, $('p.kingu-tasks-list-empty-title')).textContent = localize('kingu.tasks.linear.empty', "No Linear issues found");
			append(empty, $('p.kingu-tasks-list-empty-description')).textContent = this._appliedSearch
				? localize('kingu.tasks.linear.emptySearch', "Try a different search query.")
				: localize('kingu.tasks.linear.emptyScope', "No issues in this workspace scope. Try searching or adjusting teams.");
		}
		const rows = append(body, $('.kingu-tasks-section-rows'));
		for (const issue of this._issues) {
			this._renderRow(rows, issue);
		}
	}

	private _renderRow(parent: HTMLElement, issue: IKinguLinearIssue): void {
		const row = append(parent, $('.kingu-tasks-row.kingu-tasks-linear-grid'));
		row.style.setProperty('--linear-grid-template', LINEAR_GRID_TEMPLATE);
		const unassigned = localize('kingu.tasks.unassigned', "Unassigned");
		const team = this._workspaceId === 'all' && issue.workspaceName ? `${issue.workspaceName} / ${issue.team.name}` : issue.team.name;

		append(append(row, $('.kingu-tasks-cell-key-wrap.lg-up')), $('span.kingu-tasks-cell-key')).textContent = issue.identifier;

		const main = append(row, $('.kingu-tasks-cell-main'));
		const titleLine = append(main, $('.kingu-tasks-title-line'));
		titleLine.appendChild(this._priorityIcon(issue.priority));
		append(titleLine, $('span.kingu-tasks-key-inline.lg-down')).textContent = issue.identifier;
		append(titleLine, $('h3.kingu-tasks-title')).textContent = issue.title;
		const compact = append(main, $('.kingu-tasks-compact-meta.lg-down'));
		compact.appendChild(renderLinearStatePill(issue.state, true));
		append(compact, $('span.kingu-tasks-meta.truncate')).textContent = issue.assignee?.displayName ?? unassigned;
		append(compact, $('span.kingu-tasks-meta.truncate')).textContent = team;

		const labels = append(row, $('.kingu-tasks-cell-labels.lg-up'));
		const shown = issue.labels.slice(0, 3);
		for (const label of shown) {
			append(labels, $('span.kingu-tasks-label.linear')).textContent = label;
		}
		if (issue.labels.length > shown.length) {
			append(labels, $('span.kingu-tasks-label-more.linear')).textContent = `+${issue.labels.length - shown.length}`;
		}

		append(row, $('.kingu-tasks-cell-status.lg-up')).appendChild(renderLinearStatePill(issue.state, false));

		const assignee = append(append(row, $('.kingu-tasks-cell-assignee-center.lg-up')), $('.kingu-tasks-avatar.initial'));
		const assigneeName = issue.assignee?.displayName ?? unassigned;
		assignee.setAttribute('aria-label', assigneeName);
		if (issue.assignee?.avatarUrl) {
			const image = append(assignee, $('img.kingu-tasks-avatar')) as HTMLImageElement;
			image.alt = assigneeName;
			image.referrerPolicy = 'no-referrer';
			image.src = issue.assignee.avatarUrl;
		} else {
			assignee.textContent = issue.assignee?.displayName?.slice(0, 1) ?? '-';
		}
		this._rendered.add(this._hoverService.setupDelayedHover(assignee, { content: assigneeName, position: { hoverPosition: HoverPosition.BELOW } }));

		const updated = append(row, $('.kingu-tasks-cell-muted.lg-up'));
		const updatedAt = new Date(issue.updatedAt);
		updated.textContent = fromNow(updatedAt, true);
		this._rendered.add(this._hoverService.setupDelayedHover(updated, { content: updatedAt.toLocaleString(), position: { hoverPosition: HoverPosition.BELOW } }));

		const actions = append(row, $('.kingu-tasks-row-actions.always'));
		const open = append(actions, $('button.kingu-tasks-row-action')) as HTMLButtonElement;
		open.type = 'button';
		open.setAttribute('aria-label', localize('kingu.tasks.linear.openIssue', "Open {0} in Linear", issue.identifier));
		open.appendChild(lucideIcon('external-link', 14));
		this._rendered.add(this._hoverService.setupDelayedHover(open, { content: localize('kingu.tasks.linear.openInLinear', "Open in Linear"), position: { hoverPosition: HoverPosition.BELOW } }));
		this._rendered.add(addDisposableListener(open, EventType.CLICK, () => openExternalIssue(this._openerService, issue.url)));
		bindTaskRow(row, actions, { provider: 'linear', issue }, this._actions, this._hoverService, this._rendered);
	}

	/** `LinearPriorityIcon`. */
	private _priorityIcon(priority: number): HTMLElement {
		const label = getLinearPriorityLabel(priority);
		const holder = $('span.kingu-tasks-linear-priority');
		holder.title = label;
		holder.setAttribute('role', 'img');
		holder.setAttribute('aria-label', localize('kingu.tasks.linear.priorityLabel', "Priority: {0}", label));
		if (priority === 1) {
			holder.classList.add('urgent');
			append(holder, $('span')).textContent = '!';
			return holder;
		}
		if (priority === 0 || getLinearPriorityBars(priority) === 0) {
			append(holder, $('span.kingu-tasks-linear-priority-none'));
			return holder;
		}
		const active = getLinearPriorityBars(priority);
		const svg = mainWindow.document.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', '0 0 16 16');
		svg.setAttribute('fill', 'none');
		svg.setAttribute('aria-hidden', 'true');
		for (const [index, [x, y, height]] of [[2.25, 11, 5], [6.5, 8, 8], [10.75, 5, 11]].entries()) {
			const bar = mainWindow.document.createElementNS(SVG_NS, 'rect');
			bar.setAttribute('x', String(x));
			bar.setAttribute('y', String(y));
			bar.setAttribute('width', '3.25');
			bar.setAttribute('height', String(height));
			bar.setAttribute('rx', '1');
			bar.classList.add(index < active ? 'active' : 'inactive');
			svg.appendChild(bar);
		}
		holder.classList.add('bars');
		holder.appendChild(svg);
		return holder;
	}
}
