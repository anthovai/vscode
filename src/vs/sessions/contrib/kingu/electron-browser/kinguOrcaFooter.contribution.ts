/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/kinguOrcaFooter.css';
import { $ } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableMap, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment, ToggleTooltipCommand } from '../../../../workbench/services/statusbar/browser/statusbar.js';
import { IKinguHostService } from '../../../../platform/kinguHost/common/kinguHostService.js';
import { KinguQuotaProvider } from '../../../../platform/kinguHost/common/kinguQuotaProviders.js';
import { KINGU_OPEN_PORT_COMMAND_ID } from '../browser/kinguStatusBar.contribution.js';
import { IKinguUsageRosterOptions, renderKinguUsageRoster, updateKinguUsageRoster } from '../browser/kinguUsageRosterPanel.js';
import { IKinguUsageSource, KinguUsageDetail, usageRows } from '../common/kinguUsageRoster.js';
import { KINGU_SHOW_USAGE_COMMAND_ID } from '../browser/kinguUsagePage.contribution.js';
import { IKinguOrcaService } from '../common/kinguOrca.js';
import { formatFooterWindow, formatOrcaMemory, IOrcaFooterWindow, IOrcaProviderRateLimits, isProviderShown, normalizeOrcaAwakeMode, ORCA_FOOTER_PROVIDERS, OrcaAwakeMode, orcaAwakeSettingsForMode, OrcaRateLimitState, providerFooterWindows, tightestFooterWindow } from '../common/kinguOrcaFooter.js';
import { KINGU_PROVIDER_LOGOS } from '../common/kinguProviderLogos.js';
import { formatResetDuration, IKinguRateLimit, nextResetTickDelay } from '../common/kinguStatusBar.js';
import './kinguOrcaService.js';

/**
 * How often the memory reading is retaken.
 *
 * Slow on purpose. On Windows the ADE's snapshot enumerates processes through
 * PowerShell, then typeperf, and either can take seconds; the ADE itself only
 * polls while its resource panel is open and leaves the closed badge on the
 * last reading. A minute keeps the badge honest without a shell every few
 * seconds.
 */
const RESOURCE_INTERVAL_MS = 60_000;
/** Remote hosts change by user action, so a slow poll is enough to catch the rest. */
const SSH_INTERVAL_MS = 30_000;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Icons for the providers whose logo is not carried; codicons for the rest. */
const FALLBACK_PROVIDER_ICONS: Readonly<Record<string, ThemeIcon>> = {
	gemini: Codicon.sparkle,
	antigravity: Codicon.rocket,
	opencodeGo: Codicon.code,
	kimi: Codicon.circleFilled,
	minimax: Codicon.pulse,
	grok: Codicon.zap,
};

/** The providers the usage panel knows how to draw, by the ADE's slot. */
const ROSTER_PROVIDERS: Readonly<Record<string, KinguQuotaProvider>> = {
	claude: KinguQuotaProvider.Claude,
	codex: KinguQuotaProvider.Codex,
	gemini: KinguQuotaProvider.Gemini,
	kimi: KinguQuotaProvider.Kimi,
	grok: KinguQuotaProvider.Grok,
};

/**
 * The ADE's usage, as the panel the ADE opens from its footer reads it.
 *
 * The session and the week; the Fable week stays on the strip, where it is
 * named, because the panel labels a window by its length and would show two
 * rows both called `wk`.
 */
function rosterSources(state: OrcaRateLimitState | undefined): IKinguUsageSource[] {
	const sources: IKinguUsageSource[] = [];
	for (const [slot, provider] of Object.entries(ROSTER_PROVIDERS)) {
		const limits = state?.[slot];
		if (!isProviderShown(limits)) {
			continue;
		}
		const windows: IKinguRateLimit[] = [];
		for (const window of [limits.session, limits.weekly]) {
			if (window) {
				windows.push({ usedPercent: window.usedPercent, windowDurationMins: window.windowMinutes, resetsAt: window.resetsAt ?? undefined });
			}
		}
		sources.push({
			provider,
			limits: windows,
			problem: windows.length === 0 && limits.status === 'error' ? 'unavailable' : undefined,
			pending: windows.length === 0 && limits.status === 'fetching',
		});
	}
	return sources;
}

