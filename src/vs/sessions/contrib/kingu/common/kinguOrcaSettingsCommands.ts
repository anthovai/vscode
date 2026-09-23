/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Opens the ADE's settings screen in this window, optionally at a pane and a
 * section, as the ADE's `openSettingsTarget({ pane, sectionId })` does.
 *
 * Argument: `{ pane?: string; sectionId?: string }`.
 */
export const KINGU_OPEN_ORCA_SETTINGS_COMMAND_ID = 'kingu.settings.open';

/** Where to open the settings screen. */
export interface IKinguOpenSettingsTarget {
	readonly pane?: string;
	readonly sectionId?: string;
}
