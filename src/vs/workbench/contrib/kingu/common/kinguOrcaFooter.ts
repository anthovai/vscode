/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { displayedUsagePercent, formatResetDuration, KinguUsageDisplay } from './kinguStatusBar.js';

/**
 * The ADE's footer, as a model.
 *
 * Every rule here is the ADE's own — which providers earn a segment, which of a
 * provider's windows are shown and in what order, what each is called, how the
 * number reads — ported from `status-bar/StatusBarProviderSegment.tsx`,
 * `status-bar-provider-visibility.ts`, `lib/window-label-formatter.ts` and
 * `resource-usage-metrics.tsx`. The footer that draws it holds none of them, so
 * the two cannot drift apart on a rule without a test here saying so.
 */

// #region The ADE's shapes, as far as the footer reads them

/** `RateLimitWindow` in the ADE's `shared/rate-limit-types.ts`. */
export interface IOrcaRateLimitWindow {
	readonly usedPercent: number;
	readonly windowMinutes: number;
	readonly resetsAt: number | null;
}

export type OrcaProviderStatus = 'idle' | 'fetching' | 'ok' | 'error' | 'unavailable';

/** `ProviderRateLimits`, trimmed to what the footer reads. */
export interface IOrcaProviderRateLimits {
	readonly provider: string;
	readonly session: IOrcaRateLimitWindow | null;
	readonly weekly: IOrcaRateLimitWindow | null;
	readonly fableWeekly?: IOrcaRateLimitWindow | null;
	readonly monthly?: IOrcaRateLimitWindow | null;
	readonly buckets?: readonly (IOrcaRateLimitWindow & { readonly name: string })[];
	readonly status: OrcaProviderStatus;
	readonly error: string | null;
}

/** `RateLimitState`: one slot per provider, keyed as the ADE keys it. */
export type OrcaRateLimitState = Readonly<Record<string, IOrcaProviderRateLimits | null | boolean | undefined>>;

// #endregion

/**
 * The providers the footer can show, in the ADE's order.
 *
 * `slot` is the key in `RateLimitState`, which differs from the provider id for
 * one provider (`opencodeGo` holds `opencode-go`).
 */
export const ORCA_FOOTER_PROVIDERS: readonly { readonly slot: string; readonly name: string }[] = [
	{ slot: 'claude', name: 'Claude' },
	{ slot: 'codex', name: 'Codex' },
	{ slot: 'gemini', name: 'Gemini' },
	{ slot: 'antigravity', name: 'Antigravity' },
	{ slot: 'opencodeGo', name: 'OpenCode Go' },
	{ slot: 'kimi', name: 'Kimi' },
	{ slot: 'minimax', name: 'MiniMax' },
	{ slot: 'grok', name: 'Grok' },
];

function hasUsageData(provider: IOrcaProviderRateLimits): boolean {
	return Boolean(provider.session || provider.weekly || provider.fableWeekly || provider.monthly || (provider.buckets && provider.buckets.length > 0));
}

/**
 * Whether a provider has earned a segment: it has reported something real.
 *
 * `unavailable` never shows, and neither does a first fetch still in flight —
 * a row of `···` for every agent the machine might have would be a status bar
 * of placeholders.
 */
export function isProviderShown(provider: IOrcaProviderRateLimits | null | boolean | undefined): provider is IOrcaProviderRateLimits {
	if (!provider || typeof provider !== 'object' || provider.status === 'unavailable') {
		return false;
	}
	return !(provider.status === 'fetching' && !hasUsageData(provider));
}

/** `formatWindowLabel`: the window's length, for when no reset time is known. */
export function formatOrcaWindowLabel(windowMinutes: number): string {
	if (windowMinutes === 10_080) {
		return 'wk';
	}
	if (windowMinutes === 300) {
		return '5h';
	}
	if (windowMinutes === 60) {
		return '1h';
	}
	if (windowMinutes < 60) {
		return `${windowMinutes}m`;
	}
	if (windowMinutes % 10_080 === 0) {
		return `${windowMinutes / 10_080}wk`;
	}
	if (windowMinutes % 1_440 === 0) {
		return `${windowMinutes / 1_440}d`;
	}
	if (windowMinutes % 60 === 0) {
		return `${windowMinutes / 60}h`;
	}
	return `${windowMinutes}m`;
}

/** `formatRateLimitWindowChipLabel`: time to reset when known, else the length. */
export function formatOrcaChipLabel(window: IOrcaRateLimitWindow, now: number): string {
	return window.resetsAt !== null ? formatResetDuration(window.resetsAt - now) : formatOrcaWindowLabel(window.windowMinutes);
}

/** `formatUsagePercentageLabel`: `58% used`, or `42% left`. */
export function formatOrcaUsageLabel(usedPercent: number, display: KinguUsageDisplay): string {
	const percent = displayedUsagePercent(usedPercent, display);
	return display === 'used' ? `${percent}% used` : `${percent}% left`;
}

/** One reading in a provider's segment. */
export interface IOrcaFooterWindow {
	readonly key: string;
	readonly usedPercent: number;
	/** What follows the percentage: a countdown, a window length, or a name. */
	readonly label: string;
	/** A bucket reads its name *before* the number; a window reads its label after. */
	readonly labelFirst?: boolean;
	readonly resetsAt: number | null;
}

/** Gemini's buckets the ADE puts on the footer; the rest are for the detail panel. */
const FOOTER_BUCKET_NAMES = new Set(['Flash', 'Pro', '1.5 Pro']);

