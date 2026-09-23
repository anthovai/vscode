/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/kinguOrcaFloating.css';
import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Action, Separator } from '../../../../base/common/actions.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableMap, DisposableStore, IReference, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { basename, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { EditorExtensionsRegistry } from '../../../../editor/browser/editorExtensions.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../nls.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { ITextFileService } from '../../../../workbench/services/textfile/common/textfiles.js';
import { attachFooterTooltip, lucideIcon, providerIcon } from './kinguOrcaFooterParts.js';

/** `floating-terminal-panel-bounds.ts`. */
const DEFAULT_PANEL_WIDTH = 920;
const DEFAULT_PANEL_HEIGHT = 560;
const MIN_PANEL_WIDTH = 420;
const MIN_PANEL_HEIGHT = 280;
const MAXIMIZED_MARGIN = 12;
const MAXIMIZED_BOTTOM_GAP = 36;
const TITLEBAR_SAFE_TOP = 36;
const DEFAULT_RIGHT_GAP = 24;
const DEFAULT_BOTTOM_GAP = 84;
const PANEL_EDGE_MARGIN = 8;
const BOUNDS_KEY = 'kingu.floatingWorkspace.panelBounds';
const MAXIMIZED_KEY = 'kingu.floatingWorkspace.panelMaximized';

interface IPanelBounds {
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
}

/** A tab of the floating workspace: a terminal or a markdown note. */
type FloatingTab =
	| { readonly id: string; readonly kind: 'terminal'; readonly instance: ITerminalInstance; readonly body: HTMLElement }
	| { readonly id: string; readonly kind: 'markdown'; readonly uri: URI; readonly body: HTMLElement; readonly editor: CodeEditorWidget; readonly model: IReference<IResolvedTextEditorModel> };

export const IKinguFloatingWorkspaceService = createDecorator<IKinguFloatingWorkspaceService>('kinguFloatingWorkspaceService');

/** The ADE's floating workspace: its open state, for the toggles that show and hide it. */
export interface IKinguFloatingWorkspaceService {
	readonly _serviceBrand: undefined;
	readonly isOpen: boolean;
	readonly onDidChangeOpen: Event<boolean>;
	toggle(): void;
	open(): void;
	close(): void;
}

/**
 * The ADE's floating workspace (`FloatingTerminalPanel`): an overlay of its
 * own, not an OS window — 920 x 560 by default, 24px from the right and 84px
 * above the bottom, dragged by its title bar, resized from its edges,
 * maximized by a double-click, and holding its own tabs: terminals, and
 * markdown notes. With no tab it shows the ADE's list of what to open, each
 * with its shortcut.
 *
 * Closing it hides it; the terminals in it keep running, as in the ADE.
 */
