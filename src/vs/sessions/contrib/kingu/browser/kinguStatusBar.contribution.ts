/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/kinguStatusBar.css';
import { mainWindow } from '../../../../base/browser/window.js';
import { Codicon } from '../../../../base/common/codicons.js';
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
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../../workbench/services/statusbar/browser/statusbar.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { KINGU_QUOTA_PROVIDER_LABELS, KINGU_QUOTA_PROVIDERS, KinguQuotaProvider } from '../../../../platform/kinguHost/common/kinguQuotaProviders.js';
import { KinguQuotaProblem } from '../../../../platform/kinguHost/common/kinguRateLimits.js';
import { IKinguHostService } from '../../../../platform/kinguHost/common/kinguHostService.js';
import { KinguHostService } from './kinguHostService.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IKinguVaultService } from '../common/kinguVault.js';
import { formatRateLimit, formatWindow, IKinguRateLimit, readRateLimitFromAccount } from '../common/kinguStatusBar.js';

registerSingleton(IKinguHostService, KinguHostService, InstantiationType.Delayed);

/**
 * A codicon per provider.
 *
 * Not their logos: shipping a brand's mark means shipping its asset and its
 * terms, and a shape that merely resembles one is worse than an honest generic.
 * Distinct enough to tell two gauges apart at a glance, which is the job.
 */
const PROVIDER_ICONS: Readonly<Record<KinguQuotaProvider, ThemeIcon>> = {
	[KinguQuotaProvider.Claude]: Codicon.flame,
	[KinguQuotaProvider.Grok]: Codicon.zap,
	[KinguQuotaProvider.Kimi]: Codicon.circleFilled,
	[KinguQuotaProvider.Gemini]: Codicon.sparkle,
};

export const KINGU_REFRESH_QUOTAS_COMMAND_ID = 'kingu.status.refreshQuotas';

