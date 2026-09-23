/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { KINGU_LUCIDE_ICONS } from '../common/kinguLucideIcons.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * One of the ADE's footer icons, drawn as lucide draws it: a 24-unit stroke
 * grid, two-unit stroke, round caps, in the surrounding text colour.
 *
 * Built with DOM calls because the workbench's trusted-types policy refuses
 * markup assigned as HTML.
 */
export function lucideIcon(name: string, size = 12, className?: string): SVGSVGElement {
	const svg = mainWindow.document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', String(size));
	svg.setAttribute('height', String(size));
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	svg.setAttribute('stroke-width', '2');
	svg.setAttribute('stroke-linecap', 'round');
	svg.setAttribute('stroke-linejoin', 'round');
	svg.setAttribute('aria-hidden', 'true');
	svg.classList.add('kingu-orca-icon');
	for (const name of className?.split(' ').filter(Boolean) ?? []) {
		svg.classList.add(name);
	}
	for (const [tag, attributes] of KINGU_LUCIDE_ICONS[name] ?? []) {
		const element = mainWindow.document.createElementNS(SVG_NS, tag);
		for (const [key, value] of Object.entries(attributes)) {
			element.setAttribute(key, value);
		}
		svg.appendChild(element);
	}
	return svg;
}

/** A piece of a footer chip, in the ADE's vocabulary: an icon, a label, a status dot, a middot. */
export type FooterChipPart =
	| { readonly kind: 'icon'; readonly name: string; readonly size?: number; readonly className?: string }
	| { readonly kind: 'text'; readonly text: string; readonly className?: string }
	| { readonly kind: 'dot'; readonly className?: string }
	| { readonly kind: 'separator'; readonly className?: string }
	| { readonly kind: 'element'; readonly element: HTMLElement };

/**
 * One of the ADE's footer triggers: a `button`, drawn with the classes of the
 * ADE's own (`inline-flex items-center gap-1.5 rounded px-1 py-0.5
 * hover:bg-accent/70` and the rest, spelled out in the stylesheet).
 *
 * A click is the only thing that opens what it opens. The status bar entry
 * that carries it has no command and no tooltip of its own, so hovering shows
 * the ADE's label and nothing else, as in the ADE.
 */
export class FooterChip extends Disposable {

	readonly element = $('button.kingu-orca-trigger') as HTMLButtonElement;

	constructor(className: string, onClick: (event: MouseEvent | KeyboardEvent) => void) {
		super();
		this.element.type = 'button';
		for (const name of className.split(' ').filter(Boolean)) {
			this.element.classList.add(name);
		}
		this._register(addDisposableListener(this.element, EventType.CLICK, event => onClick(event)));
		// The status bar moves focus between its entries with the arrow keys and
		// activates on Enter and Space; a button does that on its own.
	}

	set(parts: readonly FooterChipPart[], ariaLabel: string): void {
		clearNode(this.element);
		this.element.setAttribute('aria-label', ariaLabel);
		for (const part of parts) {
			switch (part.kind) {
				case 'icon':
					this.element.appendChild(lucideIcon(part.name, part.size ?? 12, part.className));
					break;
				case 'text': {
					const text = append(this.element, $('span'));
					text.className = part.className ?? '';
					text.textContent = part.text;
					break;
				}
				case 'dot':
					append(this.element, $('span.kingu-orca-dot')).className = `kingu-orca-dot ${part.className ?? ''}`;
					break;
				case 'separator': {
					const separator = append(this.element, $('span'));
					separator.className = part.className ?? 'kingu-orca-muted-50';
					separator.textContent = '·';
					break;
				}
				case 'element':
					this.element.appendChild(part.element);
					break;
			}
		}
	}
}

// #region Tooltip

/** Radix's `skipDelayDuration`: moving from one label to the next within this shows it at once. */
const SKIP_DELAY_MS = 300;
let lastTooltipHiddenAt = 0;

/**
 * The ADE's tooltip: a small inverted label above the trigger, with an arrow,
 * after the ADE's delay (400ms app-wide, 150ms on the resource and port
 * segments). It never takes the pointer, and a press hides it until the
 * pointer leaves, as Radix does.
 */
