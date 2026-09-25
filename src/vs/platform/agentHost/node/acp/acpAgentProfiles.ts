/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../log/common/log.js';
import { IAcpAgentProfile } from './acpAgent.js';
import { resolveAcpCommand } from './acpClient.js';

/**
 * An agent CLI that can speak ACP, as the ADE's agent catalog names it, with
 * the ways its versions have spelled ACP mode (a flag or a subcommand).
 */
interface IAcpCliCandidate {
	readonly id: string;
	readonly displayName: string;
	readonly executable: string;
	/**
	 * ACP mode's arguments, newest spelling first. An empty entry marks an
	 * executable that is itself the ACP server.
	 */
	readonly argVariants: readonly (readonly string[])[];
}

/**
 * Kingu: the ADE's agents beyond Claude, Codex, Gemini and Copilot (which have
 * their own harnesses) whose CLIs can serve ACP. Each is offered only when its
 * CLI is on PATH and its own `--help` names ACP mode, so a guess here that a
 * CLI does not support costs nothing.
 */
const ACP_CLI_CANDIDATES: readonly IAcpCliCandidate[] = [
	{ id: 'qwen', displayName: 'Qwen Code', executable: 'qwen', argVariants: [['--acp'], ['--experimental-acp']] },
	{ id: 'opencode', displayName: 'OpenCode', executable: 'opencode', argVariants: [['acp']] },
	{ id: 'goose', displayName: 'Goose', executable: 'goose', argVariants: [['acp']] },
	{ id: 'kimi', displayName: 'Kimi', executable: 'kimi', argVariants: [['acp'], ['--acp']] },
	{ id: 'auggie', displayName: 'Auggie', executable: 'auggie', argVariants: [['--acp']] },
	{ id: 'kiro', displayName: 'Kiro', executable: 'kiro-cli', argVariants: [['acp']] },
	{ id: 'kilo', displayName: 'Kilocode', executable: 'kilo', argVariants: [['acp']] },
	{ id: 'cline', displayName: 'Cline', executable: 'cline', argVariants: [['--acp'], ['acp']] },
	{ id: 'cursor', displayName: 'Cursor', executable: 'cursor-agent', argVariants: [['acp'], ['--acp']] },
	{ id: 'droid', displayName: 'Droid', executable: 'droid', argVariants: [['acp'], ['--acp']] },
	{ id: 'openhands', displayName: 'OpenHands', executable: 'openhands', argVariants: [['acp']] },
	{ id: 'mistral-vibe', displayName: 'Mistral Vibe', executable: 'vibe-acp', argVariants: [[]] },
];

const HELP_TIMEOUT_MS = 10_000;

/** What `<cli> --help` prints, both streams, or `undefined` when it cannot run. */
async function readHelp(executable: string): Promise<string | undefined> {
	const command = await resolveAcpCommand(executable, ['--help']);
	if (!command) {
		return undefined;
	}
	return new Promise<string | undefined>(resolve => {
		let output = '';
		const child = spawn(command.command, [...command.args], { env: command.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
		const timer = setTimeout(() => child.kill(), HELP_TIMEOUT_MS);
		const append = (chunk: Buffer) => {
			output = `${output}${chunk.toString('utf8')}`.slice(0, 64_000);
		};
		child.stdout.on('data', append);
		child.stderr.on('data', append);
		child.on('error', () => {
			clearTimeout(timer);
			resolve(undefined);
		});
		child.on('close', () => {
			clearTimeout(timer);
			resolve(output);
		});
	});
}

/** Whether `help` offers ACP mode spelled as `args`: a `--flag`, or a subcommand listed on a line of its own. */
function helpOffers(help: string, args: readonly string[]): boolean {
	const [first] = args;
	if (!first) {
		return true;
	}
	const escaped = first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return first.startsWith('-')
		? new RegExp(`(^|[\\s,\\[])${escaped}(?![\\w-])`, 'm').test(help)
		: new RegExp(`^\\s*(\\S+\\s+)?${escaped}(\\s|$)`, 'm').test(help);
}

function profileFor(candidate: IAcpCliCandidate, args: readonly string[]): IAcpAgentProfile {
	return {
		id: candidate.id,
		displayName: candidate.displayName,
		description: localize('acp.description', "{0} agent backed by your {0} CLI over the Agent Client Protocol", candidate.displayName),
		resolveCommand: () => resolveAcpCommand(candidate.executable, args),
		notInstalledMessage: localize('acp.notInstalled', "The {0} CLI (`{1}`) is no longer on PATH. Install it again, then restart Kingu.", candidate.displayName, candidate.executable),
		signedOutMessage: async () => localize('acp.signIn', "{0} is not signed in. Run `{1}` in a terminal and sign in, then try again.", candidate.displayName, candidate.executable),
	};
}

/**
 * The ACP agents this machine can run: each candidate whose CLI is on PATH,
 * with the ACP spelling its `--help` offers. Read once when the host starts;
 * an agent installed later appears after a restart.
 */
export async function detectAcpAgentProfiles(logService: ILogService): Promise<IAcpAgentProfile[]> {
	const found = await Promise.all(ACP_CLI_CANDIDATES.map(async candidate => {
		const dedicated = candidate.argVariants.find(args => args.length === 0);
		if (dedicated) {
			return await resolveAcpCommand(candidate.executable, dedicated) ? profileFor(candidate, dedicated) : undefined;
		}
		const help = await readHelp(candidate.executable);
		if (help === undefined) {
			return undefined;
		}
		const args = candidate.argVariants.find(variant => helpOffers(help, variant));
		if (!args) {
			logService.info(`[ACP] ${candidate.displayName} is installed but its --help names no ACP mode; not offered`);
			return undefined;
		}
		logService.info(`[ACP] ${candidate.displayName} found: ${candidate.executable} ${args.join(' ')}`);
		return profileFor(candidate, args);
	}));
	return found.filter((profile): profile is IAcpAgentProfile => !!profile);
}
