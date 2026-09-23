/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/kinguStatusBar.css';
import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { KinguQuotaProvider } from '../../../../platform/kinguHost/common/kinguQuotaProviders.js';
import {
	clampUsedPercent,
	displayedPercent,
	formatResetCountdown,
	IKinguUsageRow,
	IKinguUsageWindow,
	KinguUsageDetail,
	KinguUsageDisplay,
	tightestWindow,
	usageSeverity,
} from '../common/kinguUsageRoster.js';

/**
 * A codicon per provider.
 *
 * Not their logos: shipping a brand's mark means shipping its asset and its
 * terms, and a shape that merely resembles one is worse than an honest generic.
 * Distinct enough to tell two rows apart at a glance, which is the job.
 */
export const PROVIDER_ICONS: Readonly<Record<KinguQuotaProvider, ThemeIcon>> = {
	[KinguQuotaProvider.Claude]: Codicon.flame,
	[KinguQuotaProvider.Codex]: Codicon.circleLargeOutline,
	[KinguQuotaProvider.Grok]: Codicon.zap,
	[KinguQuotaProvider.Kimi]: Codicon.circleFilled,
	[KinguQuotaProvider.Gemini]: Codicon.sparkle,
};

export interface IKinguUsageRosterOptions {
	readonly rows: readonly IKinguUsageRow[];
	readonly detail: KinguUsageDetail;
	readonly display: KinguUsageDisplay;
	readonly refreshing: boolean;
	readonly onDetailChange: (detail: KinguUsageDetail) => void;
	readonly onRefresh: () => void;
	readonly onDetails: () => void;
}

/** One window as label, bar and number — the unit the whole panel is built from. */
function renderMetric(parent: HTMLElement, window: IKinguUsageWindow, display: KinguUsageDisplay, withBar: boolean): void {
	const used = clampUsedPercent(window.limit.usedPercent);
	const shown = displayedPercent(window.limit.usedPercent, display);
	const metric = append(parent, $('span.kingu-usage-metric'));
	append(metric, $('span.kingu-usage-metric-label')).textContent = window.label;
	if (withBar) {
		const track = append(metric, $('span.kingu-usage-track'));
		const fill = append(track, $('span.kingu-usage-fill'));
		// The bar always shows consumption even where the number counts down:
		// a bar that empties as a warning grows would read backwards.
		fill.style.width = `${used}%`;
		fill.classList.add(usageSeverity(used));
	}
	const value = append(metric, $('span.kingu-usage-metric-value'));
	value.textContent = `${shown}%`;
	// Urgency tracks what is spent, not what is shown, so both directions of
	// reading colour at the same moment.
	value.classList.add(usageSeverity(used));
}

function renderRow(parent: HTMLElement, row: IKinguUsageRow, detail: KinguUsageDetail, display: KinguUsageDisplay): void {
	const element = append(parent, $('div.kingu-usage-row'));
	const head = append(element, $('div.kingu-usage-row-head'));
	append(head, $(`span.kingu-usage-row-icon${ThemeIcon.asCSSSelector(PROVIDER_ICONS[row.provider])}`));
	append(head, $('span.kingu-usage-row-name')).textContent = row.label;

	if (row.kind !== 'usage') {
		const status = append(head, $('span.kingu-usage-row-status'));
		status.textContent = row.statusLabel ?? '';
		return;
	}

	const tightest = tightestWindow(row);
	if (detail === 'compact' && tightest) {
		// Compact keeps one reading per agent: the window that will stop them
		// first. Everything else is detail they did not ask for.
		const trailing = append(head, $('span.kingu-usage-row-trailing'));
		renderMetric(trailing, tightest, display, false);
		return;
	}
	if (row.resetsInMs !== undefined) {
		append(head, $('span.kingu-usage-row-reset')).textContent = formatResetCountdown(row.resetsInMs);
	}
	const windows = append(element, $('div.kingu-usage-row-windows'));
	for (const window of row.windows) {
		renderMetric(windows, window, display, true);
	}
}

