/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/kinguStatusBar.css';
import { $ } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAgentHostService } from '../../../../platform/agentHost/common/agentService.js';
import { readCodexAccountInfo } from '../../../../platform/agentHost/common/meta/codexAccount.js';
import { IRemoteAgentHostService, RemoteAgentHostConnectionStatus } from '../../../../platform/agentHost/common/remoteAgentHostService.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment, ToggleTooltipCommand } from '../../../../workbench/services/statusbar/browser/statusbar.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { KINGU_QUOTA_PROVIDER_LABELS, KINGU_STATUS_BAR_PROVIDERS, KinguQuotaProvider } from '../../../../platform/kinguHost/common/kinguQuotaProviders.js';
import { KinguQuotaProblem } from '../../../../platform/kinguHost/common/kinguRateLimits.js';
import { IKinguHostService } from '../../../../platform/kinguHost/common/kinguHostService.js';
import { KinguHostService } from './kinguHostService.js';
import { IKinguAdvertisedUrlService, KinguAdvertisedUrlService } from './kinguAdvertisedUrlService.js';
import { isLocalhostEquivalent } from '../common/kinguAdvertisedUrls.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { URI } from '../../../../base/common/uri.js';
import { IKinguVaultService } from '../common/kinguVault.js';
import { describeListeningPort } from '../../../../platform/kinguHost/common/kinguHostPorts.js';
import { formatRateLimit, IKinguRateLimit, readRateLimitFromAccount } from '../common/kinguStatusBar.js';
import { IKinguUsageSource, KinguUsageDetail, usageRows } from '../common/kinguUsageRoster.js';
import { IKinguUsageRosterOptions, PROVIDER_ICONS, renderKinguUsageRoster, updateKinguUsageRoster } from './kinguUsageRosterPanel.js';

registerSingleton(IKinguHostService, KinguHostService, InstantiationType.Delayed);
// Eager, unlike the rest: it has to be listening to the terminals before a dev
// server prints its address, and a server prints it once. Created lazily when
// the ports entry first asked, it would have missed every announcement made
// before that — which is all of them.
registerSingleton(IKinguAdvertisedUrlService, KinguAdvertisedUrlService, InstantiationType.Eager);

export const KINGU_REFRESH_QUOTAS_COMMAND_ID = 'kingu.status.refreshQuotas';
/** Where "Usage details & history" at the foot of the panel goes. */
const KINGU_STATS_COMMAND_ID = 'kingu.stats';
const USAGE_DETAIL_STORAGE_KEY = 'kingu.usage.detail';
export const KINGU_OPEN_PORT_COMMAND_ID = 'kingu.status.openPort';

/** How many kinds of process the memory tooltip names before it becomes a list. */
const MEMORY_KINDS_SHOWN = 5;

