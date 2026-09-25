/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, EventType, isHTMLElement } from '../../../../base/browser/dom.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { getTaskReference, getTaskTitle, IKinguTaskActions, IKinguTaskRef } from '../common/kinguTasksDetail.js';
import { lucideIcon } from './kinguOrcaFooterParts.js';

/**
 * Makes a list row open its task, as the ADE's rows open its dialog, and adds
 * the row's Start workspace button. A click on the row's own buttons or on
 * selected text is left alone.
 */
export function bindTaskRow(row: HTMLElement, actionsCell: HTMLElement, ref: IKinguTaskRef, actions: IKinguTaskActions, hoverService: IHoverService, store: DisposableStore): void {
	row.classList.add('kingu-tasks-openable');
	row.tabIndex = 0;
	row.setAttribute('role', 'button');
	row.setAttribute('aria-label', localize('kingu.tasks.detail.openRow', "Open {0}: {1}", getTaskReference(ref), getTaskTitle(ref)));
	store.add(addDisposableListener(row, EventType.CLICK, (event: MouseEvent) => {
		const target = event.target;
		if (isHTMLElement(target) && target.closest('button, a')) {
			return;
		}
		if (!row.ownerDocument.getSelection()?.isCollapsed) {
			return;
		}
		actions.openDetail(ref);
	}));
	store.add(addDisposableListener(row, EventType.KEY_DOWN, (event: KeyboardEvent) => {
		if (event.target === row && (event.key === 'Enter' || event.key === ' ')) {
			event.preventDefault();
			actions.openDetail(ref);
		}
	}));
	const start = $('button.kingu-tasks-row-action') as HTMLButtonElement;
	start.type = 'button';
	const label = localize('kingu.tasks.detail.startWorkspaceFrom', "Start Workspace from {0}", getTaskReference(ref));
	start.setAttribute('aria-label', label);
	start.appendChild(lucideIcon('play', 14));
	store.add(hoverService.setupDelayedHover(start, { content: label, position: { hoverPosition: HoverPosition.BELOW } }));
	store.add(addDisposableListener(start, EventType.CLICK, () => actions.startWorkspace(ref)));
	actionsCell.prepend(start);
}