function renderDetailPicker(parent: HTMLElement, current: KinguUsageDetail, onChange: (detail: KinguUsageDetail) => void): void {
	// The density control sits inside the thing it controls, so both modes are
	// named and discoverable the first time the panel is opened.
	const group = append(parent, $('div.kingu-usage-modes'));
	group.setAttribute('role', 'radiogroup');
	group.setAttribute('aria-label', localize('kingu.usage.detailAria', "Usage detail"));
	const options: readonly { detail: KinguUsageDetail; label: string; title: string }[] = [
		{
			detail: 'detailed',
			label: localize('kingu.usage.detailed', "Detailed"),
			title: localize('kingu.usage.detailedHint', "Every window, with bars and percentages"),
		},
		{
			detail: 'compact',
			label: localize('kingu.usage.compact', "Compact"),
			title: localize('kingu.usage.compactHint', "One reading per agent: the window nearest its limit"),
		},
	];
	for (const option of options) {
		const button = append(group, $('button.kingu-usage-mode')) as HTMLButtonElement;
		button.type = 'button';
		button.textContent = option.label;
		button.title = option.title;
		button.setAttribute('role', 'radio');
		button.setAttribute('aria-checked', String(option.detail === current));
		button.classList.toggle('checked', option.detail === current);
		button.addEventListener('click', () => onChange(option.detail));
	}
}

/**
 * Every agent's quota in one panel.
 *
 * Built fresh each time it is shown rather than kept and updated: a hover's
 * content is asked for at the moment it opens, so the panel is always drawn
 * from the readings that exist then, and there is no stale element to
 * reconcile.
 */
export function renderKinguUsageRoster(options: IKinguUsageRosterOptions): HTMLElement {
	const root = $('div.kingu-usage-roster');

	const head = append(root, $('div.kingu-usage-head'));
	append(head, $('span.kingu-usage-title')).textContent = localize('kingu.usage.title', "Usage");
	append(head, $('span.kingu-usage-scope')).textContent = localize('kingu.usage.scope', "all agents");
	const refresh = append(head, $('button.kingu-usage-refresh')) as HTMLButtonElement;
	refresh.type = 'button';
	refresh.title = localize('kingu.usage.refresh', "Read every agent's quota again");
	refresh.setAttribute('aria-label', refresh.title);
	const refreshIcon = append(refresh, $(`span${ThemeIcon.asCSSSelector(Codicon.refresh)}`));
	refreshIcon.classList.toggle('spinning', options.refreshing);
	refresh.addEventListener('click', () => {
		refreshIcon.classList.add('spinning');
		options.onRefresh();
	});

	renderDetailPicker(root, options.detail, options.onDetailChange);

	const rows = append(root, $('div.kingu-usage-rows'));
	if (options.rows.length === 0) {
		append(rows, $('div.kingu-usage-empty')).textContent = localize('kingu.usage.noAgents', "No agent on this machine reports a quota.");
	} else {
		for (const row of options.rows) {
			renderRow(rows, row, options.detail, options.display);
		}
	}

	const details = append(root, $('button.kingu-usage-footer')) as HTMLButtonElement;
	details.type = 'button';
	append(details, $('span')).textContent = localize('kingu.usage.details', "Usage details & history");
	append(details, $(`span${ThemeIcon.asCSSSelector(Codicon.chevronRight)}`));
	details.addEventListener('click', () => options.onDetails());

	return root;
}

/** Redraws a panel in place, for the one case where it is already on screen. */
export function updateKinguUsageRoster(root: HTMLElement, options: IKinguUsageRosterOptions): void {
	clearNode(root);
	const rebuilt = renderKinguUsageRoster(options);
	while (rebuilt.firstChild) {
		root.appendChild(rebuilt.firstChild);
	}
}
