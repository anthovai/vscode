/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

/**
 * Defaults Kingu ships that differ from upstream's, kept here rather than in
 * upstream's own registrations so a sync never conflicts on them.
 *
 * - Voice Mode is off: it streams audio to Microsoft's voice service, which
 *   Kingu does not use (`product.json` carries no `voiceWsUrl`), so its button
 *   stays out of the chat input. On-device dictation is unaffected.
 * - The color themes are Kingu's (extensions/theme-kingu), in the ADE's palette.
 * - The activity bar is compact (16px icons), its Accounts and Manage actions in
 *   the title bar (workbench/browser/parts/kinguGlobalActions.ts), and signing in
 *   is in the Accounts menu rather than a separate title-bar button.
 */
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{
	overrides: {
		'agents.voice.enabled': false,
		'agents.voice.showButton': false,
		'workbench.colorTheme': 'Kingu Dark',
		'workbench.preferredDarkColorTheme': 'Kingu Dark',
		'workbench.preferredLightColorTheme': 'Kingu Light',
		'workbench.activityBar.compact': true,
		'chat.titleBar.signIn.enabled': false,
	},
}]);
