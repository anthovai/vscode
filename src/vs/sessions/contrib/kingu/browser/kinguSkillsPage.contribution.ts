/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/kinguSkillsPage.css';
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
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { AbstractCustomView } from '../../../services/customView/browser/customView.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { IKinguSkill, IKinguSkillScan, IKinguSkillSource, IKinguSkillsService, KinguSkillSourceKind } from '../common/kinguSkills.js';
import {
	countKinguSkillsByKind,
	filterKinguSkills,
	IKinguSkillFilter,
	isLongKinguSkillDescription,
	KINGU_SKILL_FILTER_NONE,
	kinguSkillOwnerByRoot,
	kinguSkillOwnerLabel,
	kinguSkillOwnerOptions,
	kinguSkillSourceKindLabel,
} from '../common/kinguSkillFilter.js';
import { KinguSkillsService } from './kinguSkillsService.js';

export const KINGU_SKILLS_VIEW_ID = 'kingu.customView.skills';
export const KINGU_SHOW_SKILLS_COMMAND_ID = 'kingu.skills.show';

// Delayed: the scan is a walk over a dozen directories, and nothing outside
// this page asks for it until the page is opened.
registerSingleton(IKinguSkillsService, KinguSkillsService, InstantiationType.Delayed);

/** The kinds, in the order the tabs sit in. `all` first because it is the default. */
const KINDS: readonly (KinguSkillSourceKind | 'all')[] = ['all', 'home', 'repo', 'plugin', 'bundled'];

function kindLabel(kind: KinguSkillSourceKind | 'all'): string {
	return kind === 'all' ? localize('kingu.skills.kind.all', "All") : kinguSkillSourceKindLabel(kind);
}

function skillCount(count: number): string {
	return count === 1
		? localize('kingu.skills.countOne', "1 skill")
		: localize('kingu.skills.countMany', "{0} skills", count);
}

/**
 * Every skill the agents on this machine can see.
 *
 * The ADE's Skills page, rebuilt here — its questions, not its React. What it
 * is for is the same: an installed skill that does not appear anywhere reads as
 * a failed install, and before this page there was nowhere in the window that
 * answered "did that land, and which agent got it".
 *
 * What is deliberately different is the scope. The ADE's page also installs,
 * shares, bundles and version-checks skills against its cloud; none of that is
 * here yet, and a button that looked like it worked would be worse than its
 * absence. This page reads.
 */
class KinguSkillsView extends AbstractCustomView {

	readonly title: IObservable<string> = constObservable(localize('kingu.skills.pageTitle', "Skills"));
	override readonly description: IObservable<string | undefined> = constObservable(
		localize('kingu.skills.pageDescription', "Every skill the coding agents on this machine can see, and which of them can see it."));

	private readonly _scan = this._register(new MutableDisposable<CancellationTokenSource>());
	private _container: HTMLElement | undefined;
	private _result: IKinguSkillScan | undefined;
	private _filter: IKinguSkillFilter = KINGU_SKILL_FILTER_NONE;
	private _selected: string | undefined;
	/** Held rather than looked up: typing in the search box redraws only this. */
	private _listContainer: HTMLElement | undefined;
	private _detailContainer: HTMLElement | undefined;

	constructor(
		@IKinguSkillsService private readonly _skillsService: IKinguSkillsService,
		@IEditorService private readonly _editorService: IEditorService,
		@ILabelService private readonly _labelService: ILabelService,
	) {
		super();
		this._register(this._skillsService.onDidChangeSkills(() => {
			if (this._container) {
				void this._load();
			}
		}));
	}

	render(container: HTMLElement): void {
		this._container = container;
		this._draw();
		void this._load();
	}

	private async _load(): Promise<void> {
		const source = new CancellationTokenSource();
		this._scan.value = source;
		this._result = undefined;
		this._draw();
		try {
			const result = await this._skillsService.getSkills(source.token);
			if (!source.token.isCancellationRequested) {
				this._result = result;
				this._draw();
			}
		} catch (error) {
			if (!source.token.isCancellationRequested) {
				this._drawError(error);
			}
		}
	}

	private _drawError(error: unknown): void {
		if (!this._container) {
			return;
		}
		clearNode(this._container);
		const root = append(this._container, $('.kingu-skills-page'));
		append(root, $('.kingu-skills-status')).textContent =
			localize('kingu.skills.failed', "Could not read the skill directories: {0}", error instanceof Error ? error.message : String(error));
	}

	private _draw(): void {
		if (!this._container) {
			return;
		}
		clearNode(this._container);
		const root = append(this._container, $('.kingu-skills-page'));

		const header = append(root, $('.kingu-skills-header'));
		append(header, $('h1.kingu-skills-title')).textContent = localize('kingu.skills.pageTitle', "Skills");
		const refresh = append(header, $('button.kingu-skills-refresh')) as HTMLButtonElement;
		refresh.type = 'button';
		append(refresh, $(`span${ThemeIcon.asCSSSelector(Codicon.refresh)}`));
		append(refresh, $('span')).textContent = localize('kingu.skills.rescan', "Scan again");
		refresh.addEventListener('click', () => {
			this._skillsService.invalidate();
		});

		if (!this._result) {
			append(root, $('.kingu-skills-status')).textContent = localize('kingu.skills.scanning', "Reading skill directories…");
			return;
		}

		this._drawFilters(root, this._result);
		const body = append(root, $('.kingu-skills-body'));
		this._listContainer = append(body, $('.kingu-skills-list'));
		this._detailContainer = append(body, $('.kingu-skills-detail'));
		this._drawList();
		this._drawDetail();
		this._drawSources(root, this._result);
	}

