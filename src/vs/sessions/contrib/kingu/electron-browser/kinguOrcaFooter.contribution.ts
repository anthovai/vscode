/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/kinguOrcaFooter.css';
import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { timeout } from '../../../../base/common/async.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/path.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { TerminalCommandId } from '../../../../workbench/contrib/terminal/common/terminal.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../../workbench/services/statusbar/browser/statusbar.js';
import { IKinguHostService } from '../../../../platform/kinguHost/common/kinguHostService.js';
import { IKinguListeningPort, IKinguPortScan, IKinguProcessUsage } from '../../../../platform/kinguHost/common/kinguHostPorts.js';
import { IKinguAdvertisedUrlService } from '../browser/kinguAdvertisedUrlService.js';
import { isLocalhostEquivalent } from '../common/kinguAdvertisedUrls.js';
import { KINGU_SHOW_USAGE_COMMAND_ID } from '../browser/kinguUsagePage.contribution.js';
import { IKinguOrcaService } from '../common/kinguOrca.js';
import { formatFooterWindow, formatOrcaMemory, IOrcaFooterWindow, IOrcaProviderRateLimits, isProviderShown, normalizeOrcaAwakeMode, ORCA_FOOTER_PROVIDERS, OrcaAwakeMode, OrcaRateLimitState, providerFooterWindows, tightestFooterWindow } from '../common/kinguOrcaFooter.js';
import { orcaSettingIdForKey } from '../common/kinguOrcaSettings.js';
import { KINGU_PROVIDER_LOGOS } from '../common/kinguProviderLogos.js';
import { displayedUsagePercent, KinguUsageDisplay, nextResetTickDelay } from '../common/kinguStatusBar.js';
import { OrcaUsageMode } from '../common/kinguOrcaUsage.js';
import { OrcaUsagePanel } from './kinguOrcaUsagePanel.js';
import { KINGU_OPEN_ORCA_SETTINGS_COMMAND_ID } from '../common/kinguOrcaSettingsCommands.js';
import { attachFooterTooltip, FooterChip, FooterPopover, iconButton, lucideIcon, menuItem, menuLabel, menuRadioItem, menuSeparator, wireMenuKeyboard } from './kinguOrcaFooterParts.js';
import { FLOATING_ENABLED_SETTING_ID, FLOATING_LOCATION_SETTING_ID, KINGU_TOGGLE_FLOATING_WORKSPACE_COMMAND_ID, showFloatingWorkspaceMenu } from './kinguFloatingWorkspace.contribution.js';
import './kinguOrcaService.js';

/**
 * How often the memory reading is retaken while the Resource Manager is closed.
 *
 * Slow on purpose. On Windows the ADE's snapshot enumerates processes through
 * PowerShell, then typeperf, and either can take seconds; the ADE itself only
 * polls while its resource panel is open and leaves the closed badge on the
 * last reading. A minute keeps the badge honest without a shell every few
 * seconds.
 */
const RESOURCE_INTERVAL_MS = 60_000;
/** While the Resource Manager is open it is read as the ADE reads it, every few seconds. */
const RESOURCE_OPEN_INTERVAL_MS = 2_000;
/** Remote hosts change by user action, so a slow poll is enough to catch the rest. */
const SSH_INTERVAL_MS = 30_000;
/** The ADE's background port poll. */
const PORTS_INTERVAL_MS = 30_000;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The ADE's keep-awake mode, as the setting the Settings editor shows. */
const AWAKE_SETTING_ID = orcaSettingIdForKey('computerAwakeMode') ?? 'kingu.agents.computerAwakeMode';

/** Icons for the providers whose logo is not carried; codicons for the rest. */
const FALLBACK_PROVIDER_ICONS: Readonly<Record<string, ThemeIcon>> = {
	gemini: Codicon.sparkle,
	antigravity: Codicon.rocket,
	opencodeGo: Codicon.code,
	kimi: Codicon.circleFilled,
	minimax: Codicon.pulse,
	grok: Codicon.zap,
};

function providerIcon(slot: string): HTMLElement {
	const logo = KINGU_PROVIDER_LOGOS[slot];
	if (!logo) {
		return $(`span.kingu-orca-provider-icon${ThemeIcon.asCSSSelector(FALLBACK_PROVIDER_ICONS[slot] ?? Codicon.circleLargeOutline)}`);
	}
	const holder = $('span.kingu-orca-provider-icon.logo');
	const svg = mainWindow.document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', logo.viewBox);
	svg.setAttribute('width', '13');
	svg.setAttribute('height', '13');
	const path = mainWindow.document.createElementNS(SVG_NS, 'path');
	path.setAttribute('d', logo.path);
	path.setAttribute('fill', logo.fill ?? 'currentColor');
	if (logo.evenOdd) {
		path.setAttribute('fill-rule', 'evenodd');
	}
	svg.appendChild(path);
	holder.appendChild(svg);
	return holder;
}

/**
 * One agent inside the usage pill, `ProviderSegment` in the ADE, state for
 * state: `···` pulsing while it first loads, `--` when the CLI is missing, a
 * warning and a word when it failed with nothing to show, otherwise the mark,
 * the bar from the tightest window and every window's reading.
 */
function renderProviderSegment(slot: string, provider: IOrcaProviderRateLimits, windows: readonly IOrcaFooterWindow[], mode: OrcaUsageMode, display: KinguUsageDisplay): HTMLElement {
	const tightest = tightestFooterWindow(windows);
	if (provider.status === 'idle' || (provider.status === 'fetching' && !tightest)) {
		const segment = $('span.kingu-orca-segment.quiet');
		segment.appendChild(providerIcon(slot));
		append(segment, $('span.kingu-orca-pulse')).textContent = '···';
		return segment;
	}
	if (provider.status === 'unavailable') {
		const segment = $('span.kingu-orca-segment.unavailable');
		segment.appendChild(providerIcon(slot));
		append(segment, $('span')).textContent = '--';
		return segment;
	}
	if (provider.status === 'error' && !tightest) {
		const segment = $('span.kingu-orca-segment.quiet');
		segment.appendChild(providerIcon(slot));
		segment.appendChild(lucideIcon('triangle-alert', 11, 'kingu-orca-muted'));
		append(segment, $('span.kingu-orca-text-11.kingu-orca-medium')).textContent = localize('kingu.footer.usage.error', "Error");
		return segment;
	}
	const segment = $('span.kingu-orca-segment');
	segment.appendChild(providerIcon(slot));
	if (mode === 'compact') {
		// Compact: the tightest window alone, its countdown after it, no bar.
		if (tightest) {
			append(segment, $('span.kingu-orca-tabular')).textContent = formatFooterWindow(tightest, display);
		}
	} else {
		if (tightest) {
			const bar = append(segment, $('span.kingu-orca-bar'));
			append(bar, $('span.kingu-orca-bar-fill')).style.width = `${displayedUsagePercent(Math.min(100, Math.max(0, tightest.usedPercent)), display)}%`;
		}
		windows.forEach((window, index) => {
			if (index > 0) {
				append(segment, $('span.kingu-orca-muted')).textContent = '·';
			}
			append(segment, $('span.kingu-orca-tabular')).textContent = formatFooterWindow(window, display);
		});
	}
	if (provider.status === 'error') {
		segment.appendChild(lucideIcon('triangle-alert', 11, 'kingu-orca-muted'));
	}
	return segment;
}

/** `UpdateStatus` in the ADE, as far as the footer reads it. */
interface IOrcaUpdateStatus {
	readonly state: string;
	readonly version?: string;
	readonly percent?: number;
}

/** `ComputerAwakeStatus` in the ADE. */
interface IOrcaAwakeStatus {
	readonly mode: OrcaAwakeMode;
	readonly active: boolean;
}

/** `UsageValues` in the ADE. */
interface IOrcaUsageValues {
	readonly cpu: number;
	readonly memory: number;
	readonly privateMemory?: number;
}

/** `MemorySnapshot` in the ADE, as far as the footer reads it. */
interface IOrcaMemorySnapshot {
	readonly app: IOrcaUsageValues & { readonly main: IOrcaUsageValues; readonly renderer: IOrcaUsageValues; readonly other: IOrcaUsageValues; readonly history: readonly number[] };
	readonly worktrees: readonly (IOrcaUsageValues & {
		readonly worktreeId: string;
		readonly worktreeName: string;
		readonly repoId: string;
		readonly repoName: string;
		readonly sessions: readonly (IOrcaUsageValues & { readonly sessionId: string; readonly pid: number })[];
		readonly history: readonly number[];
	})[];
	readonly host: { readonly usedMemory: number; readonly totalMemory: number };
	readonly processMemoryMetric: 'rss' | 'working-set';
	readonly processCommitMetric?: 'private-bytes';
	readonly totalCpu: number;
	readonly totalMemory: number;
	readonly totalPrivateMemory?: number;
}

