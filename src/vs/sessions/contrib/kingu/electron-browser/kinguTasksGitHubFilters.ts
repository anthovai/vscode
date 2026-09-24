/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IKinguOrcaService } from '../common/kinguOrca.js';
import { IKinguGitHubSlug, KinguGitHubTaskKind } from '../common/kinguTasksGitHub.js';
import { countActiveFilters, IKinguGitHubFilterChange, IKinguGitHubQuery, KinguGitHubQueryState } from '../common/kinguTasksGitHubQuery.js';
import { lucideIcon } from './kinguOrcaFooterParts.js';

type Section = 'status' | 'author' | 'label' | 'reviewer' | 'assignee';

interface IUser {
	readonly login: string;
	readonly name?: string | null;
}

type ListResult<T> = { readonly ok: true } & T | { readonly ok: false; readonly error?: { readonly message?: string } };

export interface IKinguGitHubFiltersHost {
	query(): IKinguGitHubQuery;
	kind(): KinguGitHubTaskKind;
	/** Authors seen in the loaded rows of the current kind. */
	authorLogins(): readonly string[];
	/** The repo the lists of labels and people are read from. */
	primarySlug(): IKinguGitHubSlug | undefined;
	change(change: IKinguGitHubFilterChange): void;
}

/** Large pasted text is refused rather than filtered, as the ADE does. */
const SEARCH_TEXT_LIMIT = 2048;

/**
 * The ADE's Filters button (`github/PRFilterDropdowns.tsx`, `PRFilterSections.tsx`,
 * `PRFilterPickers.tsx`): a menu of Status, Author, Label, Reviewer and Assignee,
 * each opening a detail screen, and a pill per active filter.
 */
export class KinguTasksGitHubFilters extends Disposable {

	private readonly _rendered = this._register(new DisposableStore());
	private readonly _popover = this._register(new MutableDisposable<DisposableStore>());
	private readonly _labels = new Map<string, Promise<ListResult<{ labels: string[] }>>>();
	private readonly _users = new Map<string, Promise<ListResult<{ users: IUser[] }>>>();

	private readonly _anchor: HTMLElement;
	private readonly _button: HTMLButtonElement;
	private readonly _pillsContainer: HTMLElement;

	constructor(
		container: HTMLElement,
		private readonly _host: IKinguGitHubFiltersHost,
		@IKinguOrcaService private readonly _orca: IKinguOrcaService,
	) {
		super();
		container.classList.add('kingu-tasks-gh-filter-group');
		// The button and its popover stay put across redraws; only the label, badge and pills change.
		this._anchor = append(container, $('.kingu-tasks-gh-filter-anchor'));
		this._button = append(this._anchor, $('button.kingu-tasks-gh-filter-button')) as HTMLButtonElement;
		this._button.type = 'button';
		this._button.setAttribute('aria-haspopup', 'dialog');
		this._register(addDisposableListener(this._button, EventType.CLICK, () => this._toggle(this._anchor, this._button)));
		this._pillsContainer = append(container, $('.kingu-tasks-gh-filter-pills'));
		this.render();
	}

	/** Redraws the button and pills from the current query. */
	render(): void {
		this._rendered.clear();
		const query = this._host.query();
		const count = countActiveFilters(query);
		const button = this._button;
		clearNode(button);
		button.classList.toggle('active', count > 0);
		button.appendChild(lucideIcon('list-filter', 14));
		append(button, $('span')).textContent = localize('kingu.tasks.github.filters', "Filters");
		if (count > 0) {
			append(button, $('span.kingu-tasks-gh-filter-count')).textContent = String(count);
		}

		clearNode(this._pillsContainer);
		for (const pill of this._pills(query)) {
			const element = append(this._pillsContainer, $('span.kingu-tasks-gh-filter-pill'));
			append(element, $('span.muted')).textContent = `${pill.label}:`;
			append(element, $('span.value')).textContent = pill.value;
			const remove = append(element, $('button.kingu-tasks-gh-filter-pill-remove')) as HTMLButtonElement;
			remove.type = 'button';
			remove.setAttribute('aria-label', localize('kingu.tasks.github.removeFilter', "Remove {0} filter", pill.label));
			remove.appendChild(lucideIcon('x', 12));
			this._rendered.add(addDisposableListener(remove, EventType.CLICK, () => this._host.change(pill.clear)));
		}
	}

