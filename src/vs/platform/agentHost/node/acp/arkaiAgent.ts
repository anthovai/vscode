/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { homedir } from 'os';
import { join } from '../../../../base/common/path.js';
import { localize } from '../../../../nls.js';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { ILogService } from '../../../log/common/log.js';
import type { AgentProvider } from '../../common/agent.js';
import { IJevBridgeRegistry } from '../jevBridgeRegistry.js';
import { AcpAgent, IAcpAgentProfile } from './acpAgent.js';
import { resolveAcpCommand } from './acpClient.js';

export const ARKAI_AGENT_PROVIDER_ID: AgentProvider = 'arkai';

/**
 * The OMP profile Arkai runs in. OMP keeps each profile's sign-ins, sessions,
 * settings and log apart, so Arkai neither reads nor changes the user's own
 * OMP setup, and its sessions do not show up in theirs.
 */
export const ARKAI_OMP_PROFILE = 'kingu-arkai';

/** Who Arkai is, added to OMP's own system prompt. */
const ARKAI_IDENTITY = 'You are Arkai, the coding agent of Kingu. When asked who you are, say you are Arkai. You run on the models the user has set up: local models or their own AI accounts and keys.';

const ARKAI_PROFILE: IAcpAgentProfile = {
	id: ARKAI_AGENT_PROVIDER_ID,
	displayName: localize('arkai.displayName', "Arkai"),
	description: localize('arkai.description', "Kingu's own agent, running on your local models or your own AI accounts"),
	resolveCommand: () => resolveAcpCommand('omp', ['--profile', ARKAI_OMP_PROFILE, '--append-system-prompt', ARKAI_IDENTITY, 'acp']),
	notInstalledMessage: localize('arkai.notInstalled', "Arkai's engine (OMP) is not installed. Install it with `bun install -g @oh-my-pi/pi-coding-agent`, then restart Kingu."),
	// OMP signs in to each provider on its own, from keys in the environment or a login; a model without one fails its turn and says so.
	signedOutMessage: async () => undefined,
	logDirectory: join(homedir(), '.omp', 'profiles', ARKAI_OMP_PROFILE, 'logs'),
};

/**
 * Kingu: Arkai, Kingu's own agent. Its engine is OMP (oh-my-pi) over ACP
 * (`omp acp`), in a profile of its own, on the models the user brings: local
 * ones (Ollama, llama.cpp, LM Studio) or their own AI accounts and keys.
 */
export class ArkaiAgent extends AcpAgent {
	constructor(
		@ILogService logService: ILogService,
		@INativeEnvironmentService environmentService: INativeEnvironmentService,
		@IJevBridgeRegistry jev: IJevBridgeRegistry,
	) {
		super(ARKAI_PROFILE, logService, environmentService, jev);
	}
}
