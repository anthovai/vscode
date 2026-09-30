/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Action, Separator } from '../../../../base/common/actions.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { FLOATING_LOCATION_SETTING_ID, KINGU_HIDE_FLOATING_WORKSPACE_COMMAND_ID } from '../common/kinguFloatingWorkspace.js';

/**
 * The ADE's right-click menu on the floating-workspace toggle, wherever it
 * sits: move it to the other place, or hide the floating workspace.
 */
export function showFloatingWorkspaceMenu(contextMenuService: IContextMenuService, configurationService: IConfigurationService, commandService: ICommandService, event: MouseEvent, location: 'floating-button' | 'status-bar'): void {
	const move = location === 'floating-button'
		? new Action('kingu.floatingWorkspace.moveToStatusBar', localize('kingu.floatingWorkspace.moveToStatusBar', "Move to Status Bar"), undefined, true,
			() => configurationService.updateValue(FLOATING_LOCATION_SETTING_ID, 'status-bar', ConfigurationTarget.USER))
		: new Action('kingu.floatingWorkspace.moveToFloatingButton', localize('kingu.floatingWorkspace.moveToFloatingButton', "Move to Floating Button"), undefined, true,
			() => configurationService.updateValue(FLOATING_LOCATION_SETTING_ID, 'floating-button', ConfigurationTarget.USER));
	const hide = new Action('kingu.floatingWorkspace.hide', localize('kingu.floatingWorkspace.hide', "Hide Floating Workspace"), undefined, true,
		() => commandService.executeCommand(KINGU_HIDE_FLOATING_WORKSPACE_COMMAND_ID));
	contextMenuService.showContextMenu({
		getAnchor: () => ({ x: event.clientX, y: event.clientY }),
		getActions: () => [move, new Separator(), hide],
	});
}