/** A byte count as the unit a person would say: `1.2 GB`, `840 MB`. */
function formatBytes(bytes: number): string {
	const gb = bytes / 1024 ** 3;
	return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/**
 * A gauge, as a real element.
 *
 * Built once and then mutated in place. A status bar entry does accept an
 * `HTMLElement`, and `update()` ignores it -- but it is appended to the item's
 * container in the constructor and stays there, so a caller that keeps the
 * reference can move the bar itself. An earlier attempt drew the bar with block
 * characters after concluding an element could never track a live value; that
 * was wrong, and the block bar is what it looked like.
 *
 * `text` is left empty on the entry because the label and the content element
 * render side by side, so a filled label would draw the reading twice. The
 * accessible name comes from `ariaLabel`, which is where it belongs.
 */
class KinguGauge {

	readonly element = $('span.kingu-quota');
	private readonly _fill = $('span.kingu-quota-fill');
	private readonly _text = $('span.kingu-quota-text');

	constructor(icon: ThemeIcon) {
		const track = $('span.kingu-quota-track');
		track.appendChild(this._fill);
		this.element.appendChild($(`span.kingu-quota-icon${ThemeIcon.asCSSSelector(icon)}`));
		this.element.appendChild(track);
		this.element.appendChild(this._text);
	}

	/** Fills to the fullest window, which is the one that will stop the user first. */
	update(windows: readonly IKinguRateLimit[], text: string): void {
		const worst = windows.reduce((highest, limit) => limit.usedPercent > highest.usedPercent ? limit : highest, windows[0]);
		this._fill.style.width = `${Math.round(worst.usedPercent)}%`;
		// The bar changes colour where the number stops being background reading.
		this._fill.classList.toggle('warn', worst.usedPercent >= 75);
		this._fill.classList.toggle('danger', worst.usedPercent >= 90);
		this._text.textContent = text;
	}
}

/** How often the bar re-reads what it shows. */
const REFRESH_INTERVAL_MS = 30_000;

/**
 * How often the provider is actually asked.
 *
 * Far less often than the bar redraws: a five-hour window does not move in
 * thirty seconds, and this is a request against the user's account rather than
 * a local read.
 */
const QUOTA_REFRESH_INTERVAL_MS = 5 * 60_000;

/**
 * The strip along the bottom of the Agents window.
 *
 * It answers the two questions a person asks while an agent is working and
 * cannot ask the agent: how much of my quota window is gone, and what is this
 * window actually connected to. Both are already known here — the agent host
 * reports the first and the remote host service the second — and neither was
 * shown anywhere.
 *
 * Every entry is conditional on real data. An agent that reports no quota gets
 * no gauge rather than an empty one, because a bar of placeholders is worse
 * than a shorter bar.
 */
class KinguStatusBarContribution extends Disposable {

	static readonly ID = 'kingu.contrib.statusBar';

	private readonly _refresh = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly _remote = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly _vault = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly _terminals = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly _memory = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly _ports = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly _providers = new Map<KinguQuotaProvider, IStatusbarEntryAccessor>();
	/**
	 * The gauge element per provider, kept because the status bar appends it once
	 * and never touches it again — so moving the bar is this contribution's job.
	 */
	private readonly _gauges = new Map<KinguQuotaProvider, KinguGauge>();
	private _lastQuotaRefresh = 0;
	/**
	 * Whether the panel draws every window or only the tightest.
	 *
	 * Stored rather than settled by a setting: the control lives inside the panel
	 * it changes, so this is a view state the user has adjusted in passing, not a
	 * preference they went looking for.
	 */
	private _detail: KinguUsageDetail;

	constructor(
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@ILogService private readonly _logService: ILogService,
		@IAgentHostService private readonly _agentHostService: IAgentHostService,
		@IRemoteAgentHostService private readonly _remoteAgentHostService: IRemoteAgentHostService,
		@IKinguVaultService private readonly _vaultService: IKinguVaultService,
		@IKinguHostService private readonly _hostService: IKinguHostService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IKinguAdvertisedUrlService private readonly _advertisedUrls: IKinguAdvertisedUrlService,
		@IStorageService private readonly _storageService: IStorageService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super();

		this._detail = this._storageService.get(USAGE_DETAIL_STORAGE_KEY, StorageScope.PROFILE) === 'compact' ? 'compact' : 'detailed';

		this._update();

		// Both sources push, so the poll is only a backstop for the parts of the
		// quota that change with time rather than with an event (a window resetting).
		this._register(this._agentHostService.rootState.onDidChange(() => this._updateProviders()));
		this._register(this._remoteAgentHostService.onDidChangeConnections(() => this._updateRemote()));
		this._register(this._vaultService.onDidChangeSessions(() => this._updateVault()));
		this._register(this._hostService.onDidChange(() => this._updateProviders()));
		this._register(this._terminalService.onDidChangeInstances(() => this._updateTerminals()));
		// A server announcing its address changes what the entry offers to open,
		// which is worth a redraw even though the count has not moved.
		this._register(this._advertisedUrls.onDidChange(() => this._updatePorts()));
		this._register({ dispose: () => { for (const entry of this._providers.values()) { entry.dispose(); } this._providers.clear(); } });
		const timer = mainWindow.setInterval(() => this._update(), REFRESH_INTERVAL_MS);
		this._register({ dispose: () => mainWindow.clearInterval(timer) });
	}

	private _update(): void {
		this._updateRemote();
		this._updateVault();
		this._updateProviders();
		this._updateTerminals();
		this._updateMemory();
		this._updatePorts();
		this._maybeRefreshQuota();
	}

	/**
	 * What this machine is listening on.
	 *
	 * An agent that has just started a dev server leaves no other trace in this
	 * window — the run happened in its own terminal, or in none — so the port
	 * appearing here is how the user learns the thing is up, and on which port.
	 */
	private _updatePorts(): void {
		void this._hostService.readListeningPorts().then(ports => {
			if (this._store.isDisposed) {
				return;
			}
			if (ports.length === 0) {
				this._ports.clear();
				return;
			}
			// An address that belongs to a port nothing is serving any more is a lie
			// the next server on that port would inherit.
			this._advertisedUrls.retain(new Set(ports.map(port => port.port)));
			// The address the server announced when it can be had, because that is
			// what a person would type: the scheme, the host it chose and the path it
			// serves from are none of them recoverable from the socket.
			const rows = ports.map(port => {
				const advertised = this._advertisedUrls.get(port.port);
				return advertised ? `${describeListeningPort(port)} · ${advertised.url}` : describeListeningPort(port);
			}).join('\n');
			const entry: IStatusbarEntry = {
				name: localize('kingu.status.ports.name', "Listening ports"),
				text: `$(plug) ${ports.length}`,
				ariaLabel: localize('kingu.status.ports.aria', "{0} ports listening", ports.length),
				tooltip: localize('kingu.status.ports.tooltip', "Ports this app's processes are serving\n\n{0}\n\nClick to open one.", rows),
				command: KINGU_OPEN_PORT_COMMAND_ID,
			};
			if (this._ports.value) {
				this._ports.value.update(entry);
			} else {
				this._ports.value = this._statusbarService.addEntry(entry, 'kingu.status.ports', StatusbarAlignment.RIGHT, 94);
			}
		});
	}

	/**
	 * How many terminals this window is running.
	 *
	 * Shown only when there are any: zero terminals is the resting state and an
	 * entry saying so is noise.
	 */
	private _updateTerminals(): void {
		const count = this._terminalService.instances.length;
		if (count === 0) {
			this._terminals.clear();
			return;
		}
		const entry: IStatusbarEntry = {
			name: localize('kingu.status.terminals.name', "Terminals"),
			text: `$(terminal) ${count}`,
			ariaLabel: localize('kingu.status.terminals.aria', "{0} terminals running", count),
			tooltip: localize('kingu.status.terminals.tooltip', "{0} terminals running in this window", count),
			command: 'workbench.action.terminal.focus',
		};
		if (this._terminals.value) {
			this._terminals.value.update(entry);
		} else {
			this._terminals.value = this._statusbarService.addEntry(entry, 'kingu.status.terminals', StatusbarAlignment.RIGHT, 95);
		}
	}

	/**
	 * What the app is holding, across every process.
	 *
	 * Asked of the main process because a window can only see its own heap, which
	 * is a fraction of the answer once an agent host is running.
	 */
	private _updateMemory(): void {
		void this._hostService.readMemory().then(reading => {
			if (this._store.isDisposed || reading === undefined || reading.total <= 0) {
				return;
			}
			const text = formatBytes(reading.total);
			// The breakdown answers the question the total provokes. Only the few
			// largest: a list of every helper process is a process explorer, and the
			// strip is not one.
			const breakdown = reading.byKind.slice(0, MEMORY_KINDS_SHOWN)
				.map(part => `${part.kind}: ${formatBytes(part.bytes)}`)
				.join('\n');
			const entry: IStatusbarEntry = {
				name: localize('kingu.status.memory.name', "Memory"),
				text: `$(dashboard) ${text}`,
				ariaLabel: localize('kingu.status.memory.aria', "{0} of memory in use", text),
				tooltip: localize('kingu.status.memory.tooltip', "{0} across every process this app runs\n\n{1}", text, breakdown),
			};
			if (this._memory.value) {
				this._memory.value.update(entry);
			} else {
				this._memory.value = this._statusbarService.addEntry(entry, 'kingu.status.memory', StatusbarAlignment.RIGHT, 96);
			}
		});
	}

	/** Asks the provider on its own slower schedule than the bar redraws on. */
	private _maybeRefreshQuota(): void {
		const now = Date.now();
		if (now - this._lastQuotaRefresh < QUOTA_REFRESH_INTERVAL_MS) {
			return;
		}
		this._lastQuotaRefresh = now;
		void this._hostService.refresh();
	}

	/**
	 * A gauge per provider that reports one.
	 *
	 * Both windows on one entry, as the ADE shows them: half of five hours and
	 * half of a week are different news and a person reads them together.
	 *
	 * A provider that reports nothing gets no entry rather than an error chip.
	 * The bar is glanced at, not read, and a machine that never ran an agent's
	 * CLI is not in a fault state — it simply has no quota to report.
	 */
	private _updateProviders(): void {
		// Ordered so a provider appearing later does not shuffle the ones before it.
		let priority = 110;
		for (const provider of KINGU_STATUS_BAR_PROVIDERS) {
			this._updateProvider(provider, priority--);
		}
		this._updateRefreshButton(priority - 1);
	}

	/**
	 * What Codex reports about itself.
	 *
	 * Not a request: the agent host publishes the signed-in account's window with
	 * its own state, so this is read rather than asked for. It is folded into the
	 * same gauge as the providers that are asked, because where a number came
	 * from is this code's problem and not the reader's.
	 */
	private _codexWindows(): readonly IKinguRateLimit[] {
		const state = this._agentHostService.rootState.value;
		const limit = readRateLimitFromAccount(readCodexAccountInfo(state instanceof Error ? undefined : state));
		return limit ? [limit] : [];
	}

	/**
	 * Every provider's reading, including the ones with nothing to report.
	 *
	 * The strip drops a provider that reports nothing, because a bar of
	 * placeholders is worse than a shorter bar. The panel keeps it and says why:
	 * it was opened by someone asking a question about all of their agents, and
	 * "Grok is not signed in" is an answer to that question where an absent row
	 * is silence.
	 */
	private _usageSources(): IKinguUsageSource[] {
		return KINGU_STATUS_BAR_PROVIDERS.map(provider => {
			if (provider === KinguQuotaProvider.Codex) {
				// Not asked for: the agent host publishes it with its own state.
				const limits = this._codexWindows();
				return { provider, limits, problem: undefined, pending: false };
			}
			const result = this._hostService.quotas.get(provider);
			if (result === undefined) {
				return { provider, limits: [], problem: undefined, pending: true };
			}
			return result.ok
				? { provider, limits: [result.quota.session, result.quota.weekly].filter(limit => limit !== undefined), problem: undefined, pending: false }
				: { provider, limits: [], problem: result.problem, pending: false };
		});
	}

	/**
	 * The panel behind every gauge.
	 *
	 * Built on open rather than kept and updated, because a hover asks for its
	 * content at the moment it is shown — so what appears is drawn from the
	 * readings that exist then, and there is no stale element to reconcile.
	 *
	 * Every gauge opens the same panel. A person who clicks the Claude gauge is
	 * asking how much they have left, and the answer is rarely about one agent.
	 */
	private _rosterPanel(): HTMLElement {
		// Redrawn in place rather than by updating the status bar entries. Updating
		// an entry rebuilds its managed hover, which closes the panel — so pressing
		// a control inside it would make it vanish instead of answer.
		let root!: HTMLElement;
		const options = (): IKinguUsageRosterOptions => ({
			rows: usageRows(this._usageSources()),
			detail: this._detail,
			// One direction for now, and it is the one the gauge already draws:
			// two readings of the same window that count opposite ways is a choice
			// worth offering only once there is somewhere to offer it.
			display: 'used',
			refreshing: false,
			onDetailChange: detail => {
				this._detail = detail;
				this._storageService.store(USAGE_DETAIL_STORAGE_KEY, detail, StorageScope.PROFILE, StorageTarget.USER);
				updateKinguUsageRoster(root, options());
			},
			onRefresh: async () => {
				await this._commandService.executeCommand(KINGU_REFRESH_QUOTAS_COMMAND_ID);
				// The panel the user is looking at answers the refresh they asked
				// for; the entries behind it catch up on their own event.
				if (!this._store.isDisposed) {
					updateKinguUsageRoster(root, options());
				}
			},
			onDetails: () => void this._commandService.executeCommand(KINGU_STATS_COMMAND_ID),
		});
		root = renderKinguUsageRoster(options());
		return root;
	}

	private _updateProvider(provider: KinguQuotaProvider, priority: number): void {
		const existing = this._providers.get(provider);
		const result = provider === KinguQuotaProvider.Codex ? undefined : this._hostService.quotas.get(provider);
		const windows = provider === KinguQuotaProvider.Codex
			? this._codexWindows()
			: result?.ok
				? [result.quota.session, result.quota.weekly].filter(limit => limit !== undefined)
				: [];
		if (windows.length === 0) {
			existing?.dispose();
			this._providers.delete(provider);
			// The element went with the entry; a provider that reports again builds
			// a new one rather than re-appending an orphan.
			this._gauges.delete(provider);
			if (result && !result.ok) {
				this._logProblemOnce(provider, result.problem);
			}
			return;
		}

		const label = KINGU_QUOTA_PROVIDER_LABELS[provider];
		const text = windows.map(formatRateLimit).join(' · ');
		let gauge = this._gauges.get(provider);
		if (!gauge) {
			gauge = new KinguGauge(PROVIDER_ICONS[provider]);
			this._gauges.set(provider, gauge);
		}
		gauge.update(windows, text);
		const entry: IStatusbarEntry = {
			name: localize('kingu.status.quota.name', "{0} quota", label),
			// Empty: the label and the content element render side by side, so a
			// filled label would draw the reading twice.
			text: '',
			content: gauge.element,
			ariaLabel: localize('kingu.status.quota.aria', "{0} quota: {1}", label, text),
			// The panel, not a sentence. Earlier this was a string and clicking the
			// gauge refreshed it — which meant the strip could show a reading and
			// offer no way to see what was behind it.
			tooltip: { element: () => this._rosterPanel(), contentOwnsPadding: true },
			// Toggling pins the hover, which is what makes the controls inside it
			// reachable: an unpinned hover closes on the way to the button.
			command: ToggleTooltipCommand,
		};
		if (existing) {
			existing.update(entry);
		} else {
			this._providers.set(provider, this._statusbarService.addEntry(entry, `kingu.status.quota.${provider}`, StatusbarAlignment.LEFT, priority));
		}
	}

	/**
	 * The button that reads every gauge again.
	 *
	 * Beside the gauges rather than hidden in the palette, and only when there is
	 * a gauge to refresh: a lone refresh arrow next to nothing is a control with
	 * no subject. Clicking a gauge does the same thing; this is the affordance
	 * that says so.
	 */
	private _updateRefreshButton(priority: number): void {
		if (this._providers.size === 0) {
			this._refresh.clear();
			return;
		}
		const entry: IStatusbarEntry = {
			name: localize('kingu.status.refresh.name', "Refresh agent quotas"),
			text: '$(refresh)',
			ariaLabel: localize('kingu.status.refresh.aria', "Refresh agent quotas"),
			tooltip: localize('kingu.status.refresh.tooltip', "Read every agent's quota again"),
			command: KINGU_REFRESH_QUOTAS_COMMAND_ID,
		};
		if (this._refresh.value) {
			this._refresh.value.update(entry);
		} else {
			this._refresh.value = this._statusbarService.addEntry(entry, 'kingu.status.refresh', StatusbarAlignment.LEFT, priority);
		}
	}

	private readonly _loggedProblems = new Map<KinguQuotaProvider, KinguQuotaProblem>();

	/** Logged once per provider and reason: this runs on a timer and would otherwise repeat forever. */
	private _logProblemOnce(provider: KinguQuotaProvider, problem: KinguQuotaProblem): void {
		if (this._loggedProblems.get(provider) === problem) {
			return;
		}
		this._loggedProblems.set(provider, problem);
		this._logService.trace(`[Kingu] no ${provider} quota to show: ${problem}`);
	}

	/**
	 * How much history is on this machine, and a way into it.
	 *
	 * The one entry that always has something to say: the vault reads files that
	 * are already there, so it is populated before the user signs into anything.
	 * It is also what keeps the bar from being an empty strip on a fresh install.
	 *
	 * Deliberately does not trigger a scan — it renders what an earlier scan
	 * found, because a status bar must not make a window read five hundred files
	 * to draw itself.
	 */
	private _updateVault(): void {
		void this._vaultService.getSessions().then(sessions => {
			if (this._store.isDisposed) {
				return;
			}
			const entry: IStatusbarEntry = {
				name: localize('kingu.status.vault.name', "Kingu vault"),
				text: `$(archive) ${sessions.length}`,
				ariaLabel: localize('kingu.status.vault.aria', "{0} sessions in the vault", sessions.length),
				tooltip: localize('kingu.status.vault.tooltip', "{0} past sessions from every agent on this machine. Click to browse.", sessions.length),
				command: 'kingu.vault.open',
			};
			if (this._vault.value) {
				this._vault.value.update(entry);
			} else {
				this._vault.value = this._statusbarService.addEntry(entry, 'kingu.status.vault', StatusbarAlignment.RIGHT, 97);
			}
		}, () => { /* a vault that cannot be read gets no entry */ });
	}

	/**
	 * What this window is attached to.
	 *
	 * Shown only when there is a remote host, because "local" is the default and
	 * a permanent entry saying so is noise.
	 */
	private _updateRemote(): void {
		// Presence is not liveness: the catalog keeps a host after a failed dial so
		// its status stays observable, so the status is what decides.
		const connected = this._remoteAgentHostService.connections
			.filter(connection => RemoteAgentHostConnectionStatus.isConnected(connection.status));
		if (connected.length === 0) {
			this._remote.clear();
			return;
		}
		const names = connected.map(connection => connection.name || connection.address).filter(Boolean);
		// The state, not the host's name. The strip is read at a glance and the
		// question it answers there is whether the connection is up; which machine
		// is a second question, and the tooltip is where a second question goes.
		const where = connected.length === 1
			? localize('kingu.status.remote.connected', "Connected")
			: localize('kingu.status.remote.many', "{0} hosts", connected.length);
		const entry: IStatusbarEntry = {
			name: localize('kingu.status.remote.name', "Remote agent host"),
			// The trailing dot is the light: green while every host answers. It is
			// coloured from this entry's own id in CSS, because a status bar entry
			// colours its whole label at once and the host's name is not the news.
			text: `$(server) SSH ${where} $(circle-filled)`,
			ariaLabel: localize('kingu.status.remote.aria', "Connected to {0}", where),
			tooltip: names.join('\n'),
		};
		if (this._remote.value) {
			this._remote.value.update(entry);
		} else {
			this._remote.value = this._statusbarService.addEntry(entry, 'kingu.status.remote', StatusbarAlignment.RIGHT, 93);
		}
	}
}

registerWorkbenchContribution2(KinguStatusBarContribution.ID, KinguStatusBarContribution, WorkbenchPhase.AfterRestored);

/**
 * Reads every provider again now.
 *
 * The gauges refresh on their own slow schedule, which is right for a number
 * that moves over hours — but a person who has just finished a long run wants
 * to see the cost of it without waiting, so clicking a gauge asks again.
 */
class RefreshKinguQuotasAction extends Action2 {

	constructor() {
		super({
			id: KINGU_REFRESH_QUOTAS_COMMAND_ID,
			title: localize2('kingu.status.refreshQuotas', "Kingu: Refresh Agent Quotas"),
			category: Categories.View,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IKinguHostService).refresh();
	}
}

registerAction2(RefreshKinguQuotasAction);

/**
 * Opens one of the ports this app is serving.
 *
 * The number in the strip is where a person notices their dev server came up;
 * this is the step they take next, and without it they would read the number
 * and then type it into a browser themselves.
 */
class OpenKinguPortAction extends Action2 {

	constructor() {
		super({
			id: KINGU_OPEN_PORT_COMMAND_ID,
			title: localize2('kingu.status.openPort', "Kingu: Open a Listening Port"),
			category: Categories.View,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		// Taken before the first await: the accessor is only valid synchronously.
		const hostService = accessor.get(IKinguHostService);
		const quickInputService = accessor.get(IQuickInputService);
		const openerService = accessor.get(IOpenerService);
		const advertisedUrls = accessor.get(IKinguAdvertisedUrlService);

		const ports = await hostService.readListeningPorts();
		if (ports.length === 0) {
			return;
		}
		const picked = await quickInputService.pick(
			ports.map(port => {
				const advertised = advertisedUrls.get(port.port);
				return {
					label: String(port.port),
					description: port.process,
					// Shown so the choice is made on the address that will open, not on
					// a number and a hope. A port with no announcement shows none.
					detail: advertised?.url,
					port,
					advertised,
				};
			}),
			{ title: localize('kingu.status.openPort.title', "Open a listening port"), placeHolder: localize('kingu.status.openPort.placeholder', "Ports this app's processes are serving"), matchOnDetail: true });
		if (picked) {
			// The address the server announced, when it announced one: it knows its
			// own scheme, hostname and path, and none of those can be read off the
			// socket. Failing that, loopback — a server on `0.0.0.0` is reached from
			// this machine at localhost, and this machine is the one doing the asking.
			const fallback = `http://localhost:${picked.port.port}`;
			const candidate = picked.advertised?.url ?? fallback;
			// Checked again here even though nothing that is not this machine is
			// recorded. This is the line that actually navigates, and it is one
			// refactor away from being handed a URL that came from terminal output
			// without passing that filter; the check is cheap and the failure is a
			// person being sent to somebody else's site by a control labelled
			// "open this port".
			const url = URI.parse(candidate);
			const safe = (url.scheme === 'http' || url.scheme === 'https') && isLocalhostEquivalent(url.authority.replace(/^.*@/, '').replace(/:\d+$/, ''));
			await openerService.open(URI.parse(safe ? candidate : fallback), { openExternal: true });
		}
	}
}

registerAction2(OpenKinguPortAction);
