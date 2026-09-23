/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { displayedUsagePercent, formatResetDuration, KinguUsageDisplay } from './kinguStatusBar.js';
import { formatOrcaChipLabel, formatOrcaWindowLabel, IOrcaProviderRateLimits, IOrcaRateLimitWindow, ORCA_FOOTER_PROVIDERS, OrcaRateLimitState } from './kinguOrcaFooter.js';

/**
 * The ADE's usage panel, as a model: `status-bar/UsageRosterPanel.tsx`,
 * `tooltip.tsx`, `usage-error-copy.ts`, `usage-roster-row-state.ts`,
 * `usage-roster-formatting.ts` and `status-bar-claude-accounts.ts`, rule for
 * rule. The panel that draws it holds none of them.
 */

/** `StatusBarUsageMode`: every window with bars, or only the tightest. */
export type OrcaUsageMode = 'verbose' | 'compact';

/** `ProviderRateLimits` with the fields the panel reads beyond the footer's. */
export interface IOrcaUsageProvider extends IOrcaProviderRateLimits {
	readonly updatedAt?: number;
	readonly planType?: string | null;
	readonly usageMetadata?: { readonly failureKind?: string; readonly credentialSource?: string };
	readonly rateLimitResetCredits?: { readonly availableCount: number; readonly nextExpiresAt?: number | null } | null;
}

/** One labelled window of a provider: `Session`, `Weekly`, `Fable`, `Monthly`, or a Gemini bucket. */
export interface IOrcaUsageSection {
	readonly key: string;
	readonly label: string;
	readonly window: IOrcaRateLimitWindow;
	/** Buckets and the Fable week keep their name in both modes. */
	readonly named: boolean;
}

/** `getWindowSections`, with the empty windows dropped. */
export function usageSections(provider: IOrcaUsageProvider): readonly IOrcaUsageSection[] {
	const sections: IOrcaUsageSection[] = [];
	if (provider.buckets && provider.buckets.length > 0) {
		for (const bucket of provider.buckets) {
			sections.push({ key: `bucket:${bucket.name}`, label: bucket.name, window: bucket, named: true });
		}
		if (provider.weekly) {
			sections.push({ key: 'weekly', label: 'Weekly', window: provider.weekly, named: false });
		}
		return sections;
	}
	if (provider.session) {
		sections.push({ key: 'session', label: 'Session', window: provider.session, named: false });
	}
	if (provider.weekly) {
		sections.push({ key: 'weekly', label: 'Weekly', window: provider.weekly, named: false });
	}
	if (provider.fableWeekly) {
		sections.push({ key: 'fableWeekly', label: 'Fable', window: provider.fableWeekly, named: true });
	}
	if (provider.monthly) {
		sections.push({ key: 'monthly', label: 'Monthly', window: provider.monthly, named: false });
	}
	return sections;
}

/** `shortLabel`: a bucket or the Fable week by name; else the window's length (detailed) or its countdown (compact). */
export function sectionShortLabel(section: IOrcaUsageSection, mode: OrcaUsageMode, now: number): string {
	if (section.named) {
		return section.label;
	}
	return mode === 'verbose' ? formatOrcaWindowLabel(section.window.windowMinutes) : formatOrcaChipLabel(section.window, now);
}

/** The section with the most consumed, which compact mode shows alone. */
export function tightestSection(sections: readonly IOrcaUsageSection[]): IOrcaUsageSection | undefined {
	return sections.reduce<IOrcaUsageSection | undefined>((tightest, section) => !tightest || section.window.usedPercent > tightest.window.usedPercent ? section : tightest, undefined);
}

/** `clampUsedPercent`. */
export function clampUsed(percent: number): number {
	return Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
}

/** `barColor`: neutral below 60%, yellow below 80%, red above — always by what is used. */
export function usageBarTone(usedPercent: number): 'muted' | 'yellow' | 'red' {
	return usedPercent < 60 ? 'muted' : usedPercent < 80 ? 'yellow' : 'red';
}

