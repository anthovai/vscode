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
 * An agent from the ADE's catalog, by the ADE's id and name, with the
 * commands the ADE detects it by.
 */
interface IAcpCliCandidate {
	readonly id: string;
	readonly displayName: string;
	readonly executables: readonly string[];
	/** An executable that is itself the ACP server, run with no arguments. */
	readonly dedicatedExecutable?: string;
}

/** The ways agent CLIs spell ACP mode, a subcommand or a flag, newest first. */
const ACP_SPELLINGS: readonly (readonly string[])[] = [['acp'], ['--acp'], ['--experimental-acp']];

/**
 * Kingu: every agent in the ADE's catalog (`TUI_AGENT_CONFIG` and
 * `TUI_AGENT_DISPLAY_NAMES` in the ADE's `src/shared`) apart from those with a
 * harness of their own here (Claude, Codex, Gemini, GitHub Copilot) and Claude
 * Agent Teams, which is Claude. Each is offered once its CLI is on PATH and its
 * own `--help` names an ACP mode; the rest stay terminal agents in the ADE.
 */
const ACP_CLI_CANDIDATES: readonly IAcpCliCandidate[] = [
	{ id: 'openclaude', displayName: 'OpenClaude', executables: ['openclaude'] },
	{ id: 'devin', displayName: 'Devin', executables: ['devin'] },
	{ id: 'ante', displayName: 'Ante', executables: ['ante'] },
	{ id: 'trae', displayName: 'Trae', executables: ['traecli'] },
	{ id: 'muse', displayName: 'Muse', executables: ['muse'] },
	{ id: 'autohand', displayName: 'Autohand Code', executables: ['autohand'] },
	{ id: 'opencode', displayName: 'OpenCode', executables: ['opencode'] },
	{ id: 'opencode2', displayName: 'OpenCode 2', executables: ['opencode2'] },
	{ id: 'mimo-code', displayName: 'MiMo Code', executables: ['mimo'] },
	{ id: 'pi', displayName: 'Pi', executables: ['pi'] },
	{ id: 'omp', displayName: 'OMP', executables: ['omp'] },
	{ id: 'prime-agent', displayName: 'Prime Agent', executables: ['prime-agent'] },
	{ id: 'antigravity', displayName: 'Antigravity', executables: ['agy'] },
	{ id: 'aider', displayName: 'Aider', executables: ['aider'] },
	{ id: 'goose', displayName: 'Goose', executables: ['goose'] },
	{ id: 'amp', displayName: 'Amp', executables: ['amp'] },
	{ id: 'kilo', displayName: 'Kilocode', executables: ['kilo'] },
	{ id: 'kiro', displayName: 'Kiro', executables: ['kiro-cli'] },
	{ id: 'crush', displayName: 'Charm', executables: ['crush'] },
	{ id: 'aug', displayName: 'Auggie', executables: ['auggie'] },
	{ id: 'cline', displayName: 'Cline', executables: ['cline'] },
	{ id: 'codebuff', displayName: 'Codebuff', executables: ['codebuff'] },
	{ id: 'command-code', displayName: 'Command Code', executables: ['command-code'] },
	{ id: 'continue', displayName: 'Continue', executables: ['cn'] },
	{ id: 'cursor', displayName: 'Cursor', executables: ['cursor-agent'] },
	{ id: 'droid', displayName: 'Droid', executables: ['droid'] },
	{ id: 'kimi', displayName: 'Kimi', executables: ['kimi', 'kimi-code'] },
	{ id: 'mistral-vibe', displayName: 'Mistral Vibe', executables: ['vibe', 'mistral-vibe'], dedicatedExecutable: 'vibe-acp' },
	{ id: 'qwen-code', displayName: 'Qwen Code', executables: ['qwen'] },
	{ id: 'rovo', displayName: 'Rovo Dev', executables: ['rovo'] },
	{ id: 'hermes', displayName: 'Hermes', executables: ['hermes'] },
	{ id: 'openclaw', displayName: 'OpenClaw', executables: ['openclaw'] },
	{ id: 'grok', displayName: 'Grok', executables: ['grok'] },
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

function profileFor(candidate: IAcpCliCandidate, executable: string, args: readonly string[]): IAcpAgentProfile {
	return {
		id: candidate.id,
		displayName: candidate.displayName,
		description: localize('acp.description', "{0} agent backed by your {0} CLI over the Agent Client Protocol", candidate.displayName),
		resolveCommand: () => resolveAcpCommand(executable, args),
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
async function detectCandidate(candidate: IAcpCliCandidate, logService: ILogService): Promise<IAcpAgentProfile | undefined> {
	if (candidate.dedicatedExecutable && await resolveAcpCommand(candidate.dedicatedExecutable, [])) {
		logService.info(`[ACP] ${candidate.displayName} found: ${candidate.dedicatedExecutable}`);
		return profileFor(candidate, candidate.dedicatedExecutable, []);
	}
	for (const executable of candidate.executables) {
		const help = await readHelp(executable);
		if (help === undefined) {
			continue;
		}
		const args = ACP_SPELLINGS.find(spelling => helpOffers(help, spelling));
		if (!args) {
			logService.info(`[ACP] ${candidate.displayName} is installed but its --help names no ACP mode; left to the terminal`);
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
	const found = await Promise.all(ACP_CLI_CANDIDATES.map(candidate => detectCandidate(candidate, logService)));
	return found.filter((profile): profile is IAcpAgentProfile => !!profile);
}
