/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/kinguActivityDot.css';
import './media/kinguAgents.css';
import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, IObservable, observableFromEvent } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { ISession } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import {
	buildKinguActivityGroups,
	IKinguActivityGroup,
	IKinguActivityRow,
	KinguActivityGroupBy,
	kinguActivityGroupByLabel,
	kinguActivityMatchesQuery,
	kinguActivityStatus,
	kinguActivityStatusLabel,
	sortKinguActivityRows,
} from '../common/kinguActivity.js';

export const KINGU_AGENTS_VIEW_ID = 'kingu.view.agents';

const GROUP_BY_STORAGE_KEY = 'kinguAgentsView.groupBy';
const READ_FILTER_STORAGE_KEY = 'kinguAgentsView.readFilter';
const COMPACT_STORAGE_KEY = 'kinguAgentsView.compact';

/** Which rows the list is showing. The ADE's `ThreadReadFilter`, with its two members. */
type KinguReadFilter = 'all' | 'unread';

const GROUP_BY: readonly KinguActivityGroupBy[] = ['status', 'project', 'agent', 'none'];

function isGroupBy(value: string | undefined): value is KinguActivityGroupBy {
	return GROUP_BY.includes(value as KinguActivityGroupBy);
}

/**
 * Every agent in this window, as a sidebar navigator.
 *
 * The ADE's `SidebarAgentsList`, which its own comment describes as the
 * Activity list hosted in the sidebar — selecting a row reveals that agent
 * rather than swapping the view. Same here, and the model is literally the same
 * module the Activity page uses: one ranking, one grouping, one search, so the
 * sidebar and the page can never disagree about what a session is doing.
 *
 * It is a view of its own rather than a second mode bolted onto the sessions
 * list. The sessions list answers "what have I got, and where did I put it" —
 * pins, custom groups, workspace and date sections, with a written spec for its
 * placement precedence. This answers "who is waiting on me". Folding the second
 * into the first would mean either overriding that precedence or explaining why
 * the same list sorts two ways.
 */
export class KinguAgentsView extends ViewPane {

