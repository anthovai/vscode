/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { Event } from '../../../base/common/event.js';
import { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { resolveGeminiCommand } from '../../agentHost/node/acp/acpClient.js';
import { readGeminiAuthStatus } from '../../agentHost/node/acp/geminiAuth.js';
import { ensureLocalChyle } from '../../agentHost/node/acp/chyleRuntime.js';
import { ILogService } from '../../log/common/log.js';
import { getOrcaCodexHome, getOrcaCodexHomeFile } from '../../kinguOrca/electron-main/kinguOrcaHost.js';
import { IKinguGeminiStatus } from '../common/kinguAi.js';
import { IKinguCommitMessageRequest } from '../common/kinguCommitMessage.js';
import { readAgentAccount } from '../node/agentAccounts.js';
import { readClaudeAccount } from '../node/claudeAccount.js';
import { generateCommitMessage } from '../node/commitMessage.js';
import { KinguSemanticSearch } from '../node/semanticSearch.js';
import { IKinguSemanticSearchRequest } from '../common/kinguSemanticSearch.js';
import { app } from 'electron';
import { join } from '../../../base/common/path.js';
import { readGeminiUsageToday } from '../node/geminiUsage.js';

/**
 * What the ADE does not keep about the AI accounts: Gemini's sign-in, read from
 * the CLI's own record in `~/.gemini` (the selected method, a Google login's
 * credentials and account, or an API key in the environment or
 * `~/.gemini/.env`), and its usage today; and the Codex home of the account the
 * ADE has selected; and each agent CLI's own sign-in. And the one-shot a signed-in
 * agent writes for the Source Control view: a commit message.
 */
export class KinguAiChannel implements IServerChannel {

	/** Search by meaning, its index kept in the user data (`kingu-semantic-index`). */
	private _semanticSearch: KinguSemanticSearch | undefined;

	constructor(
		private readonly _appRoot: string,
		private readonly _logService: ILogService,
	) { }

	listen<T>(_context: unknown, event: string): Event<T> {
		throw new Error(`No such event: ${event}`);
	}

	async call<T>(_context: unknown, command: string, arg?: unknown): Promise<T> {
		switch (command) {
			case 'geminiStatus': return await this._geminiStatus() as T;
			case 'geminiUsageToday': return await readGeminiUsageToday() as T;
			case 'claudeAccount': return await readClaudeAccount() as T;
			// An agent CLI's own sign-in (Cursor, Qwen Code, OpenCode); `undefined` where there is none to read.
			case 'agentAccount': return await readAgentAccount(typeof arg === 'string' ? arg : '') as T;
			// After the ADE selects another Codex account: record its home for the next app-server launch.
			case 'refreshCodexHome': return await getOrcaCodexHome() as T;
			// Ollama started and Chyle loaded for the IDE's own local-model features.
			case 'ensureLocalModels': return await ensureLocalChyle(this._logService) as T;
			case 'generateCommitMessage': return await this._generateCommitMessage(arg as IKinguCommitMessageRequest) as T;
			case 'semanticSearch': {
				this._semanticSearch ??= new KinguSemanticSearch(join(app.getPath('userData'), 'kingu-semantic-index'));
				return await this._semanticSearch.search(arg as IKinguSemanticSearchRequest) as T;
			}
		}
		throw new Error(`No such command: ${command}`);
	}

	private async _generateCommitMessage(request: IKinguCommitMessageRequest) {
		if (typeof request?.cwd !== 'string' || !request.cwd) {
			throw new Error('generateCommitMessage needs the repository folder');
		}
		// The Codex account the ADE selected, as it recorded it for the agent host; Codex's own login without one.
		const codexHome = (await fs.readFile(getOrcaCodexHomeFile(), 'utf8').catch(() => '')).trim() || undefined;
		return generateCommitMessage(request.cwd, this._appRoot, codexHome);
	}

	private async _geminiStatus(): Promise<IKinguGeminiStatus> {
		const [command, status] = await Promise.all([resolveGeminiCommand(), readGeminiAuthStatus()]);
		return { ...status, installed: command !== undefined };
	}
}
