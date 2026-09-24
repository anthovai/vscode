/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/kinguTasksGitHubProjects.css';
import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../base/browser/dom.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IKinguOrcaService } from '../common/kinguOrca.js';
import {
	groupProjectRows,
	IKinguProjectField,
	IKinguProjectFieldValue,
	IKinguProjectRef,
	IKinguProjectRow,
	IKinguProjectSettings,
	IKinguProjectSummary,
	IKinguProjectTable,
	IKinguProjectViewSummary,
	isProjectRefInput,
	isSupportedLayout,
	layoutLabel,
	normalizeProjectSettings,
	projectHost,
	projectKey,
	recordOpenedProject,
	sameProject,
	sortProjectRows,
} from '../common/kinguTasksGitHubProjects.js';
import { lucideIcon } from './kinguOrcaFooterParts.js';
import { openExternalIssue } from './kinguTasksJiraList.js';

type Result<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly error?: { readonly type?: string; readonly message?: string } };

/** The column the ADE adds after the title for the item's kind. */
const TYPE_COLUMN: IKinguProjectField = { kind: 'field', id: '__type__', name: 'Type', dataType: '__TYPE__' };

/**
 * The ADE's Projects mode (`github-project/ProjectViewWrapper.tsx`,
 * `ProjectViewToolbar.tsx`, `ProjectPicker*.tsx`, `ProjectViewStates.tsx`,
 * `ProjectViewList.tsx`, `ProjectCell.tsx`), read only: pick a project and a
 * view, then its table, grouped and ordered as the view is on GitHub.
 */
export class KinguTasksGitHubProjects extends Disposable {

	readonly element: HTMLElement = $('.kingu-tasks-gh-projects');

	private readonly _rendered = this._register(new DisposableStore());
	private readonly _picker = this._register(new MutableDisposable<DisposableStore>());
	private readonly _toolbar: HTMLElement;
	private readonly _tabs: HTMLElement;
	private readonly _body: HTMLElement;

	private _settings: IKinguProjectSettings = normalizeProjectSettings(undefined);
	private _views: readonly IKinguProjectViewSummary[] = [];
	private _table: IKinguProjectTable | undefined;
	private _error: { type?: string; message?: string } | undefined;
	private _loading = false;
	private _query: string | undefined;
	private _collapsed = new Set<string>();
	private _request = 0;

	constructor(
		private readonly _host: { selectedRepositories(): readonly string[] },
		@IKinguOrcaService private readonly _orca: IKinguOrcaService,
		@IHoverService private readonly _hoverService: IHoverService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super();
		const card = append(this.element, $('.kingu-tasks-gh-projects-card'));
		this._toolbar = append(card, $('.kingu-tasks-gh-projects-toolbar'));
		this._tabs = append(card, $('.kingu-tasks-gh-projects-tabs'));
		this._body = append(card, $('.kingu-tasks-gh-projects-body'));
		void this._start();
	}

	/** The picked projects changed; rows are kept to their repositories. */
	refilter(): void {
		this._render();
	}

	private async _start(): Promise<void> {
		const settings = await this._orca.invoke<{ githubProjects?: unknown }>('settings:get').catch(() => undefined);
		this._settings = normalizeProjectSettings(settings?.githubProjects);
		const active = this._settings.activeProject;
		if (active) {
			await this._open(active, this._settings.lastViewByProject[projectKey(active)]?.viewId);
		} else {
			this._render();
		}
	}

	private _saveSettings(next: IKinguProjectSettings): void {
		this._settings = next;
		this._orca.invoke('settings:set', { githubProjects: next }).catch(() => undefined);
	}

	private _ref(project: IKinguProjectRef): { owner: string; ownerType: string; projectNumber: number; host: string } {
		return { owner: project.owner, ownerType: project.ownerType, projectNumber: project.number, host: projectHost(project.host) };
	}

