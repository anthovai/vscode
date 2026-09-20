/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/kinguUsagePage.css';
import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { constObservable, IObservable } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { AbstractCustomView } from '../../../services/customView/browser/customView.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { formatCostUsd } from '../common/kinguPricing.js';
import { IKinguVaultService } from '../common/kinguVault.js';
import { formatTokens } from '../common/kinguVaultUsage.js';
import {
	formatShare,
	IKinguProviderOverview,
	IKinguUsageDay,
	IKinguUsageOverview,
	IKinguUsageTotals,
} from '../common/kinguUsageOverview.js';

export const KINGU_USAGE_VIEW_ID = 'kingu.customView.usage';
export const KINGU_SHOW_USAGE_COMMAND_ID = 'kingu.usage.show';

/**
 * Six weeks, which is what the grid can show without becoming a wall.
 *
 * Long enough that a fortnight off is visible as a gap, short enough that one
 * heavy week does not flatten every other column to nothing.
 */
const WINDOW_DAYS = 42;

/** How dark a day's cell is, in five steps against the busiest day. */
function intensityStep(tokens: number, best: number): number {
	if (tokens <= 0 || best <= 0) {
		return 0;
	}
	return Math.min(4, Math.max(1, Math.ceil((tokens / best) * 4)));
}

function cost(totals: IKinguUsageTotals): string {
	if (totals.costUsd === undefined) {
		return localize('kingu.usage.costUnknown', "not priced");
	}
	// A "+" where some models priced and others did not: the figure is a floor,
	// and a page that printed it flat would be understating by an unknown amount.
	return totals.partialCost ? `${formatCostUsd(totals.costUsd)}+` : formatCostUsd(totals.costUsd);
}

function relativeDay(timestamp: number, now: number): string {
	const days = Math.floor((now - timestamp) / 86_400_000);
	if (days <= 0) {
		return localize('kingu.usage.today', "today");
	}
	if (days === 1) {
		return localize('kingu.usage.yesterday', "yesterday");
	}
	return localize('kingu.usage.daysAgo', "{0} days ago", days);
}

/**
 * What every agent on this machine has spent.
 *
 * The ADE's Stats & Usage page, rebuilt here. Its shape is theirs — headline
 * cards, a provider row each, a token mix, a six-week intensity grid — because
 * those are the questions people bring to a usage page.
 *
 * What is not theirs is the setup. The ADE's page opens on three "Enable
 * Claude / Enable Codex / Enable OpenCode" buttons, because it has to be told
 * to scan each agent's logs into its own ledger. The vault has already read
 * every session on this machine, so this page opens on numbers.
 */
class KinguUsageView extends AbstractCustomView {

	readonly title: IObservable<string> = constObservable(localize('kingu.usage.pageTitle', "Usage"));
	override readonly description: IObservable<string | undefined> = constObservable(
		localize('kingu.usage.pageDescription', "What every agent on this machine has spent, read from their own transcripts."));

	private readonly _scan = this._register(new MutableDisposable<CancellationTokenSource>());
	private _container: HTMLElement | undefined;
	/** Held rather than looked up: the scan reports progress many times a second. */
	private _status: HTMLElement | undefined;

	constructor(
		@IKinguVaultService private readonly _vaultService: IKinguVaultService,
	) {
		super();
	}

	render(container: HTMLElement): void {
		this._container = container;
		this._draw(undefined);
		void this._load();
	}

	/**
	 * Reads every transcript, reporting how far it has got.
	 *
	 * A full pass over the vault — hundreds of files, some of them megabytes —
	 * so the page says what it is doing rather than showing nothing for several
	 * seconds. Cancelled and restarted on refresh, because two passes writing
	 * into one page would race to draw different answers.
	 */
	private async _load(): Promise<void> {
		const source = new CancellationTokenSource();
		this._scan.value = source;
		try {
			const overview = await this._vaultService.getUsageOverview(
				{ days: WINDOW_DAYS, now: Date.now() },
				source.token,
				(done, total) => {
					if (!source.token.isCancellationRequested) {
						this._drawProgress(done, total);
					}
				});
			if (!source.token.isCancellationRequested) {
				this._draw(overview);
			}
		} catch (error) {
			if (!source.token.isCancellationRequested) {
				this._drawError(error);
			}
		}
	}

	private _drawProgress(done: number, total: number): void {
		if (this._status) {
			this._status.textContent = localize('kingu.usage.reading', "Reading transcripts… {0} of {1}", done, total);
		}
	}

	private _drawError(error: unknown): void {
		if (!this._container) {
			return;
		}
		clearNode(this._container);
		const root = append(this._container, $('.kingu-usage-page'));
		this._status = append(root, $('.kingu-usage-page-status'));
		this._status.textContent =
			localize('kingu.usage.failed', "Could not read the vault: {0}", error instanceof Error ? error.message : String(error));
	}

