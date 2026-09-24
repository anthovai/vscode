/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType, getWindow } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { displayedUsagePercent, KinguUsageDisplay } from '../common/kinguStatusBar.js';
import { OrcaRateLimitState } from '../common/kinguOrcaFooter.js';
import {
	accountsSectionFor,
	clampUsed,
	formatPlanLabel,
	formatResetCountdown,
	formatResetCreditExpiry,
	formatUpdatedAgo,
	hostAccountTargets,
	IOrcaAccountsState,
	IOrcaAccountTarget,
	IOrcaUsageProvider,
	IOrcaUsageRow,
	IOrcaUsageSection,
	OrcaUsageMode,
	sectionShortLabel,
	tightestSection,
	usageBarTone,
	usagePanelRows,
	usagePercentLabel,
	usageTextTone,
} from '../common/kinguOrcaUsage.js';
import { attachFooterTooltip, lucideIcon } from './kinguOrcaFooterParts.js';

/** What the panel needs from the footer that opens it. */
export interface IOrcaUsagePanelHost {
	state(): OrcaRateLimitState | undefined;
	mode(): OrcaUsageMode;
	display(): KinguUsageDisplay;
	refreshing(): boolean;
	providerIcon(slot: string): HTMLElement;
	setMode(mode: OrcaUsageMode): void;
	refresh(): Promise<void>;
	openUsageDetails(): void;
	openAccounts(sectionId?: string): void;
	invoke<T>(channel: string, ...args: unknown[]): Promise<T>;
	confirm(message: string, detail: string, primaryButton: string): Promise<boolean>;
	notify(message: string): void;
}

/** Radix's submenu open delay on hover. */
const SUBMENU_HOVER_DELAY_MS = 100;
/** The footer's collision padding: eight pixels, thirty-two above the status bar. */
const SUBMENU_PADDING = 8;
const SUBMENU_BOTTOM_PADDING = 32;

/**
 * The ADE's usage popover (`UsageRosterPanel` inside `StatusBarSurface`): the
 * header with refresh, Detailed / Compact, one row per agent worst first, then
 * "Usage details & history" and "Manage Accounts…". Each row opens the ADE's
 * 300px side menu — the provider's panel, and for Claude and Codex the account
 * switcher — on hover or click, as a Radix submenu does.
 */
export class OrcaUsagePanel {

	private readonly _submenu = new MutableDisposable<DisposableStore>();
	private _submenuSlot: string | undefined;
	private readonly _expanded = new Set<string>();
	private readonly _accounts = new Map<string, IOrcaAccountsState>();
	private _switching = false;
	private _redeeming = false;

	constructor(private readonly _host: IOrcaUsagePanelHost) { }

	/** Closes the side menu with its popover. */
	dispose(): void {
		this._submenu.dispose();
	}

