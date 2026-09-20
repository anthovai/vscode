/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/kinguStatusBar.css';
import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAgentHostService } from '../../../../platform/agentHost/common/agentService.js';
import { readCodexAccountInfo } from '../../../../platform/agentHost/common/meta/codexAccount.js';
import { IRemoteAgentHostService, RemoteAgentHostConnectionStatus } from '../../../../platform/agentHost/common/remoteAgentHostService.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../../workbench/services/statusbar/browser/statusbar.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IKinguRateLimitService, KinguQuotaProblem } from '../../../../platform/kinguRateLimits/common/kinguRateLimits.js';
import { KinguRateLimitService } from './kinguRateLimitService.js';
import { IKinguVaultService } from '../common/kinguVault.js';
import { formatRateLimit, IKinguRateLimit, readRateLimitFromAccount } from '../common/kinguStatusBar.js';

registerSingleton(IKinguRateLimitService, KinguRateLimitService, InstantiationType.Delayed);

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
	private readonly _claude = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private _lastQuotaRefresh = 0;

	constructor(
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@ILogService private readonly _logService: ILogService,
		@IAgentHostService private readonly _agentHostService: IAgentHostService,
		@IRemoteAgentHostService private readonly _remoteAgentHostService: IRemoteAgentHostService,
		@IKinguVaultService private readonly _vaultService: IKinguVaultService,
		@IKinguRateLimitService private readonly _rateLimitService: IKinguRateLimitService,
	) {
		super();

		this._update();

		// Both sources push, so the poll is only a backstop for the parts of the
		// quota that change with time rather than with an event (a window resetting).
		this._register(this._agentHostService.rootState.onDidChange(() => this._updateRateLimit()));
		this._register(this._remoteAgentHostService.onDidChangeConnections(() => this._updateRemote()));
		this._register(this._vaultService.onDidChangeSessions(() => this._updateVault()));
		this._register(this._rateLimitService.onDidChange(() => this._updateClaude()));
		const timer = mainWindow.setInterval(() => this._update(), REFRESH_INTERVAL_MS);
		this._register({ dispose: () => mainWindow.clearInterval(timer) });
	}

	private _update(): void {
		this._updateRateLimit();
		this._updateRemote();
		this._updateVault();
		this._updateClaude();
		this._maybeRefreshQuota();
	}

	/** Asks the provider on its own slower schedule than the bar redraws on. */
	private _maybeRefreshQuota(): void {
		const now = Date.now();
		if (now - this._lastQuotaRefresh < QUOTA_REFRESH_INTERVAL_MS) {
			return;
		}
		this._lastQuotaRefresh = now;
		void this._rateLimitService.refresh();
	}

	/**
	 * Claude's quota, from the account this machine is already signed into.
	 *
	 * Both windows on one entry, as the ADE shows them: half of five hours and
	 * half of a week are different news and a person reads them together.
	 *
	 * A failure shows nothing rather than an error chip. The bar is glanced at,
	 * not read, and a machine that never ran the Claude CLI is not in a fault
	 * state — it simply has no quota to report.
	 */
	private _updateClaude(): void {
		const result = this._rateLimitService.claude;
		if (!result?.ok) {
			this._claude.clear();
			if (result) {
				this._logProblemOnce(result.problem);
			}
			return;
		}
		const windows = [result.quota.session, result.quota.weekly].filter(limit => limit !== undefined);
		if (windows.length === 0) {
			this._claude.clear();
			return;
		}
		const text = windows.map(formatRateLimit).join(' · ');
		const entry: IStatusbarEntry = {
			name: localize('kingu.status.claude.name', "Claude quota"),
			text: `$(flame) ${text}`,
			ariaLabel: localize('kingu.status.claude.aria', "Claude quota: {0}", text),
			tooltip: this._claudeTooltip(result.quota.session, result.quota.weekly),
		};
		if (this._claude.value) {
			this._claude.value.update(entry);
		} else {
			this._claude.value = this._statusbarService.addEntry(entry, 'kingu.status.claude', StatusbarAlignment.LEFT, 110);
		}
	}

	private _claudeTooltip(session: IKinguRateLimit | undefined, weekly: IKinguRateLimit | undefined): string {
		const lines: string[] = [];
		if (session) {
			lines.push(session.resetsAt
				? localize('kingu.status.claude.sessionReset', "Session window: {0}% used, resets {1}", Math.round(session.usedPercent), new Date(session.resetsAt).toLocaleString())
				: localize('kingu.status.claude.session', "Session window: {0}% used", Math.round(session.usedPercent)));
		}
		if (weekly) {
			lines.push(weekly.resetsAt
				? localize('kingu.status.claude.weeklyReset', "Weekly window: {0}% used, resets {1}", Math.round(weekly.usedPercent), new Date(weekly.resetsAt).toLocaleString())
				: localize('kingu.status.claude.weekly', "Weekly window: {0}% used", Math.round(weekly.usedPercent)));
		}
		return lines.join('\n');
	}

	private _loggedProblem: KinguQuotaProblem | undefined;

	/** Logged once per distinct reason: this runs on a timer and would otherwise repeat forever. */
	private _logProblemOnce(problem: KinguQuotaProblem): void {
		if (this._loggedProblem === problem) {
			return;
		}
		this._loggedProblem = problem;
		this._logService.trace(`[Kingu] no Claude quota to show: ${problem}`);
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
				this._vault.value = this._statusbarService.addEntry(entry, 'kingu.status.vault', StatusbarAlignment.RIGHT, 90);
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
		const text = connected.length === 1
			? localize('kingu.status.remote.one', "{0}", names[0] ?? localize('kingu.status.remote.unnamed', "remote"))
			: localize('kingu.status.remote.many', "{0} hosts", connected.length);
		const entry: IStatusbarEntry = {
			name: localize('kingu.status.remote.name', "Remote agent host"),
			text: `$(remote) ${text}`,
			ariaLabel: localize('kingu.status.remote.aria', "Connected to {0}", text),
			tooltip: names.join('\n'),
		};
		if (this._remote.value) {
			this._remote.value.update(entry);
		} else {
			this._remote.value = this._statusbarService.addEntry(entry, 'kingu.status.remote', StatusbarAlignment.RIGHT, 100);
		}
	}
}

registerWorkbenchContribution2(KinguStatusBarContribution.ID, KinguStatusBarContribution, WorkbenchPhase.AfterRestored);