/** `usageTextColorClass`: the foreground below 60%, yellow below 80%, red above. */
export function usageTextTone(usedPercent: number): 'foreground' | 'yellow' | 'red' {
	return usedPercent >= 80 ? 'red' : usedPercent >= 60 ? 'yellow' : 'foreground';
}

/** `formatResetCountdown`. */
export function formatResetCountdown(ms: number): string {
	const duration = formatResetDuration(ms);
	return duration === 'now' ? 'Resets now' : `Resets in ${duration}`;
}

/** `formatTimeAgo`, as the provider panel's "Updated …" line reads it. */
export function formatUpdatedAgo(updatedAt: number | undefined, now: number): string {
	if (!updatedAt) {
		return 'Not yet updated';
	}
	const diff = now - updatedAt;
	if (diff < 60_000) {
		return 'Updated just now';
	}
	const minutes = Math.floor(diff / 60_000);
	return minutes < 60 ? `Updated ${minutes}m ago` : `Updated ${Math.floor(minutes / 60)}h ago`;
}

/** `formatPlanLabel`: `plus` → `Plus`, `chatgpt_pro` → `ChatGPT Pro`. */
export function formatPlanLabel(planType: string | null | undefined): string | undefined {
	const words = (planType ?? '').split(/[\s_-]+/).filter(Boolean);
	if (words.length === 0) {
		return undefined;
	}
	return words.map(word => word.toLowerCase() === 'chatgpt' ? 'ChatGPT' : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
}

/** The percentage shown, `used` or `left`. */
export function usagePercentLabel(usedPercent: number, display: KinguUsageDisplay): string {
	const shown = displayedUsagePercent(usedPercent, display);
	return display === 'used' ? `${shown}% used` : `${shown}% left`;
}

const SIGNED_OUT_PATTERNS = [
	/\bnot signed in\b/i,
	/\bnot logged in\b/i,
	/\blogged out\b/i,
	/\bauthentication required\b/i,
	/\b(?:sign|log)[ -]?in required\b/i,
	/\bplease (?:sign|log) in\b/i,
	/\bplease reauthenticate\b/i,
];

function isUsageRateLimitError(message: string | null): boolean {
	if (!message || /\bauthentication required\b/i.test(message)) {
		return false;
	}
	return /\brate[- ]?limits?\b|\brate[- ]?limited\b/i.test(message);
}

/** `getProviderUsageStatusLabel`. */
export function usageStatusLabel(provider: IOrcaUsageProvider): string {
	const failure = provider.usageMetadata?.failureKind;
	if (failure === 'delegated-refresh-required' && provider.provider === 'grok') {
		return 'Run Grok to refresh';
	}
	if (failure === 'delegated-refresh-required' && provider.provider === 'kimi') {
		return 'Run Kimi to refresh';
	}
	if (provider.provider === 'claude') {
		switch (failure) {
			case 'deferred-by-live-session': return 'Waiting for Claude session';
			case 'stale-token':
			case 'refreshable-credentials-without-token':
			case 'delegated-refresh-required': return 'Refreshing sign-in';
			case 'network': return 'Network issue';
			case 'keychain-unavailable': return 'Sign-in unavailable';
			case 'cli-unavailable':
			case 'usage-unavailable': return 'Usage unavailable';
		}
	}
	if (provider.provider === 'minimax' && failure === 'stale-token') {
		return 'Sign-in expired';
	}
	if (isUsageRateLimitError(provider.error)) {
		return 'Limited';
	}
	return 'Refresh failed';
}

/** A row with nothing to measure, and why: `usage-roster-row-state.ts`. */
export interface IOrcaUsageRowState {
	readonly kind: 'loading' | 'sign-in' | 'error' | 'unavailable' | 'empty';
	readonly label: string;
}

export function usageRowState(provider: IOrcaUsageProvider): IOrcaUsageRowState {
	if (provider.status === 'idle' || provider.status === 'fetching') {
		return { kind: 'loading', label: 'Loading usage…' };
	}
	const failure = provider.usageMetadata?.failureKind;
	if (failure === 'missing-credentials' || (!failure && provider.error && SIGNED_OUT_PATTERNS.some(pattern => pattern.test(provider.error!)))) {
		return { kind: 'sign-in', label: 'not signed in' };
	}
	if (provider.status === 'error') {
		return { kind: 'error', label: usageStatusLabel(provider) };
	}
	if (provider.status === 'unavailable') {
		return { kind: 'unavailable', label: 'Usage unavailable' };
	}
	return { kind: 'empty', label: 'No usage data' };
}

/** One provider in the panel, with everything the row draws. */
export interface IOrcaUsageRow {
	readonly slot: string;
	readonly name: string;
	readonly provider: IOrcaUsageProvider;
	readonly sections: readonly IOrcaUsageSection[];
	readonly state: IOrcaUsageRowState | undefined;
	readonly worst: number;
}

/** The panel's rows: every provider that has reported, worst first. */
export function usagePanelRows(state: OrcaRateLimitState | undefined, shown: (slot: string, provider: IOrcaUsageProvider) => boolean): readonly IOrcaUsageRow[] {
	const rows: IOrcaUsageRow[] = [];
	for (const { slot, name } of ORCA_FOOTER_PROVIDERS) {
		const provider = state?.[slot];
		if (!provider || typeof provider !== 'object' || !shown(slot, provider)) {
			continue;
		}
		const sections = usageSections(provider);
		rows.push({
			slot,
			name,
			provider,
			sections,
			state: sections.length === 0 ? usageRowState(provider) : undefined,
			worst: sections.reduce((worst, section) => Math.max(worst, clampUsed(section.window.usedPercent)), -1),
		});
	}
	return rows.sort((left, right) => right.worst - left.worst);
}

/** The Settings section a signed-out row opens: `getUsageProviderAccountsSectionId`. */
export function accountsSectionFor(slot: string): string | undefined {
	switch (slot) {
		case 'claude': return 'accounts-claude';
		case 'codex': return 'accounts-codex';
		case 'gemini':
		case 'antigravity': return 'accounts-gemini';
		case 'opencodeGo': return 'accounts-opencode-go';
		case 'minimax': return 'accounts-minimax';
		case 'grok': return 'accounts-grok';
		default: return undefined;
	}
}

/** `formatResetCreditExpiry`. */
export function formatResetCreditExpiry(expiresAt: number | null | undefined, count: number, now: number): string | undefined {
	if (!expiresAt) {
		return undefined;
	}
	const duration = formatResetDuration(expiresAt - now);
	if (duration === 'now') {
		return count > 1 ? 'Next expires now' : 'Expires now';
	}
	return count > 1 ? `Next expires in ${duration}` : `Expires in ${duration}`;
}

/** `ClaudeRateLimitAccountsState` / `CodexRateLimitAccountsState`, as far as the switcher reads them. */
export interface IOrcaAccountsState {
	readonly accounts: readonly { readonly id: string; readonly email: string; readonly managedAuthRuntime?: 'host' | 'wsl'; readonly managedHomeRuntime?: 'host' | 'wsl' }[];
	readonly activeAccountId: string | null;
	readonly activeAccountIdsByRuntime?: { readonly host: string | null };
}

/** One account the switcher can move to; `id: null` is the system default. */
export interface IOrcaAccountTarget {
	readonly id: string | null;
	readonly label: string;
	readonly active: boolean;
}

/**
 * `buildClaudeStatusSwitchGroups` for this machine's host runtime: the system
 * default, then every account signed in on the host, the active one marked.
 */
export function hostAccountTargets(state: IOrcaAccountsState | undefined): readonly IOrcaAccountTarget[] {
	if (!state) {
		return [];
	}
	const activeId = state.activeAccountIdsByRuntime?.host ?? state.activeAccountId ?? null;
	return [
		{ id: null, label: 'System default', active: activeId === null },
		...state.accounts
			.filter(account => (account.managedAuthRuntime ?? account.managedHomeRuntime) !== 'wsl')
			.map(account => ({ id: account.id, label: account.email, active: account.id === activeId })),
	];
}
