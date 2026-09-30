/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { orcaSettingIdForKey } from './kinguOrcaSettings.js';

/**
 * The ADE's floating workspace lives in the Agents Window
 * (`sessions/contrib/kingu/electron-browser/kinguFloatingWorkspacePanel.ts`);
 * what the footer needs of it is here, so the footer can run in the IDE too,
 * where the service is not registered and its toggle is left out.
 */
export const IKinguFloatingWorkspaceService = createDecorator<IKinguFloatingWorkspaceService>('kinguFloatingWorkspaceService');

/** The ADE's floating workspace: its open state, for the toggles that show and hide it. */
export interface IKinguFloatingWorkspaceService {
	readonly _serviceBrand: undefined;
	readonly isOpen: boolean;
	readonly onDidChangeOpen: Event<boolean>;
	/** A tab has something new — an agent waiting, finished or stopped — while the panel is closed: the ADE's amber dot. */
	readonly needsAttention: boolean;
	readonly onDidChangeAttention: Event<boolean>;
	toggle(): void;
	open(): void;
	close(): void;
}

/** Whether the floating-workspace toggle is on, and where the ADE puts it. */
export const FLOATING_ENABLED_SETTING_ID = orcaSettingIdForKey('floatingTerminalEnabled') ?? 'kingu.floatingWorkspace.floatingTerminalEnabled';
export const FLOATING_LOCATION_SETTING_ID = orcaSettingIdForKey('floatingTerminalTriggerLocation') ?? 'kingu.floatingWorkspace.floatingTerminalTriggerLocation';

/** The ADE's `floatingTerminal.toggle`, bound to Mod+Alt+A as there: shows and hides the floating workspace. */
export const KINGU_TOGGLE_FLOATING_WORKSPACE_COMMAND_ID = 'kingu.floatingWorkspace.toggle';

export const KINGU_HIDE_FLOATING_WORKSPACE_COMMAND_ID = 'kingu.floatingWorkspace.hide';