/** `SshTarget` in the ADE, as far as the footer reads it. */
interface IOrcaSshTarget {
	readonly id: string;
	readonly label?: string;
	readonly host?: string;
}

type ResourceSort = 'memory' | 'cpu' | 'name';

/** A row of the Resource Manager's tree: a workspace and what runs in it. */
interface IResourceWorktree {
	readonly id: string;
	readonly name: string;
	readonly repoName: string;
	readonly cpu: number | null;
	readonly memory: number | null;
	readonly history: readonly number[];
	readonly sessions: readonly { readonly id: string; readonly label: string; readonly cpu: number | null; readonly memory: number | null; readonly bound: boolean; readonly terminal?: ITerminalInstance }[];
}

/**
 * The Agents Window's footer, and it is the ADE's.
 *
 * Ported from `kingu-orca/renderer/src/components/status-bar/`, component for
 * component: the usage pill (`StatusBarSurface`), refresh, keep awake
 * (`CaffeinateStatusSegment`), updates, the Resource Manager
 * (`ResourceUsageStatusSegment`), ports (`PortsStatusSegment`), remote hosts
 * (`SshStatusSegment`) and the floating-workspace button. As there, hovering a
 * segment shows its label and only a click opens what it opens.
 *
 * The numbers come from the ADE's own engine through the handlers its
 * renderer calls: `rateLimits:*`, `agentAwake:*`, `memory:getSnapshot`,
 * `updater:*`, `ssh:*`. The terminals and ports are this window's, because
 * this window runs them; the ADE's own workbench is not on screen.
 */
class KinguOrcaFooterContribution extends Disposable {

	static readonly ID = 'kingu.contrib.orcaFooter';

	private readonly _usage = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly _refresh = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly _awake = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly _update = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly _resources = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly _ports = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly _ssh = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly _panel = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly _resetTick = this._register(new MutableDisposable());
	private readonly _resourcePoll = this._register(new MutableDisposable());

	private _rateLimits: OrcaRateLimitState | undefined;
	private _refreshing = false;
	private _awakeStatus: IOrcaAwakeStatus = { mode: 'off', active: false };
	private _memory: IOrcaMemorySnapshot | undefined;
	/** Each of this window's terminals, measured with everything it started. */
	private _terminalUsage = new Map<number, IKinguProcessUsage>();
	private _portScan: IKinguPortScan = { workspace: [], external: [] };
	private _scanningPorts = false;
	private _sshTargets: readonly IOrcaSshTarget[] = [];
	private _updateStatus: IOrcaUpdateStatus | undefined;

	/** The ADE's UI state: Detailed or Compact, and whether percentages count what is used or what is left. */
	private _usageMode: OrcaUsageMode = 'verbose';
	private _usageDisplay: KinguUsageDisplay = 'used';
	private _resourceSort: ResourceSort = 'memory';
	private _appCollapsed = true;
	private readonly _collapsedWorktrees = new Set<string>();
	private _externalOpen = false;

	private readonly _usageChip = this._register(new FooterChip('usage', () => this._usagePopover.toggle()));
	private readonly _refreshChip = this._register(new FooterChip('refresh', () => void this._refreshUsage()));
	private readonly _awakeChip = this._register(new FooterChip('awake', () => this._awakePopover.toggle()));
	private readonly _updateChip = this._register(new FooterChip('update', () => this._runUpdate()));
	private readonly _resourceChip = this._register(new FooterChip('resources', () => this._resourcePopover.toggle()));
	private readonly _portsChip = this._register(new FooterChip('ports', () => this._portsPopover.toggle()));
	private readonly _sshChip = this._register(new FooterChip('ssh', () => this._sshPopover.toggle()));
	private readonly _panelChip = this._register(new FooterChip('boxed', () => void this._commandService.executeCommand(KINGU_TOGGLE_FLOATING_WORKSPACE_COMMAND_ID)));

	private readonly _usagePanel = new OrcaUsagePanel({
		state: () => this._rateLimits,
		mode: () => this._usageMode,
		display: () => this._usageDisplay,
		refreshing: () => this._refreshing || this._anyFetching(),
		providerIcon: slot => providerIcon(slot),
		setMode: mode => void this._setUsageMode(mode),
		refresh: () => this._refreshUsage(),
		openUsageDetails: () => void this._commandService.executeCommand(KINGU_SHOW_USAGE_COMMAND_ID),
		openAccounts: sectionId => void this._commandService.executeCommand(KINGU_OPEN_ORCA_SETTINGS_COMMAND_ID, { pane: 'accounts', sectionId }),
		invoke: (channel, ...args) => this._orca.invoke(channel, ...args),
		confirm: async (message, detail, primaryButton) => (await this._dialogService.confirm({ type: 'warning', message, detail, primaryButton })).confirmed,
		notify: message => this._notificationService.error(message),
	});
	private readonly _usagePopover = this._register(new FooterPopover(this._usageChip.element, (close, store) => this._usagePanel.render(close, store), {
		surface: 'menu', align: 'start', width: '360px', flush: true,
		contains: node => this._usagePanel.contains(node),
		onClose: () => this._usagePanel.closeSubmenu(),
	}));
	private readonly _awakePopover = this._register(new FooterPopover(this._awakeChip.element, close => this._awakeMenu(close), { surface: 'menu', align: 'end', width: '256px' }));
	private readonly _resourcePopover = this._register(new FooterPopover(this._resourceChip.element, (close, store) => this._resourceManager(close, store), {
		surface: 'popover', align: 'end', width: '26rem',
		onOpen: () => this._onResourceManagerOpened(),
	}));
	private readonly _portsPopover = this._register(new FooterPopover(this._portsChip.element, (close, store) => this._portsPanel(close, store), {
		surface: 'popover', align: 'end', width: '24rem',
		onOpen: () => void this._readPorts(true),
	}));
	private readonly _sshPopover = this._register(new FooterPopover(this._sshChip.element, close => this._sshMenu(close), {
		surface: 'menu', align: 'start', width: 'min(20rem, calc(100vw - 1rem))',
		onOpen: () => void this._readSsh(),
	}));