/**
 * One provider's segment, built once and updated in place.
 *
 * A status bar entry appends its `content` element when it is created and
 * ignores it on `update`, so the element is kept and moved rather than handed
 * over again.
 */
class ProviderSegment {

	readonly element = $('span.kingu-orca-segment');
	private readonly _fill = $('span.kingu-orca-bar-fill');
	private readonly _bar = $('span.kingu-orca-bar');
	private readonly _text = $('span.kingu-orca-segment-text');

	constructor(slot: string) {
		this.element.appendChild(providerIcon(slot));
		this._bar.appendChild(this._fill);
		this.element.appendChild(this._bar);
		this.element.appendChild(this._text);
	}

	update(text: string, fillPercent: number | undefined, warning: boolean): void {
		this._bar.classList.toggle('hidden', fillPercent === undefined);
		this._fill.style.width = `${fillPercent ?? 0}%`;
		this.element.classList.toggle('stale', warning);
		this._text.textContent = text;
	}
}

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

/**
 * The Agents Window's footer, and it is the ADE's.
 *
 * The segments, their order and their wording are the ADE's status bar's —
 * usage per agent with the session counting down, refresh, keep awake, updates,
 * memory and terminals, ports, remote hosts, the panel toggle — and the numbers
 * come from the ADE's own engine through the same handlers its renderer calls:
 * `rateLimits:*`, `agentAwake:*`, `memory:getSnapshot`, `updater:*`, `ssh:*`.
 * Nothing is recomputed here that the ADE already knows.
 *
 * Two readings are this window's rather than the ADE's, because the ADE's
 * version of them describes the ADE's own workbench, which is not on screen:
 * the terminal count is the terminals *this window* runs, and the ports are
 * those this app's processes are serving.
 */
class KinguOrcaFooterContribution extends Disposable {

	static readonly ID = 'kingu.contrib.orcaFooter';

	private readonly _providers = this._register(new DisposableMap<string, IStatusbarEntryAccessor>());
	private readonly _segments = new Map<string, ProviderSegment>();
	private readonly _refresh = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly _awake = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly _update = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly _resources = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly _ports = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly _ssh = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly _panel = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly _resetTick = this._register(new MutableDisposable());

	private _rateLimits: OrcaRateLimitState | undefined;
	private _refreshing = false;
	private _awakeStatus: IOrcaAwakeStatus = { mode: 'off', active: false };
	private _configuredAwake: OrcaAwakeMode | undefined;
	private _memoryBytes: number | undefined;
	private _rosterDetail: KinguUsageDetail = 'detailed';

	constructor(
		@IKinguOrcaService private readonly _orca: IKinguOrcaService,
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IKinguHostService private readonly _hostService: IKinguHostService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@ICommandService private readonly _commandService: ICommandService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		this._register(this._orca.onPush('rateLimits:update')(([state]) => this._renderUsage(state as OrcaRateLimitState)));
		this._register(this._orca.onPush('agentAwake:changed')(([status]) => {
			this._awakeStatus = status as IOrcaAwakeStatus;
			this._renderAwake();
		}));
		this._register(this._orca.onPush('settings:changed')(([updates]) => {
			const changed = updates as Record<string, unknown>;
			if (changed.computerAwakeMode !== undefined || changed.keepComputerAwakeWhileAgentsRun !== undefined) {
				this._configuredAwake = normalizeOrcaAwakeMode(changed.computerAwakeMode, changed.keepComputerAwakeWhileAgentsRun);
				this._renderAwake();
			}
		}));
		this._register(this._orca.onPush('updater:status')(([status]) => this._renderUpdate(status as IOrcaUpdateStatus)));
		this._register(this._terminalService.onDidChangeInstances(() => this._renderResources()));

		const resources = mainWindow.setInterval(() => void this._readResources(), RESOURCE_INTERVAL_MS);
		this._register(toDisposable(() => mainWindow.clearInterval(resources)));
		const ssh = mainWindow.setInterval(() => void this._readSsh(), SSH_INTERVAL_MS);
		this._register(toDisposable(() => mainWindow.clearInterval(ssh)));

		this._renderPanelToggle();
		this._renderAwake();
		this._renderResources();
		void this._start();
	}

