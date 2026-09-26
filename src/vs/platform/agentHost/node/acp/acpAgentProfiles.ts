/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../log/common/log.js';
import { IAcpAgentProfile } from './acpAgent.js';
import { resolveAcpCommand } from './acpClient.js';
import { ACP_AGENT_CATALOG, IAcpAgentCatalogEntry } from '../../common/acpAgentCatalog.js';

/** The ways agent CLIs spell ACP mode, a subcommand or a flag, newest first. */
const ACP_SPELLINGS: readonly (readonly string[])[] = [['acp'], ['--acp'], ['--experimental-acp']];

/**
 * How long `<cli> --help` gets. A Node CLI such as OpenCode takes seconds even
 * idle and far longer on a loaded machine; cut short, its help loses the line
 * naming ACP and the agent silently drops out of the picker.
 */
const HELP_TIMEOUT_MS = 30_000;

/** What `<cli> --help` prints, both streams, or `undefined` when it cannot run; `timedOut` when it was cut short. */
async function readHelpOnce(executable: string): Promise<{ output: string; timedOut: boolean } | undefined> {
	const command = await resolveAcpCommand(executable, ['--help']);
	if (!command) {
		return undefined;
	}
	return new Promise<{ output: string; timedOut: boolean } | undefined>(resolve => {
		let output = '';
		let timedOut = false;
		const child = spawn(command.command, [...command.args], { env: command.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, HELP_TIMEOUT_MS);
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
			resolve({ output, timedOut });
		});
	});
}

/** `--help`, asked a second time when the first was cut short. */
async function readHelp(executable: string, logService: ILogService): Promise<{ output: string; timedOut: boolean } | undefined> {
	const first = await readHelpOnce(executable);
	if (!first?.timedOut) {
		return first;
	}
	logService.info(`[ACP] ${executable} --help did not finish in ${HELP_TIMEOUT_MS / 1000}s; asking once more`);
	return await readHelpOnce(executable) ?? first;
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

function profileFor(candidate: IAcpAgentCatalogEntry, executable: string, args: readonly string[]): IAcpAgentProfile {
	return {
		id: candidate.id,
		displayName: candidate.displayName,
		description: localize('acp.description', "{0} agent backed by your {0} CLI over the Agent Client Protocol", candidate.displayName),
		resolveCommand: async () => {
			const command = await resolveAcpCommand(executable, args);
			if (!command || !candidate.envAliases) {
				return command;
			}
			const env = { ...command.env };
			for (const [name, source] of Object.entries(candidate.envAliases)) {
				if (!env[name] && env[source]) {
					env[name] = env[source];
				}
			}
			return { ...command, env };
		},
		notInstalledMessage: localize('acp.notInstalled', "The {0} CLI (`{1}`) is no longer on PATH. Install it again, then restart Kingu.", candidate.displayName, executable),
		signedOutMessage: async authMethods => {
			const ways = authMethods.map(method => method.description ? `${method.name}: ${method.description}` : method.name);
			return ways.length
				? localize('acp.signInWays', "{0} is not signed in. It can be signed in this way: {1}. Then restart Kingu and try again.", candidate.displayName, ways.join('; '))
				: localize('acp.signIn', "{0} is not signed in. Run `{1}` in a terminal and sign in, then try again.", candidate.displayName, executable);
		},
	};
}

/** The candidate's ACP launch on this machine: a dedicated ACP executable, or a detected CLI with the ACP spelling its `--help` offers. */
async function detectCandidate(candidate: IAcpAgentCatalogEntry, logService: ILogService): Promise<IAcpAgentProfile | undefined> {
	if (candidate.dedicatedExecutable && await resolveAcpCommand(candidate.dedicatedExecutable, [])) {
		logService.info(`[ACP] ${candidate.displayName} found: ${candidate.dedicatedExecutable}`);
		return profileFor(candidate, candidate.dedicatedExecutable, []);
	}
	for (const executable of candidate.executables) {
		const help = await readHelp(executable, logService);
		if (help === undefined) {
			continue;
		}
		const args = ACP_SPELLINGS.find(spelling => helpOffers(help.output, spelling));
		if (!args) {
			logService.info(help.timedOut
				? `[ACP] ${candidate.displayName} is installed but its --help did not finish, twice; left to the terminal until the next start`
				: `[ACP] ${candidate.displayName} is installed but its --help names no ACP mode; left to the terminal`);
			return undefined;
		}
		logService.info(`[ACP] ${candidate.displayName} found: ${executable} ${args.join(' ')}`);
		return profileFor(candidate, executable, args);
	}
	return undefined;
}

/**
 * The ACP agents this machine can run, from the ADE's catalog. Read once when
 * the host starts; an agent installed later appears after a restart.
 */
export async function detectAcpAgentProfiles(logService: ILogService): Promise<IAcpAgentProfile[]> {
	const found = await Promise.all(ACP_AGENT_CATALOG.map(candidate => detectCandidate(candidate, logService)));
	return found.filter((profile): profile is IAcpAgentProfile => !!profile);
}