export function attachFooterTooltip(target: HTMLElement, lines: () => readonly string[], delay = 400, suppressed?: () => boolean): IDisposable {
	const store = new DisposableStore();
	const shown = store.add(new MutableDisposable());
	let timer: number | undefined;
	let pressed = false;
	const cancel = () => {
		if (timer !== undefined) {
			mainWindow.clearTimeout(timer);
			timer = undefined;
		}
	};
	const hide = () => {
		cancel();
		if (shown.value) {
			shown.clear();
			lastTooltipHiddenAt = Date.now();
		}
	};
	const show = () => {
		timer = undefined;
		if (suppressed?.() || !target.isConnected) {
			return;
		}
		const text = lines().filter(line => line.length > 0);
		if (text.length === 0) {
			return;
		}
		const tooltip = $('.kingu-orca-tooltip');
		tooltip.setAttribute('role', 'tooltip');
		for (const line of text) {
			append(tooltip, $('div')).textContent = line;
		}
		const arrow = append(tooltip, $('span.kingu-orca-tooltip-arrow'));
		const container = target.closest('.monaco-workbench') ?? getWindow(target).document.body;
		container.appendChild(tooltip);
		placeAbove(tooltip, target, 6, 'center');
		const tooltipRect = tooltip.getBoundingClientRect();
		const targetRect = target.getBoundingClientRect();
		arrow.style.left = `${Math.round(targetRect.left + targetRect.width / 2 - tooltipRect.left - 5)}px`;
		shown.value = toDisposable(() => tooltip.remove());
	};
	store.add(addDisposableListener(target, 'pointerenter', () => {
		if (pressed) {
			return;
		}
		cancel();
		const immediate = Date.now() - lastTooltipHiddenAt < SKIP_DELAY_MS;
		timer = mainWindow.setTimeout(show, immediate ? 0 : delay);
	}));
	store.add(addDisposableListener(target, 'pointerleave', () => {
		pressed = false;
		hide();
	}));
	store.add(addDisposableListener(target, EventType.POINTER_DOWN, () => {
		pressed = true;
		hide();
	}));
	store.add(addDisposableListener(target, EventType.FOCUS_OUT, hide));
	store.add(toDisposable(cancel));
	return store;
}

// #endregion

// #region Popover

/** Radix's collision padding for the footer's popovers: eight pixels from every edge, footer height at the bottom. */
const COLLISION_PADDING = 8;

/**
 * Places a floating surface above an anchor, as Radix places `side="top"`:
 * `sideOffset` pixels clear of it, aligned to its start, end or centre, and
 * slid back inside the window where it would overflow.
 */
function placeAbove(surface: HTMLElement, anchor: HTMLElement, sideOffset: number, align: 'start' | 'end' | 'center'): void {
	const window = getWindow(anchor);
	const anchorRect = anchor.getBoundingClientRect();
	surface.style.position = 'fixed';
	surface.style.visibility = 'hidden';
	surface.style.left = '0px';
	surface.style.top = '0px';
	const width = surface.offsetWidth;
	const height = surface.offsetHeight;
	let left = align === 'start' ? anchorRect.left : align === 'end' ? anchorRect.right - width : anchorRect.left + anchorRect.width / 2 - width / 2;
	left = Math.max(COLLISION_PADDING, Math.min(left, window.innerWidth - COLLISION_PADDING - width));
	const top = Math.max(COLLISION_PADDING, anchorRect.top - sideOffset - height);
	surface.style.left = `${Math.round(left)}px`;
	surface.style.top = `${Math.round(top)}px`;
	surface.style.visibility = '';
}

export interface IFooterPopoverOptions {
	/** `menu` is the ADE's DropdownMenu surface; `popover` its Popover surface. */
	readonly surface: 'menu' | 'popover';
	readonly align: 'start' | 'end';
	/** The ADE's content width, e.g. `256px` for `w-64`. */
	readonly width?: string;
	/** The ADE's `p-0`, for panels that draw their own padding. */
	readonly flush?: boolean;
	/** Called once each time it opens, as the ADE's `onOpenChange(true)`. */
	readonly onOpen?: () => void;
}