	render(close: () => void, store: DisposableStore): HTMLElement {
		this._anchors.clear();
		const now = Date.now();
		const mode = this._host.mode();
		const display = this._host.display();
		const root = $('.kingu-orca-usage');

		// Header: `Usage`, `all agents`, refresh.
		const header = append(root, $('.kingu-orca-usage-header'));
		append(header, $('span.kingu-orca-usage-title')).textContent = localize('kingu.usage.title', "Usage");
		const trailing = append(header, $('.kingu-orca-usage-header-trailing'));
		append(trailing, $('span.kingu-orca-text-11')).textContent = localize('kingu.usage.scope', "all agents");
		const refresh = append(trailing, $('button.kingu-orca-usage-refresh')) as HTMLButtonElement;
		refresh.type = 'button';
		refresh.setAttribute('aria-label', localize('kingu.usage.refresh', "Refresh rate limits"));
		refresh.appendChild(lucideIcon('refresh-cw', 12, this._host.refreshing() ? 'spin' : undefined));
		refresh.addEventListener('click', () => void this._host.refresh());

		// Detailed / Compact: `SettingsSegmentedControl size=sm equalWidth`.
		const toggle = append(root, $('.kingu-orca-usage-toggle'));
		const segmented = append(toggle, $('.kingu-orca-segmented.equal'));
		segmented.setAttribute('role', 'radiogroup');
		segmented.setAttribute('aria-label', localize('kingu.usage.modeAria', "Usage footer detail"));
		const options: readonly { mode: OrcaUsageMode; label: string; tooltip: string }[] = [
			{ mode: 'verbose', label: localize('kingu.usage.detailed', "Detailed"), tooltip: localize('kingu.usage.detailedTooltip', "Full usage with bars, labels, and percentages") },
			{ mode: 'compact', label: localize('kingu.usage.compact', "Compact"), tooltip: localize('kingu.usage.compactTooltip', "Condensed usage: only the tightest window") },
		];
		for (const option of options) {
			const button = append(segmented, $('button.kingu-orca-segment-option')) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('role', 'radio');
			button.setAttribute('aria-checked', String(option.mode === mode));
			button.classList.toggle('active', option.mode === mode);
			button.textContent = option.label;
			store.add(attachFooterTooltip(button, () => [option.tooltip]));
			button.addEventListener('click', () => this._host.setMode(option.mode));
		}

		append(root, $('.kingu-orca-usage-rule'));
		const rows = usagePanelRows(this._host.state(), (_slot, provider) => provider.status !== 'unavailable' || provider.session !== null || provider.weekly !== null);
		for (const row of rows) {
			this._renderRow(root, row, mode, display, now, close, store);
		}
		append(root, $('.kingu-orca-usage-rule'));

		const footerItem = (label: string, run: () => void) => {
			const item = append(root, $('button.kingu-orca-usage-footer-item')) as HTMLButtonElement;
			item.type = 'button';
			append(item, $('span')).textContent = label;
			item.appendChild(lucideIcon('chevron-right', 14, 'kingu-orca-muted'));
			item.addEventListener('click', () => {
				close();
				run();
			});
			item.addEventListener('pointerenter', () => this._closeSubmenuSoon());
		};
		footerItem(localize('kingu.usage.details', "Usage details & history"), () => this._host.openUsageDetails());
		footerItem(localize('kingu.usage.manageAccounts', "Manage Accounts…"), () => this._host.openAccounts());
		return root;
	}

	/** Redraws the open side menu from current state, if one is open. */
	refreshSubmenu(): void {
		const slot = this._submenuSlot;
		const anchor = slot ? this._anchors.get(slot) : undefined;
		if (!slot || !anchor?.isConnected) {
			this.closeSubmenu();
			return;
		}
		const row = usagePanelRows(this._host.state(), () => true).find(candidate => candidate.slot === slot);
		if (row) {
			this._openSubmenu(row, anchor, true);
		}
	}

	private _submenuAnchor: HTMLElement | undefined;
	/** Each row's trigger in the current drawing, so a redraw keeps the side menu beside its row. */
	private readonly _anchors = new Map<string, HTMLElement>();
	private _submenuSurface: HTMLElement | undefined;
	private _hoverTimer: number | undefined;

	/** Whether a node is inside the side menu, so a press there does not close the popover. */
	contains(node: Node): boolean {
		return !!this._submenuSurface?.contains(node);
	}

