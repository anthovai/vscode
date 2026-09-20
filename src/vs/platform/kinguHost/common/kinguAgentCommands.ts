/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The commands each agent's CLI installs itself as.
 *
 * Keyed by the same ids the vault's source table uses, so the two join without
 * either owning the other. It lives here rather than beside that table because
 * the process that does the looking is the main one, and a main-process module
 * cannot reach into the window's layers.
 *
 * A name is here only if that agent's published installer puts it on PATH.
 * Several agents ship more than one — a rename that kept the old name working,
 * or a short alias — and any of them being present means the agent is
 * installed.
 */
export const KINGU_AGENT_COMMANDS: Readonly<Record<string, readonly string[]>> = {
	claude: ['claude'],
	codex: ['codex'],
	gemini: ['gemini'],
	copilot: ['copilot'],
	cursor: ['cursor-agent'],
	droid: ['droid'],
	cline: ['cline'],
	opencode: ['opencode'],
	antigravity: ['antigravity'],
	grok: ['grok'],
	devin: ['devin'],
	hermes: ['hermes'],
	rovo: ['acli'],
	pi: ['pi'],
	omp: ['omp'],
	'prime-agent': ['prime'],
	openclaw: ['openclaw', 'clawdbot'],
	kimi: ['kimi'],
};

/**
 * Every command worth looking for, flattened.
 *
 * The scan reads each directory once and asks which of these it holds, so the
 * cost is the number of directories rather than the number of agents.
 */
export const KNOWN_AGENT_COMMANDS: readonly string[] = [...new Set(Object.values(KINGU_AGENT_COMMANDS).flat())];