	constructor(
		@IKinguOrcaService private readonly _orca: IKinguOrcaService,
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IKinguHostService private readonly _hostService: IKinguHostService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IKinguAdvertisedUrlService private readonly _advertisedUrls: IKinguAdvertisedUrlService,
		@ICommandService private readonly _commandService: ICommandService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IDialogService private readonly _dialogService: IDialogService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IStorageService private readonly _storageService: IStorageService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@IContextMenuService private readonly _contextMenuService: IContextMenuService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		// Only the refresh, keep-awake, resource and port triggers carry a label in
		// the ADE; its usage pill and remote-hosts trigger have none.
		this._register(attachFooterTooltip(this._refreshChip.element, () => [localize('kingu.footer.refresh.tooltip', "Refresh usage data")]));
		this._register(attachFooterTooltip(this._awakeChip.element, () => [this._awakeAriaLabel()], 400, () => this._awakePopover.isOpen));
		this._register(attachFooterTooltip(this._updateChip.element, () => [this._updateTooltip()]));
		this._register(attachFooterTooltip(this._resourceChip.element, () => this._resourceTooltipLines(), 150, () => this._resourcePopover.isOpen));
		this._register(attachFooterTooltip(this._portsChip.element, () => [this._portsTooltip()], 150, () => this._portsPopover.isOpen));
		this._register(attachFooterTooltip(this._panelChip.element, () => {
			const shortcut = this._keybindingService.lookupKeybinding(KINGU_TOGGLE_FLOATING_WORKSPACE_COMMAND_ID)?.getLabel();
			return [shortcut ? `${this._floatingLabel()} (${shortcut})` : this._floatingLabel()];
		}));
		this._register(addDisposableListener(this._panelChip.element, EventType.CONTEXT_MENU, (event: MouseEvent) => {
			event.preventDefault();
			event.stopPropagation();
			showFloatingWorkspaceMenu(this._contextMenuService, this._configurationService, event, 'status-bar');
		}));
		this._register(this._layoutService.onDidChangePartVisibility(() => this._renderPanelToggle()));

		this._register(this._orca.onPush('rateLimits:update')(([state]) => this._renderUsage(state as OrcaRateLimitState)));
		this._register(this._orca.onPush('agentAwake:changed')(([status]) => {
			this._awakeStatus = status as IOrcaAwakeStatus;
			this._renderAwake();
		}));
		// Keep awake is a setting like any other here: the footer reads it from, and
		// writes it to, the same place the Settings editor does, so the two cannot
		// disagree about which mode is chosen.
		this._register(this._configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AWAKE_SETTING_ID)) {
				this._renderAwake();
			}
			if (event.affectsConfiguration(FLOATING_ENABLED_SETTING_ID) || event.affectsConfiguration(FLOATING_LOCATION_SETTING_ID)) {
				this._renderPanelToggle();
			}
		}));
		this._register(this._orca.onPush('updater:status')(([status]) => this._renderUpdate(status as IOrcaUpdateStatus)));
		this._register(this._terminalService.onDidChangeInstances(() => this._renderResources()));

		this._register(this._interval(() => void this._readResources(), RESOURCE_INTERVAL_MS));
		this._register(this._interval(() => void this._readSsh(), SSH_INTERVAL_MS));
		this._register(this._interval(() => void this._readPorts(false), PORTS_INTERVAL_MS));

		this._hideForeignEntries();
		this._renderAwake();
		this._renderResources();
		this._renderPorts();
		this._renderPanelToggle();
		void this._start();
	}

	private _interval(run: () => void, ms: number) {
		const handle = mainWindow.setInterval(run, ms);
		return toDisposable(() => mainWindow.clearInterval(handle));
	}

	private async _start(): Promise<void> {
		await Promise.all([
			this._read('rateLimits:get', state => this._renderUsage(state as OrcaRateLimitState)),
			this._readUsageUiState(),
			this._read('agentAwake:getStatus', status => {
				this._awakeStatus = status as IOrcaAwakeStatus;
				this._renderAwake();
			}),
			this._read('updater:getStatus', status => this._renderUpdate(status as IOrcaUpdateStatus)),
			this._readResources(),
			this._readPorts(false),
			this._readSsh(),
		]);
	}

	/** One ADE call, logged rather than thrown: a segment that cannot read stays as it was. */
	private async _read(channel: string, apply: (value: unknown) => void): Promise<void> {
		try {
			const value = await this._orca.invoke<unknown>(channel);
			if (!this._store.isDisposed) {
				apply(value);
			}
		} catch (error) {
			this._logService.warn(`[kingu-footer] ${channel} failed`, error);
		}
	}

	private _place(accessor: MutableDisposable<IStatusbarEntryAccessor>, entry: IStatusbarEntry, id: string, alignment: StatusbarAlignment, priority: number): void {
		if (accessor.value) {
			accessor.value.update(entry);
		} else {
			accessor.value = this._statusbarService.addEntry(entry, id, alignment, priority);
		}
	}

	// #region Usage

	/**
	 * The ADE's usage pill: one button holding every agent that has reported,
	 * 12px apart, opening the all-agents usage panel on click.
	 */
	private _renderUsage(state: OrcaRateLimitState | undefined): void {
		this._rateLimits = state;
		const now = Date.now();
		const resets: number[] = [];
		const segments: HTMLElement[] = [];
		const labels: string[] = [];
		let anyFetching = false;
		for (const { slot, name } of ORCA_FOOTER_PROVIDERS) {
			const provider = state?.[slot];
			if (!isProviderShown(provider)) {
				continue;
			}
			anyFetching ||= provider.status === 'fetching';
			const windows = providerFooterWindows(provider, now);
			for (const window of windows) {
				if (window.resetsAt !== null) {
					resets.push(window.resetsAt);
				}
			}
			segments.push(renderProviderSegment(slot, provider, windows, this._usageMode, this._usageDisplay));
			labels.push(localize('kingu.footer.usage.providerAria', "{0}: {1}", name, windows.map(window => formatFooterWindow(window, this._usageDisplay)).join(', ') || '—'));
		}

		if (segments.length === 0) {
			this._usage.clear();
			this._refresh.clear();
			this._usagePopover.close();
		} else {
			this._usageChip.set(segments.map(element => ({ kind: 'element', element })), localize('kingu.footer.usage.aria', "Usage, {0}", labels.join('; ')));
			this._place(this._usage, {
				name: localize('kingu.footer.usage.name', "Usage"),
				text: '',
				content: this._usageChip.element,
				ariaLabel: localize('kingu.footer.usage.aria', "Usage, {0}", labels.join('; ')),
			}, 'kingu.footer.usage', StatusbarAlignment.LEFT, 110);

			const spinning = this._refreshing || anyFetching;
			this._refreshChip.set([{ kind: 'icon', name: 'refresh-cw', size: 11, className: spinning ? 'spin' : undefined }], localize('kingu.footer.refresh.aria', "Refresh rate limits"));
			this._refreshChip.element.disabled = this._refreshing;
			this._place(this._refresh, {
				name: localize('kingu.footer.refresh.name', "Refresh Usage"),
				text: '',
				content: this._refreshChip.element,
				ariaLabel: localize('kingu.footer.refresh.aria', "Refresh rate limits"),
			}, 'kingu.footer.refresh', StatusbarAlignment.LEFT, 109);
		}
		this._usagePopover.refresh();
		this._usagePanel.refreshSubmenu();
		this._scheduleTick(resets);
	}

	private _anyFetching(): boolean {
		return ORCA_FOOTER_PROVIDERS.some(({ slot }) => {
			const provider = this._rateLimits?.[slot];
			return !!provider && typeof provider === 'object' && provider.status === 'fetching';
		});
	}

	/** Reads the ADE's usage mode and percentage display, as its footer hydrates them from `ui:get`. */
	private async _readUsageUiState(): Promise<void> {
		await this._read('ui:get', value => {
			const ui = value as { readonly statusBarUsageMode?: unknown; readonly usagePercentageDisplay?: unknown } | undefined;
			this._usageMode = ui?.statusBarUsageMode === 'compact' ? 'compact' : 'verbose';
			this._usageDisplay = ui?.usagePercentageDisplay === 'remaining' ? 'remaining' : 'used';
			this._renderUsage(this._rateLimits);
		});
	}

	/** `setStatusBarUsageMode`: persisted in the ADE's UI state, and the pill redrawn in the new mode. */
	private async _setUsageMode(mode: OrcaUsageMode): Promise<void> {
		this._usageMode = mode;
		this._renderUsage(this._rateLimits);
		try {
			await this._orca.invoke('ui:set', { statusBarUsageMode: mode });
		} catch (error) {
			this._logService.warn('[kingu-footer] could not save the usage mode', error);
		}
	}

	private async _refreshUsage(): Promise<void> {
		if (this._refreshing) {
			return;
		}
		this._refreshing = true;
		this._renderUsage(this._rateLimits);
		try {
			const state = await this._orca.invoke<OrcaRateLimitState>('rateLimits:refresh');
			this._refreshing = false;
			this._renderUsage(state ?? this._rateLimits);
		} catch (error) {
			this._refreshing = false;
			this._renderUsage(this._rateLimits);
			this._logService.warn('[kingu-footer] refresh failed', error);
		}
	}

	/**
	 * Moves the countdowns on, once a minute and only then.
	 *
	 * The labels are floored to the minute, so this wakes just past the next
	 * boundary rather than ticking a second at a time to redraw the same text.
	 */
	private _scheduleTick(resets: readonly number[]): void {
		this._resetTick.clear();
		const delay = nextResetTickDelay(Date.now(), resets);
		if (delay === undefined) {
			return;
		}
		const timer = mainWindow.setTimeout(() => this._renderUsage(this._rateLimits), delay);
		this._resetTick.value = toDisposable(() => mainWindow.clearTimeout(timer));
	}

	// #endregion

	// #region Keep awake

	/** The mode in force, the ADE's way: the configured one wins until the service agrees. */
	private _awakeState(): { readonly mode: OrcaAwakeMode; readonly active: boolean; readonly status: string } {
		const configured = normalizeOrcaAwakeMode(this._configurationService.getValue(AWAKE_SETTING_ID));
		const agrees = this._awakeStatus.mode === configured;
		const active = agrees ? this._awakeStatus.active : configured === 'on';
		const activity = active ? localize('kingu.footer.awake.active', "Active") : localize('kingu.footer.awake.inactive', "Inactive");
		return { mode: configured, active, status: localize('kingu.footer.awake.status', "{0} · {1}", awakeModeLabel(configured), activity) };
	}

	private _awakeAriaLabel(): string {
		return localize('kingu.footer.awake.aria', "{0}, {1}", awakeTitle(), this._awakeState().status);
	}

	/** A coffee cup, the mode, and a dot that fills while the machine is actually kept awake. */
	private _renderAwake(): void {
		const { mode, active } = this._awakeState();
		this._awakeChip.set([
			{ kind: 'icon', name: 'coffee' },
			{ kind: 'text', text: awakeModeLabel(mode), className: 'kingu-orca-text-11 kingu-orca-medium' },
			{ kind: 'dot', className: active ? 'active' : '' },
		], this._awakeAriaLabel());
		this._awakeChip.element.classList.toggle('active', active);
		this._place(this._awake, {
			name: localize('kingu.footer.awake.name', "Keep Computer Awake"),
			text: '',
			content: this._awakeChip.element,
			ariaLabel: this._awakeAriaLabel(),
		}, 'kingu.footer.awake', StatusbarAlignment.RIGHT, 100);
		this._awakePopover.refresh();
	}

	/** `DropdownMenuContent w-64`: the title and status, a separator, the three modes as radio items. */
	private _awakeMenu(close: () => void): HTMLElement {
		const { mode, status } = this._awakeState();
		const menu = $('div');
		menuLabel(menu, awakeTitle(), status);
		menuSeparator(menu);
		const choose = (next: OrcaAwakeMode) => () => {
			close();
			void this._setAwakeMode(next);
		};
		menuRadioItem(menu, awakeModeLabel('on'), localize('kingu.footer.awake.onDescription', "Keep this computer awake continuously"), mode === 'on', choose('on'));
		menuRadioItem(menu, awakeModeLabel('auto'), localize('kingu.footer.awake.autoDescription', "Stay awake while an agent is working"), mode === 'auto', choose('auto'));
		menuRadioItem(menu, awakeModeLabel('off'), localize('kingu.footer.awake.offDescription', "Allow normal system sleep behavior"), mode === 'off', choose('off'));
		wireMenuKeyboard(menu);
		return menu;
	}

	private async _setAwakeMode(mode: OrcaAwakeMode): Promise<void> {
		try {
			await this._configurationService.updateValue(AWAKE_SETTING_ID, mode, ConfigurationTarget.USER);
		} catch (error) {
			this._logService.error('[kingu-footer] could not set keep awake', error);
		}
	}

	// #endregion

	// #region Update

	/** Shown only while there is something to act on, as in the ADE. */
	private _renderUpdate(status: IOrcaUpdateStatus | undefined): void {
		this._updateStatus = status;
		const version = status?.version ?? '';
		if (status?.state === 'available') {
			this._updateChip.set([{ kind: 'icon', name: 'download', className: 'kingu-orca-muted' }, { kind: 'text', text: localize('kingu.footer.update.available', "Update {0}", version), className: 'kingu-orca-text-11 kingu-orca-tabular' }], this._updateTooltip());
		} else if (status?.state === 'downloading') {
			this._updateChip.set([{ kind: 'icon', name: 'download', className: 'kingu-orca-muted' }, { kind: 'text', text: `${Math.max(0, Math.min(100, Math.round(status.percent ?? 0)))}%`, className: 'kingu-orca-text-11 kingu-orca-tabular' }], this._updateTooltip());
		} else if (status?.state === 'downloaded') {
			this._updateChip.set([{ kind: 'icon', name: 'circle-check', className: 'kingu-orca-emerald' }, { kind: 'text', text: localize('kingu.footer.update.ready', "Update ready"), className: 'kingu-orca-text-11 kingu-orca-tabular' }], this._updateTooltip());
		} else if (status?.state === 'error') {
			this._updateChip.set([{ kind: 'icon', name: 'circle-alert', className: 'kingu-orca-yellow' }, { kind: 'text', text: localize('kingu.footer.update.failed', "Update failed"), className: 'kingu-orca-text-11 kingu-orca-tabular' }], this._updateTooltip());
		} else {
			this._update.clear();
			return;
		}
		this._place(this._update, {
			name: localize('kingu.footer.update.name', "Kingu Update"),
			text: '',
			content: this._updateChip.element,
			ariaLabel: this._updateTooltip(),
		}, 'kingu.footer.update', StatusbarAlignment.RIGHT, 99);
	}

	private _updateTooltip(): string {
		const status = this._updateStatus;
		const version = status?.version ?? '';
		switch (status?.state) {
			case 'available': return localize('kingu.footer.update.availableTooltip', "Kingu v{0} is available. Click to download.", version);
			case 'downloading': return localize('kingu.footer.update.downloadingTooltip', "Kingu v{0} downloading… {1}%", version, Math.round(status.percent ?? 0));
			case 'downloaded': return localize('kingu.footer.update.readyTooltip', "Kingu v{0} ready to install", version);
			case 'error': return localize('kingu.footer.update.failedTooltip', "Update failed — click to see details");
			default: return '';
		}
	}

	private _runUpdate(): void {
		const state = this._updateStatus?.state;
		if (state === 'available') {
			void this._orca.invoke('updater:download');
		} else if (state === 'downloaded') {
			void this._orca.invoke('updater:quitAndInstall');
		}
	}

	// #endregion

	// #region Resource Manager

	private async _readResources(): Promise<void> {
		await Promise.all([
			this._read('memory:getSnapshot', snapshot => {
				this._memory = snapshot as IOrcaMemorySnapshot | undefined;
			}),
			this._measureTerminals(),
		]);
		if (!this._store.isDisposed) {
			this._renderResources();
		}
	}

	/** The window's terminals are not the ADE daemon's, so they are measured here, each shell with its tree. */
	private async _measureTerminals(): Promise<void> {
		const pids = this._terminalService.instances.map(instance => instance.processId).filter((pid): pid is number => typeof pid === 'number');
		const usage = await this._hostService.measureProcesses(pids);
		this._terminalUsage = new Map(usage.map(entry => [entry.pid, entry]));
		this._resourceSampleId++;
	}

	private _onResourceManagerOpened(): void {
		void this._readResources();
		const handle = mainWindow.setInterval(() => {
			if (!this._resourcePopover.isOpen) {
				this._resourcePoll.clear();
				return;
			}
			void this._readResources();
		}, RESOURCE_OPEN_INTERVAL_MS);
		this._resourcePoll.value = toDisposable(() => mainWindow.clearInterval(handle));
	}

	/** The ADE's `Σ WS` or `Σ RSS`, by the metric the snapshot was taken in. */
	private _memoryMetric(): { readonly column: string; readonly summary: string; readonly description: string } {
		return this._memory?.processMemoryMetric === 'working-set'
			? { column: 'WS', summary: 'Σ WS', description: localize('kingu.footer.resources.wsDescription', "Summed working set (WS): pages resident in RAM right now. Shared pages can appear in more than one process, and memory Windows has paged out is not counted here.") }
			: { column: 'RSS', summary: 'Σ RSS', description: localize('kingu.footer.resources.rssDescription', "Summed resident set size (RSS). Shared or aliased pages can appear in more than one process.") };
	}

	private _sessionCountLabel(count: number): string {
		return count === 1
			? localize('kingu.footer.resources.sessionOne', "{0} terminal session", count)
			: localize('kingu.footer.resources.sessionMany', "{0} terminal sessions", count);
	}

	/** `getResourceManagerTooltipLines`: the summary, then the hint. */
	private _resourceTooltipLines(): string[] {
		const snapshot = this._memory;
		const count = this._terminalService.instances.length;
		let memory = localize('kingu.footer.resources.memoryUnavailable', "memory unavailable");
		if (snapshot) {
			memory = `${formatOrcaMemory(snapshot.totalMemory)} · ${this._memoryMetric().summary}`;
			if (snapshot.processCommitMetric && snapshot.totalPrivateMemory !== undefined) {
				memory = `${memory} · ${formatOrcaMemory(snapshot.totalPrivateMemory)} Σ Private`;
			}
		}
		return [
			localize('kingu.footer.resources.tooltipSummary', "Resource Manager - {0} - {1}", memory, this._sessionCountLabel(count)),
			count > 0
				? localize('kingu.footer.resources.grouped', "Terminal sessions are grouped by workspace.")
				: localize('kingu.footer.resources.noSessions', "No terminal sessions yet."),
		];
	}

	/** `renderResourceUsageStatusTrigger`: memory, a middot, terminals. */
	private _renderResources(): void {
		const snapshot = this._memory;
		const memory = snapshot ? formatOrcaMemory(snapshot.totalMemory) : '—';
		const count = this._terminalService.instances.length;
		const aria = localize('kingu.footer.resources.aria', "Resource Manager, {0}", this._sessionCountLabel(count));
		this._resourceChip.set([
			{ kind: 'icon', name: 'memory-stick', className: 'kingu-orca-muted' },
			{ kind: 'text', text: memory, className: `kingu-orca-text-11 kingu-orca-medium kingu-orca-tabular ${this._commitToneClass() ?? 'kingu-orca-muted'}` },
			{ kind: 'separator' },
			{ kind: 'icon', name: 'terminal', className: 'kingu-orca-muted' },
			{ kind: 'text', text: String(count), className: 'kingu-orca-text-11 kingu-orca-tabular kingu-orca-muted' },
		], aria);
		this._place(this._resources, {
			name: localize('kingu.footer.resources.title', "Resource Manager"),
			text: '',
			content: this._resourceChip.element,
			ariaLabel: aria,
		}, 'kingu.footer.resources', StatusbarAlignment.RIGHT, 98);
		this._resourcePopover.refresh();
	}

	/** `getCommitPressureToneClass`: a warning tint once committed memory is large against RAM, on the 60/80 bands. */
	private _commitToneClass(): string | undefined {
		const snapshot = this._memory;
		if (!snapshot || typeof snapshot.totalPrivateMemory !== 'number' || !(snapshot.host?.totalMemory > 0)) {
			return undefined;
		}
		const percent = snapshot.totalPrivateMemory / snapshot.host.totalMemory * 100;
		return percent >= 80 ? 'kingu-orca-destructive' : percent >= 60 ? 'kingu-orca-yellow' : undefined;
	}

	/**
	 * The workspaces that have something running: the ADE's tracked worktrees
	 * with their measured sessions, and this window's terminals, grouped by the
	 * folder they run in. The window's terminals are not the ADE's daemon's, so
	 * it has no reading for them; they show `—`, as the ADE shows a session it
	 * cannot sample.
	 */
	private _resourceWorktrees(): IResourceWorktree[] {
		const rows: IResourceWorktree[] = [];
		for (const worktree of this._memory?.worktrees ?? []) {
			rows.push({
				id: `orca:${worktree.worktreeId}`,
				name: worktree.worktreeName,
				repoName: worktree.repoName,
				cpu: worktree.cpu,
				memory: worktree.memory,
				history: worktree.history,
				sessions: worktree.sessions.map(session => ({ id: session.sessionId, label: `PID ${session.pid}`, cpu: session.cpu, memory: session.memory, bound: true })),
			});
		}
		const byFolder = new Map<string, ITerminalInstance[]>();
		for (const instance of this._terminalService.instances) {
			const folder = instance.cwd || instance.initialCwd || instance.workspaceFolder?.uri.fsPath || '';
			byFolder.set(folder, [...(byFolder.get(folder) ?? []), instance]);
		}
		const workspaceName = this._workspaceService.getWorkspace().folders[0]?.name ?? localize('kingu.footer.resources.workspace', "Workspace");
		for (const [folder, instances] of byFolder) {
			const sessions = instances.map(instance => {
				const usage = instance.processId === undefined ? undefined : this._terminalUsage.get(instance.processId);
				return { id: String(instance.instanceId), label: instance.title || localize('kingu.footer.resources.terminal', "Terminal"), cpu: usage?.cpu ?? null, memory: usage?.memory ?? null, bound: true, terminal: instance };
			});
			rows.push({
				id: `terminal:${folder}`,
				name: folder ? basename(folder) || folder : workspaceName,
				repoName: workspaceName,
				cpu: sumMetric(sessions.map(session => session.cpu)),
				memory: sumMetric(sessions.map(session => session.memory)),
				history: this._worktreeHistory(`terminal:${folder}`, sumMetric(sessions.map(session => session.memory))),
				sessions,
			});
		}
		const compare = (a: number | null, b: number | null) => a === null && b === null ? 0 : a === null ? 1 : b === null ? -1 : b - a;
		switch (this._resourceSort) {
			case 'memory': return rows.sort((a, b) => compare(a.memory, b.memory));
			case 'cpu': return rows.sort((a, b) => compare(a.cpu, b.cpu));
			default: return rows.sort((a, b) => a.name.localeCompare(b.name));
		}
	}

	/** Oldest-first memory samples for a workspace row, as the ADE keeps for its sparkline. */
	private readonly _histories = new Map<string, number[]>();

	private _worktreeHistory(id: string, memory: number | null): readonly number[] {
		const samples = this._histories.get(id) ?? [];
		if (memory !== null && this._historySampledAt.get(id) !== this._resourceSampleId) {
			samples.push(memory);
			if (samples.length > 60) {
				samples.shift();
			}
			this._historySampledAt.set(id, this._resourceSampleId);
		}
		this._histories.set(id, samples);
		return samples;
	}

	private readonly _historySampledAt = new Map<string, number>();
	private _resourceSampleId = 0;

	/** `ResourceUsageStatusSegment`'s popover: header, summary, the sorted tree, the app's own row. */
	private _resourceManager(close: () => void, store: DisposableStore): HTMLElement {
		const snapshot = this._memory;
		const metric = this._memoryMetric();
		const root = $('div');

		// Header: the title, then restart and kill-all.
		const header = append(root, $('.kingu-orca-panel-header'));
		const title = append(header, $('.kingu-orca-panel-title'));
		title.appendChild(lucideIcon('memory-stick', 12));
		append(title, $('span')).textContent = localize('kingu.footer.resources.title', "Resource Manager");
		const actions = append(header, $('.kingu-orca-panel-actions'));
		iconButton(actions, store, 'rotate-cw', localize('kingu.footer.resources.restart', "Restart daemon"), '', () => void this._confirmRestart(close));
		iconButton(actions, store, 'trash-2', localize('kingu.footer.resources.killAll', "Kill all sessions"), 'destructive', () => void this._confirmKillAll(close));

		// Summary: CPU · memory · commit.
		if (snapshot) {
			const summary = append(root, $('.kingu-orca-resource-summary'));
			const figures = append(summary, $('.kingu-orca-resource-summary-figures'));
			const cpu = append(figures, $('span.kingu-orca-figure'));
			cpu.textContent = formatCpu(snapshot.totalCpu);
			cpu.tabIndex = 0;
			store.add(attachFooterTooltip(cpu, () => [localize('kingu.footer.resources.cpuDescription', "Combined CPU load. Values above 100% mean more than one core is working at once.")], 200));
			append(figures, $('span.kingu-orca-muted-50')).textContent = '·';
			const memory = append(figures, $('span.kingu-orca-figure'));
			memory.tabIndex = 0;
			memory.append(`${formatOrcaMemory(snapshot.totalMemory)} `);
			append(memory, $('span.unit')).textContent = metric.summary;
			store.add(attachFooterTooltip(memory, () => [metric.description], 200));
			if (snapshot.processCommitMetric && snapshot.totalPrivateMemory !== undefined) {
				append(figures, $('span.kingu-orca-muted-50')).textContent = '·';
				const commit = append(figures, $('span.kingu-orca-figure'));
				commit.tabIndex = 0;
				const tone = this._commitToneClass();
				if (tone) {
					commit.classList.add(tone);
				}
				commit.append(`${formatOrcaMemory(snapshot.totalPrivateMemory)} `);
				append(commit, $('span.unit')).textContent = 'Σ Private';
				store.add(attachFooterTooltip(commit, () => [localize('kingu.footer.resources.privateDescription', "Summed private bytes: memory these processes have committed, counted whether it is resident or paged out. This is what the host charges against its commit limit, so it keeps rising while the working set above shrinks under paging.")], 200));
			}
		}

		// Body: the sort header and the tree, in a fixed 420px column.
		const body = append(root, $('.kingu-orca-resource-body'));
		const worktrees = this._resourceWorktrees();
		if (worktrees.length > 0 || snapshot) {
			const sort = append(body, $('.kingu-orca-sort-header'));
			const sortButton = (parent: HTMLElement, label: string, option: ResourceSort, className?: string) => {
				const button = append(parent, $('button')) as HTMLButtonElement;
				button.type = 'button';
				if (className) {
					button.classList.add(className);
				}
				button.classList.toggle('active', this._resourceSort === option);
				button.setAttribute('aria-pressed', String(this._resourceSort === option));
				button.textContent = label;
				button.addEventListener('click', () => {
					this._resourceSort = option;
					this._resourcePopover.refresh();
				});
			};
			sortButton(sort, localize('kingu.footer.resources.name', "Name"), 'name');
			const end = append(sort, $('.kingu-orca-metrics-end'));
			const columns = append(end, $('.kingu-orca-metric-columns'));
			sortButton(columns, localize('kingu.footer.resources.cpu', "CPU"), 'cpu', 'kingu-orca-cpu-column');
			sortButton(columns, metric.column, 'memory', 'kingu-orca-mem-column');
			append(end, $('span.kingu-orca-gutter'));
		}

		const scroll = append(body, $('.kingu-orca-scroll'));
		this._resourcePopover.trackScroll(scroll);
		const repos = new Set(worktrees.map(worktree => worktree.repoName));
		if (repos.size > 1) {
			for (const repo of [...repos].sort((a, b) => a.localeCompare(b))) {
				const group = append(scroll, $('.kingu-orca-group'));
				const children = worktrees.filter(worktree => worktree.repoName === repo);
				this._groupRow(group, `repo:${repo}`, repo, sumMetric(children.map(child => child.cpu)), sumMetric(children.map(child => child.memory)), undefined);
				if (!this._collapsedWorktrees.has(`repo:${repo}`)) {
					const list = append(group, $('.kingu-orca-group-children'));
					for (const worktree of children) {
						this._worktreeRow(list, worktree, close);
					}
				}
			}
		} else {
			for (const worktree of worktrees) {
				this._worktreeRow(scroll, worktree, close);
			}
		}
		if (worktrees.length === 0 && snapshot) {
			append(scroll, $('.kingu-orca-empty')).textContent = localize('kingu.footer.resources.nothing', "Nothing running right now");
		}
		if (snapshot) {
			// The app's own row: collapsed by default, Main, Renderer and Other beneath.
			const group = append(scroll, $('.kingu-orca-group'));
			this._groupRow(group, 'app', localize('kingu.footer.resources.app', "Kingu"), snapshot.app.cpu, snapshot.app.memory, snapshot.app.history);
			if (!this._appCollapsed) {
				const list = append(group, $('.kingu-orca-group-children'));
				const subRow = (label: string, values: IOrcaUsageValues) => {
					const row = append(list, $('.kingu-orca-subrow'));
					append(row, $('span')).textContent = label;
					const end = append(row, $('.kingu-orca-metrics-end'));
					metricPair(end, values.cpu, values.memory, true);
					append(end, $('span.kingu-orca-gutter'));
				};
				subRow(localize('kingu.footer.resources.main', "Main"), snapshot.app.main);
				subRow(localize('kingu.footer.resources.renderer', "Renderer"), snapshot.app.renderer);
				if (snapshot.app.other.cpu > 0 || snapshot.app.other.memory > 0) {
					subRow(localize('kingu.footer.resources.other', "Other"), snapshot.app.other);
				}
			}
		} else {
			append(scroll, $('.kingu-orca-empty')).textContent = localize('kingu.footer.resources.loading', "Loading…");
		}
		return root;
	}

	/** A collapsible group row: the app's own, or a repository's when there are several. */
	private _groupRow(parent: HTMLElement, key: string, label: string, cpu: number | null, memory: number | null, history: readonly number[] | undefined): void {
		const collapsed = key === 'app' ? this._appCollapsed : this._collapsedWorktrees.has(key);
		const row = append(parent, $('.kingu-orca-group-row'));
		const toggle = append(row, $('button.kingu-orca-chevron')) as HTMLButtonElement;
		toggle.type = 'button';
		toggle.setAttribute('aria-expanded', String(!collapsed));
		toggle.setAttribute('aria-label', collapsed ? localize('kingu.footer.resources.expand', "Expand {0}", label) : localize('kingu.footer.resources.collapse', "Collapse {0}", label));
		toggle.appendChild(lucideIcon(collapsed ? 'chevron-right' : 'chevron-down', 12));
		toggle.addEventListener('click', () => {
			if (key === 'app') {
				this._appCollapsed = !this._appCollapsed;
			} else if (!this._collapsedWorktrees.delete(key)) {
				this._collapsedWorktrees.add(key);
			}
			this._resourcePopover.refresh();
		});
		const name = append(row, $('.kingu-orca-group-name'));
		append(name, $('span.kingu-orca-group-title')).textContent = label;
		const end = append(name, $('.kingu-orca-metrics-end'));
		if (history) {
			end.appendChild(sparkline(history));
		}
		metricPair(end, cpu, memory, false);
		append(end, $('span.kingu-orca-gutter'));
	}

	/** `WorktreeRow`: a chevron, the name, the sparkline and metrics; its sessions under it. */
	private _worktreeRow(parent: HTMLElement, worktree: IResourceWorktree, close: () => void): void {
		const collapsed = this._collapsedWorktrees.has(worktree.id);
		const container = append(parent, $('.kingu-orca-worktree'));
		const row = append(container, $('.kingu-orca-worktree-row'));
		if (worktree.sessions.length > 0) {
			const toggle = append(row, $('button.kingu-orca-chevron')) as HTMLButtonElement;
			toggle.type = 'button';
			toggle.setAttribute('aria-label', collapsed ? localize('kingu.footer.resources.expandWorkspace', "Expand workspace") : localize('kingu.footer.resources.collapseWorkspace', "Collapse workspace"));
			toggle.appendChild(lucideIcon(collapsed ? 'chevron-right' : 'chevron-down', 12));
			toggle.addEventListener('click', () => {
				if (!this._collapsedWorktrees.delete(worktree.id)) {
					this._collapsedWorktrees.add(worktree.id);
				}
				this._resourcePopover.refresh();
			});
		} else {
			append(row, $('span.kingu-orca-chevron.placeholder'));
		}
		const name = append(row, $('button.kingu-orca-worktree-name')) as HTMLButtonElement;
		name.type = 'button';
		append(name, $('span.kingu-orca-truncate')).textContent = worktree.name;
		const first = worktree.sessions.find(session => session.terminal)?.terminal;
		name.disabled = !first;
		name.setAttribute('aria-label', localize('kingu.footer.resources.resume', "Resume workspace {0}", worktree.name));
		name.addEventListener('click', () => {
			if (first) {
				close();
				void this._focusTerminal(first);
			}
		});
		const end = append(row, $('.kingu-orca-metrics-end'));
		end.appendChild(sparkline(worktree.history));
		metricPair(end, worktree.cpu, worktree.memory, false);
		append(end, $('span.kingu-orca-gutter'));

		if (collapsed) {
			return;
		}
		for (const session of worktree.sessions) {
			const line = append(container, $('.kingu-orca-session'));
			const terminal = session.terminal;
			if (terminal) {
				line.classList.add('clickable');
				line.tabIndex = 0;
				line.setAttribute('role', 'button');
				const open = () => {
					close();
					void this._focusTerminal(terminal);
				};
				line.addEventListener('click', open);
				line.addEventListener('keydown', event => {
					if (event.key === 'Enter' || event.key === ' ') {
						event.preventDefault();
						open();
					}
				});
			}
			append(line, $(`span.kingu-orca-dot${session.bound ? '.emerald' : ''}`));
			append(line, $('span.kingu-orca-session-label')).textContent = session.label;
			metricPair(line, session.cpu, session.memory, true);
			const gutter = append(line, $('span.kingu-orca-gutter'));
			if (terminal) {
				const kill = append(gutter, $('button.kingu-orca-kill')) as HTMLButtonElement;
				kill.type = 'button';
				kill.setAttribute('aria-label', localize('kingu.footer.resources.killSession', "Kill session {0}", session.label));
				kill.appendChild(lucideIcon('x', 12));
				kill.addEventListener('click', event => {
					event.stopPropagation();
					void this._terminalService.safeDisposeTerminal(terminal);
				});
			}
		}
	}

	private async _focusTerminal(instance: ITerminalInstance): Promise<void> {
		this._terminalService.setActiveInstance(instance);
		await this._terminalService.revealTerminal(instance);
		await instance.focusWhenReady(true);
	}

	/** `DaemonActionDialog` for a restart, against this window's terminal host. */
	private async _confirmRestart(close: () => void): Promise<void> {
		close();
		const { confirmed } = await this._dialogService.confirm({
			type: 'warning',
			message: localize('kingu.footer.resources.restartTitle', "Restart the terminal daemon?"),
			detail: localize('kingu.footer.resources.restartDetail', "Kills every running terminal pane and restarts the daemon process. Panes show \"Process exited\" and can be reopened immediately. This can't be undone."),
			primaryButton: localize({ key: 'kingu.footer.resources.restartConfirm', comment: ['&& denotes a mnemonic'] }, "&&Restart daemon"),
		});
		if (confirmed) {
			await this._commandService.executeCommand(RESTART_PTY_HOST_COMMAND_ID);
		}
	}

	/** `DaemonActionDialog` for killing every session. */
	private async _confirmKillAll(close: () => void): Promise<void> {
		close();
		const { confirmed } = await this._dialogService.confirm({
			type: 'warning',
			message: localize('kingu.footer.resources.killAllTitle', "Kill all terminal sessions?"),
			detail: localize('kingu.footer.resources.killAllDetail', "This closes every terminal tab across all workspaces and requests shutdown for its current terminal sessions. Any unsaved terminal work is lost. New terminals can be opened immediately. This can't be undone."),
			primaryButton: localize({ key: 'kingu.footer.resources.killAllConfirm', comment: ['&& denotes a mnemonic'] }, "&&Kill all sessions"),
		});
		if (confirmed) {
			await this._commandService.executeCommand(TerminalCommandId.KillAll);
		}
	}

	// #endregion

	// #region Ports

	private async _readPorts(fromOpen: boolean): Promise<void> {
		if (fromOpen) {
			this._scanningPorts = true;
			this._renderPorts();
		}
		try {
			this._portScan = await this._hostService.scanPorts();
		} catch (error) {
			this._logService.warn('[kingu-footer] ports failed', error);
		}
		this._scanningPorts = false;
		if (!this._store.isDisposed) {
			this._renderPorts();
		}
	}

	private _portsTooltip(): string {
		const count = this._portScan.workspace.length;
		const external = this._portScan.external.length;
		const noun = count === 1 ? localize('kingu.footer.ports.port', "port") : localize('kingu.footer.ports.ports', "ports");
		return external > 0
			? localize('kingu.footer.ports.tooltipExternal', "Ports — {0} workspace {1} · {2} external", count, noun, external)
			: localize('kingu.footer.ports.tooltip', "Ports — {0} workspace {1}", count, noun);
	}

	/** `PortsStatusSegment`'s trigger: a plug (a spinner while scanning) and the workspace port count. */
	private _renderPorts(): void {
		const count = this._portScan.workspace.length;
		const aria = localize('kingu.footer.ports.aria', "Ports, {0} workspace {1}", count, count === 1 ? 'port' : 'ports');
		this._portsChip.set([
			this._scanningPorts ? { kind: 'icon', name: 'loader-circle', className: 'spin kingu-orca-muted' } : { kind: 'icon', name: 'plug', className: 'kingu-orca-muted' },
			{ kind: 'text', text: String(count), className: 'kingu-orca-text-11 kingu-orca-medium kingu-orca-tabular kingu-orca-muted' },
		], aria);
		this._place(this._ports, {
			name: localize('kingu.footer.ports.title', "Ports"),
			text: '',
			content: this._portsChip.element,
			ariaLabel: aria,
		}, 'kingu.footer.ports', StatusbarAlignment.RIGHT, 97);
		this._portsPopover.refresh();
	}

	/** The ports popover: the header, the workspace's ports, then the collapsed External Ports section. */
	private _portsPanel(close: () => void, store: DisposableStore): HTMLElement {
		const { workspace, external } = this._portScan;
		const root = $('div');
		const header = append(root, $('.kingu-orca-panel-header'));
		const title = append(header, $('.kingu-orca-panel-title'));
		title.appendChild(lucideIcon('plug', 12));
		append(title, $('span')).textContent = localize('kingu.footer.ports.title', "Ports");
		append(header, $('span.kingu-orca-text-11.kingu-orca-tabular.kingu-orca-muted')).textContent = localize('kingu.footer.ports.counts', "{0} workspace · {1} external", workspace.length, external.length);

		const scroll = append(root, $('.kingu-orca-scroll'));
		scroll.style.maxHeight = '28rem';
		this._portsPopover.trackScroll(scroll);
		if (workspace.length > 0) {
			const section = append(scroll, $('section.kingu-orca-port-section'));
			const sectionHeader = append(section, $('.kingu-orca-port-section-header'));
			append(sectionHeader, $('span.kingu-orca-truncate')).textContent = this._workspaceService.getWorkspace().folders[0]?.name ?? localize('kingu.footer.resources.workspace', "Workspace");
			append(sectionHeader, $('span.kingu-orca-port-section-count')).textContent = String(workspace.length);
			const rows = append(section, $('.kingu-orca-port-rows'));
			for (const port of workspace) {
				this._portRow(rows, port, false, close, store);
			}
		} else {
			append(scroll, $('.kingu-orca-empty')).textContent = this._scanningPorts
				? localize('kingu.footer.ports.scanning', "Scanning for workspace ports...")
				: localize('kingu.footer.ports.none', "No workspace ports detected");
		}

		const externalSection = append(scroll, $('section.kingu-orca-external'));
		const toggle = append(externalSection, $('button.kingu-orca-external-toggle')) as HTMLButtonElement;
		toggle.type = 'button';
		toggle.setAttribute('aria-expanded', String(this._externalOpen));
		toggle.appendChild(lucideIcon(this._externalOpen ? 'chevron-down' : 'chevron-right', 12));
		append(toggle, $('span')).textContent = localize('kingu.footer.ports.external', "External Ports");
		append(toggle, $('span.count')).textContent = String(external.length);
		toggle.addEventListener('click', () => {
			this._externalOpen = !this._externalOpen;
			this._portsPopover.refresh();
		});
		if (this._externalOpen) {
			const list = append(externalSection, $('.kingu-orca-port-rows'));
			if (external.length === 0) {
				append(list, $('.kingu-orca-empty')).textContent = localize('kingu.footer.ports.noExternal', "No external ports detected");
			}
			for (const port of external) {
				this._portRow(list, port, true, close, store);
			}
		}
		return root;
	}

	/** `PortRow`: the port, the process, and open, copy and stop on hover; the address (or `external`) beneath. */
	private _portRow(parent: HTMLElement, port: IKinguListeningPort, external: boolean, close: () => void, store: DisposableStore): void {
		const advertised = external ? undefined : this._advertisedUrls.get(port.port)?.url;
		const address = portAddress(port.port, advertised);
		const row = append(parent, $('.kingu-orca-port-row'));
		append(row, $('span.kingu-orca-port-number')).textContent = String(port.port);
		const detail = append(row, $('.kingu-orca-port-detail'));
		const processLine = append(detail, $('.kingu-orca-port-process'));
		const processLabel = port.process ?? (port.pid ? `PID ${port.pid}` : localize('kingu.footer.ports.unknownProcess', "Unknown process"));
		const processName = append(processLine, $('span'));
		processName.textContent = processLabel;
		store.add(attachFooterTooltip(processName, () => [processLabel], 200));
		const actions = append(processLine, $('.kingu-orca-port-actions'));
		iconButton(actions, store, 'external-link', localize('kingu.footer.ports.open', "Open in Browser"), 'small', () => {
			close();
			void this._openPort(port.port, advertised);
		});
		iconButton(actions, store, 'copy', localize('kingu.footer.ports.copy', "Copy {0}", address), 'small', () => {
			void this._clipboardService.writeText(address);
			this._notificationService.info(localize('kingu.footer.ports.copied', "Copied {0}", address));
		});
		// `canStopWorkspacePort`: a workspace port with a known owner that is not the app itself.
		const canStop = !external && !!port.pid && !/^(electron|kingu)(\.exe)?$/i.test(port.process ?? '');
		const stop = iconButton(actions, store, 'trash-2', localize('kingu.footer.ports.stop', "Stop Process"), 'small destructive', () => void this._stopPort(port));
		stop.disabled = !canStop;
		append(detail, $('.kingu-orca-port-address')).textContent = external ? 'external' : address;
	}

	/** The ADE's Stop Process: the host re-checks the port against a fresh scan, then the list is rescanned twice. */
	private async _stopPort(port: IKinguListeningPort): Promise<void> {
		if (!port.pid) {
			return;
		}
		const result = await this._hostService.stopPortProcess({ pid: port.pid, port: port.port });
		if (!result.ok) {
			this._notificationService.error(result.reason);
			return;
		}
		this._notificationService.info(localize('kingu.footer.ports.stopped', "Stopped process on {0}", port.port));
		await this._readPorts(true);
		await timeout(500);
		await this._readPorts(false);
	}

	/**
	 * Opens a port at the address its server announced, or at loopback.
	 *
	 * The announced address is only used when it is this machine's: this is the
	 * control labelled "open this port", and it must never navigate somewhere a
	 * terminal's output suggested.
	 */
	private async _openPort(port: number, advertised: string | undefined): Promise<void> {
		const fallback = `http://localhost:${port}`;
		await this._openerService.open(URI.parse(safeAdvertised(advertised) ?? fallback), { openExternal: true });
	}

	// #endregion

	// #region Remote hosts

	/** Shown only once a remote host exists, as in the ADE. */
	private async _readSsh(): Promise<void> {
		let targets: readonly IOrcaSshTarget[] = [];
		try {
			targets = await this._orca.invoke<readonly IOrcaSshTarget[]>('ssh:listTargets') ?? [];
		} catch (error) {
			this._logService.warn('[kingu-footer] ssh:listTargets failed', error);
		}
		if (this._store.isDisposed) {
			return;
		}
		this._sshTargets = targets;
		if (targets.length === 0) {
			this._sshPopover.close();
			this._ssh.clear();
			return;
		}
		const aria = localize('kingu.footer.ssh.aria', "Remote host connection status");
		this._sshChip.set([
			{ kind: 'icon', name: 'server-off', className: 'kingu-orca-muted' },
			{ kind: 'text', text: localize('kingu.footer.ssh.connected', "{0} connected", 0), className: 'kingu-orca-text-11 kingu-orca-muted' },
			{ kind: 'dot' },
		], aria);
		this._place(this._ssh, {
			name: localize('kingu.footer.ssh.name', "Remote Hosts"),
			text: '',
			content: this._sshChip.element,
			ariaLabel: aria,
		}, 'kingu.footer.ssh', StatusbarAlignment.RIGHT, 96);
		this._sshPopover.refresh();
	}

	/** `SshStatusSegment`'s menu: the heading, a row per host, then Manage Remote Hosts…. */
	private _sshMenu(close: () => void): HTMLElement {
		const menu = $('div');
		append(menu, $('.kingu-orca-menu-heading')).textContent = localize('kingu.footer.ssh.name', "Remote Hosts");
		for (const target of this._sshTargets) {
			const row = append(menu, $('.kingu-orca-menu-item'));
			append(row, $('span.kingu-orca-dot'));
			append(row, $('span.kingu-orca-truncate')).textContent = target.label ?? target.host ?? target.id;
		}
		menuSeparator(menu);
		menuItem(menu, localize('kingu.footer.ssh.manage', "Manage Remote Hosts…"), () => {
			close();
			void this._commandService.executeCommand('workbench.action.openSettings', 'kingu.servers');
		});
		wireMenuKeyboard(menu);
		return menu;
	}

	// #endregion

	/**
	 * The ADE's floating-workspace toggle in its status-bar form: a boxed
	 * `size-5` button with the panels icon, labelled with its shortcut, and the
	 * same right-click menu as the floating button (here, "Move to Floating
	 * Button"). The ADE puts it in the footer only when its trigger location is
	 * `status-bar`; by default it floats over the workbench instead.
	 */
	private _renderPanelToggle(): void {
		const enabled = this._configurationService.getValue<boolean>(FLOATING_ENABLED_SETTING_ID) !== false;
		const location = this._configurationService.getValue<string>(FLOATING_LOCATION_SETTING_ID);
		if (!enabled || location !== 'status-bar') {
			this._panel.clear();
			return;
		}
		const label = this._floatingLabel();
		this._panelChip.set([{ kind: 'icon', name: 'panels-top-left', size: 14 }], label);
		this._place(this._panel, {
			name: localize('kingu.footer.floating.name', "Floating Workspace"),
			text: '',
			content: this._panelChip.element,
			ariaLabel: label,
		}, 'kingu.footer.panel', StatusbarAlignment.RIGHT, 95);
	}

	/** `Show Floating Workspace` or `Minimize Floating Workspace`, as the ADE's footer spells them. */
	private _floatingLabel(): string {
		return this._layoutService.isVisible(Parts.PANEL_PART)
			? localize('kingu.footer.floating.minimize', "Minimize Floating Workspace")
			: localize('kingu.footer.floating.show', "Show Floating Workspace");
	}

	/**
	 * The strip carries the ADE's segments beside this window's own — the
	 * notifications bell and the remote indicator stay — but not the Copilot
	 * status, which this window does not use.
	 *
	 * Hidden the way a user hides an entry, so the status bar's own context menu
	 * brings it back. The bell and the remote indicator were hidden the same way
	 * by an earlier build; they are shown again once, and after that whatever the
	 * user chooses from that menu stands.
	 */
	private _hideForeignEntries(): void {
		this._statusbarService.updateEntryVisibility(COPILOT_ENTRY, false);
		if (!this._storageService.getBoolean(RESTORED_ENTRIES_KEY, StorageScope.PROFILE, false)) {
			for (const id of RESTORED_ENTRIES) {
				this._statusbarService.updateEntryVisibility(id, true);
			}
			this._storageService.store(RESTORED_ENTRIES_KEY, true, StorageScope.PROFILE, StorageTarget.MACHINE);
		}
	}
}