export class KinguFloatingWorkspaceService extends Disposable implements IKinguFloatingWorkspaceService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeOpen = this._register(new Emitter<boolean>());
	readonly onDidChangeOpen = this._onDidChangeOpen.event;

	private _open = false;
	private _maximized = false;
	private _bounds: IPanelBounds | undefined;
	private _frame: HTMLElement | undefined;
	private _tabStrip: HTMLElement | undefined;
	private _body: HTMLElement | undefined;
	private _maximizeButton: HTMLButtonElement | undefined;
	private _empty: HTMLElement | undefined;
	private readonly _tabs: FloatingTab[] = [];
	private readonly _tabStores = this._register(new DisposableMap<string>());
	private _activeTabId: string | undefined;
	private _nextId = 1;
	private readonly _frameStore = this._register(new MutableDisposable<DisposableStore>());
	private readonly _stripStore = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IStorageService private readonly _storageService: IStorageService,
		@IContextMenuService private readonly _contextMenuService: IContextMenuService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ITextModelService private readonly _textModelService: ITextModelService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@IFileService private readonly _fileService: IFileService,
		@IFileDialogService private readonly _fileDialogService: IFileDialogService,
		@IPathService private readonly _pathService: IPathService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._maximized = this._storageService.getBoolean(MAXIMIZED_KEY, StorageScope.PROFILE, false);
		try {
			const stored = JSON.parse(this._storageService.get(BOUNDS_KEY, StorageScope.PROFILE, '')) as Partial<IPanelBounds>;
			if ([stored.left, stored.top, stored.width, stored.height].every(value => typeof value === 'number')) {
				this._bounds = stored as IPanelBounds;
			}
		} catch {
			// The ADE's default bounds.
		}
	}

	get isOpen(): boolean {
		return this._open;
	}

	toggle(): void {
		if (this._open) {
			this.close();
		} else {
			this.open();
		}
	}

	open(): void {
		if (this._open) {
			return;
		}
		this._ensureFrame();
		this._open = true;
		this._frame!.classList.add('open');
		this._layout();
		if (this._activeTab()) {
			this._focusActive();
		} else {
			this._frame!.focus();
		}
		this._onDidChangeOpen.fire(true);
	}

	close(): void {
		if (!this._open) {
			return;
		}
		this._open = false;
		this._frame?.classList.remove('open');
		for (const tab of this._tabs) {
			if (tab.kind === 'terminal') {
				tab.instance.setVisible(false);
			}
		}
		this._onDidChangeOpen.fire(false);
	}

	// #region Frame

	private _ensureFrame(): void {
		if (this._frame) {
			return;
		}
		const store = new DisposableStore();
		this._frameStore.value = store;
		const container = this._layoutService.mainContainer;
		const frame = append(container, $('.kingu-orca-floating-panel'));
		frame.tabIndex = -1;
		frame.setAttribute('role', 'dialog');
		frame.setAttribute('aria-label', localize('kingu.floating.aria', "Floating workspace"));
		this._frame = frame;
		store.add(toDisposable(() => frame.remove()));

		const inner = append(frame, $('.kingu-orca-floating-inner'));
		const titlebar = append(inner, $('.kingu-orca-floating-titlebar'));
		this._tabStrip = append(titlebar, $('.kingu-orca-floating-tabs'));
		const controls = append(titlebar, $('.kingu-orca-floating-controls'));
		this._renderControls(controls, store);
		this._body = append(inner, $('.kingu-orca-floating-body'));
		this._renderResizeHandles(frame, store);
		this._wireDrag(titlebar, store);
		store.add(addDisposableListener(titlebar, EventType.DBLCLICK, event => {
			if ((event.target as HTMLElement).closest('.kingu-orca-floating-tab, .kingu-orca-floating-controls, .kingu-orca-floating-new')) {
				return;
			}
			this._toggleMaximized();
		}));
		store.add(addDisposableListener(frame, EventType.KEY_DOWN, (event: KeyboardEvent) => this._onKeyDown(event), true));
		store.add(addDisposableListener(getWindow(container), EventType.RESIZE, () => this._layout()));
		this._renderTabs();
		this._renderBody();
	}

	/** The panel's bounds: stored, or the ADE's default corner; the maximized bounds leave 12px and 36px at the bottom. */
	private _currentBounds(): IPanelBounds {
		const window = getWindow(this._layoutService.mainContainer);
		const width = window.innerWidth;
		const height = window.innerHeight;
		if (this._maximized) {
			return { left: MAXIMIZED_MARGIN, top: TITLEBAR_SAFE_TOP + MAXIMIZED_MARGIN, width: width - 2 * MAXIMIZED_MARGIN, height: height - TITLEBAR_SAFE_TOP - MAXIMIZED_MARGIN - MAXIMIZED_BOTTOM_GAP };
		}
		const base = this._bounds ?? {
			width: DEFAULT_PANEL_WIDTH,
			height: DEFAULT_PANEL_HEIGHT,
			left: width - DEFAULT_PANEL_WIDTH - DEFAULT_RIGHT_GAP,
			top: height - DEFAULT_PANEL_HEIGHT - DEFAULT_BOTTOM_GAP,
		};
		return clampBounds(base, width, height);
	}

	private _layout(): void {
		const frame = this._frame;
		if (!frame) {
			return;
		}
		const bounds = this._currentBounds();
		frame.style.left = `${bounds.left}px`;
		frame.style.top = `${bounds.top}px`;
		frame.style.width = `${bounds.width}px`;
		frame.style.height = `${bounds.height}px`;
		frame.classList.toggle('maximized', this._maximized);
		this._layoutActive();
		this._updateMaximizeButton();
	}

	private _layoutActive(): void {
		const tab = this._activeTab();
		if (!tab || !this._open) {
			return;
		}
		const width = tab.body.clientWidth;
		const height = tab.body.clientHeight;
		if (width <= 0 || height <= 0) {
			return;
		}
		if (tab.kind === 'terminal') {
			tab.instance.attachToElement(tab.body);
			tab.instance.layout({ width, height });
			tab.instance.setVisible(true);
		} else {
			tab.editor.layout({ width, height });
		}
	}

	private _storeBounds(bounds: IPanelBounds): void {
		this._bounds = bounds;
		this._storageService.store(BOUNDS_KEY, JSON.stringify(bounds), StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	private _toggleMaximized(): void {
		this._maximized = !this._maximized;
		this._storageService.store(MAXIMIZED_KEY, this._maximized, StorageScope.PROFILE, StorageTarget.MACHINE);
		this._layout();
	}

	/** The title bar drags the panel; a press on a tab or a control does not. */
	private _wireDrag(titlebar: HTMLElement, store: DisposableStore): void {
		let drag: { pointerId: number; x: number; y: number; bounds: IPanelBounds } | undefined;
		store.add(addDisposableListener(titlebar, EventType.POINTER_DOWN, (event: PointerEvent) => {
			if (event.button !== 0 || this._maximized || (event.target as HTMLElement).closest('button, .kingu-orca-floating-tab')) {
				return;
			}
			drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, bounds: this._currentBounds() };
			titlebar.setPointerCapture(event.pointerId);
			titlebar.classList.add('dragging');
		}));
		store.add(addDisposableListener(titlebar, EventType.POINTER_MOVE, (event: PointerEvent) => {
			if (!drag || event.pointerId !== drag.pointerId) {
				return;
			}
			const window = getWindow(titlebar);
			const next = clampBounds({ ...drag.bounds, left: drag.bounds.left + event.clientX - drag.x, top: drag.bounds.top + event.clientY - drag.y }, window.innerWidth, window.innerHeight);
			this._bounds = next;
			this._layout();
		}));
		const end = (event: PointerEvent) => {
			if (drag && event.pointerId === drag.pointerId) {
				drag = undefined;
				titlebar.classList.remove('dragging');
				this._storeBounds(this._currentBounds());
			}
		};
		store.add(addDisposableListener(titlebar, EventType.POINTER_UP, end));
		store.add(addDisposableListener(titlebar, 'pointercancel', end));
	}

	/** `FloatingTerminalResizeHandles`: every edge and corner, down to 420 x 280. */
	private _renderResizeHandles(frame: HTMLElement, store: DisposableStore): void {
		for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
			const handle = append(frame, $(`.kingu-orca-floating-resize.${edge}`));
			let resize: { pointerId: number; x: number; y: number; bounds: IPanelBounds } | undefined;
			store.add(addDisposableListener(handle, EventType.POINTER_DOWN, (event: PointerEvent) => {
				if (event.button !== 0 || this._maximized) {
					return;
				}
				event.preventDefault();
				resize = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, bounds: this._currentBounds() };
				handle.setPointerCapture(event.pointerId);
			}));
			store.add(addDisposableListener(handle, EventType.POINTER_MOVE, (event: PointerEvent) => {
				if (!resize || event.pointerId !== resize.pointerId) {
					return;
				}
				const dx = event.clientX - resize.x;
				const dy = event.clientY - resize.y;
				let { left, top, width, height } = resize.bounds;
				if (edge.includes('e')) {
					width = Math.max(MIN_PANEL_WIDTH, width + dx);
				}
				if (edge.includes('s')) {
					height = Math.max(MIN_PANEL_HEIGHT, height + dy);
				}
				if (edge.includes('w')) {
					const next = Math.max(MIN_PANEL_WIDTH, width - dx);
					left += width - next;
					width = next;
				}
				if (edge.includes('n')) {
					const next = Math.max(MIN_PANEL_HEIGHT, height - dy);
					top += height - next;
					height = next;
				}
				const window = getWindow(handle);
				this._bounds = clampBounds({ left, top, width, height }, window.innerWidth, window.innerHeight);
				this._layout();
			}));
			const end = (event: PointerEvent) => {
				if (resize && event.pointerId === resize.pointerId) {
					resize = undefined;
					this._storeBounds(this._currentBounds());
				}
			};
			store.add(addDisposableListener(handle, EventType.POINTER_UP, end));
			store.add(addDisposableListener(handle, 'pointercancel', end));
		}
	}

	/** `FloatingTerminalWindowControls`: open Claude here, maximize or restore, minimize — `icon-xs` bordered buttons. */
	private _renderControls(controls: HTMLElement, store: DisposableStore): void {
		const control = (content: HTMLElement | SVGElement, label: () => string, run: () => void): HTMLButtonElement => {
			const button = append(controls, $('button.kingu-orca-floating-control')) as HTMLButtonElement;
			button.type = 'button';
			button.appendChild(content);
			button.setAttribute('aria-label', label());
			store.add(attachFooterTooltip(button, () => [label()]));
			button.addEventListener('click', run);
			return button;
		};
		control(providerIcon('claude', 14), () => localize('kingu.floating.openAgent', "Open {0} in floating workspace", 'Claude'), () => void this._newTerminal('claude'));
		this._maximizeButton = control(lucideIcon('maximize-2', 14), () => this._maximized ? localize('kingu.floating.restore', "Restore") : localize('kingu.floating.maximize', "Maximize"), () => this._toggleMaximized());
		control(lucideIcon('minus', 14), () => localize('kingu.floating.minimize', "Minimize"), () => this.close());
	}

	private _updateMaximizeButton(): void {
		const button = this._maximizeButton;
		if (!button) {
			return;
		}
		clearNode(button);
		button.appendChild(lucideIcon(this._maximized ? 'minimize-2' : 'maximize-2', 14));
		button.setAttribute('aria-label', this._maximized ? localize('kingu.floating.restoreAria', "Restore floating workspace") : localize('kingu.floating.maximizeAria', "Maximize floating workspace"));
	}

	// #endregion

	// #region Tabs

	private _activeTab(): FloatingTab | undefined {
		return this._tabs.find(tab => tab.id === this._activeTabId);
	}

	/** The tab strip: each tab with its icon, title and close; then `+`, whose menu lists markdown first, as the ADE's does. */
	private _renderTabs(): void {
		const strip = this._tabStrip;
		if (!strip) {
			return;
		}
		const store = new DisposableStore();
		this._stripStore.value = store;
		clearNode(strip);
		for (const tab of this._tabs) {
			const element = append(strip, $('.kingu-orca-floating-tab'));
			element.classList.toggle('active', tab.id === this._activeTabId);
			element.appendChild(lucideIcon(tab.kind === 'terminal' ? 'terminal' : 'file-text', 12));
			append(element, $('span.kingu-orca-floating-tab-title')).textContent = tab.kind === 'terminal' ? (tab.instance.title || localize('kingu.floating.terminal', "Terminal")) : basename(tab.uri);
			const close = append(element, $('button.kingu-orca-floating-tab-close')) as HTMLButtonElement;
			close.type = 'button';
			close.setAttribute('aria-label', localize('kingu.floating.closeTab', "Close"));
			close.appendChild(lucideIcon('x', 12));
			store.add(addDisposableListener(close, EventType.CLICK, event => {
				event.stopPropagation();
				void this._closeTab(tab.id);
			}));
			store.add(addDisposableListener(element, EventType.MOUSE_DOWN, event => {
				if (event.button === 1) {
					event.preventDefault();
					void this._closeTab(tab.id);
				}
			}));
			store.add(addDisposableListener(element, EventType.CLICK, () => this._activate(tab.id)));
		}
		const add = append(strip, $('button.kingu-orca-floating-new')) as HTMLButtonElement;
		add.type = 'button';
		add.setAttribute('aria-label', localize('kingu.floating.newTab', "New tab"));
		add.appendChild(lucideIcon('plus', 14));
		store.add(addDisposableListener(add, EventType.CLICK, () => {
			const rect = add.getBoundingClientRect();
			this._contextMenuService.showContextMenu({
				getAnchor: () => ({ x: rect.left, y: rect.bottom + 4 }),
				getActions: () => [
					new Action('kingu.floating.newMarkdown', localize('kingu.floating.newMarkdown', "New Markdown Note"), undefined, true, () => this._newMarkdown()),
					new Action('kingu.floating.openMarkdown', localize('kingu.floating.openMarkdown', "Open Markdown Note"), undefined, true, () => this._openMarkdown()),
					new Separator(),
					new Action('kingu.floating.newTerminal', localize('kingu.floating.newTerminal', "New Terminal"), undefined, true, () => this._newTerminal()),
				],
			});
		}));
	}

	private _activate(id: string): void {
		const previous = this._activeTab();
		if (previous?.kind === 'terminal' && previous.id !== id) {
			previous.instance.setVisible(false);
		}
		this._activeTabId = id;
		for (const tab of this._tabs) {
			tab.body.classList.toggle('active', tab.id === id);
		}
		this._renderTabs();
		this._renderBody();
		this._layoutActive();
		this._focusActive();
	}

	private _focusActive(): void {
		const tab = this._activeTab();
		if (tab?.kind === 'terminal') {
			tab.instance.focus(true);
		} else if (tab?.kind === 'markdown') {
			tab.editor.focus();
		}
	}

	private _addTab(tab: FloatingTab, store: DisposableStore): void {
		this._tabs.push(tab);
		this._tabStores.set(tab.id, store);
		this._body?.appendChild(tab.body);
		this.open();
		this._activate(tab.id);
	}

	private async _closeTab(id: string): Promise<void> {
		const index = this._tabs.findIndex(tab => tab.id === id);
		if (index === -1) {
			return;
		}
		const [tab] = this._tabs.splice(index, 1);
		if (tab.kind === 'terminal' && !tab.instance.isDisposed) {
			await this._terminalService.safeDisposeTerminal(tab.instance);
		}
		this._tabStores.deleteAndDispose(id);
		tab.body.remove();
		if (this._activeTabId === id) {
			const next = this._tabs[Math.min(index, this._tabs.length - 1)];
			this._activeTabId = undefined;
			if (next) {
				this._activate(next.id);
				return;
			}
		}
		this._renderTabs();
		this._renderBody();
	}

	/** The body: the active tab, or the ADE's empty state when there is none. */
	private _renderBody(): void {
		const body = this._body;
		if (!body) {
			return;
		}
		this._empty?.remove();
		this._empty = undefined;
		if (this._tabs.length > 0) {
			return;
		}
		const empty = append(body, $('.kingu-orca-floating-empty'));
		this._empty = empty;
		const list = append(empty, $('.kingu-orca-floating-empty-list'));
		const item = (icon: string, label: string, keys: readonly string[], run: () => void) => {
			const button = append(list, $('button.kingu-orca-floating-empty-item')) as HTMLButtonElement;
			button.type = 'button';
			button.appendChild(lucideIcon(icon, 14));
			append(button, $('span.kingu-orca-floating-empty-label')).textContent = label;
			const shortcut = append(button, $('span.kingu-orca-floating-shortcut'));
			keys.forEach((key, index) => {
				if (index > 0) {
					append(shortcut, $('span.kingu-orca-floating-shortcut-sep')).textContent = '+';
				}
				append(shortcut, $('kbd')).textContent = key;
			});
			button.addEventListener('click', run);
		};
		const mod = mainWindow.navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl';
		item('square-terminal', localize('kingu.floating.newTerminal', "New Terminal"), [mod, 'T'], () => void this._newTerminal());
		item('file-text', localize('kingu.floating.newMarkdown', "New Markdown Note"), [mod, 'Shift', 'M'], () => void this._newMarkdown());
		item('file-text', localize('kingu.floating.openMarkdown', "Open Markdown Note"), [mod, 'Shift', 'O'], () => void this._openMarkdown());
		item('minus', localize('kingu.floating.minimize', "Minimize"), [mod, 'W'], () => this.close());
	}

	/** The ADE's panel shortcuts, taken before the terminal sees them. */
	private _onKeyDown(event: KeyboardEvent): void {
		const keyboard = new StandardKeyboardEvent(event);
		const handle = (run: () => void) => {
			event.preventDefault();
			event.stopPropagation();
			run();
		};
		if (keyboard.equals(KeyMod.CtrlCmd | KeyCode.KeyT)) {
			handle(() => void this._newTerminal());
		} else if (keyboard.equals(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyM)) {
			handle(() => void this._newMarkdown());
		} else if (keyboard.equals(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyO)) {
			handle(() => void this._openMarkdown());
		} else if (keyboard.equals(KeyMod.CtrlCmd | KeyCode.KeyW)) {
			handle(() => this._activeTabId ? void this._closeTab(this._activeTabId) : this.close());
		} else if (keyboard.equals(KeyCode.Escape) && this._tabs.length === 0) {
			handle(() => this.close());
		}
	}

	// #endregion

	// #region Terminals

	/**
	 * A terminal that lives in the floating workspace: created in the
	 * background, so no panel group owns it, and drawn into the tab's body.
	 * `command` runs once the shell is up, as the ADE's agent button starts
	 * its default agent.
	 */
	private async _newTerminal(command?: string): Promise<void> {
		let instance: ITerminalInstance;
		try {
			instance = await this._terminalService.createTerminal({ config: { hideFromUser: true, forcePersist: true } });
		} catch (error) {
			this._logService.error('[kingu-floating] could not create a terminal', error);
			return;
		}
		const store = new DisposableStore();
		const id = `terminal-${this._nextId++}`;
		const body = $('.kingu-orca-floating-tab-body');
		store.add(instance.onTitleChanged(() => this._renderTabs()));
		store.add(instance.onDisposed(() => {
			if (this._tabs.some(tab => tab.id === id)) {
				void this._closeTab(id);
			}
		}));
		this._addTab({ id, kind: 'terminal', instance, body }, store);
		if (command) {
			await instance.sendText(command, true);
		}
	}

	// #endregion

	// #region Markdown notes

	/** Where new notes are kept: the ADE's own folder, one file per note. */
	private async _notesFolder(): Promise<URI> {
		const folder = joinPath(await this._pathService.userHome(), '.kingu', 'floating-notes');
		await this._fileService.createFolder(folder).catch(() => undefined);
		return folder;
	}

	private async _newMarkdown(): Promise<void> {
		const folder = await this._notesFolder();
		let index = 1;
		let uri = joinPath(folder, 'Untitled.md');
		while (await this._fileService.exists(uri)) {
			uri = joinPath(folder, `Untitled-${++index}.md`);
		}
		await this._fileService.writeFile(uri, VSBuffer.fromString(''));
		await this._openNote(uri);
	}

	private async _openMarkdown(): Promise<void> {
		const picked = await this._fileDialogService.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			filters: [{ name: localize('kingu.floating.markdown', "Markdown"), extensions: ['md', 'markdown', 'mdx'] }],
			defaultUri: await this._notesFolder(),
		});
		if (picked?.[0]) {
			await this._openNote(picked[0]);
		}
	}

	/** A note as a markdown editor in its tab, saved a moment after each change. */
	private async _openNote(uri: URI): Promise<void> {
		const existing = this._tabs.find(tab => tab.kind === 'markdown' && tab.uri.toString() === uri.toString());
		if (existing) {
			this.open();
			this._activate(existing.id);
			return;
		}
		const store = new DisposableStore();
		const model = await this._textModelService.createModelReference(uri);
		store.add(model);
		const body = $('.kingu-orca-floating-tab-body.markdown');
		const editor = store.add(this._instantiationService.createInstance(CodeEditorWidget, body, {
			automaticLayout: false,
			minimap: { enabled: false },
			wordWrap: 'on',
			lineNumbers: 'off',
			glyphMargin: false,
			folding: false,
			renderLineHighlight: 'none',
			scrollBeyondLastLine: false,
			padding: { top: 16, bottom: 16 },
			fontSize: 14,
		}, { isSimpleWidget: false, contributions: EditorExtensionsRegistry.getEditorContributions() }));
		editor.setModel(model.object.textEditorModel);
		const save = store.add(new RunOnceScheduler(() => void this._textFileService.save(uri), 500));
		store.add(model.object.textEditorModel.onDidChangeContent(() => save.schedule()));
		store.add(toDisposable(() => {
			if (save.isScheduled()) {
				save.cancel();
				void this._textFileService.save(uri);
			}
		}));
		this._addTab({ id: `markdown-${this._nextId++}`, kind: 'markdown', uri, body, editor, model }, store);
	}

	// #endregion
}

/** Keeps the panel inside the window: 8px from the edges, below the title bar. */
function clampBounds(bounds: IPanelBounds, width: number, height: number): IPanelBounds {
	const panelWidth = Math.max(MIN_PANEL_WIDTH, Math.min(bounds.width, width - 2 * PANEL_EDGE_MARGIN));
	const panelHeight = Math.max(MIN_PANEL_HEIGHT, Math.min(bounds.height, height - TITLEBAR_SAFE_TOP - PANEL_EDGE_MARGIN));
	return {
		width: panelWidth,
		height: panelHeight,
		left: Math.round(Math.min(Math.max(PANEL_EDGE_MARGIN, bounds.left), Math.max(PANEL_EDGE_MARGIN, width - panelWidth - PANEL_EDGE_MARGIN))),
		top: Math.round(Math.min(Math.max(TITLEBAR_SAFE_TOP, bounds.top), Math.max(TITLEBAR_SAFE_TOP, height - panelHeight - PANEL_EDGE_MARGIN))),
	};
}

registerSingleton(IKinguFloatingWorkspaceService, KinguFloatingWorkspaceService, InstantiationType.Delayed);
