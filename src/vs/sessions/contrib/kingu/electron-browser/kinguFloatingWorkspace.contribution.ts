/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/kinguOrcaFooter.css';
import { $, addDisposableListener, EventType, getWindow } from '../../../../base/browser/dom.js';
import { Action, Separator } from '../../../../base/common/actions.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { orcaSettingIdForKey } from '../common/kinguOrcaSettings.js';
import { attachFooterTooltip, lucideIcon } from './kinguOrcaFooterParts.js';

/** Whether the floating-workspace toggle is on, and where the ADE puts it. */
export const FLOATING_ENABLED_SETTING_ID = orcaSettingIdForKey('floatingTerminalEnabled') ?? 'kingu.floatingWorkspace.floatingTerminalEnabled';
export const FLOATING_LOCATION_SETTING_ID = orcaSettingIdForKey('floatingTerminalTriggerLocation') ?? 'kingu.floatingWorkspace.floatingTerminalTriggerLocation';

/**
 * The ADE's `floatingTerminal.toggle`, bound to Mod+Alt+A as there.
 *
 * The ADE's floating workspace is an overlay holding its own terminal tabs. This
 * window already has a surface for exactly that, its panel, so the toggle
 * shows and hides the panel rather than drawing a second terminal host.
 */
export const KINGU_TOGGLE_FLOATING_WORKSPACE_COMMAND_ID = 'kingu.floatingWorkspace.toggle';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: KINGU_TOGGLE_FLOATING_WORKSPACE_COMMAND_ID,
			title: localize2('kingu.floatingWorkspace.toggle', "Toggle Floating Workspace"),
			f1: true,
			keybinding: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyA, weight: KeybindingWeight.WorkbenchContrib },
		});
	}
	run(accessor: ServicesAccessor): Promise<unknown> {
		return accessor.get(ICommandService).executeCommand('workbench.action.togglePanel');
	}
});

/** `floating-terminal-trigger-position.ts`. */
const TRIGGER_SIZE = 36;
const DEFAULT_RIGHT_GAP = 24;
const DEFAULT_BOTTOM_GAP = 72;
const DRAG_MARGIN = 8;
const TITLEBAR_SAFE_TOP = 36;
const DRAG_THRESHOLD = 4;
const POSITION_KEY = 'kingu.floatingWorkspace.triggerPosition';

/** Where the button sits, relative to the corner it was dropped nearest, as the ADE stores it. */
interface ITriggerAnchor {
	readonly anchorX: 'left' | 'right';
	readonly anchorY: 'top' | 'bottom';
	readonly offsetX: number;
	readonly offsetY: number;
}

const DEFAULT_ANCHOR: ITriggerAnchor = { anchorX: 'right', anchorY: 'bottom', offsetX: DEFAULT_RIGHT_GAP, offsetY: DEFAULT_BOTTOM_GAP };

function clampPosition(left: number, top: number, width: number, height: number): { left: number; top: number } {
	return {
		left: Math.min(Math.max(DRAG_MARGIN, left), Math.max(DRAG_MARGIN, width - TRIGGER_SIZE - DRAG_MARGIN)),
		top: Math.min(Math.max(TITLEBAR_SAFE_TOP, top), Math.max(TITLEBAR_SAFE_TOP, height - TRIGGER_SIZE - DRAG_MARGIN)),
	};
}

function resolveAnchor(anchor: ITriggerAnchor, width: number, height: number): { left: number; top: number } {
	const left = anchor.anchorX === 'right' ? width - TRIGGER_SIZE - anchor.offsetX : anchor.offsetX;
	const top = anchor.anchorY === 'bottom' ? height - TRIGGER_SIZE - anchor.offsetY : anchor.offsetY;
	return clampPosition(left, top, width, height);
}

function anchorFor(left: number, top: number, width: number, height: number): ITriggerAnchor {
	const anchorX = left + TRIGGER_SIZE / 2 > width / 2 ? 'right' : 'left';
	const anchorY = top + TRIGGER_SIZE / 2 > height / 2 ? 'bottom' : 'top';
	return {
		anchorX,
		anchorY,
		offsetX: Math.round(anchorX === 'right' ? width - TRIGGER_SIZE - left : left),
		offsetY: Math.round(anchorY === 'bottom' ? height - TRIGGER_SIZE - top : top),
	};
}