/** The terminal's own restart of its pty host (`TerminalDeveloperCommandId.RestartPtyHost`), which this layer may not import. */
const RESTART_PTY_HOST_COMMAND_ID = 'workbench.action.terminal.restartPtyHost';

/** The Copilot status, which the ADE's footer does not have and this window does not use. */
const COPILOT_ENTRY = 'chat.statusBarEntry';
/** This window's own entries that an earlier build hid, shown again once. */
const RESTORED_ENTRIES = ['status.host', 'status.notifications'];
const RESTORED_ENTRIES_KEY = 'kingu.footer.restoredOwnEntries';

function awakeTitle(): string {
	return localize('kingu.footer.awake.title', "Keep computer awake");
}

function awakeModeLabel(mode: OrcaAwakeMode): string {
	switch (mode) {
		case 'on': return localize('kingu.footer.awake.on', "On");
		case 'auto': return localize('kingu.footer.awake.auto', "Agent");
		default: return localize('kingu.footer.awake.off', "Off");
	}
}

/** `formatCpu`: one decimal and a percent sign. */
function formatCpu(percent: number): string {
	return `${percent.toFixed(1)}%`;
}

function sumMetric(values: readonly (number | null)[]): number | null {
	const known = values.filter((value): value is number => value !== null);
	return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0);
}

