/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { KINGU_OPEN_ORCA_SETTINGS_COMMAND_ID } from '../../../../workbench/contrib/kingu/common/kinguOrcaSettingsCommands.js';
import { Menus } from '../../../browser/menus.js';

/** Kingu Settings in the Agents window's account menu; the screen itself is shared with the editor window. */
MenuRegistry.appendMenuItem(Menus.AccountMenu, {
	command: { id: KINGU_OPEN_ORCA_SETTINGS_COMMAND_ID, title: localize('kingu.settings.menu', "Kingu Settings") },
	group: '2_settings',
	order: 0,
});