	private _drawFilters(root: HTMLElement, result: IKinguSkillScan): void {
		const bar = append(root, $('.kingu-skills-filters'));

		const search = append(bar, $('input.kingu-skills-search')) as HTMLInputElement;
		search.type = 'search';
		search.placeholder = localize('kingu.skills.searchPlaceholder', "Search names, descriptions and paths");
		search.value = this._filter.query;
		search.addEventListener('input', () => {
			this._filter = { ...this._filter, query: search.value };
			this._drawList();
			this._drawDetail();
		});

		const counts = countKinguSkillsByKind(result.skills);
		const kinds = append(bar, $('.kingu-skills-kinds'));
		for (const kind of KINDS) {
			const count = kind === 'all' ? result.skills.length : counts[kind];
			// A kind nobody has is not a tab. Offering "Plugin (0)" invites a
			// click whose only outcome is an empty list.
			if (count === 0 && kind !== 'all') {
				continue;
			}
			const tab = append(kinds, $('button.kingu-skills-kind')) as HTMLButtonElement;
			tab.type = 'button';
			tab.classList.toggle('selected', this._filter.sourceKind === kind);
			tab.textContent = `${kindLabel(kind)} · ${count}`;
			tab.addEventListener('click', () => {
				this._filter = { ...this._filter, sourceKind: kind };
				this._draw();
			});
		}

		const owners = kinguSkillOwnerOptions(result.skills, result.sources);
		if (owners.length > 1) {
			const select = append(bar, $('select.kingu-skills-owner')) as HTMLSelectElement;
			const all = append(select, $('option')) as HTMLOptionElement;
			all.value = 'all';
			all.textContent = localize('kingu.skills.everyAgent', "Every agent");
			for (const owner of owners) {
				const option = append(select, $('option')) as HTMLOptionElement;
				option.value = owner.id;
				option.textContent = `${owner.label} · ${owner.count}`;
			}
			select.value = this._filter.owner;
			select.addEventListener('change', () => {
				this._filter = { ...this._filter, owner: select.value };
				this._drawList();
				this._drawDetail();
			});
		}
	}

	private _visible(): IKinguSkill[] {
		if (!this._result) {
			return [];
		}
		return filterKinguSkills(this._result.skills, this._filter, kinguSkillOwnerByRoot(this._result.sources));
	}

	private _drawList(): void {
		const container = this._listContainer;
		if (!container || !this._result) {
			return;
		}
		clearNode(container);
		const visible = this._visible();

		const summary = append(container, $('.kingu-skills-summary'));
		summary.textContent = visible.length === this._result.skills.length
			? skillCount(visible.length)
			: localize('kingu.skills.filtered', "{0} of {1}", visible.length, skillCount(this._result.skills.length));

		if (visible.length === 0) {
			append(container, $('.kingu-skills-status')).textContent = this._result.skills.length === 0
				? localize('kingu.skills.none', "No agent on this machine has a skill installed.")
				: localize('kingu.skills.noMatch', "Nothing matches that.");
			return;
		}

		for (const skill of visible) {
			this._drawRow(append(container, $('button.kingu-skills-row')) as HTMLButtonElement, skill);
		}
	}

	private _drawRow(row: HTMLButtonElement, skill: IKinguSkill): void {
		row.type = 'button';
		row.classList.toggle('selected', this._selected === skill.id);
		const head = append(row, $('.kingu-skills-row-head'));
		append(head, $('.kingu-skills-row-name')).textContent = skill.name;
		append(head, $('.kingu-skills-row-source')).textContent = skill.sourceLabel;
		const description = append(row, $('.kingu-skills-row-description'));
		description.textContent = skill.description ?? localize('kingu.skills.noDescription', "No description.");
		description.classList.toggle('muted', skill.description === undefined);
		row.addEventListener('click', () => {
			this._selected = skill.id;
			this._drawList();
			this._drawDetail();
		});
	}