	/** Opens a project on a view: the given one, else its first supported view. */
	private async _open(project: IKinguProjectRef, viewId?: string, viewNumber?: number): Promise<void> {
		const request = ++this._request;
		this._loading = true;
		this._error = undefined;
		this._render();
		const views = await this._orca.invoke<Result<{ views: IKinguProjectViewSummary[] }>>('gh:listProjectViews', this._ref(project)).catch((error: unknown) => ({ ok: false as const, error: { message: error instanceof Error ? error.message : String(error) } }));
		if (request !== this._request) {
			return;
		}
		this._views = views.ok ? views.views : [];
		const view = this._views.find(candidate => candidate.id === viewId)
			?? this._views.find(candidate => candidate.number === viewNumber)
			?? this._views.find(candidate => isSupportedLayout(candidate.layout));
		if (!view) {
			this._loading = false;
			this._table = undefined;
			this._error = views.ok ? { type: 'not_found' } : views.error;
			this._render();
			return;
		}
		this._saveSettings(recordOpenedProject(this._settings, project, view.id, new Date().toISOString()));
		await this._fetch(project, view.id);
	}

	private async _fetch(project: IKinguProjectRef, viewId: string): Promise<void> {
		const request = ++this._request;
		this._loading = true;
		this._error = undefined;
		this._render();
		const result = await this._orca.invoke<Result<{ data: IKinguProjectTable }>>('gh:getProjectViewTable', {
			...this._ref(project),
			viewId,
			...(this._query !== undefined ? { queryOverride: this._query } : {}),
		}).catch((error: unknown) => ({ ok: false as const, error: { message: error instanceof Error ? error.message : String(error) } }));
		if (request !== this._request) {
			return;
		}
		this._loading = false;
		if (result.ok) {
			this._table = result.data;
			if (result.data.parentFieldDropped) {
				this._notificationService.info(localize('kingu.tasks.projects.subIssues', "Sub-issue data is unavailable for your token."));
			}
		} else {
			this._table = undefined;
			this._error = result.error ?? {};
		}
		this._render();
	}

	private _activeViewId(): string | undefined {
		const active = this._settings.activeProject;
		return active ? this._settings.lastViewByProject[projectKey(active)]?.viewId : undefined;
	}

	private _render(): void {
		this._rendered.clear();
		this._renderToolbar();
		this._renderTabs();
		this._renderBody();
	}

