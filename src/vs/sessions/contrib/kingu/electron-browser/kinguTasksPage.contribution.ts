/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/kinguTasksPage.css';
import { $, addDisposableListener, append, clearNode, EventType, isHTMLElement } from '../../../../base/browser/dom.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { SelectBox } from '../../../../base/browser/ui/selectBox/selectBox.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { constObservable, IObservable, waitForState } from '../../../../base/common/observable.js';
import { timeout } from '../../../../base/common/async.js';
import { Schemas } from '../../../../base/common/network.js';
import { isLinux, isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { defaultSelectBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { AbstractCustomView } from '../../../services/customView/browser/customView.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { ISessionsRecentWorkspacesService } from '../../../services/sessions/browser/sessionsRecentWorkspacesService.js';
import { IKinguOrcaService } from '../common/kinguOrca.js';
import {
	getLocalHostLabel,
	getRepoBackedProviderReason,
	getSelectedJiraSiteId,
	getSelectedLinearWorkspace,
	getTaskSourceNotice,
	getTaskSourceSummary,
	getVisibleTaskProviders,
	IKinguJiraStatus,
	IKinguLinearStatus,
	IKinguPreflightStatus,
	IKinguTaskSourceNotice,
	KINGU_SHOW_TASKS_COMMAND_ID,
	KINGU_TASKS_VIEW_ID,
	KinguTaskProvider,
	KinguTaskSourceReason,
	normalizeVisibleTaskProviders,
	reasonLabel,
	resolveVisibleTaskProvider,
} from '../common/kinguTasks.js';
import { getRepoBackedSummary, getRepoGitHubSlug, getRepoHostId, IKinguGitHubSlug, IKinguRepo, isTaskEligibleRepo, resolveRepoSelection } from '../common/kinguTasksGitHub.js';
import { KINGU_PROVIDER_LOGOS, IKinguProviderLogo } from '../common/kinguProviderLogos.js';
import { IKinguTaskActions, IKinguTaskRef } from '../common/kinguTasksDetail.js';
import { lucideIcon, logoIcon } from './kinguOrcaFooterParts.js';
import { KinguTasksDetail } from './kinguTasksDetail.js';
import { KinguTasksGitHubList } from './kinguTasksGitHubList.js';
import { KinguTasksGitLabList } from './kinguTasksGitLabList.js';
import { KinguTasksJiraList } from './kinguTasksJiraList.js';
import { KinguTasksLinearList } from './kinguTasksLinearList.js';
import { KinguTasksWorkspaceLauncher } from './kinguTasksWorkspaceLauncher.js';

/** The two settings the source bar reads and writes. */
interface ITaskSettings {
	readonly visibleTaskProviders?: unknown;
	readonly defaultTaskSource?: unknown;
	/** The picked projects; `null` is "All projects", absent is the default pick. */
	readonly defaultRepoSelection?: unknown;
}

interface ISourceOption {
	readonly id: KinguTaskProvider;
	readonly label: string;
	icon(size: number): Element;
}

const LINEAR_LOGO: IKinguProviderLogo = KINGU_PROVIDER_LOGOS.linear;
const JIRA_LOGO: IKinguProviderLogo = KINGU_PROVIDER_LOGOS.jira;

/** The ADE's `getSourceOptions`, in its order. */
const SOURCE_OPTIONS: readonly ISourceOption[] = [
	{ id: 'github', label: localize('kingu.tasks.github', "GitHub"), icon: size => lucideIcon('github', size) },
	{ id: 'gitlab', label: localize('kingu.tasks.gitlab', "GitLab"), icon: size => lucideIcon('gitlab', size) },
	{ id: 'linear', label: localize('kingu.tasks.linear', "Linear"), icon: size => logoIcon(LINEAR_LOGO, size) },
	{ id: 'jira', label: localize('kingu.tasks.jira', "Jira"), icon: size => logoIcon(JIRA_LOGO, size) },
];

function optionOf(provider: KinguTaskProvider): ISourceOption {
	return SOURCE_OPTIONS.find(option => option.id === provider) ?? SOURCE_OPTIONS[0];
}

function labelOf(provider: KinguTaskProvider): string {
	return optionOf(provider).label;
}

/** Folders the ADE refused as projects (not git repositories), not offered again this session. */
const refusedFolders = new Set<string>();

/** One spelling for a local path, as both the ADE (`E:/a/b`) and a file URI (`e:\a\b`) write it. */
function normalizeRepoPath(path: string): string {
	return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

const HOST_LABEL = getLocalHostLabel(isMacintosh ? 'mac' : isWindows ? 'windows' : isLinux ? 'linux' : 'other');

/**
 * The ADE's Tasks page, ported from `task-page/TaskPage.tsx` a piece at a time.
 *
 * This piece is the source bar (`task-page/SourceBar.tsx`) and what each
 * source reports: the repo-backed sources from the ADE's preflight, Linear and
 * Jira from their own status. The lists behind each source follow.
 */
class KinguTasksView extends AbstractCustomView {

	readonly title: IObservable<string> = constObservable(localize('kingu.tasks.pageTitle', "Tasks"));
	/** Full width, as the ADE's page is: its list columns are sized for it. */
	override readonly maxWidth = Number.POSITIVE_INFINITY;
	/** The ADE's page has no title bar; the source bar is its chrome. */
	override readonly showHeader = false;

	private readonly _drawn = this._register(new DisposableStore());
	private readonly _list = this._register(new MutableDisposable<KinguTasksJiraList | KinguTasksLinearList | KinguTasksGitHubList | KinguTasksGitLabList>());
	/** An open task's detail page, drawn in place of the list, which stays behind it. */
	private readonly _detail = this._register(new MutableDisposable<KinguTasksDetail>());
	private readonly _launcher: KinguTasksWorkspaceLauncher;
	private readonly _taskActions: IKinguTaskActions = {
		openDetail: ref => this._openDetail(ref),
		startWorkspace: ref => void this._launcher.start(ref),
	};
	private _repos: readonly IKinguRepo[] = [];
	private _repoSelection: readonly string[] = [];
	private readonly _repoSources = new Map<string, IKinguGitHubSlug>();
	private _listKey: string | undefined;
	private _container: HTMLElement | undefined;
	private _bar: HTMLElement | undefined;

	private _settings: ITaskSettings | undefined;
	private _preflight: IKinguPreflightStatus | undefined;
	private _linear: IKinguLinearStatus | undefined;
	private _jira: IKinguJiraStatus | undefined;
	private _loaded = false;
	private _refreshing = false;
	/** Set once the reader picks a source, so a late settings push does not move them off it. */
	private _taskSource: KinguTaskProvider | undefined;

	constructor(
		@IKinguOrcaService private readonly _orca: IKinguOrcaService,
		@IHoverService private readonly _hoverService: IHoverService,
		@IContextViewService private readonly _contextViewService: IContextViewService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ICustomViewService private readonly _customViewService: ICustomViewService,
		@ISessionsRecentWorkspacesService private readonly _recentWorkspacesService: ISessionsRecentWorkspacesService,
	) {
		super();
		this._launcher = this._register(this._instantiationService.createInstance(KinguTasksWorkspaceLauncher));
		this._register(this._orca.onPush('settings:changed')(([updates]) => {
			if (updates && typeof updates === 'object') {
				this._settings = { ...this._settings, ...updates };
				this._draw();
			}
		}));
	}

	render(container: HTMLElement): void {
		this._container = container;
		container.classList.add('kingu-tasks-page');
		// `Close · Esc`, as the ADE's page closes; a field keeps Escape for itself.
		this._register(addDisposableListener(container, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			const target = event.target;
			if (event.key === 'Escape' && !(isHTMLElement(target) && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'))) {
				event.preventDefault();
				this._customViewService.hideCustomView();
			}
		}));
		this._draw();
		void this._load();
	}

	/**
	 * Reads every source's state. `force` re-runs the ADE's preflight rather than
	 * taking its cached answer, for a CLI installed or signed in since (`glab`,
	 * `gh auth refresh`), and fetches the open list again.
	 */
	private async _load(force = false): Promise<void> {
		// Each answer stands alone: a provider that fails to report costs its own state, not the page.
		const [settings, preflight, linear, jira, repos] = await Promise.allSettled([
			this._orca.invoke<ITaskSettings>('settings:get'),
			this._orca.invoke<IKinguPreflightStatus>('preflight:check', force ? { force: true } : undefined),
			this._orca.invoke<IKinguLinearStatus>('linear:status'),
			this._orca.invoke<IKinguJiraStatus>('jira:status'),
			this._orca.invoke<IKinguRepo[]>('repos:list'),
		]);
		let allRepos = repos.status === 'fulfilled' ? repos.value ?? [] : [];
		if (await this._addAgentsFolders(allRepos)) {
			allRepos = await this._orca.invoke<IKinguRepo[]>('repos:list').catch(() => allRepos) ?? allRepos;
		}
		this._repos = allRepos.filter(isTaskEligibleRepo);
		this._settings = settings.status === 'fulfilled' ? settings.value ?? {} : {};
		this._preflight = preflight.status === 'fulfilled' ? preflight.value : undefined;
		this._linear = linear.status === 'fulfilled' ? linear.value : undefined;
		this._jira = jira.status === 'fulfilled' ? jira.value : undefined;
		this._repoSelection = resolveRepoSelection(this._repos, this._settings.defaultRepoSelection);
		this._loaded = true;
		if (force) {
			this._detail.clear();
			this._list.clear();
			this._listKey = undefined;
		}
		this._draw();
	}

	/**
	 * The Agents window's folders are this program's projects, so the ADE should
	 * know them: any local folder it does not have yet is added the way the ADE's
	 * own Add Project does (`repos:add`), which is also what its GitHub reads
	 * require of a path. A folder that is not a git repository is refused there
	 * and not asked about again this session.
	 */
	private async _addAgentsFolders(repos: readonly IKinguRepo[]): Promise<boolean> {
		await Promise.race([
			waitForState(this._recentWorkspacesService.historyLoadState, state => state !== 'loading'),
			timeout(5000),
		]);
		const known = new Set(repos.map(repo => normalizeRepoPath(repo.path)));
		const folders = new Map<string, string>();
		for (const recent of this._recentWorkspacesService.getRecentWorkspaces(false, true)) {
			for (const folder of recent.workspace.folders) {
				const key = normalizeRepoPath(folder.root.fsPath);
				if (folder.root.scheme === Schemas.file && !known.has(key) && !refusedFolders.has(key)) {
					folders.set(key, folder.root.fsPath);
				}
			}
		}
		let added = false;
		for (const [key, path] of folders) {
			try {
				const result = await this._orca.invoke<{ repo?: IKinguRepo; error?: unknown }>('repos:add', { path, kind: 'git' });
				if (result?.repo) {
					added = true;
				} else {
					refusedFolders.add(key);
				}
			} catch {
				refusedFolders.add(key);
			}
		}
		return added;
	}

	private async _refresh(): Promise<void> {
		if (this._refreshing) {
			return;
		}
		this._refreshing = true;
		this._redrawBar();
		try {
			await this._load(true);
		} finally {
			this._refreshing = false;
			this._redrawBar();
		}
	}

	private _visibleProviders(): KinguTaskProvider[] {
		return getVisibleTaskProviders(this._settings, {
			gitlabInstalled: this._preflight?.glab?.installed === true,
			linearConnected: this._linear?.connected === true,
		});
	}

	private _selectedRepos(): IKinguRepo[] {
		return this._repos.filter(repo => this._repoSelection.includes(repo.id));
	}

	/**
	 * Why a repo-backed source cannot load. As in the ADE it is asked per picked
	 * project's host, so with none picked there is nothing to be unavailable;
	 * only this machine's preflight is read, remote hosts answer for themselves.
	 */
	private _reason(provider: KinguTaskProvider): KinguTaskSourceReason | undefined {
		if (provider !== 'github' && provider !== 'gitlab') {
			return undefined;
		}
		return this._selectedRepos().some(repo => getRepoHostId(repo) === 'local') ? getRepoBackedProviderReason(provider, this._preflight) : undefined;
	}

	private _hostLabel(repo: IKinguRepo): string {
		const hostId = getRepoHostId(repo);
		return hostId === 'local' ? HOST_LABEL : hostId.replace(/^(ssh|runtime):/, '');
	}

	private _setRepoSelection(ids: readonly string[] | undefined): void {
		this._repoSelection = ids ? [...ids] : this._repos.map(repo => repo.id);
		const defaultRepoSelection = ids ? [...ids] : null;
		this._settings = { ...this._settings, defaultRepoSelection };
		this._orca.invoke('settings:set', { defaultRepoSelection }).catch(() => {
			this._notificationService.error(localize('kingu.tasks.saveProjectsFailed', "Failed to save the selected projects."));
		});
		this._redrawBar();
	}

	/** Only the bar's summary changes; redrawing the list would take focus from its open picker. */
	private _redrawBar(): void {
		const bar = this._bar;
		if (bar) {
			this._drawn.clear();
			const visible = this._visibleProviders();
			const next = $('.kingu-tasks-source-bar');
			this._drawSourceBar(next, visible, resolveVisibleTaskProvider(this._taskSource ?? this._settings?.defaultTaskSource, visible));
			bar.replaceWith(next);
			this._bar = next;
		}
	}

	private _notice(provider: KinguTaskProvider): IKinguTaskSourceNotice | undefined {
		return getTaskSourceNotice(labelOf(provider), HOST_LABEL, this._reason(provider));
	}

	private _draw(): void {
		const container = this._container;
		if (!container) {
			return;
		}
		this._drawn.clear();
		clearNode(container);

		const visible = this._visibleProviders();
		const taskSource = resolveVisibleTaskProvider(this._taskSource ?? this._settings?.defaultTaskSource, visible);

		this._bar = append(container, $('.kingu-tasks-source-bar'));
		this._drawSourceBar(this._bar, visible, taskSource);
		this._drawContent(append(container, $('.kingu-tasks-content')), taskSource);
	}

	private _drawSourceBar(bar: HTMLElement, visible: readonly KinguTaskProvider[], taskSource: KinguTaskProvider): void {
		const sources = append(bar, $('.kingu-tasks-sources'));
		// Close is anchored left with the source icons, as the ADE places it.
		const close = append(sources, $('button.kingu-tasks-close')) as HTMLButtonElement;
		close.type = 'button';
		close.setAttribute('aria-label', localize('kingu.tasks.close', "Close tasks"));
		close.appendChild(lucideIcon('x', 16));
		this._drawn.add(this._hoverService.setupDelayedHover(close, { content: localize('kingu.tasks.closeHint', "Close · Esc"), position: { hoverPosition: HoverPosition.BELOW } }));
		this._drawn.add(addDisposableListener(close, EventType.CLICK, () => this._customViewService.hideCustomView()));
		append(sources, $('.kingu-tasks-divider'));
		for (const option of SOURCE_OPTIONS.filter(option => visible.includes(option.id))) {
			const notice = this._notice(option.id);
			const label = notice?.label ?? option.label;
			const button = append(sources, $('button.kingu-tasks-source')) as HTMLButtonElement;
			button.type = 'button';
			button.dataset.taskSource = option.id;
			button.setAttribute('aria-label', label);
			button.setAttribute('aria-pressed', String(option.id === taskSource));
			button.disabled = !!notice?.blocking;
			button.appendChild(option.icon(14));
			this._drawn.add(this._hoverService.setupDelayedHover(button, { content: label, position: { hoverPosition: HoverPosition.BELOW } }));
			this._drawn.add(addDisposableListener(button, EventType.CLICK, () => this._selectSource(option.id)));
		}

		const reason = this._reason(taskSource);
		const selected = this._selectedRepos();
		const summary = taskSource === 'github' || taskSource === 'gitlab'
			? getRepoBackedSummary(labelOf(taskSource), [...new Set(selected.map(repo => this._hostLabel(repo)))], reason ? reasonLabel(reason) : undefined, selected, repo => this._repoSources.get(repo.id) ?? getRepoGitHubSlug(repo))
			: getTaskSourceSummary({
				provider: taskSource,
				providerLabel: labelOf(taskSource),
				hostLabel: HOST_LABEL,
				reason,
				accountLabel: taskSource === 'linear' ? this._linearAccountLabel() : this._jiraAccountLabel(),
			});
		const chip = append(sources, $('.kingu-tasks-summary'));
		append(chip, $('span')).textContent = summary.label;
		this._drawn.add(this._hoverService.setupDelayedHover(chip, { content: summary.title, position: { hoverPosition: HoverPosition.BELOW } }));

		const refresh = append(sources, $('button.kingu-tasks-close.kingu-tasks-refresh')) as HTMLButtonElement;
		refresh.type = 'button';
		refresh.setAttribute('aria-label', localize('kingu.tasks.refreshSources', "Check task sources again"));
		refresh.appendChild(lucideIcon('refresh-cw', 14, this._refreshing ? 'kingu-tasks-spin' : undefined));
		refresh.disabled = this._refreshing;
		this._drawn.add(this._hoverService.setupDelayedHover(refresh, { content: localize('kingu.tasks.refreshSourcesHint', "Check task sources again (installed CLIs, sign-ins, projects)"), position: { hoverPosition: HoverPosition.BELOW } }));
		this._drawn.add(addDisposableListener(refresh, EventType.CLICK, () => void this._refresh()));

		const sites = this._jira?.sites ?? [];
		if (taskSource === 'jira' && this._jira?.connected && sites.length > 1) {
			this._drawJiraSitePicker(append(bar, $('.kingu-tasks-source-controls')), sites);
		}
	}

	private _drawJiraSitePicker(parent: HTMLElement, sites: readonly { id: string; displayName: string }[]): void {
		const ids = ['all', ...sites.map(site => site.id)];
		const selected = Math.max(0, ids.indexOf(getSelectedJiraSiteId(this._jira) ?? 'all'));
		const select = this._drawn.add(new SelectBox(
			[{ text: localize('kingu.tasks.allJiraSites', "All Jira sites") }, ...sites.map(site => ({ text: site.displayName }))],
			selected,
			this._contextViewService,
			defaultSelectBoxStyles,
			{ ariaLabel: localize('kingu.tasks.jiraSite', "Jira site") },
		));
		select.render(append(parent, $('.kingu-tasks-site-select')));
		this._drawn.add(select.onDidSelect(({ index }) => void this._selectJiraSite(ids[index])));
	}

	private async _selectJiraSite(siteId: string): Promise<void> {
		try {
			await this._orca.invoke('jira:selectSite', { siteId });
			this._jira = await this._orca.invoke<IKinguJiraStatus>('jira:status');
		} catch {
			this._notificationService.error(localize('kingu.tasks.jiraSiteFailed', "Failed to switch Jira site."));
		}
		this._draw();
	}

	private _selectSource(provider: KinguTaskProvider): void {
		if (this._notice(provider)?.blocking) {
			return;
		}
		this._detail.clear();
		this._taskSource = provider;
		this._draw();
		this._orca.invoke('settings:set', { defaultTaskSource: provider }).catch(() => {
			this._notificationService.error(localize('kingu.tasks.saveDefaultFailed', "Failed to save default task source."));
		});
	}

	private _linearAccountLabel(): string | undefined {
		const workspace = getSelectedLinearWorkspace(this._linear);
		return workspace?.organizationName ?? workspace?.displayName;
	}

	private _jiraAccountLabel(): string | undefined {
		const id = getSelectedJiraSiteId(this._jira);
		const site = id && id !== 'all' ? this._jira?.sites?.find(candidate => candidate.id === id) : undefined;
		return site?.displayName ?? site?.siteUrl;
	}

	private _openDetail(ref: IKinguTaskRef): void {
		this._detail.value = this._instantiationService.createInstance(KinguTasksDetail, ref, {
			back: () => {
				this._detail.clear();
				this._draw();
			},
			startWorkspace: target => void this._launcher.start(target),
		});
		this._draw();
		this._detail.value?.focus();
	}

	private _drawContent(content: HTMLElement, taskSource: KinguTaskProvider): void {
		if (this._detail.value) {
			content.appendChild(this._detail.value.element);
			return;
		}
		if (!this._loaded) {
			const loading = append(content, $('.kingu-tasks-loading'));
			loading.appendChild(lucideIcon('loader-circle', 20, 'kingu-tasks-spin'));
			loading.setAttribute('aria-label', localize('kingu.tasks.loading', "Loading task sources"));
			return;
		}
		switch (taskSource) {
			case 'github':
			case 'gitlab':
				return this._drawRepoBacked(content, taskSource);
			case 'linear':
				return this._drawAccountBacked(content, taskSource, this._linear,
					localize('kingu.tasks.linear.connectTitle', "Connect your Linear account"),
					localize('kingu.tasks.linear.connectDescription', "Browse and start work on your assigned Linear issues directly from here."));
			case 'jira':
				return this._drawAccountBacked(content, taskSource, this._jira,
					localize('kingu.tasks.jira.connectTitle', "Connect your Jira site"),
					localize('kingu.tasks.jira.connectDescription', "Browse, edit, create, and start work from Jira issues directly from here."));
		}
	}

	private _drawRepoBacked(content: HTMLElement, provider: 'github' | 'gitlab'): void {
		const notice = this._notice(provider);
		if (notice) {
			this._list.clear();
			this._emptyCard(content, provider, notice.label, notice.title);
			return;
		}
		if (provider === 'github') {
			// Kept across redraws; the list owns the query, paging and the picker's popover.
			if (this._listKey !== 'github' || !this._list.value) {
				this._listKey = 'github';
				this._list.value = this._instantiationService.createInstance(KinguTasksGitHubList, {
					...this._taskActions,
					repos: this._repos,
					hostLabel: repo => this._hostLabel(repo),
					setSelection: ids => this._setRepoSelection(ids),
					setSource: (repoId, source) => {
						const known = this._repoSources.get(repoId);
						if (known?.owner !== source.owner || known?.repo !== source.repo || known?.host !== source.host) {
							this._repoSources.set(repoId, source);
							this._redrawBar();
						}
					},
				}, this._repoSelection);
			}
			content.appendChild(this._list.value.element);
			return;
		}
		if (this._listKey !== 'gitlab' || !this._list.value) {
			this._listKey = 'gitlab';
			this._list.value = this._instantiationService.createInstance(KinguTasksGitLabList, {
				...this._taskActions,
				repos: this._repos,
				hostLabel: repo => this._hostLabel(repo),
				setSelection: ids => this._setRepoSelection(ids),
			}, this._repoSelection);
		}
		content.appendChild(this._list.value.element);
	}

	private _drawAccountBacked(content: HTMLElement, provider: 'linear' | 'jira', status: IKinguLinearStatus | IKinguJiraStatus | undefined, connectTitle: string, connectDescription: string): void {
		if (!status?.connected) {
			this._list.clear();
			const card = this._emptyCard(content, provider, connectTitle, connectDescription);
			// Linear has no Hide here: while disconnected it is off the bar unless it is the saved default.
			if (provider === 'jira') {
				const actions = append(card, $('.kingu-tasks-card-actions'));
				const hide = append(actions, $('button.kingu-tasks-button.outline')) as HTMLButtonElement;
				hide.type = 'button';
				hide.textContent = localize('kingu.tasks.hideSource', "Hide {0}", labelOf(provider));
				this._drawn.add(addDisposableListener(hide, EventType.CLICK, () => this._hideSource(provider)));
			}
			return;
		}
		// Kept across redraws of the bar, so a settings push does not refetch or drop the search.
		const scope = provider === 'jira' ? getSelectedJiraSiteId(this._jira) : this._linear?.selectedWorkspaceId ?? this._linear?.activeWorkspaceId ?? undefined;
		const key = `${provider}:${scope ?? ''}:${status.credentialError ?? ''}`;
		if (this._listKey !== key || !this._list.value) {
			this._listKey = key;
			this._list.value = provider === 'jira'
				? this._instantiationService.createInstance(KinguTasksJiraList, scope, status.credentialError, this._taskActions)
				: this._instantiationService.createInstance(KinguTasksLinearList, scope, status.credentialError, this._taskActions);
		}
		content.appendChild(this._list.value.element);
	}

	/** The ADE's `hideTaskSource`: drop it from the bar, keeping one other visible. */
	private _hideSource(provider: KinguTaskProvider): void {
		const remaining = normalizeVisibleTaskProviders(this._settings?.visibleTaskProviders).filter(candidate => candidate !== provider);
		// An empty list normalizes to every provider, so keep one other or hiding does nothing.
		const visibleTaskProviders: KinguTaskProvider[] = remaining.length > 0 ? remaining : ['github'];
		const defaultTaskSource = resolveVisibleTaskProvider(this._settings?.defaultTaskSource, visibleTaskProviders);
		this._taskSource = undefined;
		this._orca.invoke('settings:set', { visibleTaskProviders, defaultTaskSource }).catch(() => {
			this._notificationService.error(localize('kingu.tasks.hideFailed', "Failed to hide {0}.", labelOf(provider)));
		});
	}

	/** `rounded-md border bg-muted/50 px-6 py-14 text-center`: the ADE's empty and connect states. */
	private _emptyCard(content: HTMLElement, provider: KinguTaskProvider, title: string, description: string): HTMLElement {
		const card = append(content, $('.kingu-tasks-card'));
		const icon = optionOf(provider).icon(32);
		icon.classList.add('kingu-tasks-card-icon');
		card.appendChild(icon);
		append(card, $('p.kingu-tasks-card-title')).textContent = title;
		append(card, $('p.kingu-tasks-card-description')).textContent = description;
		return card;
	}

	layout(_width: number, height: number): void {
		// Fill the view, so only the list scrolls as it does in the ADE.
		if (this._container) {
			this._container.style.height = `${height}px`;
		}
	}
}

class KinguTasksPageContribution extends Disposable {

	static readonly ID = 'kingu.contrib.tasksPage';

	constructor(
		@ICustomViewService customViewService: ICustomViewService,
	) {
		super();
		this._register(customViewService.registerCustomView({
			id: KINGU_TASKS_VIEW_ID,
			ctor: new SyncDescriptor(KinguTasksView),
		}));
	}
}

registerWorkbenchContribution2(KinguTasksPageContribution.ID, KinguTasksPageContribution, WorkbenchPhase.BlockRestore);

class ShowKinguTasksAction extends Action2 {

	constructor() {
		super({
			id: KINGU_SHOW_TASKS_COMMAND_ID,
			title: localize2('kingu.showTasks', "Kingu: Tasks"),
			category: Categories.View,
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(ICustomViewService).showCustomView(KINGU_TASKS_VIEW_ID);
	}
}

registerAction2(ShowKinguTasksAction);
