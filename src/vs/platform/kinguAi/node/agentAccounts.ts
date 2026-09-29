/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from '../../../base/common/path.js';
import { ACP_AGENT_CATALOG } from '../../agentHost/common/acpAgentCatalog.js';
import { candidateEnv } from '../../agentHost/node/acp/acpAgentProfiles.js';
import { resolveAcpCommand } from '../../agentHost/node/acp/acpClient.js';
import { IKinguAgentAccount } from '../common/kinguAi.js';

/**
 * Whether an agent CLI is signed in, read from the CLI itself rather than
 * guessed from the models it lists (a CLI still starting lists none, and one on
 * an API key lists the same as one signed in). `undefined` for an agent Kingu
 * has no way to ask, or whose CLI is not installed.
 */
export async function readAgentAccount(id: string): Promise<IKinguAgentAccount | undefined> {
	switch (id) {
		case 'cursor': return readCursorAccount();
		case 'qwen-code': return readQwenAccount();
		case 'opencode': return readOpenCodeAccount();
		default: return undefined;
	}
}

const COMMAND_TIMEOUT_MS = 20_000;

/** The output of `<executable> <args>`, or `undefined` when it is not installed or does not finish. */
async function runCli(executable: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
	const command = await resolveAcpCommand(executable, args, env);
	if (!command) {
		return undefined;
	}
	return new Promise(resolve => {
		let output = '';
		const child = spawn(command.command, [...command.args], { env: command.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
		const timer = setTimeout(() => {
			child.kill();
			resolve(undefined);
		}, COMMAND_TIMEOUT_MS);
		const append = (chunk: Buffer) => { output = `${output}${chunk.toString('utf8')}`.slice(0, 64_000); };
		child.stdout.on('data', append);
		child.stderr.on('data', append);
		child.on('error', () => { clearTimeout(timer); resolve(undefined); });
		child.on('close', () => { clearTimeout(timer); resolve(output); });
	});
}

const ANSI = /\u001b\[[0-9;]*m/g;

/** `Label   value` from a CLI's aligned key/value listing. */
function field(output: string, label: string): string | undefined {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const value = new RegExp(`^\\s*${escaped}\\s{2,}(?<value>.+?)\\s*$`, 'm').exec(output)?.groups?.value;
	return value && !/^(n\/a|none|-|not logged in)$/i.test(value) ? value : undefined;
}

/** Cursor's CLI names the account and its plan in `about` (`User Email`, `Subscription Tier`). */
export function parseCursorAbout(output: string): IKinguAgentAccount {
	const text = output.replace(ANSI, '');
	const email = field(text, 'User Email');
	return email
		? { signedIn: true, email, plan: field(text, 'Subscription Tier') }
		: { signedIn: false };
}

async function readCursorAccount(): Promise<IKinguAgentAccount | undefined> {
	const cursor = ACP_AGENT_CATALOG.find(entry => entry.id === 'cursor');
	const env = cursor ? candidateEnv(cursor) : process.env;
	const output = await runCli('cursor-agent', ['about'], env) ?? await runCli('agent', ['about'], env);
	return output === undefined ? undefined : parseCursorAbout(output);
}

/**
 * Qwen Code signs in with Qwen's OAuth (`~/.qwen/oauth_creds.json`) or runs on
 * an OpenAI-compatible key (`OPENAI_API_KEY`); either works. Its use is in
 * `~/.qwen/usage_record.jsonl`, one line per session with its token totals.
 */
async function readQwenAccount(): Promise<IKinguAgentAccount | undefined> {
	const home = join(homedir(), '.qwen');
	const hasOAuth = await fs.stat(join(home, 'oauth_creds.json')).then(() => true, () => false);
	const hasKey = !!process.env.OPENAI_API_KEY?.trim() || !!process.env.DASHSCOPE_API_KEY?.trim();
	if (!hasOAuth && !hasKey) {
		return { signedIn: false };
	}
	let records: string | undefined;
	try {
		records = await fs.readFile(join(home, 'usage_record.jsonl'), 'utf8');
	} catch {
		records = undefined;
	}
	return {
		signedIn: true,
		method: hasOAuth ? 'Qwen OAuth' : 'API key',
		tokensToday: records === undefined ? undefined : qwenTokensToday(records, new Date()),
	};
}

/** The tokens of every session recorded since local midnight. */
export function qwenTokensToday(records: string, now: Date): number {
	const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	let total = 0;
	for (const line of records.split('\n')) {
		let record: { timestamp?: unknown; models?: Record<string, { totalTokens?: unknown }> };
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof record.timestamp !== 'number' || record.timestamp < midnight) {
			continue;
		}
		for (const model of Object.values(record.models ?? {})) {
			total += typeof model.totalTokens === 'number' && Number.isFinite(model.totalTokens) ? model.totalTokens : 0;
		}
	}
	return total;
}

/** The providers `opencode auth list` names, stored credentials and environment keys alike (`•  Google GEMINI_API_KEY`). */
export function parseOpenCodeAuthList(output: string): IKinguAgentAccount {
	const providers = [...output.replace(ANSI, '').matchAll(/^\s*[•●]\s+(?<name>[^\s].*?)(?:\s{2,}|\s+[A-Z][A-Z0-9_]+\s*$|$)/gm)]
		.map(match => match.groups?.name.replace(/\s+[A-Z][A-Z0-9_]+$/, '').trim())
		.filter((name): name is string => !!name);
	return providers.length
		? { signedIn: true, method: providers.join(', ') }
		: { signedIn: false };
}

async function readOpenCodeAccount(): Promise<IKinguAgentAccount | undefined> {
	const output = await runCli('opencode', ['auth', 'list']);
	return output === undefined ? undefined : parseOpenCodeAuthList(output);
}