/** A byte count as the unit a person would say: `1.2 GB`, `840 MB`. */
function formatBytes(bytes: number): string {
	const gb = bytes / 1024 ** 3;
	return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** How many cells the bar is drawn with. */
const GAUGE_CELLS = 8;

/**
 * The bar, drawn in the label rather than as an element.
 *
 * A status bar entry does take an `HTMLElement`, but only its constructor reads
 * it — `update()` refreshes the text and leaves the element alone, so a bar
 * built that way freezes at whatever the first reading was. Drawn in the label
 * it tracks the value, which is the entire point of a gauge.
 *
 * It fills to the fullest window, since that is the one that will stop the user
 * first, while the text still names every window.
 */
function renderGauge(windows: readonly IKinguRateLimit[], text: string): string {
	const worst = windows.reduce((highest, limit) => limit.usedPercent > highest.usedPercent ? limit : highest, windows[0]);
	const filled = Math.round((worst.usedPercent / 100) * GAUGE_CELLS);
	// A non-zero reading keeps at least one cell: a bar that reads empty while the
	// number beside it does not is worse than a coarse bar.
	const cells = worst.usedPercent > 0 ? Math.max(1, filled) : 0;
	return '█'.repeat(cells) + '░'.repeat(GAUGE_CELLS - cells) + ' ' + text;
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

	private readonly _rateLimit = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly _remote = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly _vault = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly _terminals = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly _memory = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly _ports = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly _providers = new Map<KinguQuotaProvider, IStatusbarEntryAccessor>();
	private _lastQuotaRefresh = 0;

	constructor(
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@ILogService private readonly _logService: ILogService,
		@IAgentHostService private readonly _agentHostService: IAgentHostService,
		@IRemoteAgentHostService private readonly _remoteAgentHostService: IRemoteAgentHostService,
		@IKinguVaultService private readonly _vaultService: IKinguVaultService,
		@IKinguHostService private readonly _hostService: IKinguHostService,
		@ITerminalService private readonly _terminalService: ITerminalService,
	) {
		super();

		this._update();

		// Both sources push, so the poll is only a backstop for the parts of the
		// quota that change with time rather than with an event (a window resetting).
		this._register(this._agentHostService.rootState.onDidChange(() => this._updateRateLimit()));
		this._register(this._remoteAgentHostService.onDidChangeConnections(() => this._updateRemote()));
		this._register(this._vaultService.onDidChangeSessions(() => this._updateVault()));
		this._register(this._hostService.onDidChange(() => this._updateProviders()));
		this._register(this._terminalService.onDidChangeInstances(() => this._updateTerminals()));
		this._register({ dispose: () => { for (const entry of this._providers.values()) { entry.dispose(); } this._providers.clear(); } });
		const timer = mainWindow.setInterval(() => this._update(), REFRESH_INTERVAL_MS);
		this._register({ dispose: () => mainWindow.clearInterval(timer) });
	}

	private _update(): void {
		this._updateRateLimit();
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
			const numbers = ports.map(port => port.port);
			const entry: IStatusbarEntry = {
				name: localize('kingu.status.ports.name', "Listening ports"),
				text: `$(plug) ${ports.length}`,
				ariaLabel: localize('kingu.status.ports.aria', "{0} ports listening", ports.length),
				tooltip: localize('kingu.status.ports.tooltip', "Listening on {0}", numbers.join(', ')),
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
		void this._hostService.readMemoryBytes().then(bytes => {
			if (this._store.isDisposed || bytes === undefined || bytes <= 0) {
				return;
			}
			const text = formatBytes(bytes);
			const entry: IStatusbarEntry = {
				name: localize('kingu.status.memory.name', "Memory"),
				text: `$(dashboard) ${text}`,
				ariaLabel: localize('kingu.status.memory.aria', "{0} of memory in use", text),
				tooltip: localize('kingu.status.memory.tooltip', "{0} across every process this app runs", text),
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
		for (const provider of KINGU_QUOTA_PROVIDERS) {
			this._updateProvider(provider, priority--);
		}
	}

	private _updateProvider(provider: KinguQuotaProvider, priority: number): void {
		const existing = this._providers.get(provider);
		const result = this._hostService.quotas.get(provider);
		const windows = result?.ok
			? [result.quota.session, result.quota.weekly].filter(limit => limit !== undefined)
			: [];
		if (windows.length === 0) {
			existing?.dispose();
			this._providers.delete(provider);
			if (result && !result.ok) {
				this._logProblemOnce(provider, result.problem);
			}
			return;
		}

		const label = KINGU_QUOTA_PROVIDER_LABELS[provider];
		const text = windows.map(formatRateLimit).join(' · ');
		const entry: IStatusbarEntry = {
			name: localize('kingu.status.quota.name', "{0} quota", label),
			// `text` is the fallback for surfaces that cannot take an element, and the
			// accessible name comes from `ariaLabel` either way.
			text: `$(${PROVIDER_ICONS[provider].id}) ${renderGauge(windows, text)}`,
			ariaLabel: localize('kingu.status.quota.aria', "{0} quota: {1}", label, text),
			tooltip: this._quotaTooltip(label, windows),
			command: KINGU_REFRESH_QUOTAS_COMMAND_ID,
		};
		if (existing) {
			existing.update(entry);
		} else {
			this._providers.set(provider, this._statusbarService.addEntry(entry, `kingu.status.quota.${provider}`, StatusbarAlignment.LEFT, priority));
		}
	}

	private _quotaTooltip(label: string, windows: readonly IKinguRateLimit[]): string {
		return windows.map(limit => {
			const used = Math.round(limit.usedPercent);
			const window = limit.windowDurationMins === undefined ? '' : ' ' + formatWindow(limit.windowDurationMins);
			return limit.resetsAt
				? localize('kingu.status.quota.windowReset', "{0}{1}: {2}% used, resets {3}", label, window, used, new Date(limit.resetsAt).toLocaleString())
				: localize('kingu.status.quota.window', "{0}{1}: {2}% used", label, window, used);
		}).join('\n');
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
	 * The quota gauge, from what the agent host already reports about the account.
	 *
	 * Only Codex publishes this today. The others get no gauge rather than a
	 * guessed one; when a host starts reporting theirs, it appears here.
	 */
	private _updateRateLimit(): void {
		const state = this._agentHostService.rootState.value;
		const account = readCodexAccountInfo(state instanceof Error ? undefined : state);
		const limit = readRateLimitFromAccount(account);
		if (!limit) {
			this._rateLimit.clear();
			return;
		}
		const entry = this._rateLimitEntry(limit);
		if (this._rateLimit.value) {
			this._rateLimit.value.update(entry);
		} else {
			this._rateLimit.value = this._statusbarService.addEntry(entry, 'kingu.status.rateLimit', StatusbarAlignment.LEFT, 100);
		}
	}

	private _rateLimitEntry(limit: IKinguRateLimit): IStatusbarEntry {
		const text = formatRateLimit(limit);
		return {
			name: localize('kingu.status.rateLimit.name', "Agent quota"),
			text: `$(pulse) ${text}`,
			ariaLabel: localize('kingu.status.rateLimit.aria', "Codex quota: {0}", text),
			tooltip: limit.resetsAt
				? localize('kingu.status.rateLimit.tooltipReset', "Codex: {0} of the window used. Resets {1}.", `${Math.round(limit.usedPercent)}%`, new Date(limit.resetsAt).toLocaleString())
				: localize('kingu.status.rateLimit.tooltip', "Codex: {0} of the window used.", `${Math.round(limit.usedPercent)}%`),
		};
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
		const where = connected.length === 1
			? names[0] ?? localize('kingu.status.remote.unnamed', "Connected")
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
