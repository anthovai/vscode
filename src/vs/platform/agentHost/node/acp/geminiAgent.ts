/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { ILogService } from '../../../log/common/log.js';
import type { AgentProvider } from '../../common/agent.js';
import { AcpAgent, IAcpAgentProfile } from './acpAgent.js';
import { IAcpModel, resolveGeminiCommand } from './acpClient.js';
import { readGeminiAuthStatus } from './geminiAuth.js';

export const GEMINI_AGENT_PROVIDER_ID: AgentProvider = 'gemini';

/**
 * Models the CLI (0.61) runs by id without listing them, each run once to
 * check it answers as itself. Left out: `gemini-3.5-flash` and
 * `gemini-3.1-flash-lite`, which the CLI routes to their successors, and
 * `gemini-2.5-flash`, which Google no longer serves to new users.
 */
const EXTRA_GEMINI_MODELS: readonly IAcpModel[] = [
	{ modelId: 'gemini-3.7-flash', name: 'gemini-3.7-flash' },
	{ modelId: 'gemini-3.6-flash', name: 'gemini-3.6-flash' },
	{ modelId: 'gemini-flash-latest', name: 'gemini-flash-latest' },
	{ modelId: 'gemini-flash-lite-latest', name: 'gemini-flash-lite-latest' },
	{ modelId: 'gemini-2.5-flash-lite', name: 'gemini-2.5-flash-lite' },
];

/**
 * A name that says which Gemini it is: the CLI names most models by their id
 * (`gemini-3.1-pro-preview`), which reads as `Gemini 3.1 Pro Preview`.
 */
function geminiModelDisplayName(model: IAcpModel): string {
	if (model.modelId === 'auto') {
		return localize('gemini.autoModel', "Gemini Auto");
	}
	if (!/^gemini-[a-z0-9.-]+$/.test(model.name)) {
		return model.name;
	}
	return model.name.split('-').map(word => /^\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

const GEMINI_PROFILE: IAcpAgentProfile = {
	id: GEMINI_AGENT_PROVIDER_ID,
	displayName: localize('gemini.displayName', "Gemini"),
	description: localize('gemini.description', "Gemini agent backed by your Gemini CLI"),
	resolveCommand: () => resolveGeminiCommand(),
	notInstalledMessage: localize('gemini.notInstalled', "The Gemini CLI is not installed. Install it with `npm install -g @google/gemini-cli`, then try again."),
	signedOutMessage: async () => (await readGeminiAuthStatus()).signedIn
		? undefined
		: localize('gemini.signIn', "Gemini is not signed in. Choose Sign in to Gemini in the account menu, or set GEMINI_API_KEY, then try again."),
	modelDisplayName: geminiModelDisplayName,
	extraModels: EXTRA_GEMINI_MODELS,
};

/**
 * Kingu: the Gemini agent, running the user's Gemini CLI over ACP
 * (`gemini --acp`) on the user's own Gemini login (API key or Google).
 */
export class GeminiAgent extends AcpAgent {
	constructor(
		@ILogService logService: ILogService,
		@INativeEnvironmentService environmentService: INativeEnvironmentService,
	) {
		super(GEMINI_PROFILE, logService, environmentService);
	}
}