	/** `UsageRow` inside its trigger: a sign-in item, or a submenu trigger with the built-in chevron. */
	private _renderRow(parent: HTMLElement, row: IOrcaUsageRow, mode: OrcaUsageMode, display: KinguUsageDisplay, now: number, close: () => void, store: DisposableStore): void {
		const signIn = row.state?.kind === 'sign-in' && accountsSectionFor(row.slot) !== undefined;
		const trigger = append(parent, $(signIn ? 'button.kingu-orca-usage-row.sign-in' : 'button.kingu-orca-usage-row')) as HTMLButtonElement;
		trigger.type = 'button';
		this._anchors.set(row.slot, trigger);
		trigger.classList.toggle('open', this._submenuSlot === row.slot);
		const content = append(trigger, $('.kingu-orca-usage-row-content'));
		content.setAttribute('data-usage-mode', mode);

		const line = append(content, $('.kingu-orca-usage-row-line'));
		const icon = append(line, $('span.kingu-orca-usage-row-icon'));
		icon.appendChild(this._host.providerIcon(row.slot));
		const name = append(line, $('span.kingu-orca-usage-row-name'));
		name.textContent = row.name;
		const plan = formatPlanLabel(row.provider.planType);
		if (plan) {
			append(name, $('span.kingu-orca-usage-row-plan')).textContent = ` · ${plan}`;
		}

		if (row.sections.length === 0) {
			append(line, $('span.kingu-orca-usage-row-status')).textContent = row.state?.label ?? '';
			if (signIn) {
				append(line, $('span.kingu-orca-usage-sign-in')).textContent = localize('kingu.usage.signIn', "Sign in");
			}
		} else if (mode === 'compact') {
			const tightest = tightestSection(row.sections);
			if (tightest) {
				usageMetric(append(line, $('span.kingu-orca-push-end')), tightest, sectionShortLabel(tightest, mode, now), display, false);
			}
		} else {
			const resets = row.sections.map(section => section.window.resetsAt).filter((at): at is number => at !== null);
			if (resets.length > 0) {
				append(line, $('span.kingu-orca-usage-row-reset')).textContent = formatResetCountdown(Math.min(...resets) - now);
			}
		}
		if (mode === 'verbose' && row.sections.length > 0) {
			const metrics = append(content, $('.kingu-orca-usage-row-metrics'));
			for (const section of row.sections) {
				usageMetric(metrics, section, sectionShortLabel(section, mode, now), display, true);
			}
		}

		if (signIn) {
			trigger.addEventListener('click', () => {
				close();
				this._host.openAccounts(accountsSectionFor(row.slot));
			});
			trigger.addEventListener('pointerenter', () => this._closeSubmenuSoon());
			return;
		}
		trigger.classList.add('has-submenu');
		trigger.appendChild(lucideIcon('chevron-right', 16, 'kingu-orca-usage-row-chevron'));
		trigger.setAttribute('aria-haspopup', 'menu');
		trigger.setAttribute('aria-label', localize('kingu.usage.openDetails', "Open usage details"));
		trigger.addEventListener('click', () => this._openSubmenu(row, trigger, false));
		trigger.addEventListener('keydown', event => {
			if (event.key === 'ArrowRight') {
				event.preventDefault();
				this._openSubmenu(row, trigger, false);
			}
		});
		// On move as well as on enter: a row redrawn under a resting pointer gets
		// no enter, and should still open once the pointer stirs.
		const hover = () => {
			if (this._submenuSlot === row.slot || this._hoverTimer !== undefined) {
				return;
			}
			this._hoverTimer = mainWindow.setTimeout(() => {
				this._hoverTimer = undefined;
				this._openSubmenu(row, trigger, false);
			}, SUBMENU_HOVER_DELAY_MS);
		};
		store.add(addDisposableListener(trigger, 'pointerenter', () => {
			this._cancelHover();
			hover();
		}));
		store.add(addDisposableListener(trigger, 'pointermove', hover));
		store.add(addDisposableListener(trigger, 'pointerleave', () => this._cancelHover()));
	}

	private _cancelHover(): void {
		if (this._hoverTimer !== undefined) {
			mainWindow.clearTimeout(this._hoverTimer);
			this._hoverTimer = undefined;
		}
	}

	private _closeSubmenuSoon(): void {
		this._cancelHover();
		this._hoverTimer = mainWindow.setTimeout(() => {
			this._hoverTimer = undefined;
			this.closeSubmenu();
		}, SUBMENU_HOVER_DELAY_MS);
	}

	closeSubmenu(): void {
		this._submenu.clear();
		this._submenuSlot = undefined;
		this._submenuAnchor?.classList.remove('open');
		this._submenuAnchor = undefined;
	}

