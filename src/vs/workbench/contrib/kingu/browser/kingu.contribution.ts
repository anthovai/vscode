/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ILanguageModelsService, IUserFriendlyLanguageModel } from '../../chat/common/languageModels.js';
import { KINGU_SETUP_COMMAND_ID, KINGU_VENDOR_ID, kinguVendorConfigurationSchema } from '../common/kinguLanguageModels.js';
import { KinguLanguageModelProvider } from './kinguLanguageModelProvider.js';
import { runKinguSetupFlow } from './kinguSetupFlow.js';
import '../common/kinguProductDefaults.js';

/**
 * Publishes Kingu's own model vendor.
 *
 * Registered from core rather than from an extension because the point of it is
 * that a fresh install has a model source before any extension, account or
 * marketplace is involved — the editor window already opens signed out, and this
 * is what lets chat do the same.
 */
class KinguLanguageModelContribution extends Disposable {

	static readonly ID = 'workbench.contrib.kingu.languageModels';

	constructor(
		@ILanguageModelsService languageModelsService: ILanguageModelsService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		// `IUserFriendlyLanguageModel` is derived from the contribution point's JSON
		// schema, whose open `anyOf` for `configuration` collapses to `undefined` in
		// the inferred type. Extensions pass it as untyped JSON and the models service
		// reads it back as a schema, so core has to say so explicitly here.
		const vendor = {
			vendor: KINGU_VENDOR_ID,
			displayName: 'Kingu',
			configuration: kinguVendorConfigurationSchema as unknown as IUserFriendlyLanguageModel['configuration'],
			managementCommand: undefined,
			when: undefined,
		} satisfies IUserFriendlyLanguageModel;
		// Order matters: the vendor has to exist before a provider may claim it,
		// and the descriptor is withdrawn on dispose so a reload does not trip the
		// service's "already registered" guard.
		languageModelsService.deltaLanguageModelChatProviderDescriptors([vendor], []);
		this._register(toDisposable(() => languageModelsService.deltaLanguageModelChatProviderDescriptors([], [vendor])));

		const provider = this._register(instantiationService.createInstance(KinguLanguageModelProvider));
		this._register(languageModelsService.registerLanguageModelProvider(KINGU_VENDOR_ID, provider));
	}
}

registerWorkbenchContribution2(KinguLanguageModelContribution.ID, KinguLanguageModelContribution, WorkbenchPhase.BlockRestore);

/**
 * Adds a Kingu endpoint.
 *
 * A command rather than a settings link because the workbench's model management
 * UI is contributed by the Copilot extension: on the fresh, signed-out profile
 * this whole vendor exists to serve, there is nothing there to open.
 */
class ConfigureKinguModelsAction extends Action2 {

	static readonly ID = KINGU_SETUP_COMMAND_ID;

	constructor() {
		super({
			id: ConfigureKinguModelsAction.ID,
			title: localize2('kingu.configureModels', "Kingu: Add Model Endpoint"),
			category: Categories.Preferences,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await runKinguSetupFlow(
			accessor.get(IQuickInputService),
			accessor.get(ILanguageModelsService),
			accessor.get(INotificationService),
			accessor.get(ILogService));
	}
}

registerAction2(ConfigureKinguModelsAction);