	private readonly _redraw = this._register(new MutableDisposable());
	private _body: HTMLElement | undefined;
	private _listContainer: HTMLElement | undefined;
	private _rows: readonly IKinguActivityRow[] = [];
	private _sessionsById = new Map<string, ISession>();
	private _query = '';
	private _groupBy: KinguActivityGroupBy;
	private _readFilter: KinguReadFilter;
	private _compact: boolean;
	private readonly _sessions: IObservable<readonly ISession[]>;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ISessionsManagementService private readonly _managementService: ISessionsManagementService,
		@ISessionsService private readonly _sessionsService: ISessionsService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		const storedGroupBy = this._storageService.get(GROUP_BY_STORAGE_KEY, StorageScope.PROFILE);
		this._groupBy = isGroupBy(storedGroupBy) ? storedGroupBy : 'status';
		this._readFilter = this._storageService.get(READ_FILTER_STORAGE_KEY, StorageScope.PROFILE) === 'unread' ? 'unread' : 'all';
		this._compact = this._storageService.getBoolean(COMPACT_STORAGE_KEY, StorageScope.PROFILE, false);
		this._sessions = observableFromEvent(this,
			this._managementService.onDidChangeSessions,
			() => this._managementService.getSessions());
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);
		this._body = append(parent, $('.kingu-agents'));
		// One autorun over every session's observables, for the same reason the
		// Activity page uses one: subscribing per session would mean tearing the
		// subscriptions down and rebuilding them every time a session appears.
		this._redraw.value = autorun(reader => {
			// Read through the observable, not `getSessions()` directly, so the
			// autorun re-runs when the *set* changes and not only when a session
			// it already holds does.
			const sessions = this._sessions.read(reader);
			this._sessionsById = new Map(sessions.map(session => [session.sessionId, session]));
			this._rows = sortKinguActivityRows(sessions.map((session): IKinguActivityRow => {
				const workspace = session.workspace.read(reader);
				return {
					sessionId: session.sessionId,
					resource: session.resource,
					title: session.title.read(reader),
					status: kinguActivityStatus(session.status.read(reader), session.isArchived.read(reader)),
					agentLabel: session.sessionType,
					projectLabel: workspace?.label,
					detail: session.description.read(reader)?.value,
					updatedAt: session.updatedAt.read(reader).getTime(),
					isRead: session.isRead.read(reader),
				};
			}));
			this._draw();
		});
	}

	private _draw(): void {
		if (!this._body) {
			return;
		}
		clearNode(this._body);
		this._body.classList.toggle('compact', this._compact);
		this._drawToolbar(this._body);
		this._listContainer = append(this._body, $('.kingu-agents-list'));
		this._drawList();
	}

	private _drawToolbar(parent: HTMLElement): void {
		const bar = append(parent, $('.kingu-agents-toolbar'));

		const search = append(bar, $('input.kingu-agents-search')) as HTMLInputElement;
		search.type = 'search';
		search.placeholder = localize('kingu.agents.search', "Filter agents");
		search.value = this._query;
		search.addEventListener('input', () => {
			this._query = search.value;
			this._drawList();
		});

		const controls = append(bar, $('.kingu-agents-controls'));

		const unread = append(controls, $('button.kingu-agents-toggle')) as HTMLButtonElement;
		unread.type = 'button';
		unread.classList.toggle('checked', this._readFilter === 'unread');
		unread.textContent = localize('kingu.agents.unreadOnly', "Unread");
		unread.title = localize('kingu.agents.unreadOnlyTitle', "Show only sessions you have not read");
		unread.addEventListener('click', () => {
			this._readFilter = this._readFilter === 'unread' ? 'all' : 'unread';
			this._storageService.store(READ_FILTER_STORAGE_KEY, this._readFilter, StorageScope.PROFILE, StorageTarget.USER);
			this._draw();
		});

		const compact = append(controls, $('button.kingu-agents-toggle')) as HTMLButtonElement;
		compact.type = 'button';
		compact.classList.toggle('checked', this._compact);
		compact.textContent = localize('kingu.agents.compact', "Compact");
		compact.addEventListener('click', () => {
			this._compact = !this._compact;
			this._storageService.store(COMPACT_STORAGE_KEY, this._compact, StorageScope.PROFILE, StorageTarget.USER);
			this._draw();
		});

		const select = append(controls, $('select.kingu-agents-groupby')) as HTMLSelectElement;
		select.title = localize('kingu.agents.groupByTitle', "Group by");
		for (const groupBy of GROUP_BY) {
			const option = append(select, $('option')) as HTMLOptionElement;
			option.value = groupBy;
			option.textContent = kinguActivityGroupByLabel(groupBy);
		}
		select.value = this._groupBy;
		select.addEventListener('change', () => {
			this._groupBy = select.value as KinguActivityGroupBy;
			this._storageService.store(GROUP_BY_STORAGE_KEY, this._groupBy, StorageScope.PROFILE, StorageTarget.USER);
			this._drawList();
		});

		const markAll = append(controls, $('button.kingu-agents-toggle')) as HTMLButtonElement;
		markAll.type = 'button';
		markAll.textContent = localize('kingu.agents.markAllRead', "Mark all read");
		markAll.addEventListener('click', () => this._markAllRead());
	}

	/**
	 * Marks every row the list is currently showing as read.
	 *
	 * Scoped to the visible rows rather than to every session, because the
	 * button sits above a filtered list: "mark all read" next to three rows that
	 * quietly cleared thirty would be the wrong promise.
	 */
	private _markAllRead(): void {
		for (const row of this._visible()) {
			const session = this._sessionsById.get(row.sessionId);
			if (session && !row.isRead) {
				this._managementService.markRead(session).catch(onUnexpectedError);
			}
		}
	}

	private _visible(): IKinguActivityRow[] {
		return this._rows.filter(row =>
			(this._readFilter === 'all' || !row.isRead)
			&& kinguActivityMatchesQuery(row, this._query));
	}

	private _drawList(): void {
		const container = this._listContainer;
		if (!container) {
			return;
		}
		clearNode(container);
		const visible = this._visible();
		if (visible.length === 0) {
			append(container, $('.kingu-agents-empty')).textContent = this._readFilter === 'unread' && this._rows.length > 0
				? localize('kingu.agents.allRead', "Nothing unread.")
				: this._rows.length === 0
					? localize('kingu.agents.none', "No agent has run in this window yet.")
					: localize('kingu.agents.noMatch', "Nothing matches that.");
			return;
		}
		for (const group of buildKinguActivityGroups(visible, this._groupBy)) {
			this._drawGroup(container, group);
		}
	}

	private _drawGroup(container: HTMLElement, group: IKinguActivityGroup): void {
		if (group.label) {
			const header = append(container, $('.kingu-agents-group'));
			if (group.status !== undefined) {
				append(header, $(`span.kingu-activity-dot.${group.status}`));
			}
			append(header, $('span.kingu-agents-group-label')).textContent = group.label;
			append(header, $('span.kingu-agents-group-count')).textContent = `${group.rows.length}`;
		}
		for (const row of group.rows) {
			this._drawRow(append(container, $('button.kingu-agents-row')) as HTMLButtonElement, row);
		}
	}

	private _drawRow(element: HTMLButtonElement, row: IKinguActivityRow): void {
		element.type = 'button';
		element.classList.toggle('unread', !row.isRead);
		append(element, $(`span.kingu-activity-dot.${row.status}`));
		const body = append(element, $('.kingu-agents-row-body'));
		append(body, $('.kingu-agents-row-title')).textContent = row.title;
		// Dropped in compact mode rather than hidden with CSS: the second line is
		// the expensive part of a row, and a sidebar holding hundreds of them is
		// exactly when someone reaches for compact.
		if (!this._compact) {
			const parts = [kinguActivityStatusLabel(row.status)];
			if (row.projectLabel) {
				parts.push(row.projectLabel);
			}
			if (row.detail) {
				parts.push(row.detail);
			}
			append(body, $('.kingu-agents-row-meta')).textContent = parts.join(' · ');
		}
		element.title = row.detail
			? `${row.title} — ${kinguActivityStatusLabel(row.status)} · ${row.detail}`
			: `${row.title} — ${kinguActivityStatusLabel(row.status)}`;
		element.addEventListener('click', () => {
			this._sessionsService.openSession(row.resource).catch(onUnexpectedError);
		});
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this._body) {
			this._body.style.height = `${height}px`;
		}
	}
}