	/**
	 * The side menu: `w-[300px] p-0`, beside its row, flipped to the left when
	 * the right has no room, and kept 32px above the status bar.
	 */
	private _openSubmenu(row: IOrcaUsageRow, anchor: HTMLElement, redraw: boolean): void {
		if (!redraw && this._submenuSlot === row.slot && this._submenu.value) {
			return;
		}
		const store = new DisposableStore();
		this._submenuAnchor?.classList.remove('open');
		this._submenu.value = store;
		this._submenuSlot = row.slot;
		this._submenuAnchor = anchor;
		anchor.classList.add('open');
		if (!redraw && (row.slot === 'claude' || row.slot === 'codex')) {
			void this._loadAccounts(row.slot);
		}

		const surface = $('.kingu-orca-surface.menu.flush.kingu-orca-usage-submenu');
		surface.setAttribute('role', 'menu');
		surface.style.width = '300px';
		this._renderSubmenu(surface, row, store);
		const container = anchor.closest('.monaco-workbench') ?? getWindow(anchor).document.body;
		container.appendChild(surface);
		this._submenuSurface = surface;
		store.add(toDisposable(() => {
			surface.remove();
			if (this._submenuSurface === surface) {
				this._submenuSurface = undefined;
			}
		}));

		const window = getWindow(anchor);
		const rect = anchor.getBoundingClientRect();
		const parentRect = (anchor.closest('.kingu-orca-surface') ?? anchor).getBoundingClientRect();
		surface.style.position = 'fixed';
		const width = surface.offsetWidth;
		const height = surface.offsetHeight;
		let left = parentRect.right + 2;
		if (left + width > window.innerWidth - SUBMENU_PADDING) {
			left = Math.max(SUBMENU_PADDING, parentRect.left - 2 - width);
		}
		const top = Math.max(SUBMENU_PADDING, Math.min(rect.top - 4, window.innerHeight - SUBMENU_BOTTOM_PADDING - height));
		surface.style.left = `${Math.round(left)}px`;
		surface.style.top = `${Math.round(top)}px`;

		// A press outside both menus closes the side menu; the popover's own handler closes the rest.
		store.add(addDisposableListener(window.document, EventType.POINTER_DOWN, (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (target && (surface.contains(target) || anchor.contains(target))) {
				return;
			}
			if (target && anchor.closest('.kingu-orca-surface')?.contains(target)) {
				return;
			}
			this.closeSubmenu();
		}, true));
		store.add(addDisposableListener(surface, 'pointerenter', () => this._cancelHover()));
		store.add(addDisposableListener(surface, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'ArrowLeft') {
				event.preventDefault();
				this.closeSubmenu();
				anchor.focus();
			}
		}));
	}

	/** `ProviderDetailsMenu` body: the provider panel, then Claude's or Codex's own section. */
	private _renderSubmenu(surface: HTMLElement, row: IOrcaUsageRow, store: DisposableStore): void {
		const display = this._host.display();
		const now = Date.now();
		const panelBox = append(surface, $('.kingu-orca-usage-panel-box'));
		this._renderProviderPanel(panelBox, row, display, now, row.slot !== 'codex');
		if (row.slot === 'claude') {
			this._renderAccountSection(surface, row, 'claude', store);
		} else if (row.slot === 'codex') {
			this._renderCodexCredits(surface, row.provider, now);
			this._renderAccountSection(surface, row, 'codex', store);
		}
	}

	/** `ProviderPanel`: the name, when it was updated, then each window as a label, a full bar, and its numbers. */
	private _renderProviderPanel(parent: HTMLElement, row: IOrcaUsageRow, display: KinguUsageDisplay, now: number, showResetCredits: boolean): void {
		const panel = append(parent, $('.kingu-orca-provider-panel'));
		const header = append(panel, $('.kingu-orca-provider-panel-header'));
		header.appendChild(this._host.providerIcon(row.slot));
		append(header, $('span')).textContent = row.name;
		const provider = row.provider;
		if (provider.status === 'unavailable') {
			append(panel, $('.kingu-orca-muted')).textContent = provider.error ?? 'Unavailable';
			return;
		}
		append(panel, $('.kingu-orca-provider-panel-updated')).textContent = formatUpdatedAgo(provider.updatedAt, now);
		const credits = provider.rateLimitResetCredits;
		if (showResetCredits && provider.provider === 'codex' && credits) {
			append(panel, $('.kingu-orca-muted')).textContent = resetCreditsLabel(credits.availableCount);
			const expiry = formatResetCreditExpiry(credits.nextExpiresAt, credits.availableCount, now);
			if (expiry) {
				append(panel, $('.kingu-orca-muted')).textContent = expiry;
			}
		}
		if (row.sections.length === 0 && provider.status === 'error') {
			append(panel, $('.kingu-orca-provider-panel-error-label')).textContent = row.state?.label ?? 'Refresh failed';
			append(panel, $('.kingu-orca-muted')).textContent = provider.error ?? 'Unable to fetch usage';
			return;
		}
		if (provider.error && row.sections.length > 0) {
			append(panel, $('.kingu-orca-provider-panel-error-label')).textContent = 'Refresh failed — showing cached data';
		}
		append(panel, $('.kingu-orca-provider-panel-divider'));
		for (const section of row.sections) {
			const used = clampUsed(section.window.usedPercent);
			const block = append(panel, $('.kingu-orca-provider-panel-window'));
			append(block, $('.kingu-orca-provider-panel-window-label')).textContent = section.label;
			const bar = append(block, $('.kingu-orca-provider-panel-bar'));
			const fill = append(bar, $(`span.kingu-orca-bar-tone.${usageBarTone(used)}`));
			fill.style.width = `${displayedUsagePercent(used, display)}%`;
			const numbers = append(block, $('.kingu-orca-provider-panel-numbers'));
			append(numbers, $('span')).textContent = usagePercentLabel(used, display);
			if (section.window.resetsAt) {
				append(numbers, $('span')).textContent = formatResetCountdown(section.window.resetsAt - now);
			}
		}
	}

	/** Codex's reset credits, and "Reset now" with the ADE's confirmation. */
	private _renderCodexCredits(surface: HTMLElement, provider: IOrcaUsageProvider, now: number): void {
		const credits = provider.rateLimitResetCredits;
		if (!credits) {
			return;
		}
		append(surface, $('.kingu-orca-menu-separator'));
		const label = append(surface, $('.kingu-orca-menu-label.stacked'));
		append(label, $('div')).textContent = resetCreditsLabel(credits.availableCount);
		const expiry = formatResetCreditExpiry(credits.nextExpiresAt, credits.availableCount, now);
		if (expiry) {
			append(label, $('div.kingu-orca-menu-label-trailing')).textContent = expiry;
		}
		if (credits.availableCount > 0) {
			const reset = append(surface, $('button.kingu-orca-menu-item')) as HTMLButtonElement;
			reset.type = 'button';
			if (this._redeeming) {
				reset.appendChild(lucideIcon('loader-circle', 14, 'spin'));
			}
			append(reset, $('span')).textContent = this._redeeming ? localize('kingu.usage.usingReset', "Using reset…") : localize('kingu.usage.resetNow', "Reset now");
			reset.disabled = this._redeeming;
			reset.addEventListener('click', () => void this._redeemReset());
		}
		append(surface, $('.kingu-orca-menu-separator'));
	}

	private async _redeemReset(): Promise<void> {
		const confirmed = await this._host.confirm(
			localize('kingu.usage.resetTitle', "Reset Codex limits?"),
			localize('kingu.usage.resetDetail', "This uses one Codex rate-limit reset credit for the active account and resets any eligible usage windows immediately."),
			localize({ key: 'kingu.usage.resetConfirm', comment: ['&& denotes a mnemonic'] }, "&&Reset now"),
		);
		if (!confirmed) {
			return;
		}
		this._redeeming = true;
		this.refreshSubmenu();
		try {
			await this._host.invoke('rateLimits:consumeCodexResetCredit');
		} finally {
			this._redeeming = false;
			await this._host.refresh();
			this.refreshSubmenu();
		}
	}

	private async _loadAccounts(provider: 'claude' | 'codex'): Promise<void> {
		try {
			const state = await this._host.invoke<IOrcaAccountsState>(`${provider}Accounts:list`);
			if (state) {
				this._accounts.set(provider, state);
				this.refreshSubmenu();
			}
		} catch {
			// No managed accounts to offer: the section shows the system default alone.
		}
	}

	/**
	 * `ClaudeSwitcherMenu` / `CodexSwitcherMenu`'s account section: the active
	 * account, and when expanded the others to switch to, each with its own
	 * usage, then "Manage Accounts…".
	 */
	private _renderAccountSection(surface: HTMLElement, row: IOrcaUsageRow, provider: 'claude' | 'codex', store: DisposableStore): void {
		const targets = hostAccountTargets(this._accounts.get(provider));
		const active = targets.find(target => target.active);
		if (provider === 'claude') {
			append(surface, $('.kingu-orca-menu-separator'));
		}
		const section = append(surface, $('.kingu-orca-usage-accounts'));
		const heading = append(section, $('.kingu-orca-menu-label'));
		append(heading, $('span')).textContent = provider === 'claude' ? localize('kingu.usage.claudeAccount', "Claude Account") : localize('kingu.usage.codexAccount', "Codex Account");
		const expanded = this._expanded.has(provider);
		const current = append(section, $('button.kingu-orca-menu-item')) as HTMLButtonElement;
		current.type = 'button';
		current.setAttribute('aria-expanded', String(expanded));
		append(current, $('span.kingu-orca-usage-account-current')).textContent = active?.label ?? localize('kingu.usage.systemDefault', "System default");
		current.appendChild(lucideIcon(expanded ? 'chevron-down' : 'chevron-right', 14, 'kingu-orca-usage-account-chevron'));
		current.addEventListener('click', () => {
			if (!this._expanded.delete(provider)) {
				this._expanded.add(provider);
				void this._host.invoke(provider === 'claude' ? 'rateLimits:fetchInactiveClaudeAccounts' : 'rateLimits:fetchInactiveCodexAccounts').catch(() => undefined);
			}
			this.refreshSubmenu();
		});
		if (expanded) {
			const box = append(section, $('.kingu-orca-usage-account-box-wrap'));
			if (provider === 'claude') {
				append(box, $('.kingu-orca-usage-switch-heading')).textContent = localize('kingu.usage.switchTo', "Switch to");
			}
			const list = append(box, $('.kingu-orca-usage-account-box'));
			const others = targets;
			if (others.length === 0 && provider === 'claude') {
				append(list, $('.kingu-orca-usage-account-empty')).textContent = localize('kingu.usage.noOtherAccounts', "No other accounts");
			}
			const inactive = this._inactiveUsage(provider);
			for (const target of others) {
				this._renderAccountTarget(list, provider, target, inactive.get(target.id ?? ''), row, store);
			}
			if (provider === 'claude') {
				append(box, $('.kingu-orca-usage-account-note')).textContent = localize('kingu.usage.restartNote', "Restart live Claude terminals before continuing old conversations after switching.");
			}
		}
		append(surface, $('.kingu-orca-menu-separator'));
		const manage = append(surface, $('button.kingu-orca-menu-item')) as HTMLButtonElement;
		manage.type = 'button';
		manage.textContent = localize('kingu.usage.manageAccounts', "Manage Accounts…");
		manage.addEventListener('click', () => this._host.openAccounts(provider === 'claude' ? 'accounts-claude' : 'accounts-codex'));
	}

	private _inactiveUsage(provider: 'claude' | 'codex'): Map<string, { readonly rateLimits: IOrcaUsageProvider | null; readonly isFetching: boolean }> {
		const state = this._host.state() as { readonly inactiveClaudeAccounts?: unknown; readonly inactiveCodexAccounts?: unknown } | undefined;
		const list = (provider === 'claude' ? state?.inactiveClaudeAccounts : state?.inactiveCodexAccounts) as readonly { accountId: string; rateLimits: IOrcaUsageProvider | null; isFetching: boolean }[] | undefined;
		return new Map((Array.isArray(list) ? list : []).map(entry => [entry.accountId, entry]));
	}

	private _renderAccountTarget(parent: HTMLElement, provider: 'claude' | 'codex', target: IOrcaAccountTarget, usage: { readonly rateLimits: IOrcaUsageProvider | null; readonly isFetching: boolean } | undefined, row: IOrcaUsageRow, _store: DisposableStore): void {
		const item = append(parent, $('button.kingu-orca-menu-item.kingu-orca-usage-account')) as HTMLButtonElement;
		item.type = 'button';
		item.disabled = this._switching || target.active;
		const body = append(item, $('.kingu-orca-usage-account-body'));
		const line = append(body, $('.kingu-orca-usage-account-line'));
		append(line, $(provider === 'claude' ? 'span.kingu-orca-usage-account-label' : 'span.kingu-orca-usage-account-label.wrap')).textContent = target.label;
		if (target.active) {
			append(line, $('span.kingu-orca-usage-account-active')).textContent = localize('kingu.usage.active', "Active");
		}
		const limits = target.active ? row.provider : usage?.rateLimits ?? undefined;
		if (usage?.isFetching && !usage.rateLimits) {
			const skeleton = append(body, $('.kingu-orca-inline-skeleton'));
			append(skeleton, $('span'));
			append(skeleton, $('span'));
		} else if (limits) {
			inlineUsageBars(body, limits, this._host.display());
		}
		item.addEventListener('click', () => void this._selectAccount(provider, target));
	}

	private async _selectAccount(provider: 'claude' | 'codex', target: IOrcaAccountTarget): Promise<void> {
		if (this._switching || target.active) {
			return;
		}
		this._switching = true;
		this.refreshSubmenu();
		try {
			await this._host.invoke(`${provider}Accounts:select`, { accountId: target.id });
			this._expanded.delete(provider);
			await this._loadAccounts(provider);
			await this._host.refresh();
		} catch (error) {
			this._host.notify(error instanceof Error ? error.message : String(error));
		} finally {
			this._switching = false;
			this.refreshSubmenu();
		}
	}
}