	private _draw(overview: IKinguUsageOverview | undefined): void {
		if (!this._container) {
			return;
		}
		clearNode(this._container);
		this._status = undefined;
		const root = append(this._container, $('.kingu-usage-page'));

		const header = append(root, $('.kingu-usage-page-header'));
		append(header, $('h1.kingu-usage-page-title')).textContent = localize('kingu.usage.pageTitle', "Usage");
		const refresh = append(header, $('button.kingu-usage-page-refresh')) as HTMLButtonElement;
		refresh.type = 'button';
		append(refresh, $(`span${ThemeIcon.asCSSSelector(Codicon.refresh)}`));
		append(refresh, $('span')).textContent = localize('kingu.usage.refreshPage', "Read again");
		refresh.addEventListener('click', () => {
			this._draw(undefined);
			void this._load();
		});

		if (!overview) {
			this._status = append(root, $('.kingu-usage-page-status'));
			this._status.textContent = localize('kingu.usage.scanning', "Reading transcripts…");
			return;
		}
		if (overview.sessions === 0) {
			append(root, $('.kingu-usage-page-status')).textContent =
				localize('kingu.usage.nothing', "No session on this machine has recorded any tokens yet.");
			return;
		}

		this._drawCards(root, overview);
		this._drawMix(root, overview);
		this._drawProviders(root, overview);
		this._drawGrid(root, overview);
	}

	private _drawCards(root: HTMLElement, overview: IKinguUsageOverview): void {
		const now = Date.now();
		const cards: readonly { label: string; value: string; detail: string }[] = [
			{
				label: localize('kingu.usage.card.cost', "Estimated cost"),
				value: cost(overview),
				// The number is large and it is not a bill. Almost everyone reading
				// this page is on a subscription, where these tokens cost a flat
				// monthly fee; the figure is what the same work would list at on
				// the API. Saying only "list prices" left that inference to the
				// reader, and the inference people make from a four-figure number
				// is that they owe it.
				detail: overview.partialCost
					? localize('kingu.usage.card.costPartial', "at least this — some models are in no price table. API list prices, not a bill.")
					: localize('kingu.usage.card.costDetail', "what this would list at on the API — not what a subscription was charged"),
			},
			{
				label: localize('kingu.usage.card.tokens', "Tokens"),
				value: formatTokens(overview.totalTokens),
				detail: localize('kingu.usage.card.tokensDetail', "{0} sent fresh, {1} from cache", formatTokens(overview.newInputTokens), formatTokens(overview.cacheTokens)),
			},
			{
				label: localize('kingu.usage.card.sessions', "Sessions"),
				value: `${overview.sessions}`,
				detail: overview.lastActivityAt === undefined
					? localize('kingu.usage.card.sessionsDetail', "across every agent")
					: localize('kingu.usage.card.sessionsLast', "last one {0}", relativeDay(overview.lastActivityAt, now)),
			},
			{
				label: localize('kingu.usage.card.cache', "Served from cache"),
				value: formatShare(overview.cacheShare),
				detail: localize('kingu.usage.card.cacheDetail', "of everything sent to a model"),
			},
		];
		const grid = append(root, $('.kingu-usage-cards'));
		for (const card of cards) {
			const element = append(grid, $('.kingu-usage-card'));
			append(element, $('.kingu-usage-card-label')).textContent = card.label;
			append(element, $('.kingu-usage-card-value')).textContent = card.value;
			append(element, $('.kingu-usage-card-detail')).textContent = card.detail;
		}
	}

	/**
	 * The three kinds of token, to scale.
	 *
	 * Cache is its own band rather than folded into the input because it is
	 * routinely most of the total and costs a fraction as much: a single bar
	 * would say the work was ten times bigger than it was.
	 */
	private _drawMix(root: HTMLElement, overview: IKinguUsageOverview): void {
		const bands: readonly { kind: string; label: string; tokens: number }[] = [
			{ kind: 'input', label: localize('kingu.usage.mix.input', "Fresh input"), tokens: overview.newInputTokens },
			{ kind: 'output', label: localize('kingu.usage.mix.output', "Output"), tokens: overview.outputTokens },
			{ kind: 'cache', label: localize('kingu.usage.mix.cache', "Cache"), tokens: overview.cacheTokens },
		];
		const total = bands.reduce((sum, band) => sum + band.tokens, 0);
		if (total <= 0) {
			return;
		}
		const section = append(root, $('.kingu-usage-section'));
		append(section, $('h2.kingu-usage-section-title')).textContent = localize('kingu.usage.mix.title', "Token mix");
		const bar = append(section, $('.kingu-usage-mix'));
		const legend = append(section, $('.kingu-usage-legend'));
		for (const band of bands) {
			const share = band.tokens / total;
			const segment = append(bar, $(`span.kingu-usage-mix-band.${band.kind}`));
			segment.style.width = `${share * 100}%`;
			segment.title = `${band.label}: ${formatTokens(band.tokens)}`;
			const entry = append(legend, $('span.kingu-usage-legend-entry'));
			append(entry, $(`span.kingu-usage-legend-swatch.${band.kind}`));
			append(entry, $('span')).textContent = `${band.label} · ${formatTokens(band.tokens)} · ${formatShare(share)}`;
		}
	}

