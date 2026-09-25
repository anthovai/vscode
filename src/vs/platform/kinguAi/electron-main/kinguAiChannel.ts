/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { resolveGeminiCommand } from '../../agentHost/node/acp/acpClient.js';
import { readGeminiAuthStatus } from '../../agentHost/node/acp/geminiAuth.js';
import { getOrcaCodexHome } from '../../kinguOrca/electron-main/kinguOrcaHost.js';
import { IKinguGeminiStatus } from '../common/kinguAi.js';
import { readClaudeAccount } from '../node/claudeAccount.js';
import { readGeminiUsageToday } from '../node/geminiUsage.js';

/**
 * What the ADE does not keep about the AI accounts: Gemini's sign-in, read from
 * the CLI's own record in `~/.gemini` (the selected method, a Google login's
 * credentials and account, or an API key in the environment or
 * `~/.gemini/.env`), and its usage today; and the Codex home of the account the
 * ADE has selected.
 */
export class KinguAiChannel implements IServerChannel {

	listen<T>(_context: unknown, event: string): Event<T> {
		throw new Error(`No such event: ${event}`);
	}

	async call<T>(_context: unknown, command: string): Promise<T> {
		switch (command) {
			case 'geminiStatus': return await this._geminiStatus() as T;
			case 'geminiUsageToday': return await readGeminiUsageToday() as T;
			case 'claudeAccount': return await readClaudeAccount() as T;
			// After the ADE selects another Codex account: record its home for the next app-server launch.
			case 'refreshCodexHome': return await getOrcaCodexHome() as T;
		}
		throw new Error(`No such command: ${command}`);
	}

	private async _geminiStatus(): Promise<IKinguGeminiStatus> {
		const [command, status] = await Promise.all([resolveGeminiCommand(), readGeminiAuthStatus()]);
		return { ...status, installed: command !== undefined };
	}
}