	private _statusLabel(query: IKinguGitHubQuery): string | undefined {
		const state = query.state === 'closed' ? localize('kingu.tasks.github.stateClosed', "Closed")
			: query.state === 'merged' ? localize('kingu.tasks.github.stateMerged', "Merged")
				: query.state === 'all' ? localize('kingu.tasks.github.stateAll', "All")
					: localize('kingu.tasks.github.stateOpen', "Open");
		return query.draft ? `${state} · ${localize('kingu.tasks.github.draft', "Draft")}` : state;
	}

	private _reviewerLabel(query: IKinguGitHubQuery): string {
		return query.reviewedBy ? localize('kingu.tasks.github.reviewedBy', "Reviewed by") : localize('kingu.tasks.github.reviewFrom', "Review from");
	}

	private _pills(query: IKinguGitHubQuery): { label: string; value: string; clear: IKinguGitHubFilterChange }[] {
		const pills: { label: string; value: string; clear: IKinguGitHubFilterChange }[] = [];
		if ((query.state !== null && query.state !== 'open') || query.draft) {
			const value = query.state === 'all' ? localize('kingu.tasks.github.stateAny', "Any") : this._statusLabel(query) ?? '';
			pills.push({ label: localize('kingu.tasks.github.status', "Status"), value: query.state === 'all' && query.draft ? `${value} · ${localize('kingu.tasks.github.draft', "Draft")}` : value, clear: { state: 'open', draft: false } });
		}
		if (query.author) {
			pills.push({ label: localize('kingu.tasks.github.author', "Author"), value: query.author, clear: { author: null } });
		}
		if (query.labels.length > 0) {
			pills.push({ label: localize('kingu.tasks.github.label', "Label"), value: query.labels.length === 1 ? query.labels[0] : localize('kingu.tasks.github.nLabels', "{0} labels", query.labels.length), clear: { labels: [] } });
		}
		const reviewer = query.reviewRequested ?? query.reviewedBy;
		if (reviewer) {
			pills.push({ label: this._reviewerLabel(query), value: reviewer, clear: { reviewer: null } });
		}
		if (query.assignee) {
			pills.push({ label: localize('kingu.tasks.github.assignee', "Assignee"), value: query.assignee, clear: { assignee: null } });
		}
		return pills;
	}

