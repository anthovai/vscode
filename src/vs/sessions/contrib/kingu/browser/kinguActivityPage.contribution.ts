/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/kinguActivityDot.css';
import './media/kinguActivityPage.css';
import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, constObservable, IObservable, observableFromEvent } from '../../../../base/common/observable.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { AbstractCustomView } from '../../../services/customView/browser/customView.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { ISession } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import {
	buildKinguActivityGroups,
	countUnreadKinguActivity,
	IKinguActivityGroup,
	IKinguActivityRow,
	KINGU_ACTIVITY_QUERY_MAX_LENGTH,
	KinguActivityGroupBy,
	kinguActivityGroupByLabel,
	kinguActivityMatchesQuery,
	kinguActivityStatus,
	kinguActivityStatusLabel,
	sortKinguActivityRows,
} from '../common/kinguActivity.js';

export const KINGU_ACTIVITY_VIEW_ID = 'kingu.customView.activity';
export const KINGU_SHOW_ACTIVITY_COMMAND_ID = 'kingu.activity.show';

const GROUP_BY: readonly KinguActivityGroupBy[] = ['status', 'project', 'agent', 'none'];

function relativeTime(timestamp: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
	if (seconds < 60) {
		return localize('kingu.activity.justNow', "just now");
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {
		return localize('kingu.activity.minutes', "{0}m ago", minutes);
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return localize('kingu.activity.hours', "{0}h ago", hours);
	}
	return localize('kingu.activity.days', "{0}d ago", Math.round(hours / 24));
}

/**
 * What every agent in this window has been doing, attention first.
 *
 * The ADE's Activity page, rebuilt against sessions. What carried over is the
 * part that makes it a different surface from a list of sessions: the rows are
 * ranked by *who is waiting on you*, not by recency, so a session that needs an
 * answer cannot be pushed off the top by a busier one that needs nothing.
 *
 * What did not carry over is most of the file count. The ADE's activity is a
 * fan-in of per-pane hook snapshots — portals, readiness, retained history,
 * per-pane caps — because an agent running as a CLI in a terminal cannot be
 * asked what it is doing and has to be remembered instead. Here every session
 * reports its own status over the protocol, so there is nothing to retain and
 * nothing to reconcile.
 *
 * "Clear completed" is not here for the same reason. In the ADE it stamps a
 * per-pane cutoff over retained snapshots and offers an undo, because the rows
 * exist only in its own memory. The equivalent act in this window is archiving
 * a session, which the sessions list already owns and which is real rather than
 * a local hide.
 */
class KinguActivityView extends AbstractCustomView {

	readonly title: IObservable<string> = constObservable(localize('kingu.activity.pageTitle', "Activity"));
	override readonly description: IObservable<string | undefined> = constObservable(
		localize('kingu.activity.pageDescription', "Every session in this window, the ones waiting on you first."));

	private readonly _redraw = this._register(new MutableDisposable());
	private _container: HTMLElement | undefined;
	private _query = '';
	private _groupBy: KinguActivityGroupBy = 'status';
	/** Held rather than looked up: typing redraws only the list, not the toolbar. */
	private _listContainer: HTMLElement | undefined;
	private _summary: HTMLElement | undefined;
	private _rows: readonly IKinguActivityRow[] = [];

	private readonly _sessions: IObservable<readonly ISession[]>;

	constructor(
		@ISessionsManagementService private readonly _managementService: ISessionsManagementService,
		@ISessionsService private readonly _sessionsService: ISessionsService,
	) {
		super();
		this._sessions = observableFromEvent(this,
			this._managementService.onDidChangeSessions,
			() => this._managementService.getSessions());
	}

	render(container: HTMLElement): void {
		this._container = container;
		// An autorun rather than a listener per session: every field the rows are
		// built from is an observable, and a page that subscribed to them one by
		// one would have to re-subscribe every time the set of sessions changed.
		this._redraw.value = autorun(reader => {
			this._rows = this._readRows(reader);
			this._draw();
		});
	}

	private _readRows(reader: Parameters<Parameters<typeof autorun>[0]>[0]): IKinguActivityRow[] {
		const rows = this._sessions.read(reader).map((session): IKinguActivityRow => {
			const workspace = session.workspace.read(reader);
			const detail = session.description.read(reader);
			return {
				sessionId: session.sessionId,
				resource: session.resource,
				title: session.title.read(reader),
				status: kinguActivityStatus(session.status.read(reader), session.isArchived.read(reader)),
				// The session type rather than the provider id: `copilot-cli` is
				// what the user picked, `copilot` is only who implements it.
				agentLabel: session.sessionType,
				projectLabel: workspace?.label,
				detail: detail?.value,
				updatedAt: session.updatedAt.read(reader).getTime(),
				isRead: session.isRead.read(reader),
			};
		});
		return sortKinguActivityRows(rows);
	}

	private _draw(): void {
		if (!this._container) {
			return;
		}
		clearNode(this._container);
		const root = append(this._container, $('.kingu-activity-page'));

		const header = append(root, $('.kingu-activity-header'));
		append(header, $('h1.kingu-activity-title')).textContent = localize('kingu.activity.pageTitle', "Activity");
		const unread = countUnreadKinguActivity(this._rows);
		if (unread > 0) {
			append(header, $('span.kingu-activity-unread')).textContent =
				localize('kingu.activity.unread', "{0} unread", unread);
		}

		this._drawToolbar(root);
		this._listContainer = append(root, $('.kingu-activity-list'));
		this._drawList();
	}

	private _drawToolbar(root: HTMLElement): void {
		const bar = append(root, $('.kingu-activity-toolbar'));

		const search = append(bar, $('input.kingu-activity-search')) as HTMLInputElement;
		search.type = 'search';
		search.placeholder = localize('kingu.activity.searchPlaceholder', "Search sessions");
		search.maxLength = KINGU_ACTIVITY_QUERY_MAX_LENGTH;
		search.value = this._query;
		search.addEventListener('input', () => {
			this._query = search.value;
			this._drawList();
		});

		append(bar, $('span.kingu-activity-groupby-label')).textContent = localize('kingu.activity.groupBy', "Group by");
		const select = append(bar, $('select.kingu-activity-groupby')) as HTMLSelectElement;
		for (const groupBy of GROUP_BY) {
			const option = append(select, $('option')) as HTMLOptionElement;
			option.value = groupBy;
			option.textContent = kinguActivityGroupByLabel(groupBy);
		}
		select.value = this._groupBy;
		select.addEventListener('change', () => {
			this._groupBy = select.value as KinguActivityGroupBy;
			this._drawList();
		});

		this._summary = append(bar, $('span.kingu-activity-summary'));
	}

	private _drawList(): void {
		const container = this._listContainer;
		if (!container) {
			return;
		}
		clearNode(container);
		const visible = this._rows.filter(row => kinguActivityMatchesQuery(row, this._query));
		if (this._summary) {
			this._summary.textContent = visible.length === this._rows.length
				? localize('kingu.activity.count', "{0} sessions", this._rows.length)
				: localize('kingu.activity.filteredCount', "{0} of {1}", visible.length, this._rows.length);
		}

		if (visible.length === 0) {
			append(container, $('.kingu-activity-status')).textContent = this._rows.length === 0
				? localize('kingu.activity.none', "Nothing has run in this window yet.")
				: localize('kingu.activity.noMatch', "Nothing matches that.");
			return;
		}

		const now = Date.now();
		for (const group of buildKinguActivityGroups(visible, this._groupBy)) {
			this._drawGroup(container, group, now);
		}
	}

	private _drawGroup(container: HTMLElement, group: IKinguActivityGroup, now: number): void {
		if (group.label) {
			const header = append(container, $('.kingu-activity-group'));
			if (group.status !== undefined) {
				// The header dot is the row dot, so the two cannot disagree about
				// what the group is.
				append(header, $(`span.kingu-activity-dot.${group.status}`));
			}
			append(header, $('span.kingu-activity-group-label')).textContent = group.label;
			append(header, $('span.kingu-activity-group-count')).textContent = `${group.rows.length}`;
		}
		for (const row of group.rows) {
			this._drawRow(append(container, $('button.kingu-activity-row')) as HTMLButtonElement, row, now);
		}
	}

	private _drawRow(element: HTMLButtonElement, row: IKinguActivityRow, now: number): void {
		element.type = 'button';
		element.classList.toggle('unread', !row.isRead);
		append(element, $(`span.kingu-activity-dot.${row.status}`));

		const body = append(element, $('.kingu-activity-row-body'));
		const head = append(body, $('.kingu-activity-row-head'));
		append(head, $('span.kingu-activity-row-title')).textContent = row.title;
		append(head, $('span.kingu-activity-row-time')).textContent = relativeTime(row.updatedAt, now);

		const meta = append(body, $('.kingu-activity-row-meta'));
		// The status is spelled out on the row as well as in the header, because
		// the page can be grouped by project or by agent, and then the dot is the
		// only thing carrying it.
		const parts = [kinguActivityStatusLabel(row.status), row.agentLabel];
		if (row.projectLabel) {
			parts.push(row.projectLabel);
		}
		if (row.detail) {
			parts.push(row.detail);
		}
		meta.textContent = parts.join(' · ');

		element.addEventListener('click', () => {
			void this._sessionsService.openSession(row.resource);
		});
	}

	layout(_width: number, _height: number): void { }
}

class KinguActivityPageContribution extends Disposable {

	static readonly ID = 'kingu.contrib.activityPage';

	constructor(
		@ICustomViewService customViewService: ICustomViewService,
	) {
		super();
		this._register(customViewService.registerCustomView({
			id: KINGU_ACTIVITY_VIEW_ID,
			ctor: new SyncDescriptor(KinguActivityView),
		}));
	}
}

registerWorkbenchContribution2(KinguActivityPageContribution.ID, KinguActivityPageContribution, WorkbenchPhase.BlockRestore);

class ShowKinguActivityAction extends Action2 {

	constructor() {
		super({
			id: KINGU_SHOW_ACTIVITY_COMMAND_ID,
			title: localize2('kingu.showActivity', "Kingu: Activity"),
			category: Categories.View,
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(ICustomViewService).showCustomView(KINGU_ACTIVITY_VIEW_ID);
	}
}

registerAction2(ShowKinguActivityAction);