	private async _start(): Promise<void> {
		await Promise.all([
			this._read('rateLimits:get', state => this._renderUsage(state as OrcaRateLimitState)),
			this._read('agentAwake:getStatus', status => {
				this._awakeStatus = status as IOrcaAwakeStatus;
				this._renderAwake();
			}),
			this._read('settings:get', settings => {
				const values = settings as Record<string, unknown>;
				this._configuredAwake = normalizeOrcaAwakeMode(values.computerAwakeMode, values.keepComputerAwakeWhileAgentsRun);
				this._renderAwake();
			}),
			this._read('updater:getStatus', status => this._renderUpdate(status as IOrcaUpdateStatus)),
			this._readResources(),
			this._readPorts(),
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

	// #region Usage

	/**
	 * A segment per agent that has reported, the ADE's way.
	 *
	 * Rebuilt on every push and on the countdown's tick; the entries themselves
	 * are kept so the strip does not flicker as a number changes.
	 */
	private _renderUsage(state: OrcaRateLimitState | undefined): void {
		this._rateLimits = state;
		const now = Date.now();
		const resets: number[] = [];
		let priority = 110;
		let anyFetching = false;
		let anyShown = false;
		for (const { slot, name } of ORCA_FOOTER_PROVIDERS) {
			const provider = state?.[slot];
			if (!isProviderShown(provider)) {
				this._providers.deleteAndDispose(slot);
				this._segments.delete(slot);
				priority--;
				continue;
			}
			anyShown = true;
			anyFetching ||= provider.status === 'fetching';
			const windows = providerFooterWindows(provider, now);
			for (const window of windows) {
				if (window.resetsAt !== null) {
					resets.push(window.resetsAt);
				}
			}
			this._renderProvider(slot, name, provider, windows, priority--);
		}
		this._renderRefresh(anyShown, anyFetching, priority);
		this._scheduleTick(resets);
	}

	private _renderProvider(slot: string, name: string, provider: IOrcaProviderRateLimits, windows: readonly IOrcaFooterWindow[], priority: number): void {
		let segment = this._segments.get(slot);
		if (!segment) {
			segment = new ProviderSegment(slot);
			this._segments.set(slot, segment);
		}
		const tightest = tightestFooterWindow(windows);
		const readings = windows.map(window => formatFooterWindow(window, 'used'));
		const text = windows.length === 0
			? provider.status === 'error' ? localize('kingu.footer.usage.error', "Error") : '···'
			: readings.join(' · ');
		segment.update(text, tightest ? Math.round(Math.min(100, Math.max(0, tightest.usedPercent))) : undefined, provider.status === 'error');

		const now = Date.now();
		const details = windows.map(window => window.resetsAt !== null
			? localize('kingu.footer.usage.windowResets', "{0} — resets in {1}", formatFooterWindow(window, 'used'), formatResetDuration(window.resetsAt - now))
			: formatFooterWindow(window, 'used'));
		if (provider.error) {
			details.push(provider.error);
		}
		const entry: IStatusbarEntry = {
			name: localize('kingu.footer.usage.name', "{0} Usage", name),
			text: '',
			content: segment.element,
			ariaLabel: localize('kingu.footer.usage.aria', "{0} usage: {1}", name, readings.join(', ') || text),
			// The ADE's usage panel for the agents it can draw, pinned by a click as
			// the ADE's footer opens it; a plain summary for the rest.
			...(ROSTER_PROVIDERS[slot]
				? { tooltip: { element: () => this._rosterPanel(), contentOwnsPadding: true }, command: ToggleTooltipCommand }
				: { tooltip: [name, ...details].join('\n'), command: KINGU_SHOW_USAGE_COMMAND_ID }),
		};
		const existing = this._providers.get(slot);
		if (existing) {
			existing.update(entry);
		} else {
			this._providers.set(slot, this._statusbarService.addEntry(entry, `kingu.footer.usage.${slot}`, StatusbarAlignment.LEFT, priority));
		}
	}

	private _rosterPanel(): HTMLElement {
		const options = (): IKinguUsageRosterOptions => ({
			rows: usageRows(rosterSources(this._rateLimits)),
			detail: this._rosterDetail,
			display: 'used',
			refreshing: this._refreshing,
			onDetailChange: detail => {
				this._rosterDetail = detail;
				updateKinguUsageRoster(root, options());
			},
			onRefresh: async () => {
				await this._refreshUsage();
				if (!this._store.isDisposed) {
					updateKinguUsageRoster(root, options());
				}
			},
			onDetails: () => void this._commandService.executeCommand(KINGU_SHOW_USAGE_COMMAND_ID),
		});
		// Declared after the closures above, which only run once it exists.
		const root = renderKinguUsageRoster(options());
		return root;
	}

	private _renderRefresh(anyShown: boolean, anyFetching: boolean, priority: number): void {
		if (!anyShown) {
			this._refresh.clear();
			return;
		}
		const entry: IStatusbarEntry = {
			name: localize('kingu.footer.refresh.name', "Refresh Usage"),
			text: this._refreshing || anyFetching ? '$(sync~spin)' : '$(sync)',
			ariaLabel: localize('kingu.footer.refresh.aria', "Refresh rate limits"),
			tooltip: localize('kingu.footer.refresh.tooltip', "Refresh usage data"),
			command: { id: KINGU_FOOTER_REFRESH_COMMAND_ID, title: localize('kingu.footer.refresh.name', "Refresh Usage"), arguments: [() => this._refreshUsage()] },
		};
		if (this._refresh.value) {
			this._refresh.value.update(entry);
		} else {
			this._refresh.value = this._statusbarService.addEntry(entry, 'kingu.footer.refresh', StatusbarAlignment.LEFT, priority);
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

	private _renderAwake(): void {
		// The configured mode wins over the service's until the service agrees,
		// as in the ADE: a choice just made must read back as made.
		const configured = this._configuredAwake ?? this._awakeStatus.mode;
		const agrees = this._awakeStatus.mode === configured;
		const active = agrees ? this._awakeStatus.active : configured === 'on';
		const label = awakeModeLabel(configured);
		const state = active ? localize('kingu.footer.awake.active', "Active") : localize('kingu.footer.awake.inactive', "Inactive");
		const entry: IStatusbarEntry = {
			name: localize('kingu.footer.awake.name', "Keep Computer Awake"),
			text: `$(coffee) ${label}`,
			ariaLabel: localize('kingu.footer.awake.aria', "Keep computer awake, {0} · {1}", label, state),
			tooltip: localize('kingu.footer.awake.tooltip', "Keep computer awake\n{0} · {1}", label, state),
			command: { id: KINGU_FOOTER_AWAKE_COMMAND_ID, title: localize('kingu.footer.awake.name', "Keep Computer Awake"), arguments: [() => this._pickAwakeMode(configured)] },
		};
		if (this._awake.value) {
			this._awake.value.update(entry);
		} else {
			this._awake.value = this._statusbarService.addEntry(entry, 'kingu.footer.awake', StatusbarAlignment.RIGHT, 100);
		}
	}

	private async _pickAwakeMode(current: OrcaAwakeMode): Promise<void> {
		const items: (IQuickPickItem & { mode: OrcaAwakeMode })[] = [
			{ mode: 'on', label: awakeModeLabel('on'), description: localize('kingu.footer.awake.onDescription', "Keep this computer awake continuously") },
			{ mode: 'auto', label: awakeModeLabel('auto'), description: localize('kingu.footer.awake.autoDescription', "Stay awake while an agent is working") },
			{ mode: 'off', label: awakeModeLabel('off'), description: localize('kingu.footer.awake.offDescription', "Let this computer sleep normally") },
		];
		const picked = await this._quickInputService.pick(items, {
			placeHolder: localize('kingu.footer.awake.placeholder', "Keep computer awake"),
			activeItem: items.find(item => item.mode === current),
		});
		if (!picked) {
			return;
		}
		this._configuredAwake = picked.mode;
		this._renderAwake();
		try {
			await this._orca.invoke('settings:set', orcaAwakeSettingsForMode(picked.mode));
		} catch (error) {
			this._logService.error('[kingu-footer] could not set keep awake', error);
		}
	}

	// #endregion

	// #region Update

	/** Shown only while there is something to act on, as in the ADE. */
	private _renderUpdate(status: IOrcaUpdateStatus | undefined): void {
		const version = status?.version ?? '';
		let entry: IStatusbarEntry | undefined;
		if (status?.state === 'available') {
			entry = {
				name: localize('kingu.footer.update.name', "Kingu Update"),
				text: `$(cloud-download) ${localize('kingu.footer.update.available', "Update {0}", version)}`,
				ariaLabel: localize('kingu.footer.update.availableAria', "Kingu {0} is available", version),
				tooltip: localize('kingu.footer.update.availableTooltip', "Kingu {0} is available. Click to download.", version),
				command: { id: KINGU_FOOTER_INVOKE_COMMAND_ID, title: '', arguments: [() => this._orca.invoke('updater:download')] },
			};
		} else if (status?.state === 'downloading') {
			entry = {
				name: localize('kingu.footer.update.name', "Kingu Update"),
				text: `$(sync~spin) ${Math.round(status.percent ?? 0)}%`,
				ariaLabel: localize('kingu.footer.update.downloadingAria', "Downloading Kingu {0}", version),
				tooltip: localize('kingu.footer.update.downloadingAria', "Downloading Kingu {0}", version),
			};
		} else if (status?.state === 'downloaded') {
			entry = {
				name: localize('kingu.footer.update.name', "Kingu Update"),
				text: `$(debug-restart) ${localize('kingu.footer.update.restart', "Restart to Update")}`,
				ariaLabel: localize('kingu.footer.update.downloadedAria', "Kingu {0} is ready. Restart to update.", version),
				tooltip: localize('kingu.footer.update.downloadedAria', "Kingu {0} is ready. Restart to update.", version),
				command: { id: KINGU_FOOTER_INVOKE_COMMAND_ID, title: '', arguments: [() => this._orca.invoke('updater:quitAndInstall')] },
			};
		}
		if (!entry) {
			this._update.clear();
		} else if (this._update.value) {
			this._update.value.update(entry);
		} else {
			this._update.value = this._statusbarService.addEntry(entry, 'kingu.footer.update', StatusbarAlignment.RIGHT, 99);
		}
	}

	// #endregion

	// #region Memory and terminals

	private async _readResources(): Promise<void> {
		await this._read('memory:getSnapshot', snapshot => {
			const total = (snapshot as { totalMemory?: number } | undefined)?.totalMemory;
			this._memoryBytes = typeof total === 'number' ? total : undefined;
			this._renderResources();
		});
	}

	private _renderResources(): void {
		const memory = this._memoryBytes === undefined ? '—' : formatOrcaMemory(this._memoryBytes);
		const terminals = this._terminalService.instances.length;
		const entry: IStatusbarEntry = {
			name: localize('kingu.footer.resources.name', "Resource Usage"),
			text: `$(server) ${memory} · $(terminal) ${terminals}`,
			ariaLabel: localize('kingu.footer.resources.aria', "{0} of memory, {1} terminals", memory, terminals),
			tooltip: localize('kingu.footer.resources.tooltip', "Memory across every process Kingu runs: {0}\nTerminals in this window: {1}", memory, terminals),
			command: 'workbench.action.terminal.focus',
		};
		if (this._resources.value) {
			this._resources.value.update(entry);
		} else {
			this._resources.value = this._statusbarService.addEntry(entry, 'kingu.footer.resources', StatusbarAlignment.RIGHT, 98);
		}
		void this._readPorts();
	}

	// #endregion

	// #region Ports and remote hosts

	private async _readPorts(): Promise<void> {
		let count = 0;
		try {
			count = (await this._hostService.readListeningPorts()).length;
		} catch (error) {
			this._logService.warn('[kingu-footer] ports failed', error);
		}
		if (this._store.isDisposed) {
			return;
		}
		const label = count === 1 ? localize('kingu.footer.ports.one', "1 port") : localize('kingu.footer.ports.many', "{0} ports", count);
		const entry: IStatusbarEntry = {
			name: localize('kingu.footer.ports.name', "Ports"),
			text: `$(plug) ${count}`,
			ariaLabel: label,
			tooltip: localize('kingu.footer.ports.tooltip', "Ports: {0}", label),
			command: KINGU_OPEN_PORT_COMMAND_ID,
		};
		if (this._ports.value) {
			this._ports.value.update(entry);
		} else {
			this._ports.value = this._statusbarService.addEntry(entry, 'kingu.footer.ports', StatusbarAlignment.RIGHT, 97);
		}
	}

	/** Shown only once a remote host exists, as in the ADE. */
	private async _readSsh(): Promise<void> {
		let targets: readonly { id: string; label?: string; host?: string }[] = [];
		try {
			targets = await this._orca.invoke<readonly { id: string; label?: string; host?: string }[]>('ssh:listTargets') ?? [];
		} catch (error) {
			this._logService.warn('[kingu-footer] ssh:listTargets failed', error);
		}
		if (this._store.isDisposed) {
			return;
		}
		if (targets.length === 0) {
			this._ssh.clear();
			return;
		}
		const names = targets.map(target => target.label ?? target.host ?? target.id);
		const entry: IStatusbarEntry = {
			name: localize('kingu.footer.ssh.name', "Remote Hosts"),
			text: `$(remote) ${targets.length}`,
			ariaLabel: localize('kingu.footer.ssh.aria', "{0} remote hosts", targets.length),
			tooltip: [localize('kingu.footer.ssh.name', "Remote Hosts"), ...names].join('\n'),
		};
		if (this._ssh.value) {
			this._ssh.value.update(entry);
		} else {
			this._ssh.value = this._statusbarService.addEntry(entry, 'kingu.footer.ssh', StatusbarAlignment.RIGHT, 96);
		}
	}

	// #endregion

	/** The ADE's floating-workspace button; here, the window's own panel. */
	private _renderPanelToggle(): void {
		this._panel.value = this._statusbarService.addEntry({
			name: localize('kingu.footer.panel.name', "Toggle Panel"),
			text: '$(layout-panel)',
			ariaLabel: localize('kingu.footer.panel.name', "Toggle Panel"),
			tooltip: localize('kingu.footer.panel.name', "Toggle Panel"),
			command: 'workbench.action.togglePanel',
		}, 'kingu.footer.panel', StatusbarAlignment.RIGHT, 95);
	}
}

function awakeModeLabel(mode: OrcaAwakeMode): string {
	switch (mode) {
		case 'on': return localize('kingu.footer.awake.on', "On");
		case 'auto': return localize('kingu.footer.awake.auto', "Agent");
		default: return localize('kingu.footer.awake.off', "Off");
	}
}

/**
 * Commands that run the closure they are handed. A status bar entry's command is
 * how a click reaches code; these keep that code beside the segment it belongs to.
 */
const KINGU_FOOTER_REFRESH_COMMAND_ID = 'kingu.footer.refresh';
const KINGU_FOOTER_AWAKE_COMMAND_ID = 'kingu.footer.awake';
const KINGU_FOOTER_INVOKE_COMMAND_ID = 'kingu.footer.invoke';

for (const id of [KINGU_FOOTER_REFRESH_COMMAND_ID, KINGU_FOOTER_AWAKE_COMMAND_ID, KINGU_FOOTER_INVOKE_COMMAND_ID]) {
	CommandsRegistry.registerCommand(id, (_accessor, run: unknown) => typeof run === 'function' ? run() : undefined);
}

registerWorkbenchContribution2(KinguOrcaFooterContribution.ID, KinguOrcaFooterContribution, WorkbenchPhase.AfterRestored);
