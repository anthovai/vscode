/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * An agent from the ADE's catalog, by the ADE's id and name, with the
 * commands the ADE detects it by.
 */
export interface IAcpAgentCatalogEntry {
	readonly id: string;
	readonly displayName: string;
	readonly executables: readonly string[];
	/** An executable that is itself the ACP server, run with no arguments. */
	readonly dedicatedExecutable?: string;
	/**
	 * Environment variables the CLI reads under another name than the one the
	 * user set, as `{ [name the CLI reads]: name the user set }`.
	 */
	readonly envAliases?: Readonly<Record<string, string>>;
	/**
	 * Arguments that run the CLI's own sign-in; without them the CLI itself is
	 * run, and signs in from its first screen.
	 */
	readonly loginArgs?: readonly string[];
}

/**
 * Kingu: every agent in the ADE's catalog (`TUI_AGENT_CONFIG` and
 * `TUI_AGENT_DISPLAY_NAMES` in the ADE's `src/shared`) apart from those with a
 * harness of their own here (Claude, Codex, Gemini, GitHub Copilot) and Claude
 * Agent Teams, which is Claude. Each is offered once its CLI is on PATH and its
 * own `--help` names an ACP mode; the rest stay terminal agents in the ADE.
 */
export const ACP_AGENT_CATALOG: readonly IAcpAgentCatalogEntry[] = [
	{ id: 'openclaude', displayName: 'OpenClaude', executables: ['openclaude'] },
	{ id: 'devin', displayName: 'Devin', executables: ['devin'] },
	{ id: 'ante', displayName: 'Ante', executables: ['ante'] },
	{ id: 'trae', displayName: 'Trae', executables: ['traecli'] },
	{ id: 'muse', displayName: 'Muse', executables: ['muse'] },
	{ id: 'autohand', displayName: 'Autohand Code', executables: ['autohand'] },
	// OpenCode lists Google's models on `GEMINI_API_KEY` but calls them with `GOOGLE_GENERATIVE_AI_API_KEY`.
	{ id: 'opencode', displayName: 'OpenCode', executables: ['opencode'], loginArgs: ['auth', 'login'], envAliases: { GOOGLE_GENERATIVE_AI_API_KEY: 'GEMINI_API_KEY' } },
	{ id: 'opencode2', displayName: 'OpenCode 2', executables: ['opencode2'], loginArgs: ['auth', 'login'], envAliases: { GOOGLE_GENERATIVE_AI_API_KEY: 'GEMINI_API_KEY' } },
	{ id: 'mimo-code', displayName: 'MiMo Code', executables: ['mimo'] },
	{ id: 'pi', displayName: 'Pi', executables: ['pi'] },
	{ id: 'omp', displayName: 'OMP', executables: ['omp'] },
	{ id: 'prime-agent', displayName: 'Prime Agent', executables: ['prime-agent'] },
	{ id: 'antigravity', displayName: 'Antigravity', executables: ['agy'] },
	{ id: 'aider', displayName: 'Aider', executables: ['aider'] },
	{ id: 'goose', displayName: 'Goose', executables: ['goose'], loginArgs: ['configure'] },
	{ id: 'amp', displayName: 'Amp', executables: ['amp'] },
	{ id: 'kilo', displayName: 'Kilocode', executables: ['kilo'] },
	{ id: 'kiro', displayName: 'Kiro', executables: ['kiro-cli'] },
	{ id: 'crush', displayName: 'Charm', executables: ['crush'] },
	{ id: 'aug', displayName: 'Auggie', executables: ['auggie'] },
	{ id: 'cline', displayName: 'Cline', executables: ['cline'] },
	{ id: 'codebuff', displayName: 'Codebuff', executables: ['codebuff'] },
	{ id: 'command-code', displayName: 'Command Code', executables: ['command-code'] },
	{ id: 'continue', displayName: 'Continue', executables: ['cn'] },
	{ id: 'cursor', displayName: 'Cursor', executables: ['cursor-agent'], loginArgs: ['login'] },
	{ id: 'droid', displayName: 'Droid', executables: ['droid'] },
	{ id: 'kimi', displayName: 'Kimi', executables: ['kimi', 'kimi-code'] },
	{ id: 'mistral-vibe', displayName: 'Mistral Vibe', executables: ['vibe', 'mistral-vibe'], dedicatedExecutable: 'vibe-acp' },
	{ id: 'qwen-code', displayName: 'Qwen Code', executables: ['qwen'] },
	{ id: 'rovo', displayName: 'Rovo Dev', executables: ['rovo'] },
	{ id: 'hermes', displayName: 'Hermes', executables: ['hermes'] },
	{ id: 'openclaw', displayName: 'OpenClaw', executables: ['openclaw'] },
	{ id: 'grok', displayName: 'Grok', executables: ['grok'] },
];

/** The ADE catalog entry for an agent id, when the agent is one of the ACP agents. */
export function acpAgentCatalogEntry(id: string): IAcpAgentCatalogEntry | undefined {
	return ACP_AGENT_CATALOG.find(entry => entry.id === id);
}

/** The command line, as typed in a terminal, that signs in to an ACP agent's CLI. */
export function acpAgentLoginCommand(entry: IAcpAgentCatalogEntry): string {
	return [entry.executables[0], ...(entry.loginArgs ?? [])].join(' ');
}