/**
 * The popover a footer trigger opens, and only on click: Radix's
 * `DropdownMenu` and `Popover` as the ADE's footer uses them. A second click on
 * the trigger closes it; so do a press anywhere outside, Escape, and the
 * window resizing under it. One is open at a time.
 */
export class FooterPopover extends Disposable {

	private static _current: FooterPopover | undefined;

	private readonly _open = this._register(new MutableDisposable<DisposableStore>());
	/** What the current drawing registered — its tooltips — released when it is redrawn or closed. */
	private readonly _drawing = this._register(new MutableDisposable<DisposableStore>());
	private _surface: HTMLElement | undefined;
	private _scroll: HTMLElement | undefined;

	constructor(
		private readonly _anchor: HTMLElement,
		private readonly _render: (close: () => void, store: DisposableStore) => HTMLElement,
		private readonly _options: IFooterPopoverOptions,
	) {
		super();
		this._register(toDisposable(() => {
			if (FooterPopover._current === this) {
				FooterPopover._current = undefined;
			}
		}));
	}

	get isOpen(): boolean {
		return !!this._open.value;
	}

	toggle(): void {
		if (this.isOpen) {
			this.close();
		} else {
			this.open();
		}
	}

	open(): void {
		FooterPopover._current?.close();
		FooterPopover._current = this;
		const store = new DisposableStore();
		this._open.value = store;

		const surface = $(this._options.surface === 'menu' ? '.kingu-orca-surface.menu' : '.kingu-orca-surface.popover');
		surface.classList.toggle('flush', !!this._options.flush);
		if (this._options.width) {
			surface.style.width = this._options.width;
		}
		surface.setAttribute('role', this._options.surface === 'menu' ? 'menu' : 'dialog');
		surface.tabIndex = -1;
		this._surface = surface;
		surface.appendChild(this._draw());
		const container = this._anchor.closest('.monaco-workbench') ?? getWindow(this._anchor).document.body;
		container.appendChild(surface);
		placeAbove(surface, this._anchor, 8, this._options.align);
		this._anchor.setAttribute('aria-expanded', 'true');
		store.add(toDisposable(() => {
			this._drawing.clear();
			surface.remove();
			this._surface = undefined;
			this._anchor.setAttribute('aria-expanded', 'false');
			if (FooterPopover._current === this) {
				FooterPopover._current = undefined;
			}
		}));

		const window = getWindow(this._anchor);
		// Capture, so a press that a surface underneath swallows still closes it.
		store.add(addDisposableListener(window.document, EventType.POINTER_DOWN, (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (target && (surface.contains(target) || this._anchor.contains(target))) {
				return;
			}
			this.close();
		}, true));
		store.add(addDisposableListener(window.document, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (new StandardKeyboardEvent(event).equals(KeyCode.Escape)) {
				event.preventDefault();
				event.stopPropagation();
				this.close();
				this._anchor.focus();
			}
		}, true));
		store.add(addDisposableListener(window, EventType.RESIZE, () => this.close()));
		store.add(addDisposableListener(window, EventType.BLUR, () => this.close()));

		this._options.onOpen?.();
		if (this._options.surface === 'menu') {
			surface.focus();
		}
	}

	/** Redraws an open popover from current state, keeping its place. */
	refresh(): void {
		const surface = this._surface;
		if (!surface) {
			return;
		}
		const scrollTop = this._scroll?.scrollTop ?? 0;
		clearNode(surface);
		surface.appendChild(this._draw());
		if (this._scroll) {
			this._scroll.scrollTop = scrollTop;
		}
		placeAbove(surface, this._anchor, 8, this._options.align);
	}

	close(): void {
		this._open.clear();
	}

	/** Names the element of the current drawing that scrolls, so a redraw keeps its place. */
	trackScroll(element: HTMLElement): void {
		this._scroll = element;
	}

	private _draw(): HTMLElement {
		this._scroll = undefined;
		const store = new DisposableStore();
		this._drawing.value = store;
		return this._render(() => this.close(), store);
	}
}

// #endregion