/** `MetricPair`: CPU and memory in fixed right-aligned columns, `—` for what was not measured. */
function metricPair(parent: HTMLElement, cpu: number | null, memory: number | null, small: boolean): void {
	const pair = append(parent, $('.kingu-orca-metric-columns.kingu-orca-metric-pair'));
	pair.classList.toggle('small', small);
	pair.classList.toggle('empty', cpu === null && memory === null);
	append(pair, $('span.kingu-orca-cpu-column')).textContent = cpu === null ? '—' : formatCpu(cpu);
	append(pair, $('span.kingu-orca-mem-column')).textContent = memory === null ? '—' : formatOrcaMemory(memory);
}

/** `Sparkline`: 48 x 14, a flat midline until there are two samples. */
function sparkline(samples: readonly number[], width = 48, height = 14): SVGSVGElement {
	const svg = mainWindow.document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('width', String(width));
	svg.setAttribute('height', String(height));
	svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
	svg.setAttribute('preserveAspectRatio', 'none');
	svg.setAttribute('aria-hidden', 'true');
	svg.classList.add('kingu-orca-sparkline');
	let points: string;
	if (samples.length < 2) {
		const middle = (height / 2).toFixed(1);
		points = `0,${middle} ${width},${middle}`;
	} else {
		const min = Math.min(...samples);
		const range = (Math.max(...samples) - min) || 1;
		const step = width / (samples.length - 1);
		points = samples.map((value, index) => `${(index * step).toFixed(1)},${(height - (value - min) / range * height).toFixed(1)}`).join(' ');
	}
	const line = mainWindow.document.createElementNS(SVG_NS, 'polyline');
	line.setAttribute('points', points);
	line.setAttribute('fill', 'none');
	line.setAttribute('stroke-width', '1');
	line.setAttribute('stroke-linecap', 'round');
	line.setAttribute('stroke-linejoin', 'round');
	svg.appendChild(line);
	return svg;
}

/** The announced URL, only when it is this machine's. */
function safeAdvertised(advertised: string | undefined): string | undefined {
	if (!advertised) {
		return undefined;
	}
	const candidate = URI.parse(advertised);
	const local = (candidate.scheme === 'http' || candidate.scheme === 'https') && isLocalhostEquivalent(candidate.authority.replace(/^.*@/, '').replace(/:\d+$/, ''));
	return local ? advertised : undefined;
}

/** `addressForPort`: the announced origin's host when there is one, else `localhost:port`. */
function portAddress(port: number, advertised: string | undefined): string {
	const safe = safeAdvertised(advertised);
	return safe ? URI.parse(safe).authority.replace(/^.*@/, '') : `localhost:${port}`;
}

registerWorkbenchContribution2(KinguOrcaFooterContribution.ID, KinguOrcaFooterContribution, WorkbenchPhase.AfterRestored);