	private _drawDetail(): void {
		const container = this._detailContainer;
		if (!container) {
			return;
		}
		clearNode(container);
		const visible = this._visible();
		// The selection survives a filter change only while it is still on screen;
		// a detail pane describing a row the list no longer shows is a pane about
		// nothing.
		const skill = visible.find(candidate => candidate.id === this._selected);
		if (!skill) {
			append(container, $('.kingu-skills-status')).textContent = localize('kingu.skills.pickOne', "Pick a skill to see where it lives.");
			return;
		}

		append(container, $('h2.kingu-skills-detail-name')).textContent = skill.name;

		const description = append(container, $('.kingu-skills-detail-description'));
		description.textContent = skill.description ?? localize('kingu.skills.noDescription', "No description.");
		description.classList.toggle('muted', skill.description === undefined);
		// Long descriptions are clamped rather than truncated: the whole text is
		// still there for anyone who wants it, and the path and the button below
		// stay above the fold for everyone who does not.
		if (isLongKinguSkillDescription(skill.description)) {
			description.classList.add('clamped');
			const more = append(container, $('button.kingu-skills-more')) as HTMLButtonElement;
			more.type = 'button';
			more.textContent = localize('kingu.skills.showMore', "Show more");
			more.addEventListener('click', () => {
				const clamped = description.classList.toggle('clamped');
				more.textContent = clamped
					? localize('kingu.skills.showMore', "Show more")
					: localize('kingu.skills.showLess', "Show less");
			});
		}

		const facts = append(container, $('dl.kingu-skills-facts'));
		this._fact(facts, localize('kingu.skills.fact.kind', "Kind"), kinguSkillSourceKindLabel(skill.sourceKind));
		this._fact(facts, localize('kingu.skills.fact.source', "Found in"), skill.sourceLabel);
		this._fact(facts, localize('kingu.skills.fact.agents', "Read by"), this._agentsFor(skill));
		// Through the label service, not the URI's own path: on Windows that path
		// is `/c:/Users/…`, which is nobody's idea of a Windows path, and a
		// remote host's path drawn with `fsPath` would come out backslashed.
		this._fact(facts, localize('kingu.skills.fact.path', "Path"), this._labelService.getUriLabel(skill.directory));
		if (skill.updatedAt !== undefined) {
			this._fact(facts, localize('kingu.skills.fact.updated', "Changed"), new Date(skill.updatedAt).toLocaleString());
		}

		const open = append(container, $('button.kingu-skills-open')) as HTMLButtonElement;
		open.type = 'button';
		append(open, $(`span${ThemeIcon.asCSSSelector(Codicon.goToFile)}`));
		append(open, $('span')).textContent = localize('kingu.skills.open', "Open SKILL.md");
		open.addEventListener('click', () => {
			void this._editorService.openEditor({ resource: skill.resource, options: { pinned: true } });
		});
	}

	/**
	 * Which agents can actually read this skill.
	 *
	 * Taken from the roots it was found in rather than from its provider list,
	 * because the scan tags every root that is neither Codex's nor Claude's own
	 * format as `agent-skills` — a provider list would say the same thing for a
	 * dozen different agents.
	 */
	private _agentsFor(skill: IKinguSkill): string {
		const ownerByRoot = kinguSkillOwnerByRoot(this._result?.sources ?? []);
		const owners = [...new Set(skill.rootPaths.map(root => ownerByRoot.get(root)).filter((owner): owner is string => !!owner))];
		return owners.length === 0
			? localize('kingu.skills.unknownAgent', "unknown")
			: owners.map(kinguSkillOwnerLabel).join(', ');
	}

	private _fact(list: HTMLElement, label: string, value: string): void {
		append(list, $('dt')).textContent = label;
		append(list, $('dd')).textContent = value;
	}

	/**
	 * The roots that were looked in, and the ones that would not open.
	 *
	 * A missing root is not reported: nobody has every agent installed, and a
	 * wall of "not found" is noise. A root that exists and failed to read is
	 * reported, because its skills are unknown rather than absent and the empty
	 * list above would otherwise be quietly wrong.
	 */
	private _drawSources(root: HTMLElement, result: IKinguSkillScan): void {
		const scanned = result.sources.filter(source => source.exists);
		const unreadable = result.sources.filter(source => source.skippedReason === 'unreadable');
		const section = append(root, $('.kingu-skills-sources'));
		section.textContent = localize('kingu.skills.scannedRoots', "Looked in {0} of {1} known skill directories.", scanned.length, result.sources.length);
		if (unreadable.length > 0) {
			append(section, $('.kingu-skills-sources-warning')).textContent =
				localize('kingu.skills.unreadableRoots', "{0} could not be read, so their skills are unknown rather than absent: {1}",
					unreadable.length, unreadable.map((source: IKinguSkillSource) => source.label).join(', '));
		}
	}

	layout(_width: number, _height: number): void { }
}

class KinguSkillsPageContribution extends Disposable {

	static readonly ID = 'kingu.contrib.skillsPage';

	constructor(
		@ICustomViewService customViewService: ICustomViewService,
	) {
		super();
		this._register(customViewService.registerCustomView({
			id: KINGU_SKILLS_VIEW_ID,
			ctor: new SyncDescriptor(KinguSkillsView),
		}));
	}
}

registerWorkbenchContribution2(KinguSkillsPageContribution.ID, KinguSkillsPageContribution, WorkbenchPhase.BlockRestore);

class ShowKinguSkillsAction extends Action2 {

	constructor() {
		super({
			id: KINGU_SHOW_SKILLS_COMMAND_ID,
			title: localize2('kingu.showSkills', "Kingu: Skills"),
			category: Categories.View,
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(ICustomViewService).showCustomView(KINGU_SKILLS_VIEW_ID);
	}
}

registerAction2(ShowKinguSkillsAction);