/**
 * The ADE's `FloatingTerminalToggleButton`: a 36 x 36 card-coloured square with
 * the panels icon, 24px from the right and 72px above the bottom by default,
 * draggable to anywhere (a press that moves less than 4px is a click), and
 * remembered relative to the nearest corner. Right-click moves it to the
 * status bar or hides it, as the ADE's menu does.
 *
 * Shown while the ADE would show it: the floating workspace is enabled and its
 * trigger lives on the floating button (the ADE's default).
 */
class KinguFloatingWorkspaceButton extends Disposable {

	static readonly ID = 'kingu.contrib.floatingWorkspaceButton';

	private readonly _shown = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IContextMenuService private readonly _contextMenuService: IContextMenuService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@ICommandService private readonly _commandService: ICommandService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
		this._register(this._configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(FLOATING_ENABLED_SETTING_ID) || event.affectsConfiguration(FLOATING_LOCATION_SETTING_ID)) {
				this._update();
			}
		}));
		this._update();
	}

	private _update(): void {
		const enabled = this._configurationService.getValue<boolean>(FLOATING_ENABLED_SETTING_ID) !== false;
		const location = this._configurationService.getValue<string>(FLOATING_LOCATION_SETTING_ID) ?? 'floating-button';
		if (!enabled || location === 'status-bar') {
			this._shown.clear();
		} else if (!this._shown.value) {
			this._shown.value = this._show();
		}
	}

	private _show(): DisposableStore {
		const store = new DisposableStore();
		const container = this._layoutService.mainContainer;
		const window = getWindow(container);
		const wrapper = $('span.kingu-orca-floating-trigger');
		wrapper.setAttribute('data-floating-terminal-toggle', '');
		const button = $('button.kingu-orca-floating-button') as HTMLButtonElement;
		button.type = 'button';
		button.appendChild(lucideIcon('panels-top-left', 16));
		wrapper.appendChild(button);
		container.appendChild(wrapper);
		store.add(toDisposable(() => wrapper.remove()));

		const open = () => this._layoutService.isVisible(Parts.PANEL_PART);
		const label = () => {
			const shortcut = this._keybindingService.lookupKeybinding(KINGU_TOGGLE_FLOATING_WORKSPACE_COMMAND_ID)?.getLabel();
			const action = open() ? localize('kingu.floatingWorkspace.minimize', "Minimize") : localize('kingu.floatingWorkspace.show', "Show");
			return shortcut
				? localize('kingu.floatingWorkspace.tooltip', "{0} floating workspace ({1})", action, shortcut)
				: localize('kingu.floatingWorkspace.tooltipNoShortcut', "{0} floating workspace", action);
		};
		const refresh = () => {
			button.setAttribute('aria-pressed', String(open()));
			button.setAttribute('aria-label', open() ? localize('kingu.floatingWorkspace.minimizeAria', "Minimize floating workspace") : localize('kingu.floatingWorkspace.showAria', "Show floating workspace"));
		};
		refresh();
		store.add(this._layoutService.onDidChangePartVisibility(refresh));
		store.add(attachFooterTooltip(button, () => [label()], 400, undefined, 'left'));

		// Position: the stored corner anchor, re-resolved when the window resizes.
		let anchor = this._readAnchor();
		const place = (left: number, top: number) => {
			wrapper.style.left = `${Math.round(left)}px`;
			wrapper.style.top = `${Math.round(top)}px`;
		};
		const placeAnchor = () => {
			const { left, top } = resolveAnchor(anchor, window.innerWidth, window.innerHeight);
			place(left, top);
		};
		placeAnchor();
		store.add(addDisposableListener(window, EventType.RESIZE, () => {
			if (window.innerWidth >= TRIGGER_SIZE + 2 * DRAG_MARGIN && window.innerHeight >= TRIGGER_SIZE + TITLEBAR_SAFE_TOP + DRAG_MARGIN) {
				placeAnchor();
			}
		}));

		// Drag with pointer capture; under four pixels of travel it is a click.
		let drag: { pointerId: number; startX: number; startY: number; left: number; top: number; moved: boolean } | undefined;
		let swallowClick = false;
		store.add(addDisposableListener(button, EventType.POINTER_DOWN, (event: PointerEvent) => {
			if (event.button !== 0) {
				return;
			}
			const rect = wrapper.getBoundingClientRect();
			drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top, moved: false };
			button.setPointerCapture(event.pointerId);
		}));
		store.add(addDisposableListener(button, EventType.POINTER_MOVE, (event: PointerEvent) => {
			if (!drag || event.pointerId !== drag.pointerId) {
				return;
			}
			const dx = event.clientX - drag.startX;
			const dy = event.clientY - drag.startY;
			if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) {
				return;
			}
			drag.moved = true;
			button.classList.add('dragging');
			const { left, top } = clampPosition(drag.left + dx, drag.top + dy, window.innerWidth, window.innerHeight);
			place(left, top);
		}));
		const endDrag = (event: PointerEvent) => {
			if (!drag || event.pointerId !== drag.pointerId) {
				return;
			}
			const moved = drag.moved;
			drag = undefined;
			button.classList.remove('dragging');
			if (moved) {
				const rect = wrapper.getBoundingClientRect();
				anchor = anchorFor(rect.left, rect.top, window.innerWidth, window.innerHeight);
				this._storageService.store(POSITION_KEY, JSON.stringify(anchor), StorageScope.PROFILE, StorageTarget.MACHINE);
				swallowClick = true;
			}
		};
		store.add(addDisposableListener(button, EventType.POINTER_UP, endDrag));
		store.add(addDisposableListener(button, 'pointercancel', endDrag));
		store.add(addDisposableListener(button, EventType.CLICK, () => {
			if (swallowClick) {
				swallowClick = false;
				return;
			}
			void this._commandService.executeCommand(KINGU_TOGGLE_FLOATING_WORKSPACE_COMMAND_ID);
		}));

		// `FloatingTerminalIconContextMenu`.
		store.add(addDisposableListener(wrapper, EventType.CONTEXT_MENU, (event: MouseEvent) => {
			event.preventDefault();
			event.stopPropagation();
			showFloatingWorkspaceMenu(this._contextMenuService, this._configurationService, event, 'floating-button');
		}));
		return store;
	}

	private _readAnchor(): ITriggerAnchor {
		try {
			const stored = JSON.parse(this._storageService.get(POSITION_KEY, StorageScope.PROFILE, '')) as Partial<ITriggerAnchor>;
			if ((stored.anchorX === 'left' || stored.anchorX === 'right') && (stored.anchorY === 'top' || stored.anchorY === 'bottom') && typeof stored.offsetX === 'number' && typeof stored.offsetY === 'number') {
				return stored as ITriggerAnchor;
			}
		} catch {
			// Nothing stored yet, or something unreadable: the ADE's default corner.
		}
		return DEFAULT_ANCHOR;
	}
}

