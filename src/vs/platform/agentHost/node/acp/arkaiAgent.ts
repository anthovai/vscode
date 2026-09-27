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
import { CHYLE_MODEL_ID, ensureChyleRuntime } from './chyleRuntime.js';

export const ARKAI_AGENT_PROVIDER_ID: AgentProvider = 'arkai';

/**
 * The OMP profile Arkai runs in. OMP keeps each profile's sign-ins, sessions,
 * settings and log apart, so Arkai neither reads nor changes the user's own
 * OMP setup, and its sessions do not show up in theirs.
 */
export const ARKAI_OMP_PROFILE = 'kingu-arkai';

/**
 * Arkai's light mode: six tools, a short prompt of its own and no thinking,
 * without OMP's skills, rules, language servers or extensions. OMP's own
 * prompt is ~12k tokens, which a local model reads for minutes on every
 * turn; this one is ~2.7k in all. Kept on one line with no shell characters,
 * since on Windows the CLI may start through a `.cmd` shim.
 */
const ARKAI_TOOLS = 'read,write,edit,bash,grep,glob';
const ARKAI_SYSTEM_PROMPT = [
	'You are Arkai, the coding agent of Kingu. You work in the project directory of the user, with tools.',
	'When asked who you are, say you are Arkai. Answer questions directly.',
	'For a task: do it without asking for permission or confirmation.',
	'Read the files you will edit before changing them.',
	'Change files with the write or edit tool, never by describing the change.',
	'Use paths relative to the project directory.',
	'After changing code, run it or its tests with bash when a command for that exists, and fix what fails.',
	'Keep changes to what was asked. Do not add files, dependencies or features that were not requested.',
	'When done, reply with one or two sentences saying what you changed.',
].join(' ');

/** Where Arkai's OMP profile keeps its settings and provider file (`models.yml`). */
const ARKAI_AGENT_DIR = join(homedir(), '.omp', 'profiles', ARKAI_OMP_PROFILE, 'agent');

function arkaiProfile(logService: ILogService): IAcpAgentProfile {
	return {
		id: ARKAI_AGENT_PROVIDER_ID,
		displayName: localize('arkai.displayName', "Arkai"),
		description: localize('arkai.description', "Kingu's own agent, running on Chyle 1, your local models or your own AI accounts"),
		resolveCommand: async () => {
			// Chyle, Arkai's own model, needs no account: bring up its local server and gateway first.
			await ensureChyleRuntime(ARKAI_AGENT_DIR, logService).catch(error => logService.warn(`[Chyle] ${error instanceof Error ? error.message : String(error)}`));
			return resolveAcpCommand('omp', ['--profile', ARKAI_OMP_PROFILE, '--tools', ARKAI_TOOLS, '--no-skills', '--no-rules', '--no-lsp', '--no-extensions', '--thinking', 'off', '--system-prompt', ARKAI_SYSTEM_PROMPT, 'acp']);
		},
		notInstalledMessage: localize('arkai.notInstalled', "Arkai's engine (OMP) is not installed. Install it with `bun install -g @oh-my-pi/pi-coding-agent`, then restart Kingu."),
		// OMP signs in to each provider on its own, from keys in the environment or a login; Chyle needs neither.
		signedOutMessage: async () => undefined,
		logDirectory: join(homedir(), '.omp', 'profiles', ARKAI_OMP_PROFILE, 'logs'),
		// Chyle 1, Arkai's default (the profile's `modelRoles.default`), offered while OMP starts.
		initialModels: [{ modelId: `chyle/${CHYLE_MODEL_ID}`, name: 'Chyle 1' }],
		quietMessage: seconds => localize('arkai.quiet', "Arkai has sent nothing for {0} seconds. On Chyle 1, which runs on this computer, the first answer waits for the model to load and each answer comes whole rather than word by word; keep waiting, or stop the turn to give up.", seconds),
	};
}

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
		super(arkaiProfile(logService), logService, environmentService, jev);
	}
}