	private _drawProviders(root: HTMLElement, overview: IKinguUsageOverview): void {
		const now = Date.now();
		const section = append(root, $('.kingu-usage-section'));
		append(section, $('h2.kingu-usage-section-title')).textContent = localize('kingu.usage.providers.title', "By agent");
		const busiest = overview.providers[0]?.totalTokens ?? 0;
		for (const provider of overview.providers) {
			this._drawProviderRow(append(section, $('.kingu-usage-provider')), provider, busiest, now);
		}
	}

	private _drawProviderRow(row: HTMLElement, provider: IKinguProviderOverview, busiest: number, now: number): void {
		const head = append(row, $('.kingu-usage-provider-head'));
		append(head, $('.kingu-usage-provider-name')).textContent = provider.label;
		append(head, $('.kingu-usage-provider-sessions')).textContent = provider.sessions === 1
			? localize('kingu.usage.provider.oneSession', "1 session")
			: localize('kingu.usage.provider.sessions', "{0} sessions", provider.sessions);
		append(head, $('.kingu-usage-provider-cost')).textContent = cost(provider);

		const track = append(row, $('.kingu-usage-provider-track'));
		const fill = append(track, $('.kingu-usage-provider-fill'));
		fill.style.width = busiest > 0 ? `${(provider.totalTokens / busiest) * 100}%` : '0%';

		const detail = append(row, $('.kingu-usage-provider-detail'));
		detail.textContent = provider.lastActivityAt === undefined
			? formatTokens(provider.totalTokens)
			: localize('kingu.usage.provider.detail', "{0} tokens · last run {1}", formatTokens(provider.totalTokens), relativeDay(provider.lastActivityAt, now));
	}

	/**
	 * Six weeks of days, darkest where the most ran.
	 *
	 * Every day is drawn, including the empty ones, so a week off is a gap in
	 * the grid rather than something the eye slides past.
	 */
	private _drawGrid(root: HTMLElement, overview: IKinguUsageOverview): void {
		const section = append(root, $('.kingu-usage-section'));
		append(section, $('h2.kingu-usage-section-title')).textContent = localize('kingu.usage.grid.title', "Last six weeks");

		const best = overview.bestDay?.totalTokens ?? 0;
		const grid = append(section, $('.kingu-usage-grid'));
		for (const day of overview.daily) {
			const cell = append(grid, $(`span.kingu-usage-grid-cell.step-${intensityStep(day.totalTokens, best)}`));
			cell.title = this._dayTitle(day);
		}

		const caption = append(section, $('.kingu-usage-grid-caption'));
		caption.textContent = overview.bestDay === undefined
			? localize('kingu.usage.grid.quiet', "Nothing ran in this window.")
			: localize('kingu.usage.grid.caption', "{0} active days · busiest was {1} with {2} tokens",
				overview.activeDays, overview.bestDay.day, formatTokens(overview.bestDay.totalTokens));
	}

	private _dayTitle(day: IKinguUsageDay): string {
		if (day.totalTokens === 0) {
			return localize('kingu.usage.grid.empty', "{0} — nothing ran", day.day);
		}
		return day.costUsd === undefined
			? localize('kingu.usage.grid.day', "{0} — {1} tokens", day.day, formatTokens(day.totalTokens))
			: localize('kingu.usage.grid.dayCost', "{0} — {1} tokens · {2}", day.day, formatTokens(day.totalTokens), formatCostUsd(day.costUsd));
	}

	layout(_width: number, _height: number): void { }
}

class KinguUsagePageContribution extends Disposable {

	static readonly ID = 'kingu.contrib.usagePage';

	constructor(
		@ICustomViewService customViewService: ICustomViewService,
	) {
		super();
		this._register(customViewService.registerCustomView({
			id: KINGU_USAGE_VIEW_ID,
			ctor: new SyncDescriptor(KinguUsageView),
		}));
	}
}

registerWorkbenchContribution2(KinguUsagePageContribution.ID, KinguUsagePageContribution, WorkbenchPhase.BlockRestore);

class ShowKinguUsageAction extends Action2 {

	constructor() {
		super({
			id: KINGU_SHOW_USAGE_COMMAND_ID,
			title: localize2('kingu.showUsage', "Kingu: Usage Details & History"),
			category: Categories.View,
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(ICustomViewService).showCustomView(KINGU_USAGE_VIEW_ID);
	}
}

registerAction2(ShowKinguUsageAction);
