/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

// Generated from kingu-orca/renderer/src/lib/agent-catalog.tsx; regenerate rather than edit.

/** An agent the ADE can start in a terminal. */
export interface IKinguTuiAgent {
	readonly id: string;
	readonly label: string;
	/** The command it runs by default, which a command override replaces. */
	readonly command: string;
	readonly docsUrl: string;
}

/** The ADE's agents, in its order. */
export const KINGU_TUI_AGENTS: readonly IKinguTuiAgent[] = [
	{ id: 'claude', label: 'Claude', command: 'claude', docsUrl: 'https://code.claude.com/docs' },
	{ id: 'claude-agent-teams', label: 'Claude Agent Teams', command: 'claude', docsUrl: 'https://code.claude.com/docs/en/agent-teams' },
	{ id: 'openclaude', label: 'OpenClaude', command: 'openclaude', docsUrl: 'https://openclaude.gitlawb.com/' },
	{ id: 'codex', label: 'Codex', command: 'codex', docsUrl: 'https://github.com/openai/codex' },
	{ id: 'grok', label: 'Grok', command: 'grok', docsUrl: 'https://x.ai/cli' },
	{ id: 'copilot', label: 'GitHub Copilot', command: 'copilot', docsUrl: 'https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli' },
	{ id: 'opencode2', label: 'OpenCode 2', command: 'opencode2', docsUrl: 'https://opencode.ai/v2/docs/' },
	{ id: 'opencode', label: 'OpenCode', command: 'opencode', docsUrl: 'https://opencode.ai/docs/cli/' },
	{ id: 'mimo-code', label: 'MiMo Code', command: 'mimo', docsUrl: 'https://mimo.xiaomi.com/coder' },
	{ id: 'ante', label: 'Ante', command: 'ante', docsUrl: 'https://github.com/AntigmaLabs/ante-preview' },
	{ id: 'trae', label: 'Trae', command: 'traecli', docsUrl: 'https://docs.trae.cn/cli_get-started-with-trae-cli' },
	{ id: 'muse', label: 'Muse', command: 'muse', docsUrl: 'https://dev.meta.ai/docs/muse-code' },
	{ id: 'zcode', label: 'ZCode', command: 'zcode', docsUrl: 'https://zcode.z.ai/en/docs' },
	{ id: 'pi', label: 'Pi', command: 'pi', docsUrl: 'https://pi.dev' },
	{ id: 'omp', label: 'OMP', command: 'omp', docsUrl: 'https://omp.sh' },
	{ id: 'prime-agent', label: 'Prime Agent', command: 'prime-agent', docsUrl: 'https://github.com/PrimeIntellect-ai/prime-agent' },
	{ id: 'gemini', label: 'Gemini', command: 'gemini', docsUrl: 'https://github.com/google-gemini/gemini-cli' },
	{ id: 'antigravity', label: 'Antigravity', command: 'agy', docsUrl: 'https://antigravity.google/docs/cli-overview' },
	{ id: 'aider', label: 'Aider', command: 'aider', docsUrl: 'https://aider.chat/docs/' },
	{ id: 'goose', label: 'Goose', command: 'goose', docsUrl: 'https://block.github.io/goose/docs/quickstart/' },
	{ id: 'amp', label: 'Amp', command: 'amp', docsUrl: 'https://ampcode.com/manual#install' },
	{ id: 'kilo', label: 'Kilocode', command: 'kilo', docsUrl: 'https://kilo.ai/docs/cli' },
	{ id: 'kiro', label: 'Kiro', command: 'kiro-cli', docsUrl: 'https://kiro.dev/docs/cli/' },
	{ id: 'crush', label: 'Charm', command: 'crush', docsUrl: 'https://github.com/charmbracelet/crush' },
	{ id: 'aug', label: 'Auggie', command: 'auggie', docsUrl: 'https://docs.augmentcode.com/cli/overview' },
	{ id: 'autohand', label: 'Autohand Code', command: 'autohand', docsUrl: 'https://github.com/autohandai/code-cli' },
	{ id: 'cline', label: 'Cline', command: 'cline', docsUrl: 'https://docs.cline.bot/cline-cli/overview' },
	{ id: 'codebuff', label: 'Codebuff', command: 'codebuff', docsUrl: 'https://www.codebuff.com/docs/help/quick-start' },
	{ id: 'command-code', label: 'Command Code', command: 'command-code', docsUrl: 'https://commandcode.ai/docs/quickstart' },
	{ id: 'continue', label: 'Continue', command: 'cn', docsUrl: 'https://docs.continue.dev/guides/cli' },
	{ id: 'cursor', label: 'Cursor', command: 'cursor-agent', docsUrl: 'https://cursor.com/cli' },
	{ id: 'droid', label: 'Droid', command: 'droid', docsUrl: 'https://docs.factory.ai/cli/getting-started/quickstart' },
	{ id: 'kimi', label: 'Kimi', command: 'kimi', docsUrl: 'https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html' },
	{ id: 'mistral-vibe', label: 'Mistral Vibe', command: 'vibe', docsUrl: 'https://github.com/mistralai/mistral-vibe' },
	{ id: 'qwen-code', label: 'Qwen Code', command: 'qwen', docsUrl: 'https://github.com/QwenLM/qwen-code' },
	{ id: 'rovo', label: 'Rovo Dev', command: 'rovo', docsUrl: 'https://support.atlassian.com/rovo/docs/install-and-run-rovo-dev-cli-on-your-device/' },
	{ id: 'hermes', label: 'Hermes', command: 'hermes', docsUrl: 'https://hermes-agent.nousresearch.com/docs/' },
	{ id: 'devin', label: 'Devin', command: 'devin', docsUrl: 'https://devin.ai/cli' },
	{ id: 'openclaw', label: 'OpenClaw', command: 'openclaw', docsUrl: 'https://github.com/openclaw/openclaw' },
];
