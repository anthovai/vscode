/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/kinguOrcaSettings.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Emitter } from '../../../../base/common/event.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { Menus } from '../../../browser/menus.js';
import { IKinguOrcaService } from '../common/kinguOrca.js';
import { orcaKeyForSettingId, orcaSettingIdForKey } from '../common/kinguOrcaSettings.js';
import { IKinguOpenSettingsTarget, KINGU_OPEN_ORCA_SETTINGS_COMMAND_ID } from '../common/kinguOrcaSettingsCommands.js';
import { IOrcaSettingsPane, IOrcaSettingsRow, IOrcaSettingsSection, ORCA_SETTINGS_NAV, ORCA_SETTINGS_PANES } from '../common/kinguOrcaSettingsScreen.js';
import { attachFooterTooltip, lucideIcon } from './kinguOrcaFooterParts.js';
import { OrcaAccountsPane } from './kinguOrcaSettingsAccounts.js';
import './kinguOrcaService.js';

// #region Values

/**
 * The ADE's settings as the screen reads and writes them.
 *
 * Read whole from the ADE (`settings:get`), so every row shows the value the
 * ADE is using, defaults included. Written the way that keeps one source of
 * truth: a key this window also offers as a VS Code setting goes through the
 * configuration service, so the settings bridge carries it down (and a key
 * bound to a VS Code equivalent stays bound); any other key goes straight to
 * the ADE's `settings:set`.
 */
class OrcaSettingsValues extends Disposable {

	private _values: Record<string, unknown> = {};
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	constructor(
		private readonly _orca: IKinguOrcaService,
		private readonly _configurationService: IConfigurationService,
		private readonly _logService: ILogService,
	) {
		super();
		this._register(this._orca.onPush('settings:changed')(([updates]) => {
			this._values = { ...this._values, ...(updates as Record<string, unknown>) };
			this._onDidChange.fire();
		}));
		// A key this window also offers changes here first; the ADE follows through
		// the bridge, so the value is taken from here rather than read back early.
		this._register(this._configurationService.onDidChangeConfiguration(event => {
			let changed = false;
			for (const id of event.affectedKeys) {
				const key = id.startsWith('kingu.') ? orcaKeyForSettingId(id) : undefined;
				if (key !== undefined) {
					this._values = { ...this._values, [key]: this._configurationService.getValue(id) };
					changed = true;
				}
			}
			if (changed) {
				this._onDidChange.fire();
			}
		}));
	}

	async load(): Promise<void> {
		try {
			this._values = await this._orca.invoke<Record<string, unknown>>('settings:get') ?? {};
			this._onDidChange.fire();
		} catch (error) {
			this._logService.warn('[kingu-settings] settings:get failed', error);
		}
	}

	get(key: string): unknown {
		let value: unknown = this._values;
		for (const part of key.split('.')) {
			value = value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined;
		}
		return value;
	}

	async set(key: string, value: unknown): Promise<void> {
		const [top, ...rest] = key.split('.');
		let next: unknown = value;
		if (rest.length > 0) {
			const clone = structuredClone((this._values[top] ?? {}) as Record<string, unknown>);
			let cursor = clone;
			for (const part of rest.slice(0, -1)) {
				cursor[part] = { ...(cursor[part] as Record<string, unknown> | undefined) };
				cursor = cursor[part] as Record<string, unknown>;
			}
			cursor[rest[rest.length - 1]] = value;
			next = clone;
		}
		this._values = { ...this._values, [top]: next };
		this._onDidChange.fire();
		try {
			const id = orcaSettingIdForKey(top);
			if (id && this._configurationService.inspect(id).defaultValue !== undefined) {
				await this._configurationService.updateValue(id, next, ConfigurationTarget.USER);
			} else {
				await this._orca.invoke('settings:set', { [top]: next });
			}
		} catch (error) {
			this._logService.error(`[kingu-settings] could not save ${key}`, error);
			await this.load();
		}
	}
}