	private _renderToolbar(): void {
		const toolbar = this._toolbar;
		clearNode(toolbar);
		const anchor = append(toolbar, $('.kingu-tasks-gh-projects-picker-anchor'));
		const trigger = append(anchor, $('button.kingu-tasks-gh-picker')) as HTMLButtonElement;
		trigger.type = 'button';
		const project = this._table?.project;
		const active = this._settings.activeProject;
		const label = append(trigger, $('span.kingu-tasks-gh-picker-label'));
		label.textContent = project ? `${project.owner} / ${project.title}` : active ? `${active.owner} / #${active.number}` : localize('kingu.tasks.projects.choose', "Choose a project");
		trigger.appendChild(lucideIcon('chevrons-up-down', 14, 'kingu-tasks-gh-picker-chevron'));
		this._rendered.add(addDisposableListener(trigger, EventType.CLICK, () => this._togglePicker(anchor)));

		if (!active) {
			return;
		}
		const search = append(toolbar, $('input.kingu-tasks-gh-projects-search')) as HTMLInputElement;
		search.type = 'text';
		search.placeholder = this._table?.selectedView.filter || localize('kingu.tasks.projects.searchPlaceholder', "GitHub search, e.g. assignee:@me is:open");
		search.setAttribute('aria-label', localize('kingu.tasks.projects.search', "Search this view"));
		search.value = this._query ?? '';
		const apply = () => {
			const next = search.value.trim();
			if (next !== (this._query ?? '')) {
				this._query = next || undefined;
				const viewId = this._activeViewId();
				if (viewId) {
					void this._fetch(active, viewId);
				}
			}
		};
		this._rendered.add(addDisposableListener(search, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Enter' && !event.isComposing) {
				event.preventDefault();
				apply();
			} else if (event.key === 'Escape') {
				event.stopPropagation();
				search.value = this._query ?? '';
			}
		}));
		this._rendered.add(addDisposableListener(search, EventType.BLUR, apply));

		if (this._table) {
			append(toolbar, $('span.kingu-tasks-gh-projects-count')).textContent = localize('kingu.tasks.projects.items', "{0} items", this._visibleRows().length);
		}
		const view = this._views.find(candidate => candidate.id === this._activeViewId());
		const open = append(toolbar, $('button.kingu-tasks-gh-action')) as HTMLButtonElement;
		open.type = 'button';
		const openLabel = localize('kingu.tasks.projects.openView', "Open view in GitHub");
		open.setAttribute('aria-label', openLabel);
		open.disabled = !this._table || !view;
		open.appendChild(lucideIcon('external-link', 14));
		this._rendered.add(this._hoverService.setupDelayedHover(open, { content: openLabel, position: { hoverPosition: HoverPosition.BELOW } }));
		this._rendered.add(addDisposableListener(open, EventType.CLICK, () => {
			if (this._table && view) {
				openExternalIssue(this._openerService, `${this._table.project.url}/views/${view.number}`);
			}
		}));
		const refresh = append(toolbar, $('button.kingu-tasks-gh-action')) as HTMLButtonElement;
		refresh.type = 'button';
		const refreshLabel = this._loading ? localize('kingu.tasks.projects.refreshing', "Refreshing") : localize('kingu.tasks.projects.refresh', "Refresh");
		refresh.setAttribute('aria-label', refreshLabel);
		refresh.disabled = this._loading;
		refresh.appendChild(this._loading ? lucideIcon('loader-circle', 14, 'kingu-tasks-spin') : lucideIcon('refresh-cw', 14));
		this._rendered.add(this._hoverService.setupDelayedHover(refresh, { content: refreshLabel, position: { hoverPosition: HoverPosition.BELOW } }));
		this._rendered.add(addDisposableListener(refresh, EventType.CLICK, () => {
			const viewId = this._activeViewId();
			if (viewId) {
				void this._fetch(active, viewId);
			}
		}));
	}

	private _renderTabs(): void {
		const tabs = this._tabs;
		clearNode(tabs);
		tabs.style.display = this._settings.activeProject && this._views.length > 0 ? '' : 'none';
		const active = this._settings.activeProject;
		const activeViewId = this._activeViewId();
		for (const view of this._views) {
			const tab = append(tabs, $('button.kingu-tasks-gh-projects-tab')) as HTMLButtonElement;
			tab.type = 'button';
			const supported = isSupportedLayout(view.layout);
			tab.classList.toggle('active', view.id === activeViewId);
			tab.disabled = !supported;
			tab.appendChild(lucideIcon(view.layout === 'ROADMAP_LAYOUT' ? 'calendar-clock' : view.layout === 'BOARD_LAYOUT' ? 'panels-top-left' : 'list-checks', 12));
			append(tab, $('span')).textContent = view.name;
			if (!supported) {
				this._rendered.add(this._hoverService.setupDelayedHover(tab, { content: localize('kingu.tasks.projects.layoutUnsupported', "Kingu doesn't support {0} project views yet.", layoutLabel(view.layout)), position: { hoverPosition: HoverPosition.BELOW } }));
			}
			this._rendered.add(addDisposableListener(tab, EventType.CLICK, () => {
				if (active && supported && view.id !== activeViewId) {
					this._saveSettings(recordOpenedProject(this._settings, active, view.id, new Date().toISOString()));
					void this._fetch(active, view.id);
				}
			}));
		}
	}

	/** Rows kept to the picked Kingu projects' repositories; drafts belong to none and stay. */
	private _visibleRows(): IKinguProjectRow[] {
		const rows = this._table?.rows ?? [];
		const repositories = new Set(this._host.selectedRepositories().map(name => name.toLowerCase()));
		return repositories.size === 0 ? [...rows] : rows.filter(row => !row.content.repository || repositories.has(row.content.repository.toLowerCase()));
	}

	private _renderBody(): void {
		const body = this._body;
		clearNode(body);
		if (!this._settings.activeProject) {
			append(body, $('.kingu-tasks-gh-projects-empty')).textContent = localize('kingu.tasks.projects.chooseToStart', "Choose a project to get started.");
			return;
		}
		if (this._loading && !this._table) {
			const skeleton = append(body, $('.kingu-tasks-gh-projects-skeleton'));
			for (let i = 0; i < 12; i++) {
				append(skeleton, $('.kingu-tasks-gh-projects-skeleton-row'));
			}
			return;
		}
		if (this._error) {
			this._renderError(body);
			return;
		}
		const table = this._table;
		if (!table) {
			return;
		}
		const rows = sortProjectRows(this._visibleRows(), table.selectedView.sortByFields);
		if (rows.length === 0) {
			const empty = append(body, $('.kingu-tasks-gh-projects-empty'));
			if (table.selectedView.filter) {
				empty.textContent = localize('kingu.tasks.projects.noMatch', "No items match this view's filter.");
			} else {
				append(empty, $('p')).textContent = localize('kingu.tasks.projects.noItems', "This view has no items yet.");
				append(empty, $('p.muted')).textContent = localize('kingu.tasks.projects.recentlyAdded', "Recently added items can take a while to appear.");
			}
			return;
		}
		const fields = table.selectedView.fields;
		const titleIndex = fields.findIndex(field => field.dataType === 'TITLE');
		const columns = titleIndex >= 0 ? [...fields.slice(0, titleIndex + 1), TYPE_COLUMN, ...fields.slice(titleIndex + 1)] : [TYPE_COLUMN, ...fields];
		const template = columns.map(field => field.dataType === 'TITLE' ? 'minmax(280px, 2fr)' : field === TYPE_COLUMN ? '72px' : 'minmax(120px, 1fr)').join(' ');

		const scroller = append(body, $('.kingu-tasks-gh-projects-scroller'));
		const header = append(scroller, $('.kingu-tasks-gh-projects-header'));
		header.style.gridTemplateColumns = template;
		for (const field of columns) {
			append(header, $('span')).textContent = field === TYPE_COLUMN ? localize('kingu.tasks.projects.type', "Type") : field.name;
		}
		const groupField = table.selectedView.groupByFields[0];
		for (const group of groupProjectRows(rows, groupField)) {
			if (groupField) {
				const open = !this._collapsed.has(group.key);
				const trigger = append(scroller, $('button.kingu-tasks-gh-projects-group')) as HTMLButtonElement;
				trigger.type = 'button';
				trigger.setAttribute('aria-expanded', String(open));
				trigger.appendChild(lucideIcon(open ? 'chevron-down' : 'chevron-right', 12));
				append(trigger, $('span.label')).textContent = group.label;
				append(trigger, $('span.count')).textContent = String(group.rows.length);
				if (group.iteration) {
					append(trigger, $('span.dates')).textContent = this._iterationRange(group.iteration.startDate, group.iteration.duration);
					if (group.iteration.current) {
						append(trigger, $('span.current')).textContent = localize('kingu.tasks.projects.current', "Current");
					}
				}
				this._rendered.add(addDisposableListener(trigger, EventType.CLICK, () => {
					if (open) {
						this._collapsed.add(group.key);
					} else {
						this._collapsed.delete(group.key);
					}
					this._renderBody();
				}));
				if (!open) {
					continue;
				}
			}
			for (const row of group.rows) {
				const element = append(scroller, $('.kingu-tasks-gh-projects-row'));
				element.style.gridTemplateColumns = template;
				for (const field of columns) {
					this._renderCell(append(element, $('.kingu-tasks-gh-projects-cell')), row, field);
				}
			}
		}
	}

	private _iterationRange(startDate: string, duration: number): string {
		const start = new Date(`${startDate}T00:00:00`);
		const end = new Date(start.getTime() + (duration - 1) * 86_400_000);
		const format = (date: Date) => date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
		return `${format(start)} – ${format(end)}`;
	}

	private _renderError(body: HTMLElement): void {
		const error = this._error ?? {};
		const panel = append(body, $('.kingu-tasks-gh-projects-empty.error'));
		const message = error.type === 'too_large'
			? localize('kingu.tasks.projects.tooLarge', "This view has too many items to render in Kingu. Narrow the view's filter on GitHub.")
			: error.type === 'unsupported_layout'
				? localize('kingu.tasks.projects.unsupportedLayout', "Kingu renders table and roadmap project views. This view uses a layout it cannot render yet.")
				: error.type === 'not_found'
					? localize('kingu.tasks.projects.notFound', "Could not find this project or view.")
					: error.type === 'schema_drift'
						? localize('kingu.tasks.projects.schemaDrift', "Could not read this project view.")
						: error.message || localize('kingu.tasks.projects.failed', "Failed to load this project view.");
		append(panel, $('p')).textContent = message;
		const project = this._settings.activeProject;
		if (project) {
			const open = append(panel, $('button.kingu-tasks-button.outline')) as HTMLButtonElement;
			open.type = 'button';
			open.textContent = localize('kingu.tasks.projects.openInGitHub', "Open in GitHub");
			const url = this._table?.project.url ?? `https://${projectHost(project.host)}/${project.ownerType === 'organization' ? 'orgs' : 'users'}/${encodeURIComponent(project.owner)}/projects/${project.number}`;
			this._rendered.add(addDisposableListener(open, EventType.CLICK, () => openExternalIssue(this._openerService, url)));
		}
	}

	/** `ProjectCell`, read only. */
	private _renderCell(cell: HTMLElement, row: IKinguProjectRow, field: IKinguProjectField): void {
		if (field === TYPE_COLUMN) {
			const icon = row.itemType === 'PULL_REQUEST' ? (row.content.isDraft ? 'git-pull-request-draft' : 'git-pull-request') : row.itemType === 'DRAFT_ISSUE' ? 'file-text' : row.itemType === 'REDACTED' ? 'lock' : 'circle-dot';
			cell.appendChild(lucideIcon(icon, 14, 'kingu-tasks-gh-projects-type'));
			cell.setAttribute('aria-label', row.itemType);
			return;
		}
		switch (field.dataType) {
			case 'TITLE': {
				cell.classList.add('title');
				if (row.content.number !== null) {
					append(cell, $('span.number')).textContent = `#${row.content.number}`;
				}
				const title = append(cell, $('span.truncate'));
				title.textContent = row.content.title;
				if (row.content.url) {
					const url = row.content.url;
					const open = append(cell, $('button.kingu-tasks-row-action')) as HTMLButtonElement;
					open.type = 'button';
					open.setAttribute('aria-label', localize('kingu.tasks.github.openInBrowser', "Open in browser"));
					open.appendChild(lucideIcon('external-link', 12));
					this._rendered.add(addDisposableListener(open, EventType.CLICK, () => openExternalIssue(this._openerService, url)));
				}
				return;
			}
			case 'ASSIGNEES': return this._users(cell, row.content.assignees);
			case 'LABELS': return this._labels(cell, row.content.labels);
			case 'REPOSITORY':
				cell.classList.add('muted');
				cell.textContent = row.content.repository ?? '';
				return;
			case 'PARENT_ISSUE':
				cell.textContent = row.content.parentIssue ? `#${row.content.parentIssue.number}` : '';
				return;
		}
		this._value(cell, row.fieldValuesByFieldId[field.id]);
	}

	private _value(cell: HTMLElement, value: IKinguProjectFieldValue | undefined): void {
		switch (value?.kind) {
			case 'single-select': {
				const chip = append(cell, $('span.kingu-tasks-gh-projects-option'));
				chip.dataset.color = value.color.toLowerCase();
				chip.textContent = value.name;
				return;
			}
			case 'iteration': cell.textContent = value.title; return;
			case 'text': cell.textContent = value.text; return;
			case 'number': cell.textContent = String(value.number); return;
			case 'date': cell.textContent = new Date(`${value.date}T00:00:00`).toLocaleDateString(); return;
			case 'labels': return this._labels(cell, value.labels);
			case 'users': return this._users(cell, value.users);
		}
	}

	private _users(cell: HTMLElement, users: readonly { login: string; avatarUrl: string | null }[]): void {
		for (const user of users.slice(0, 3)) {
			const chip = append(cell, $('span.kingu-tasks-gh-projects-user'));
			if (user.avatarUrl) {
				const image = append(chip, $('img.kingu-tasks-avatar')) as HTMLImageElement;
				image.alt = '';
				image.referrerPolicy = 'no-referrer';
				image.src = user.avatarUrl;
			}
			append(chip, $('span.truncate')).textContent = user.login;
		}
		if (users.length > 3) {
			append(cell, $('span.muted')).textContent = `+${users.length - 3}`;
		}
	}

	private _labels(cell: HTMLElement, labels: readonly { name: string; color: string }[]): void {
		for (const label of labels.slice(0, 3)) {
			const chip = append(cell, $('span.kingu-tasks-gh-projects-label'));
			if (/^[0-9a-f]{6}$/i.test(label.color)) {
				chip.style.setProperty('--label-color', `#${label.color}`);
			}
			chip.textContent = label.name;
		}
		if (labels.length > 3) {
			append(cell, $('span.muted')).textContent = `+${labels.length - 3}`;
		}
	}

	/** `ProjectPicker`: Pinned, Recent and Browse all, and Add by URL or owner/number; then a view when there is no saved one. */
	private _togglePicker(anchor: HTMLElement): void {
		if (this._picker.value) {
			this._picker.clear();
			return;
		}
		const store = new DisposableStore();
		this._picker.value = store;
		const popover = append(anchor, $('.kingu-tasks-gh-popover.kingu-tasks-gh-projects-popover'));
		store.add({ dispose: () => popover.remove() });
		store.add(addDisposableListener(getWindow(anchor).document, EventType.MOUSE_DOWN, (event: MouseEvent) => {
			if (!anchor.contains(event.target as Node)) {
				this._picker.clear();
			}
		}, true));
		store.add(addDisposableListener(popover, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.stopPropagation();
				this._picker.clear();
			}
		}));
		let projects: readonly IKinguProjectSummary[] | undefined;
		let browseError: string | undefined;
		const screen = new DisposableStore();
		store.add(screen);

		const choose = async (project: IKinguProjectRef, viewNumber?: number) => {
			const lastView = this._settings.lastViewByProject[projectKey(project)]?.viewId;
			if (lastView && viewNumber === undefined) {
				this._picker.clear();
				this._query = undefined;
				await this._open(project, lastView);
				return;
			}
			if (viewNumber !== undefined) {
				this._picker.clear();
				this._query = undefined;
				await this._open(project, undefined, viewNumber);
				return;
			}
			chooseView(project);
		};

		const chooseView = (project: IKinguProjectRef) => {
			screen.clear();
			clearNode(popover);
			const back = append(popover, $('button.kingu-tasks-gh-filter-back')) as HTMLButtonElement;
			back.type = 'button';
			back.textContent = localize('kingu.tasks.projects.back', "← Back");
			screen.add(addDisposableListener(back, EventType.CLICK, browse));
			append(popover, $('.kingu-tasks-gh-filter-heading')).textContent = localize('kingu.tasks.projects.chooseView', "Choose a view");
			const list = append(popover, $('.kingu-tasks-gh-popover-list'));
			append(list, $('.kingu-tasks-gh-filter-status')).textContent = localize('kingu.tasks.projects.loadingViews', "Loading views…");
			this._orca.invoke<Result<{ views: IKinguProjectViewSummary[] }>>('gh:listProjectViews', this._ref(project)).then(result => {
				// The reader may have gone back or closed the picker meanwhile.
				if (!list.isConnected) {
					return;
				}
				clearNode(list);
				if (!result.ok) {
					this._notificationService.error(result.error?.message || localize('kingu.tasks.projects.viewsFailed', "Failed to load views."));
					return;
				}
				if (result.views.length === 0) {
					append(list, $('.kingu-tasks-gh-filter-status')).textContent = localize('kingu.tasks.projects.noViews', "No views found.");
				}
				for (const view of result.views) {
					const row = append(list, $('button.kingu-tasks-gh-popover-row.project')) as HTMLButtonElement;
					row.type = 'button';
					row.disabled = !isSupportedLayout(view.layout);
					const text = append(row, $('span.kingu-tasks-gh-popover-text'));
					append(text, $('span.truncate')).textContent = view.name;
					append(text, $('span.kingu-tasks-gh-popover-path')).textContent = layoutLabel(view.layout);
					screen.add(addDisposableListener(row, EventType.CLICK, () => {
						this._picker.clear();
						this._query = undefined;
						void this._open(project, view.id);
					}));
				}
			}, (error: unknown) => {
				if (list.isConnected) {
					this._notificationService.error(localize('kingu.tasks.projects.viewsFailedWith', "Failed to load views: {0}", error instanceof Error ? error.message : String(error)));
				}
			});
		};

		const browse = () => {
			screen.clear();
			clearNode(popover);
			const search = append(popover, $('input.kingu-tasks-gh-popover-search')) as HTMLInputElement;
			search.type = 'text';
			search.placeholder = localize('kingu.tasks.projects.searchProjects', "Search projects");
			search.setAttribute('aria-label', search.placeholder);
			const list = append(popover, $('.kingu-tasks-gh-popover-list'));
			const footer = append(popover, $('.kingu-tasks-gh-projects-add'));
			const add = append(footer, $('input.kingu-tasks-gh-popover-search')) as HTMLInputElement;
			add.type = 'text';
			add.placeholder = localize('kingu.tasks.projects.addPlaceholder', "Add by URL or owner/number");
			add.setAttribute('aria-label', add.placeholder);
			const addButton = append(footer, $('button.kingu-tasks-button.outline')) as HTMLButtonElement;
			addButton.type = 'button';
			addButton.textContent = localize('kingu.tasks.projects.add', "Add");
			const addError = append(popover, $('.kingu-tasks-gh-dialog-error'));
			addError.style.display = 'none';
			const submitAdd = async () => {
				const input = add.value.trim();
				if (!isProjectRefInput(input)) {
					addError.textContent = localize('kingu.tasks.projects.badRef', "Expected a project URL or owner/number");
					addError.style.display = '';
					return;
				}
				addError.style.display = 'none';
				const resolved = await this._orca.invoke<Result<IKinguProjectRef & { viewNumber?: number }>>('gh:resolveProjectRef', { input }).catch((error: unknown) => ({ ok: false as const, error: { message: error instanceof Error ? error.message : String(error) } }));
				if (!resolved.ok) {
					addError.textContent = resolved.error?.message || localize('kingu.tasks.projects.badRef', "Expected a project URL or owner/number");
					addError.style.display = '';
					return;
				}
				await choose(resolved, resolved.viewNumber);
			};
			screen.add(addDisposableListener(addButton, EventType.CLICK, () => void submitAdd()));
			screen.add(addDisposableListener(add, EventType.KEY_DOWN, (event: KeyboardEvent) => {
				if (event.key === 'Enter' && !event.isComposing) {
					event.preventDefault();
					void submitAdd();
				}
			}));

			const draw = () => {
				clearNode(list);
				const query = search.value.trim().toLowerCase();
				const matches = (ref: IKinguProjectRef & { title?: string }) => !query || ref.owner.toLowerCase().includes(query) || (ref.title ?? '').toLowerCase().includes(query) || String(ref.number).includes(query);
				const titled = (ref: IKinguProjectRef) => projects?.find(project => sameProject(project, ref));
				const section = (title: string, refs: readonly IKinguProjectRef[]) => {
					const shown = refs.filter(ref => matches({ ...ref, title: titled(ref)?.title }));
					if (shown.length === 0) {
						return;
					}
					append(list, $('.kingu-tasks-gh-filter-heading')).textContent = title;
					for (const ref of shown) {
						const row = append(list, $('button.kingu-tasks-gh-popover-row.project')) as HTMLButtonElement;
						row.type = 'button';
						const text = append(row, $('span.kingu-tasks-gh-popover-text'));
						append(text, $('span.truncate')).textContent = titled(ref)?.title ?? `#${ref.number}`;
						append(text, $('span.kingu-tasks-gh-popover-path')).textContent = ref.owner;
						screen.add(addDisposableListener(row, EventType.CLICK, () => void choose(ref)));
					}
				};
				section(localize('kingu.tasks.projects.pinned', "Pinned"), this._settings.pinned);
				section(localize('kingu.tasks.projects.recent', "Recent"), this._settings.recent.filter(recent => !this._settings.pinned.some(pinned => sameProject(pinned, recent))));
				const listed = [...this._settings.pinned, ...this._settings.recent];
				section(projects === undefined ? localize('kingu.tasks.projects.browseLoading', "Browse all (loading…)") : localize('kingu.tasks.projects.browseAll', "Browse all"),
					(projects ?? []).filter(project => !listed.some(ref => sameProject(ref, project))));
				if (projects === undefined) {
					append(list, $('.kingu-tasks-gh-filter-status')).textContent = localize('kingu.tasks.github.loading', "Loading…");
				} else if (browseError) {
					append(list, $('.kingu-tasks-gh-dialog-error')).textContent = browseError;
				}
			};
			draw();
			screen.add(addDisposableListener(search, EventType.INPUT, draw));
			search.focus();
			if (projects === undefined) {
				this._orca.invoke<Result<{ projects: IKinguProjectSummary[]; partialFailures?: { owner: string; message: string }[] }>>('gh:listAccessibleProjects', {}).then(result => {
					projects = result.ok ? result.projects : [];
					browseError = !result.ok
						? result.error?.message
						: result.partialFailures?.length === 1
							? localize('kingu.tasks.projects.partialOne', "Couldn't load projects from {0}. Paste a project URL below to reach missing ones.", result.partialFailures[0].owner)
							: result.partialFailures?.length
								? localize('kingu.tasks.projects.partialMany', "Some organizations didn't load ({0}). Paste a project URL below to reach missing ones.", result.partialFailures.length)
								: undefined;
				}, (error: unknown) => {
					projects = [];
					browseError = error instanceof Error ? error.message : String(error);
				}).finally(() => {
					if (list.isConnected) {
						draw();
					}
				});
			}
		};
		browse();
	}
}
