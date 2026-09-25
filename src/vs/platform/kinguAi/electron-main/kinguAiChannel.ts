/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { tmpdir } from 'os';
import { Event } from '../../../base/common/event.js';
import { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../log/common/log.js';
import { AcpClient, resolveGeminiCommand } from '../../agentHost/node/acp/acpClient.js';
import { readGeminiAuthStatus } from '../../agentHost/node/acp/geminiAuth.js';
import { getOrcaCodexHome } from '../../kinguOrca/electron-main/kinguOrcaHost.js';
import { IKinguGeminiStatus } from '../common/kinguAi.js';
import { readGeminiUsageToday } from '../node/geminiUsage.js';

/**
 * Gemini's sign-in, which the ADE does not keep: the CLI's own record in
 * `~/.gemini` (the selected method, a Google login's credentials and account,
 * or an API key in the environment or `~/.gemini/.env`), and a Google login run
 * through the CLI's ACP `authenticate`, which opens the browser and returns
 * once the credentials are stored.
 */
export class KinguAiChannel implements IServerChannel {

	private _signIn: Promise<boolean> | undefined;

	constructor(@ILogService private readonly _logService: ILogService) { }

	listen<T>(_context: unknown, event: string): Event<T> {
		throw new Error(`No such event: ${event}`);
	}

	async call<T>(_context: unknown, command: string): Promise<T> {
		switch (command) {
			case 'geminiStatus': return await this._geminiStatus() as T;
			case 'geminiUsageToday': return await readGeminiUsageToday() as T;
			case 'geminiSignIn': return await (this._signIn ??= this._geminiSignIn().finally(() => { this._signIn = undefined; })) as T;
			// After the ADE selects another Codex account: record its home for the next app-server launch.
			case 'refreshCodexHome': return await getOrcaCodexHome() as T;
		}
		throw new Error(`No such command: ${command}`);
	}

	private async _geminiStatus(): Promise<IKinguGeminiStatus> {
		const [command, status] = await Promise.all([resolveGeminiCommand(), readGeminiAuthStatus()]);
		return { ...status, installed: command !== undefined };
	}

	private async _geminiSignIn(): Promise<boolean> {
		const command = await resolveGeminiCommand();
		if (!command) {
			throw new Error('The Gemini CLI is not installed. Install it with `npm install -g @google/gemini-cli`.');
		}
		const client = new AcpClient(command, tmpdir(), {
			requestPermission: async () => ({ outcome: 'cancelled' as const }),
			readTextFile: async () => { throw new Error('Not available while signing in.'); },
			writeTextFile: async () => { throw new Error('Not available while signing in.'); },
		}, message => this._logService.info(message));
		try {
			await client.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
			await client.request('authenticate', { methodId: 'oauth-personal' });
			return true;
		} finally {
			client.dispose();
		}
	}
}