/**
 * The ADE's right-click menu on the floating-workspace toggle, wherever it
 * sits: move it to the other place, or hide the floating workspace.
 */
export function showFloatingWorkspaceMenu(contextMenuService: IContextMenuService, configurationService: IConfigurationService, event: MouseEvent, location: 'floating-button' | 'status-bar'): void {
	const move = location === 'floating-button'
		? new Action('kingu.floatingWorkspace.moveToStatusBar', localize('kingu.floatingWorkspace.moveToStatusBar', "Move to Status Bar"), undefined, true,
			() => configurationService.updateValue(FLOATING_LOCATION_SETTING_ID, 'status-bar', ConfigurationTarget.USER))
		: new Action('kingu.floatingWorkspace.moveToFloatingButton', localize('kingu.floatingWorkspace.moveToFloatingButton', "Move to Floating Button"), undefined, true,
			() => configurationService.updateValue(FLOATING_LOCATION_SETTING_ID, 'floating-button', ConfigurationTarget.USER));
	const hide = new Action('kingu.floatingWorkspace.hide', localize('kingu.floatingWorkspace.hide', "Hide Floating Workspace"), undefined, true,
		() => configurationService.updateValue(FLOATING_ENABLED_SETTING_ID, false, ConfigurationTarget.USER));
	contextMenuService.showContextMenu({
		getAnchor: () => ({ x: event.clientX, y: event.clientY }),
		getActions: () => [move, new Separator(), hide],
	});
}

registerWorkbenchContribution2(KinguFloatingWorkspaceButton.ID, KinguFloatingWorkspaceButton, WorkbenchPhase.AfterRestored);