/**
 * The readings a provider's segment shows, in order.
 *
 * Gemini reports named buckets and shows the footer-worthy ones by name. The
 * others show the session, the week and — for Claude — the Fable week, named
 * `Fable` rather than counted down. A monthly window only appears on the strip
 * for a provider that has nothing else; everywhere else it belongs to the panel.
 */
export function providerFooterWindows(provider: IOrcaProviderRateLimits, now: number): readonly IOrcaFooterWindow[] {
	if (provider.buckets && provider.buckets.length > 0) {
		const buckets = provider.buckets
			.filter(bucket => FOOTER_BUCKET_NAMES.has(bucket.name))
			.map(bucket => ({ key: `bucket:${bucket.name}`, usedPercent: bucket.usedPercent, label: bucket.name, labelFirst: true, resetsAt: bucket.resetsAt }));
		if (buckets.length > 0 || !provider.session) {
			return buckets;
		}
		return [{ key: 'session', usedPercent: provider.session.usedPercent, label: formatOrcaChipLabel(provider.session, now), resetsAt: provider.session.resetsAt }];
	}
	const windows: IOrcaFooterWindow[] = [];
	if (provider.session) {
		windows.push({ key: 'session', usedPercent: provider.session.usedPercent, label: formatOrcaChipLabel(provider.session, now), resetsAt: provider.session.resetsAt });
	}
	if (provider.weekly) {
		windows.push({ key: 'weekly', usedPercent: provider.weekly.usedPercent, label: formatOrcaChipLabel(provider.weekly, now), resetsAt: provider.weekly.resetsAt });
	}
	if (provider.fableWeekly) {
		windows.push({ key: 'fableWeekly', usedPercent: provider.fableWeekly.usedPercent, label: 'Fable', resetsAt: provider.fableWeekly.resetsAt });
	}
	if (provider.monthly && !provider.session && !provider.weekly) {
		windows.push({ key: 'monthly', usedPercent: provider.monthly.usedPercent, label: formatOrcaChipLabel(provider.monthly, now), resetsAt: provider.monthly.resetsAt });
	}
	return windows;
}

/**
 * The reading the segment's bar fills from: the most consumed.
 *
 * Chosen by consumption even when the footer displays `% left` — the bar is an
 * urgency signal, and urgency is about what is gone.
 */
export function tightestFooterWindow(windows: readonly IOrcaFooterWindow[]): IOrcaFooterWindow | undefined {
	return windows.reduce<IOrcaFooterWindow | undefined>((tightest, window) => !tightest || window.usedPercent > tightest.usedPercent ? window : tightest, undefined);
}

/** The text of one reading: `58% used 3h 54m`, or `Pro 12% used` for a bucket. */
export function formatFooterWindow(window: IOrcaFooterWindow, display: KinguUsageDisplay): string {
	const usage = formatOrcaUsageLabel(window.usedPercent, display);
	return window.labelFirst ? `${window.label} ${usage}` : `${usage} ${window.label}`;
}

/** `formatMemory` from the ADE's resource-usage metrics: KB below a megabyte, two decimals of GB above a gigabyte. */
export function formatOrcaMemory(bytes: number): string {
	if (bytes < 1024 * 1024) {
		return `${Math.round(bytes / 1024)} KB`;
	}
	if (bytes < 1024 * 1024 * 1024) {
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** The ADE's keep-awake modes. */
export type OrcaAwakeMode = 'on' | 'auto' | 'off';

/** `normalizeComputerAwakeMode`: the legacy boolean reads as `auto`. */
export function normalizeOrcaAwakeMode(mode: unknown, legacyAutoEnabled?: unknown): OrcaAwakeMode {
	if (mode === 'on' || mode === 'auto' || mode === 'off') {
		return mode;
	}
	return legacyAutoEnabled === true ? 'auto' : 'off';
}

/** `SshConnectionStatus` in the ADE. */
export type OrcaSshStatus = 'disconnected' | 'connecting' | 'auth-failed' | 'deploying-relay' | 'connected' | 'reconnecting' | 'reconnection-failed' | 'error';

/** What the remote-hosts segment shows: `remote-host-connection-status.ts`, rule for rule. */
export interface IOrcaSshSummary {
	readonly overall: 'connected' | 'partial' | 'disconnected' | 'connecting';
	readonly connected: number;
	/** `bg-emerald-500`, `bg-yellow-500`, or the muted dot. */
	readonly dot: 'emerald' | 'yellow' | 'muted';
}

/** `sshStatusForOverall`: connected, connecting (any step on the way), or not. */
export function sshHostStatus(status: OrcaSshStatus | undefined): 'connected' | 'connecting' | 'disconnected' {
	if (status === 'connected') {
		return 'connected';
	}
	return status === 'connecting' || status === 'deploying-relay' || status === 'reconnecting' ? 'connecting' : 'disconnected';
}

/** `overallStatus` and `overallDotColor` over every host's status. */
export function summarizeSshStatuses(statuses: readonly (OrcaSshStatus | undefined)[]): IOrcaSshSummary {
	const hosts = statuses.map(sshHostStatus);
	const connected = hosts.filter(status => status === 'connected').length;
	let overall: IOrcaSshSummary['overall'];
	if (hosts.length === 0) {
		overall = 'disconnected';
	} else if (hosts.every(status => status === 'connected')) {
		overall = 'connected';
	} else if (hosts.some(status => status === 'connecting')) {
		overall = 'connecting';
	} else if (connected > 0) {
		overall = 'partial';
	} else {
		overall = 'disconnected';
	}
	const dot = overall === 'connected' || (overall === 'partial' && connected > 0) ? 'emerald' : overall === 'connecting' ? 'yellow' : 'muted';
	return { overall, connected, dot };
}