// #region The ADE's DropdownMenu parts

/** Each menu's rows in order, for the arrow keys. */
const menuRows = new WeakMap<HTMLElement, HTMLElement[]>();

function addMenuRow(menu: HTMLElement, row: HTMLElement): void {
	const rows = menuRows.get(menu) ?? [];
	rows.push(row);
	menuRows.set(menu, rows);
}

/** `DropdownMenuLabel`: `px-2 py-[4px] text-[11px] font-semibold text-muted-foreground`. */
export function menuLabel(parent: HTMLElement, text: string, trailing?: string): HTMLElement {
	const label = append(parent, $('.kingu-orca-menu-label'));
	append(label, $('span')).textContent = text;
	if (trailing !== undefined) {
		append(label, $('span.kingu-orca-menu-label-trailing')).textContent = trailing;
	}
	return label;
}

/** `DropdownMenuSeparator`: `my-[3px] h-px bg-border/60`. */
export function menuSeparator(parent: HTMLElement): void {
	append(parent, $('.kingu-orca-menu-separator')).setAttribute('role', 'separator');
}

/**
 * `DropdownMenuRadioItem` with the ADE's two-line body: the label, then an
 * 11px muted line; a filled dot at the left on the chosen one.
 */
export function menuRadioItem(parent: HTMLElement, label: string, description: string | undefined, checked: boolean, run: () => void): HTMLElement {
	const item = append(parent, $('button.kingu-orca-menu-item.radio')) as HTMLButtonElement;
	item.type = 'button';
	item.setAttribute('role', 'menuitemradio');
	item.setAttribute('aria-checked', String(checked));
	const indicator = append(item, $('span.kingu-orca-menu-indicator'));
	if (checked) {
		append(indicator, $('span.kingu-orca-menu-radio-dot'));
	}
	const body = append(item, $('span.kingu-orca-menu-body'));
	append(body, $('span')).textContent = label;
	if (description) {
		append(body, $('span.kingu-orca-menu-description')).textContent = description;
	}
	item.addEventListener('click', run);
	addMenuRow(parent, item);
	return item;
}

/** `DropdownMenuItem`: a plain row. */
export function menuItem(parent: HTMLElement, label: string, run: () => void): HTMLElement {
	const item = append(parent, $('button.kingu-orca-menu-item')) as HTMLButtonElement;
	item.type = 'button';
	item.setAttribute('role', 'menuitem');
	item.textContent = label;
	item.addEventListener('click', run);
	addMenuRow(parent, item);
	return item;
}

/**
 * Arrow keys move between a menu's rows, as Radix's roving focus does; Enter
 * and Space activate the focused one, which a button does by itself.
 */
export function wireMenuKeyboard(menu: HTMLElement): void {
	menu.addEventListener('keydown', event => {
		const keyboard = new StandardKeyboardEvent(event);
		const down = keyboard.equals(KeyCode.DownArrow);
		if (!down && !keyboard.equals(KeyCode.UpArrow)) {
			return;
		}
		event.preventDefault();
		const items = menuRows.get(menu) ?? [];
		if (items.length === 0) {
			return;
		}
		const index = items.indexOf(getWindow(menu).document.activeElement as HTMLElement);
		const next = index === -1 ? (down ? 0 : items.length - 1) : (index + (down ? 1 : -1) + items.length) % items.length;
		items[next].focus();
	});
}

// #endregion

/** A small icon button inside a popover: `inline-flex size-6 items-center justify-center rounded`. */
export function iconButton(parent: HTMLElement, store: DisposableStore, icon: string, label: string, className: string, run: (event: MouseEvent) => void, tooltipDelay = 200): HTMLButtonElement {
	const button = append(parent, $('button.kingu-orca-icon-button')) as HTMLButtonElement;
	button.type = 'button';
	for (const name of className.split(' ').filter(Boolean)) {
		button.classList.add(name);
	}
	button.setAttribute('aria-label', label);
	button.appendChild(lucideIcon(icon, 12));
	store.add(attachFooterTooltip(button, () => [label], tooltipDelay));
	button.addEventListener('click', run);
	return button;
}
