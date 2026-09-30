/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { KINGU_AI_CHANNEL_NAME } from '../../../../platform/kinguAi/common/kinguAi.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { KINGU_LOCAL_MODELS_AUTO_START_SETTING } from '../common/kinguLocalModels.js';

/**
 * Starts the user's Ollama and loads Chyle once the window is idle, so the
 * IDE's local-model features (completions, inline chat, semantic search) are
 * ready by the time they are used: loading Chyle from disk is most of the
 * wait on the first answer. Before, Ollama started only with an Arkai
 * session, and those features found nothing until one had.
 */
class KinguLocalModelsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.kinguLocalModels';

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@ILogService logService: ILogService,
	) {
		super();
		if (configurationService.getValue<boolean>(KINGU_LOCAL_MODELS_AUTO_START_SETTING) === false) {
			return;
		}
		mainProcessService.getChannel(KINGU_AI_CHANNEL_NAME).call<boolean>('ensureLocalModels').then(
			up => logService.info(`[Kingu] local models ${up ? 'ready (Ollama up, Chyle loading)' : 'unavailable: Ollama is not installed or did not start'}`),
			error => logService.warn('[Kingu] could not start the local models', error),
		);
	}
}

registerWorkbenchContribution2(KinguLocalModelsContribution.ID, KinguLocalModelsContribution, WorkbenchPhase.Eventually);