/** An option's value as the ADE stores it, typed after the value it replaces. */
function parseOptionValue(raw: string, current: unknown): unknown {
	if (raw === 'null') {
		return null;
	}
	if (raw === 'true' || raw === 'false') {
		return raw === 'true';
	}
	if (typeof current === 'number' || (/^-?\d+(\.\d+)?$/.test(raw) && typeof current !== 'string')) {
		const number = Number(raw);
		return Number.isFinite(number) ? number : raw;
	}
	return raw;
}

function optionMatches(raw: string, current: unknown): boolean {
	return raw === (current === null ? 'null' : String(current));
}

// #endregion

// #region Screen

/** The ADE shows its macOS permissions pane on macOS only. */
function isPaneOnThisPlatform(paneId: string): boolean {
	return paneId !== 'developer-permissions' || isMacintosh;
}

/** A row as the search sees it. */
function rowMatches(query: string, pane: IOrcaSettingsPane, section: IOrcaSettingsSection, row: IOrcaSettingsRow): boolean {
	if (!query) {
		return true;
	}
	const haystack = [pane.title, section.title, section.description, row.label, row.description, ...(row.options ?? []).map(option => option.label)]
		.filter(Boolean).join('\n').toLowerCase();
	return query.toLowerCase().split(/\s+/).filter(Boolean).every(word => haystack.includes(word));
}

/**
 * The ADE's settings screen, in this window.
 *
 * It takes the place of the workbench between the title bar and the footer, as
 * the ADE's settings view takes the place of its app: a 280px sidebar with
 * "Back to app", the search, and the ADE's groups; then the selected pane —
 * its title, subtitle, and its sections in one card, row by row with the ADE's
 * labels and controls.
 */
class KinguOrcaSettingsScreen extends Disposable {

	static readonly ID = 'kingu.contrib.orcaSettingsScreen';
	private static _instance: KinguOrcaSettingsScreen | undefined;

	static open(target: IKinguOpenSettingsTarget | undefined): void {
		KinguOrcaSettingsScreen._instance?._open(target);
	}

	private readonly _values: OrcaSettingsValues;
	private readonly _accounts: OrcaAccountsPane;
	private readonly _shown = this._register(new MutableDisposable<DisposableStore>());
	private readonly _drawing = this._register(new MutableDisposable<DisposableStore>());
	private _root: HTMLElement | undefined;
	private _content: HTMLElement | undefined;
	private _nav: HTMLElement | undefined;
	private _activePane = 'general';
	private _query = '';
	private _pendingSection: string | undefined;
	private _redrawPending = false;
	/** The current drawing's sections, by id, for a deep link to scroll to. */
	private readonly _sectionElements = new Map<string, HTMLElement>();

	constructor(
		@IKinguOrcaService orca: IKinguOrcaService,
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IFileDialogService private readonly _fileDialogService: IFileDialogService,
		@ICommandService private readonly _commandService: ICommandService,
		@IDialogService private readonly _dialogService: IDialogService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IOpenerService private readonly _openerService: IOpenerService,
	) {
		super();
		this._values = this._register(new OrcaSettingsValues(orca, configurationService, logService));
		this._accounts = new OrcaAccountsPane({
			invoke: (channel, ...args) => orca.invoke(channel, ...args),
			confirm: async (message, detail, primaryButton) => (await this._dialogService.confirm({ type: 'warning', message, detail, primaryButton })).confirmed,
			notifyError: message => this._notificationService.error(message),
			redraw: () => this._redrawContent(),
			rateLimits: () => undefined,
			openExternal: url => void this._openerService.open(URI.parse(url), { openExternal: true }),
		});
		this._register(this._values.onDidChange(() => this._redrawContent()));
		KinguOrcaSettingsScreen._instance = this;
		this._register(toDisposable(() => {
			if (KinguOrcaSettingsScreen._instance === this) {
				KinguOrcaSettingsScreen._instance = undefined;
			}
		}));
	}

	private _open(target: IKinguOpenSettingsTarget | undefined): void {
		if (target?.pane && ORCA_SETTINGS_PANES.some(pane => pane.id === target.pane)) {
			this._activePane = target.pane;
			this._query = '';
		}
		this._pendingSection = target?.sectionId;
		if (!this._shown.value) {
			this._shown.value = this._show();
		}
		void this._values.load();
		this._redraw();
	}