function resetCreditsLabel(count: number): string {
	return count === 1
		? localize('kingu.usage.resetOne', "1 rate-limit reset available")
		: localize('kingu.usage.resetMany', "{0} rate-limit resets available", count);
}

/** `UsageMetric`: a 10px label, an optional 5 x 28 bar, the percentage in its urgency colour. */
function usageMetric(parent: HTMLElement, section: IOrcaUsageSection, label: string, display: KinguUsageDisplay, withBar: boolean): void {
	const used = clampUsed(section.window.usedPercent);
	const metric = append(parent, $('span.kingu-orca-usage-metric'));
	metric.setAttribute('data-usage-window', label);
	append(metric, $('span.kingu-orca-usage-metric-label')).textContent = label;
	if (withBar) {
		const bar = append(metric, $('span.kingu-orca-usage-metric-bar'));
		append(bar, $(`span.kingu-orca-bar-tone.${usageBarTone(used)}`)).style.width = `${displayedUsagePercent(used, display)}%`;
	}
	append(metric, $(`span.kingu-orca-usage-metric-value.${usageTextTone(used)}`)).textContent = `${displayedUsagePercent(used, display)}%`;
}

/** `InlineUsageBars`: up to three cells — the session by its countdown, `wk`, `Fable`. */
function inlineUsageBars(parent: HTMLElement, provider: IOrcaUsageProvider, display: KinguUsageDisplay): void {
	const now = Date.now();
	const cells: { label: string; used: number }[] = [];
	if (provider.session) {
		cells.push({ label: sectionShortLabel({ key: 'session', label: 'Session', window: provider.session, named: false }, 'compact', now), used: clampUsed(provider.session.usedPercent) });
	}
	if (provider.weekly) {
		cells.push({ label: 'wk', used: clampUsed(provider.weekly.usedPercent) });
	}
	if (provider.fableWeekly) {
		cells.push({ label: 'Fable', used: clampUsed(provider.fableWeekly.usedPercent) });
	}
	if (cells.length === 0) {
		if (provider.status === 'error') {
			append(parent, $('span.kingu-orca-inline-sign-in')).textContent = localize('kingu.usage.signInToSee', "Sign in to see usage");
		}
		return;
	}
	const grid = append(parent, $('.kingu-orca-inline-bars'));
	grid.classList.toggle('kingu-orca-pulse', provider.status === 'fetching');
	grid.style.gridTemplateColumns = `repeat(${cells.length}, minmax(0, 1fr))`;
	for (const cell of cells) {
		const element = append(grid, $('.kingu-orca-inline-cell'));
		const bar = append(element, $('span.kingu-orca-inline-bar'));
		append(bar, $(`span.kingu-orca-bar-tone.${usageBarTone(cell.used)}`)).style.width = `${displayedUsagePercent(cell.used, display)}%`;
		append(element, $('span.kingu-orca-inline-label')).textContent = `${usagePercentLabel(cell.used, display)} ${cell.label}`;
	}
}