	private _toggle(anchor: HTMLElement, button: HTMLElement): void {
		if (this._popover.value) {
			this._popover.clear();
			return;
		}
		const store = new DisposableStore();
		this._popover.value = store;
		const popover = append(anchor, $('.kingu-tasks-gh-filter-popover'));
		popover.setAttribute('role', 'dialog');
		popover.setAttribute('aria-label', localize('kingu.tasks.github.filters', "Filters"));
		store.add({ dispose: () => popover.remove() });
		const screen = new DisposableStore();
		store.add(screen);
		const show = (section: Section | undefined) => {
			screen.clear();
			clearNode(popover);
			if (section) {
				this._detail(popover, screen, section, () => show(undefined));
			} else {
				this._menu(popover, screen, section => show(section), () => this._popover.clear());
			}
		};
		show(undefined);
		store.add(addDisposableListener(getWindow(anchor).document, EventType.MOUSE_DOWN, (event: MouseEvent) => {
			if (!anchor.contains(event.target as Node)) {
				this._popover.clear();
			}
		}, true));
		store.add(addDisposableListener(popover, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.stopPropagation();
				this._popover.clear();
				button.focus();
			}
		}));
	}

	private _menu(popover: HTMLElement, store: DisposableStore, open: (section: Section) => void, close: () => void): void {
		const query = this._host.query();
		const isPr = this._host.kind() === 'prs';
		const menu = append(popover, $('.kingu-tasks-gh-filter-menu'));
		append(menu, $('.kingu-tasks-gh-filter-heading')).textContent = isPr
			? localize('kingu.tasks.github.filterPrs', "Filter pull requests")
			: localize('kingu.tasks.github.filterIssues', "Filter issues");
		const rows: [Section, string, string | undefined][] = [
			['status', localize('kingu.tasks.github.status', "Status"), this._statusLabel(query)],
			['author', localize('kingu.tasks.github.author', "Author"), query.author ?? undefined],
			['label', localize('kingu.tasks.github.label', "Label"), query.labels.length === 0 ? undefined : query.labels.length === 1 ? query.labels[0] : localize('kingu.tasks.github.nLabels', "{0} labels", query.labels.length)],
			...(isPr ? [['reviewer', this._reviewerLabel(query), (query.reviewRequested ?? query.reviewedBy) ?? undefined] as [Section, string, string | undefined]] : []),
			['assignee', localize('kingu.tasks.github.assignee', "Assignee"), query.assignee ?? undefined],
		];
		let first: HTMLButtonElement | undefined;
		for (const [section, label, value] of rows) {
			const row = append(menu, $('button.kingu-tasks-gh-filter-row')) as HTMLButtonElement;
			first ??= row;
			row.type = 'button';
			append(row, $('span')).textContent = label;
			const right = append(row, $('span.kingu-tasks-gh-filter-row-value'));
			if (value) {
				append(right, $('span.truncate')).textContent = value;
			}
			right.appendChild(lucideIcon('chevron-right', 14));
			store.add(addDisposableListener(row, EventType.CLICK, () => open(section)));
		}
		if (countActiveFilters(query) > 0) {
			append(menu, $('.kingu-tasks-gh-filter-divider'));
			const clear = append(menu, $('button.kingu-tasks-gh-filter-clear')) as HTMLButtonElement;
			clear.type = 'button';
			clear.textContent = localize('kingu.tasks.github.clearFilters', "Clear all filters");
			store.add(addDisposableListener(clear, EventType.CLICK, () => {
				this._host.change({ author: null, assignee: null, reviewer: null, labels: [], state: 'open', draft: false });
				close();
			}));
		}
		first?.focus();
	}

	private _detail(popover: HTMLElement, store: DisposableStore, section: Section, back: () => void): void {
		const backButton = append(popover, $('button.kingu-tasks-gh-filter-back')) as HTMLButtonElement;
		backButton.type = 'button';
		backButton.appendChild(lucideIcon('chevron-left', 12));
		append(backButton, $('span')).textContent = localize('kingu.tasks.github.back', "Back");
		store.add(addDisposableListener(backButton, EventType.CLICK, back));
		const apply = (change: IKinguGitHubFilterChange) => {
			this._host.change(change);
			back();
		};
		const query = this._host.query();
		switch (section) {
			case 'status': return this._status(popover, store, query, apply);
			case 'author': return this._picker(popover, store, {
				options: Promise.resolve([{ key: '@me', primary: '@me', secondary: localize('kingu.tasks.github.currentUser', "Current user") }, ...this._authorOptions(query)]),
				selected: query.author ? [query.author] : [],
				placeholder: localize('kingu.tasks.github.filterLogin', "Filter or type a login..."),
				empty: localize('kingu.tasks.github.noAuthors', "No authors"),
				custom: true,
				pick: value => apply({ author: value[0] ?? null }),
			});
			case 'assignee': return this._picker(popover, store, {
				options: this._userOptions(),
				selected: query.assignee ? [query.assignee] : [],
				placeholder: localize('kingu.tasks.github.filterLogin', "Filter or type a login..."),
				empty: localize('kingu.tasks.github.noUsers', "No users"),
				custom: true,
				pick: value => apply({ assignee: value[0] ?? null }),
			});
			case 'label': return this._picker(popover, store, {
				options: this._labelOptions(),
				selected: query.labels,
				placeholder: localize('kingu.tasks.github.filterLabels', "Filter labels..."),
				empty: localize('kingu.tasks.github.noLabels', "No labels"),
				multi: true,
				pick: value => apply({ labels: value }),
			});
			case 'reviewer': return this._reviewer(popover, store, query, apply);
		}
	}

	private _status(popover: HTMLElement, store: DisposableStore, query: IKinguGitHubQuery, apply: (change: IKinguGitHubFilterChange) => void): void {
		const list = append(popover, $('.kingu-tasks-gh-filter-menu'));
		const isPr = this._host.kind() === 'prs';
		const options: [KinguGitHubQueryState, string][] = [
			['open', localize('kingu.tasks.github.stateOpen', "Open")],
			['closed', localize('kingu.tasks.github.stateClosed', "Closed")],
			...(isPr ? [['merged', localize('kingu.tasks.github.stateMerged', "Merged")] as [KinguGitHubQueryState, string]] : []),
			['all', localize('kingu.tasks.github.anyState', "Any state")],
		];
		const current = query.state ?? 'open';
		for (const [state, label] of options) {
			const row = append(list, $('button.kingu-tasks-gh-filter-row')) as HTMLButtonElement;
			row.type = 'button';
			row.classList.toggle('selected', current === state);
			append(row, $('span')).textContent = label;
			if (current === state) {
				append(row, $('span.kingu-tasks-gh-filter-selected')).textContent = localize('kingu.tasks.github.selected', "selected");
			}
			store.add(addDisposableListener(row, EventType.CLICK, () => apply({ state })));
		}
		if (isPr) {
			append(list, $('.kingu-tasks-gh-filter-divider'));
			const draft = append(list, $('button.kingu-tasks-gh-filter-row')) as HTMLButtonElement;
			draft.type = 'button';
			append(draft, $('span')).textContent = localize('kingu.tasks.github.draftOnly', "Draft only");
			append(draft, $('span.kingu-tasks-gh-filter-selected')).textContent = query.draft ? localize('kingu.tasks.github.on', "on") : localize('kingu.tasks.github.off', "off");
			store.add(addDisposableListener(draft, EventType.CLICK, () => apply({ draft: !query.draft })));
		}
	}

	private _reviewer(popover: HTMLElement, store: DisposableStore, query: IKinguGitHubQuery, apply: (change: IKinguGitHubFilterChange) => void): void {
		let mode: 'requested' | 'reviewed-by' = query.reviewedBy ? 'reviewed-by' : 'requested';
		const switcher = append(popover, $('.kingu-tasks-gh-filter-modes'));
		const buttons = new Map<'requested' | 'reviewed-by', HTMLButtonElement>();
		for (const [id, label] of [['requested', localize('kingu.tasks.github.reviewRequested', "Review requested")], ['reviewed-by', localize('kingu.tasks.github.reviewedBy', "Reviewed by")]] as const) {
			const button = append(switcher, $('button.kingu-tasks-gh-filter-mode')) as HTMLButtonElement;
			button.type = 'button';
			button.textContent = label;
			buttons.set(id, button);
			store.add(addDisposableListener(button, EventType.CLICK, () => {
				mode = id;
				sync();
			}));
		}
		const sync = () => {
			for (const [id, button] of buttons) {
				button.classList.toggle('active', mode === id);
				button.setAttribute('aria-pressed', String(mode === id));
			}
		};
		sync();
		const current = query.reviewRequested ?? query.reviewedBy;
		this._picker(popover, store, {
			options: this._userOptions(),
			selected: current ? [current] : [],
			placeholder: localize('kingu.tasks.github.filterLogin', "Filter or type a login..."),
			empty: localize('kingu.tasks.github.noUsers', "No users"),
			custom: true,
			pick: value => apply({ reviewer: value[0] ? { kind: mode, login: value[0] } : null }),
		});
	}

	private _authorOptions(query: IKinguGitHubQuery): { key: string; primary: string }[] {
		const seen = new Set<string>(['@me']);
		const options: { key: string; primary: string }[] = [];
		for (const login of [...this._host.authorLogins(), ...(query.author ? [query.author] : [])]) {
			if (!seen.has(login.toLowerCase())) {
				seen.add(login.toLowerCase());
				options.push({ key: login, primary: login });
			}
		}
		return options;
	}

	private _slugKey(slug: IKinguGitHubSlug): string {
		return `${slug.host ?? 'github.com'}/${slug.owner}/${slug.repo}`.toLowerCase();
	}

	private async _labelOptions(): Promise<{ key: string; primary: string }[]> {
		const slug = this._host.primarySlug();
		if (!slug) {
			return [];
		}
		const key = this._slugKey(slug);
		let request = this._labels.get(key);
		if (!request) {
			request = this._orca.invoke<ListResult<{ labels: string[] }>>('gh:listLabelsBySlug', { ...slug });
			this._labels.set(key, request);
			request.catch(() => this._labels.delete(key));
		}
		const result = await request;
		if (!result.ok) {
			this._labels.delete(key);
			throw new Error(result.error?.message || localize('kingu.tasks.github.labelsFailed', "Failed to load labels"));
		}
		return result.labels.map(label => ({ key: label, primary: label }));
	}

	private async _userOptions(): Promise<{ key: string; primary: string; secondary?: string }[]> {
		const me = { key: '@me', primary: '@me', secondary: localize('kingu.tasks.github.currentUser', "Current user") };
		const slug = this._host.primarySlug();
		if (!slug) {
			return [me];
		}
		const key = this._slugKey(slug);
		let request = this._users.get(key);
		if (!request) {
			request = this._orca.invoke<ListResult<{ users: IUser[] }>>('gh:listAssignableUsersBySlug', { ...slug });
			this._users.set(key, request);
			request.catch(() => this._users.delete(key));
		}
		const result = await request;
		if (!result.ok) {
			this._users.delete(key);
			throw new Error(result.error?.message || localize('kingu.tasks.github.usersFailed', "Failed to load assignees"));
		}
		return [me, ...result.users.map(user => ({ key: user.login, primary: user.login, secondary: user.name ?? undefined }))];
	}

	/** `PRFilterPickers`: a filtered list; single-select clears on re-pick and may take a typed login. */
	private _picker(popover: HTMLElement, store: DisposableStore, options: {
		options: Promise<{ key: string; primary: string; secondary?: string }[]>;
		selected: readonly string[];
		placeholder: string;
		empty: string;
		custom?: boolean;
		multi?: boolean;
		pick(value: string[]): void;
	}): void {
		const input = append(popover, $('input.kingu-tasks-gh-filter-search')) as HTMLInputElement;
		input.type = 'text';
		input.placeholder = options.placeholder;
		input.setAttribute('aria-label', options.placeholder);
		const list = append(popover, $('.kingu-tasks-gh-filter-list'));
		list.setAttribute('role', 'listbox');
		let items: { key: string; primary: string; secondary?: string }[] | undefined;
		let error: string | undefined;
		const selected = new Set(options.selected.map(value => value.toLowerCase()));
		const draw = () => {
			clearNode(list);
			const text = input.value.trim();
			const status = (message: string) => { append(list, $('.kingu-tasks-gh-filter-status')).textContent = message; };
			if (text.length > SEARCH_TEXT_LIMIT) {
				return status(localize('kingu.tasks.github.searchTooLarge', "Search text is too large."));
			}
			const lower = text.toLowerCase();
			const matches = (items ?? []).filter(item => !lower || item.primary.toLowerCase().includes(lower) || item.secondary?.toLowerCase().includes(lower));
			const row = (label: HTMLElement | string, run: () => void, checked?: boolean) => {
				const button = append(list, $('button.kingu-tasks-gh-filter-option')) as HTMLButtonElement;
				button.type = 'button';
				button.setAttribute('role', 'option');
				if (checked !== undefined) {
					button.setAttribute('aria-selected', String(checked));
					button.appendChild(lucideIcon('check', 12, checked ? 'kingu-tasks-gh-check on' : 'kingu-tasks-gh-check'));
				}
				if (typeof label === 'string') {
					append(button, $('span')).textContent = label;
				} else {
					button.appendChild(label);
				}
				store.add(addDisposableListener(button, EventType.CLICK, run));
				return button;
			};
			const customCandidate = options.custom && text && !(items ?? []).some(item => item.key.toLowerCase() === lower);
			if (customCandidate) {
				const label = $('span');
				append(label, $('span')).textContent = `${localize('kingu.tasks.github.use', "Use")} `;
				append(label, $('b')).textContent = text;
				row(label, () => options.pick([text]));
			}
			if (options.multi && selected.size > 0) {
				row(localize('kingu.tasks.github.clearCount', "Clear ({0})", selected.size), () => options.pick([]));
			} else if (!options.multi && selected.size > 0) {
				row(localize('kingu.tasks.github.clear', "Clear"), () => options.pick([])).classList.add('muted');
			}
			for (const item of matches) {
				const label = $('span.kingu-tasks-gh-filter-option-text');
				append(label, $('span.truncate')).textContent = item.primary;
				if (item.secondary) {
					append(label, $('span.kingu-tasks-gh-filter-option-secondary')).textContent = item.secondary;
				}
				const checked = selected.has(item.key.toLowerCase());
				row(label, () => {
					if (options.multi) {
						const next = new Set(options.selected);
						const existing = [...next].find(value => value.toLowerCase() === item.key.toLowerCase());
						if (existing) {
							next.delete(existing);
						} else {
							next.add(item.key);
						}
						options.pick([...next]);
					} else {
						options.pick(checked ? [] : [item.key]);
					}
				}, checked);
			}
			if (matches.length === 0 && !customCandidate) {
				status(items === undefined ? localize('kingu.tasks.github.loading', "Loading…")
					: error ?? (text ? localize('kingu.tasks.github.noMatches', "No matches") : options.empty));
			} else if (customCandidate && matches.length === 0) {
				status(localize('kingu.tasks.github.enterToUse', "Press Enter to use the typed value."));
			}
		};
		store.add(addDisposableListener(input, EventType.INPUT, draw));
		store.add(addDisposableListener(input, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			const text = input.value.trim();
			if (event.key === 'Enter' && !event.isComposing && text && options.custom && text.length <= SEARCH_TEXT_LIMIT) {
				event.preventDefault();
				options.pick([text]);
			}
		}));
		draw();
		options.options.then(value => { items = value; }, (err: unknown) => {
			items = [];
			error = err instanceof Error ? err.message : String(err);
		}).finally(() => {
			if (!store.isDisposed) {
				draw();
			}
		});
		input.focus();
	}
}