	private _close(): void {
		this._shown.clear();
	}

	private _show(): DisposableStore {
		const store = new DisposableStore();
		const container = this._layoutService.mainContainer;
		const root = append(container, $('.kingu-orca-settings'));
		root.setAttribute('role', 'dialog');
		root.setAttribute('aria-label', localize('kingu.settings.aria', "Settings"));
		this._root = root;
		store.add(toDisposable(() => {
			root.remove();
			this._root = undefined;
			this._content = undefined;
			this._nav = undefined;
			this._drawing.clear();
		}));

		// Between the title bar and the footer, as the ADE's settings view sits between its own.
		const place = () => {
			const title = this._layoutService.getContainer(mainWindow, Parts.TITLEBAR_PART)?.getBoundingClientRect();
			const footer = this._layoutService.getContainer(mainWindow, Parts.STATUSBAR_PART)?.getBoundingClientRect();
			root.style.top = `${Math.round(title?.bottom ?? 0)}px`;
			root.style.bottom = `${Math.round(footer && footer.height > 0 ? mainWindow.innerHeight - footer.top : 0)}px`;
		};
		place();
		store.add(this._layoutService.onDidLayoutMainContainer(place));
		store.add(addDisposableListener(mainWindow, EventType.RESIZE, place));
		store.add(addDisposableListener(root, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			const keyboard = new StandardKeyboardEvent(event);
			if (keyboard.equals(KeyMod.CtrlCmd | KeyCode.KeyF)) {
				event.preventDefault();
				this._searchInput?.focus();
			}
		}));
		return store;
	}

	private _searchInput: HTMLInputElement | undefined;

	private _redraw(): void {
		const root = this._root;
		if (!root) {
			return;
		}
		clearNode(root);
		this._renderSidebar(append(root, $('aside.kingu-orca-settings-sidebar')));
		const main = append(root, $('.kingu-orca-settings-main'));
		this._content = append(main, $('.kingu-orca-settings-scroll'));
		this._redrawContent();
	}

	/** The sidebar: back, search, then the ADE's groups (only panes with a match while searching). */
	private _renderSidebar(sidebar: HTMLElement): void {
		const backWrap = append(sidebar, $('.kingu-orca-settings-sidebar-block'));
		const back = append(backWrap, $('button.kingu-orca-settings-back')) as HTMLButtonElement;
		back.type = 'button';
		back.appendChild(lucideIcon('arrow-left', 16));
		append(back, $('span')).textContent = localize('kingu.settings.back', "Back to app");
		back.addEventListener('click', () => this._close());

		const searchWrap = append(sidebar, $('.kingu-orca-settings-sidebar-block'));
		const search = append(searchWrap, $('.kingu-orca-settings-search'));
		search.appendChild(lucideIcon('search', 16, 'kingu-orca-settings-search-icon'));
		const input = append(search, $('input.kingu-orca-input')) as HTMLInputElement;
		input.placeholder = localize('kingu.settings.search', "Search settings");
		input.value = this._query;
		input.setAttribute('aria-label', input.placeholder);
		this._searchInput = input;
		const hint = append(search, $('span.kingu-orca-settings-search-hint'));
		const shortcut = mainWindow.navigator.platform.startsWith('Mac') ? ['⌘', 'F'] : ['Ctrl', 'F'];
		shortcut.forEach((key, index) => {
			if (index > 0) {
				append(hint, $('span.kingu-orca-settings-kbd-sep')).textContent = '+';
			}
			append(hint, $('kbd.kingu-orca-settings-kbd')).textContent = key;
		});
		hint.style.display = this._query ? 'none' : '';
		input.addEventListener('input', () => {
			this._query = input.value;
			hint.style.display = this._query ? 'none' : '';
			this._renderNav();
			this._redrawContent();
		});
		mainWindow.setTimeout(() => input.focus(), 0);

		this._nav = append(sidebar, $('.kingu-orca-settings-nav'));
		this._renderNav();
	}

	private _visiblePanes(): readonly IOrcaSettingsPane[] {
		return ORCA_SETTINGS_PANES.filter(pane => isPaneOnThisPlatform(pane.id) && pane.sections.some(section => section.rows.some(row => !row.dynamic && rowMatches(this._query, pane, section, row))));
	}

	private _renderNav(): void {
		const nav = this._nav;
		if (!nav) {
			return;
		}
		clearNode(nav);
		const visible = new Set(this._visiblePanes().map(pane => pane.id));
		if (this._query && !visible.has(this._activePane) && visible.size > 0) {
			this._activePane = [...visible][0];
		}
		for (const group of ORCA_SETTINGS_NAV) {
			const items = group.items.filter(item => isPaneOnThisPlatform(item.id) && (!this._query || visible.has(item.id)));
			if (items.length === 0) {
				continue;
			}
			const block = append(nav, $('.kingu-orca-settings-nav-group'));
			append(block, $('p.kingu-orca-settings-nav-heading')).textContent = group.label;
			const list = append(block, $('.kingu-orca-settings-nav-items'));
			for (const item of items) {
				const button = append(list, $('button.kingu-orca-settings-nav-item')) as HTMLButtonElement;
				button.type = 'button';
				button.classList.toggle('active', item.id === this._activePane);
				button.setAttribute('aria-current', item.id === this._activePane ? 'page' : 'false');
				button.appendChild(lucideIcon(item.icon, 16));
				append(button, $('span.kingu-orca-truncate')).textContent = item.label;
				if (item.badge) {
					append(button, $('span.kingu-orca-settings-nav-badge')).textContent = item.badge;
				}
				button.addEventListener('click', () => {
					this._activePane = item.id;
					this._renderNav();
					this._redrawContent();
					this._content?.scrollTo({ top: 0 });
				});
			}
		}
	}

	private _redrawContent(): void {
		const content = this._content;
		if (!content) {
			return;
		}
		// A redraw replaces every control. While one of them is being edited, a
		// change arriving from elsewhere would throw away what is being typed, so
		// the redraw waits until the edit ends.
		const active = content.ownerDocument.activeElement;
		if (active && content.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
			if (!this._redrawPending) {
				this._redrawPending = true;
				active.addEventListener('blur', () => {
					this._redrawPending = false;
					// After the blur's own commit has been taken.
					mainWindow.setTimeout(() => this._redrawContent(), 0);
				}, { once: true });
			}
			return;
		}
		const scrollTop = content.scrollTop;
		const store = new DisposableStore();
		this._drawing.value = store;
		this._sectionElements.clear();
		clearNode(content);
		const column = append(content, $('.kingu-orca-settings-column'));
		const pane = this._visiblePanes().find(candidate => candidate.id === this._activePane) ?? (this._query ? undefined : ORCA_SETTINGS_PANES.find(candidate => candidate.id === this._activePane));
		if (!pane) {
			const empty = append(column, $('.kingu-orca-settings-empty'));
			empty.textContent = localize('kingu.settings.noResults', "No settings found for \"{0}\"", this._query.trim());
			return;
		}
		this._renderPane(column, pane, store);
		content.scrollTop = scrollTop;
		if (this._pendingSection) {
			this._sectionElements.get(this._pendingSection)?.scrollIntoView({ block: 'start' });
			this._pendingSection = undefined;
		}
	}

	/** `SettingsSection`: the title with its badge, the subtitle, then the body card. */
	private _renderPane(parent: HTMLElement, pane: IOrcaSettingsPane, store: DisposableStore): void {
		if (pane.id === 'accounts' && !this._accounts.loaded) {
			void this._accounts.load();
		}
		const section = append(parent, $('section.kingu-orca-settings-pane'));
		const header = append(section, $('.kingu-orca-settings-pane-header'));
		const title = append(header, $('h2.kingu-orca-settings-pane-title'));
		title.append(pane.title);
		if (pane.badge) {
			append(title, $('span.kingu-orca-settings-pane-badge')).textContent = pane.badge;
		}
		if (pane.subtitle) {
			append(header, $('p.kingu-orca-settings-pane-subtitle')).textContent = pane.subtitle;
		}
		const card = append(section, $('.kingu-orca-settings-card'));
		let first = true;
		for (const subsection of pane.sections) {
			const rows = subsection.rows.filter(row => !row.dynamic && rowMatches(this._query, pane, subsection, row) && this._isShown(row));
			if (rows.length === 0 || (pane.id === 'accounts' && this._accounts.isHidden(subsection.title))) {
				continue;
			}
			if (!first) {
				append(card, $('.kingu-orca-settings-separator'));
			}
			first = false;
			const block = append(card, $('section.kingu-orca-settings-subsection'));
			this._sectionElements.set(subsection.id, block);
			if (pane.id === 'accounts' && this._accounts.render(block, subsection.title, subsection.description)) {
				continue;
			}
			if (subsection.title || subsection.description) {
				const head = append(block, $('.kingu-orca-settings-subsection-header'));
				if (subsection.title) {
					append(head, $('h3')).textContent = subsection.title;
				}
				if (subsection.description) {
					append(head, $('p')).textContent = subsection.description;
				}
			}
			for (const row of rows) {
				this._renderRow(block, row, store);
			}
		}
	}

	private _isShown(row: IOrcaSettingsRow): boolean {
		if (!row.when) {
			return true;
		}
		const value = this._values.get(row.when.key);
		if (row.when.equals !== undefined) {
			return value === row.when.equals;
		}
		return !(row.when.notEquals ?? []).includes(value);
	}

	// #region Rows

	/** `SettingsRow`: label and description on the left, the control on the right. */
	private _row(parent: HTMLElement, row: IOrcaSettingsRow): { readonly element: HTMLElement; readonly control: HTMLElement } {
		const element = append(parent, $('.kingu-orca-settings-row'));
		element.classList.toggle('has-description', !!row.description);
		const text = append(element, $('.kingu-orca-settings-row-text'));
		append(text, $('label.kingu-orca-settings-label')).textContent = row.label;
		if (row.description) {
			append(text, $('p.kingu-orca-settings-description')).textContent = row.description;
		}
		const control = append(element, $('.kingu-orca-settings-row-control'));
		return { element, control };
	}

	/** A label and description above a control that takes the full width. */
	private _stacked(parent: HTMLElement, row: IOrcaSettingsRow, descriptionBelow: boolean): { readonly element: HTMLElement; readonly body: HTMLElement } {
		const element = append(parent, $('.kingu-orca-settings-stacked'));
		append(element, $('label.kingu-orca-settings-label')).textContent = row.label;
		if (row.description && !descriptionBelow) {
			append(element, $('p.kingu-orca-settings-description')).textContent = row.description;
		}
		const body = append(element, $('.kingu-orca-settings-stacked-body'));
		if (row.description && descriptionBelow) {
			append(element, $('p.kingu-orca-settings-description')).textContent = row.description;
		}
		return { element, body };
	}

	private _renderRow(parent: HTMLElement, row: IOrcaSettingsRow, store: DisposableStore): void {
		if (row.keys.length === 0 && this._accounts.renderMiniMaxCredential(parent, row.label)) {
			return;
		}
		const key = row.keys[0];
		switch (row.control) {
			case 'toggle':
				if (key) {
					return this._toggleRow(parent, row, key);
				}
				break;
			case 'select':
				if (key && row.options?.length) {
					return this._selectRow(parent, row, key);
				}
				break;
			case 'segmented':
				if (key && row.options?.length) {
					return this._segmentedRow(parent, row, key);
				}
				break;
			case 'text':
				if (key && this._isScalar(key)) {
					return this._textRow(parent, row, key);
				}
				break;
			case 'textarea':
				if (key && this._isScalar(key)) {
					return this._textareaRow(parent, row, key);
				}
				break;
			case 'number':
			case 'slider':
				if (key && this._isScalar(key)) {
					return this._numberRow(parent, row, key, store);
				}
				break;
			case 'path-with-browse':
				if (key) {
					return this._pathRow(parent, row, key);
				}
				break;
			case 'show-hide-list':
				if (key === 'worktreeVisibilityDefaults') {
					return this._sourcesRow(parent, row);
				}
				break;
		}
		this._otherRow(parent, row, store);
	}

	private _isScalar(key: string): boolean {
		const value = this._values.get(key);
		return value === undefined || value === null || typeof value !== 'object';
	}

	/** `SettingsSwitchRow`, the ADE's switch: `h-5 w-9`, the thumb sliding 16px. */
	private _toggleRow(parent: HTMLElement, row: IOrcaSettingsRow, key: string): void {
		const { control } = this._row(parent, row);
		const raw = this._values.get(key);
		const checked = row.inverted ? raw !== true : raw === true;
		const toggle = append(control, $('button.kingu-orca-switch')) as HTMLButtonElement;
		toggle.type = 'button';
		toggle.setAttribute('role', 'switch');
		toggle.setAttribute('aria-checked', String(checked));
		toggle.setAttribute('aria-label', row.label);
		toggle.classList.toggle('checked', checked);
		append(toggle, $('span.kingu-orca-switch-thumb'));
		toggle.addEventListener('click', () => void this._values.set(key, row.inverted ? checked : !checked));
	}

	/** The ADE's `Select`: an `h-9` bordered trigger, `w-[180px]`, a chevron at its end. */
	private _selectRow(parent: HTMLElement, row: IOrcaSettingsRow, key: string): void {
		const { control } = this._row(parent, row);
		const current = this._values.get(key);
		const wrap = append(control, $('.kingu-orca-select'));
		const select = append(wrap, $('select')) as HTMLSelectElement;
		select.setAttribute('aria-label', row.label);
		for (const option of row.options ?? []) {
			const element = append(select, $('option')) as HTMLOptionElement;
			element.value = option.value;
			element.textContent = option.label;
			element.selected = optionMatches(option.value, current);
		}
		wrap.appendChild(lucideIcon('chevron-down', 16, 'kingu-orca-select-chevron'));
		select.addEventListener('change', () => void this._values.set(key, parseOptionValue(select.value, current)));
	}

	/** `SettingsSegmentedControl`, the ADE's default `md` size. */
	private _segmentedRow(parent: HTMLElement, row: IOrcaSettingsRow, key: string): void {
		const { control } = this._row(parent, row);
		const current = this._values.get(key);
		const group = append(control, $('.kingu-orca-segmented.md'));
		group.setAttribute('role', 'radiogroup');
		group.setAttribute('aria-label', row.label);
		for (const option of row.options ?? []) {
			const button = append(group, $('button.kingu-orca-segment-option')) as HTMLButtonElement;
			button.type = 'button';
			const active = optionMatches(option.value, current);
			button.setAttribute('role', 'radio');
			button.setAttribute('aria-checked', String(active));
			button.classList.toggle('active', active);
			button.textContent = option.label;
			button.addEventListener('click', () => void this._values.set(key, parseOptionValue(option.value, current)));
		}
	}

	/** An input committed on blur or Enter, reverted on Escape, as the ADE's settings inputs are. */
	private _bindInput(input: HTMLInputElement | HTMLTextAreaElement, key: string, parse: (value: string) => unknown, multiline: boolean): void {
		const initial = this._values.get(key);
		input.value = initial === undefined || initial === null ? '' : String(initial);
		const commit = () => {
			const next = parse(input.value);
			if (next !== initial) {
				void this._values.set(key, next);
			}
		};
		input.addEventListener('blur', commit);
		(input as HTMLElement).addEventListener('keydown', (event: KeyboardEvent) => {
			if (event.key === 'Enter' && (!multiline || event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				input.blur();
			} else if (event.key === 'Escape') {
				input.value = initial === undefined || initial === null ? '' : String(initial);
				input.blur();
			}
		});
	}

	private _textRow(parent: HTMLElement, row: IOrcaSettingsRow, key: string): void {
		const { control } = this._row(parent, row);
		const input = append(control, $('input.kingu-orca-input.wide')) as HTMLInputElement;
		input.setAttribute('aria-label', row.label);
		this._bindInput(input, key, value => value, false);
	}

	private _textareaRow(parent: HTMLElement, row: IOrcaSettingsRow, key: string): void {
		const { body } = this._stacked(parent, row, false);
		const textarea = append(body, $('textarea.kingu-orca-textarea')) as HTMLTextAreaElement;
		textarea.rows = 4;
		textarea.setAttribute('aria-label', row.label);
		this._bindInput(textarea, key, value => value, true);
	}

	/** `NumberField`: a `w-24` number input; a slider beside it for the ADE's slider rows. */
	private _numberRow(parent: HTMLElement, row: IOrcaSettingsRow, key: string, _store: DisposableStore): void {
		const { control } = this._row(parent, row);
		const wrap = append(control, $('.kingu-orca-number'));
		if (row.control === 'slider') {
			const slider = append(wrap, $('input.kingu-orca-slider')) as HTMLInputElement;
			slider.type = 'range';
			const current = Number(this._values.get(key) ?? 0);
			slider.min = String(Math.min(0, current));
			slider.max = String(Math.max(current * 2, current + 10, 21));
			slider.step = Number.isInteger(current) ? '1' : '0.1';
			slider.value = String(current);
			slider.setAttribute('aria-label', row.label);
			slider.addEventListener('change', () => void this._values.set(key, Number(slider.value)));
		}
		const input = append(wrap, $('input.kingu-orca-input.number')) as HTMLInputElement;
		input.type = 'number';
		input.setAttribute('aria-label', row.label);
		this._bindInput(input, key, value => {
			const number = Number(value);
			return value.trim() === '' || !Number.isFinite(number) ? this._values.get(key) : number;
		}, false);
	}

	/** The workspace directory: a full-width input and "Browse", the helper beneath. */
	private _pathRow(parent: HTMLElement, row: IOrcaSettingsRow, key: string): void {
		const { body } = this._stacked(parent, row, true);
		const line = append(body, $('.kingu-orca-settings-path'));
		const input = append(line, $('input.kingu-orca-input')) as HTMLInputElement;
		input.setAttribute('aria-label', row.label);
		this._bindInput(input, key, value => value, false);
		const browse = append(line, $('button.kingu-orca-button.outline')) as HTMLButtonElement;
		browse.type = 'button';
		browse.appendChild(lucideIcon('folder-open', 16));
		append(browse, $('span')).textContent = localize('kingu.settings.browse', "Browse");
		browse.addEventListener('click', async () => {
			const current = this._values.get(key);
			const picked = await this._fileDialogService.showOpenDialog({
				canSelectFolders: true,
				canSelectFiles: false,
				canSelectMany: false,
				defaultUri: typeof current === 'string' && current ? URI.file(current) : undefined,
			});
			if (picked?.[0]) {
				await this._values.set(key, picked[0].fsPath);
			}
		});
	}

	/**
	 * `GlobalWorktreeVisibilitySourcesSetting`: a bordered list — Claude Code,
	 * GSD, and every other location — each with Show / Hide.
	 */
	private _sourcesRow(parent: HTMLElement, row: IOrcaSettingsRow): void {
		const { body } = this._stacked(parent, row, false);
		const defaults = (this._values.get('worktreeVisibilityDefaults') ?? {}) as {
			external?: 'show' | 'hide';
			customSources?: { id: string; rootPath: string }[];
			sourcePreferences?: { builtIn?: Record<string, 'show' | 'hide'>; custom?: Record<string, 'show' | 'hide'> };
		};
		const external = defaults.external ?? 'hide';
		const list = append(body, $('.kingu-orca-settings-list'));
		const item = (label: string, detail: string, value: 'show' | 'hide', choose: (next: 'show' | 'hide') => void) => {
			const line = append(list, $('.kingu-orca-settings-list-row'));
			const text = append(line, $('.kingu-orca-settings-list-text'));
			append(text, $('span.kingu-orca-settings-list-label')).textContent = label;
			append(text, $('span.kingu-orca-settings-list-detail')).textContent = detail;
			const group = append(line, $('.kingu-orca-segmented.sm'));
			group.setAttribute('role', 'radiogroup');
			group.setAttribute('aria-label', label);
			for (const option of ['show', 'hide'] as const) {
				const button = append(group, $('button.kingu-orca-segment-option')) as HTMLButtonElement;
				button.type = 'button';
				button.setAttribute('role', 'radio');
				button.setAttribute('aria-checked', String(value === option));
				button.classList.toggle('active', value === option);
				button.textContent = option === 'show' ? localize('kingu.settings.show', "Show") : localize('kingu.settings.hide', "Hide");
				button.addEventListener('click', () => choose(option));
			}
		};
		const save = (next: typeof defaults) => void this._values.set('worktreeVisibilityDefaults', next);
		const builtIn = (id: string) => defaults.sourcePreferences?.builtIn?.[id] ?? external;
		const setBuiltIn = (id: string) => (next: 'show' | 'hide') => save({ ...defaults, sourcePreferences: { ...defaults.sourcePreferences, builtIn: { ...defaults.sourcePreferences?.builtIn, [id]: next } } });
		item('Claude Code', '.claude/worktrees/*', builtIn('claude'), setBuiltIn('claude'));
		item('GSD', '.gsd-workspaces/*', builtIn('gsd'), setBuiltIn('gsd'));
		for (const source of defaults.customSources ?? []) {
			const name = source.rootPath.split(/[\\/]/).filter(Boolean).pop() ?? source.rootPath;
			item(name, `${source.rootPath}/*`, defaults.sourcePreferences?.custom?.[source.id] ?? 'hide', next => save({ ...defaults, sourcePreferences: { ...defaults.sourcePreferences, custom: { ...defaults.sourcePreferences?.custom, [source.id]: next } } }));
		}
		item(localize('kingu.settings.otherLocations', "Other locations"), localize('kingu.settings.outsideSources', "Outside listed sources"), external, next => save({ ...defaults, external: next }));
	}

	/**
	 * A row this window cannot edit in place yet: a list, an account, an action
	 * that belongs to one of the ADE's own panels. Shown with its label and
	 * description; a key this window offers as a VS Code setting opens there.
	 */
	private _otherRow(parent: HTMLElement, row: IOrcaSettingsRow, store: DisposableStore): void {
		const { control } = this._row(parent, row);
		const id = row.keys.map(key => orcaSettingIdForKey(key.split('.')[0])).find((candidate): candidate is string => !!candidate);
		if (id) {
			const edit = append(control, $('button.kingu-orca-button.outline.sm')) as HTMLButtonElement;
			edit.type = 'button';
			edit.textContent = localize('kingu.settings.edit', "Edit…");
			store.add(attachFooterTooltip(edit, () => [localize('kingu.settings.editTooltip', "Edit in the Settings editor")]));
			edit.addEventListener('click', () => void this._commandService.executeCommand('workbench.action.openSettings', `@id:${id}`));
			return;
		}
		append(control, $('span.kingu-orca-settings-unavailable')).textContent = localize('kingu.settings.notHere', "Not in this window yet");
	}

	// #endregion
}

// #endregion

registerWorkbenchContribution2(KinguOrcaSettingsScreen.ID, KinguOrcaSettingsScreen, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: KINGU_OPEN_ORCA_SETTINGS_COMMAND_ID,
			title: localize2('kingu.settings.open', "Kingu: Settings"),
			f1: true,
		});
	}
	run(_accessor: ServicesAccessor, target?: IKinguOpenSettingsTarget): void {
		KinguOrcaSettingsScreen.open(target);
	}
});

MenuRegistry.appendMenuItem(Menus.AccountMenu, {
	command: { id: KINGU_OPEN_ORCA_SETTINGS_COMMAND_ID, title: localize('kingu.settings.menu', "Kingu Settings") },
	group: '2_settings',
	order: 0,
});
