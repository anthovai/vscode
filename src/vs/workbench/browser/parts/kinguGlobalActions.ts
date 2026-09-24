/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../platform/registry/common/platform.js';

/**
 * Where the Accounts and Manage actions sit while the activity bar is at its
 * default place, the side: at the foot of the activity bar (upstream), or in the
 * title bar beside the layout controls (Kingu). With the activity bar at the top,
 * at the bottom or hidden they are in the title bar either way.
 */
export const KINGU_GLOBAL_ACTIONS_LOCATION = 'workbench.activityBar.globalActionsLocation';

export function kinguGlobalActionsInTitleBar(configurationService: IConfigurationService): boolean {
	return configurationService.getValue<string>(KINGU_GLOBAL_ACTIONS_LOCATION) !== 'activityBar';
}

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'workbench',
	properties: {
		[KINGU_GLOBAL_ACTIONS_LOCATION]: {
			type: 'string',
			enum: ['titleBar', 'activityBar'],
			enumDescriptions: [
				localize('globalActionsLocation.titleBar', "In the title bar, beside the layout controls."),
				localize('globalActionsLocation.activityBar', "At the bottom of the activity bar."),
			],
			default: 'titleBar',
			markdownDescription: localize('globalActionsLocation', "Controls where the Accounts and Manage actions are shown while the activity bar is at the side. With {0} set to top, bottom or hidden they are in the title bar.", '`#workbench.activityBar.location#`'),
		},
	},
});
