/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from '../../../base/common/path.js';
import { IKinguGeminiUsage } from '../common/kinguAi.js';

/**
 * Today's Gemini use, read from the chats the Gemini CLI records under
 * `~/.gemini/tmp/<project>/chats/session-*.jsonl`: every reply there carries
 * its token counts. That covers the CLI wherever it ran, as a usage meter
 * should; an API key has no quota to read instead.
 *
 * A resumed session is recorded again in a new file, so replies are counted
 * once by id. Only files changed since midnight can hold today's replies.
 */
export async function readGeminiUsageToday(now = new Date()): Promise<IKinguGeminiUsage> {
	const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const root = join(homedir(), '.gemini', 'tmp');
	const seen = new Set<string>();
	const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, replies: 0 };
	let projects: string[];
	try {
		projects = await fs.readdir(root);
	} catch {
		return { ...usage, since: midnight };
	}
	for (const project of projects) {
		const chats = join(root, project, 'chats');
		let files: string[];
		try {
			files = (await fs.readdir(chats)).filter(file => file.startsWith('session-') && file.endsWith('.jsonl'));
		} catch {
			continue;
		}
		for (const file of files) {
			const path = join(chats, file);
			try {
				if ((await fs.stat(path)).mtimeMs < midnight) {
					continue;
				}
				for (const line of (await fs.readFile(path, 'utf8')).split('\n')) {
					if (!line.includes('"type":"gemini"')) {
						continue;
					}
					countReply(line, midnight, seen, usage);
				}
			} catch {
				// A file the CLI is writing or has removed; the next read counts it.
			}
		}
	}
	return { ...usage, since: midnight };
}

interface IRecordedReply {
	readonly id?: unknown;
	readonly type?: unknown;
	readonly timestamp?: unknown;
	readonly tokens?: { readonly input?: unknown; readonly output?: unknown; readonly cached?: unknown; readonly thoughts?: unknown };
}

function countReply(line: string, midnight: number, seen: Set<string>, usage: { inputTokens: number; outputTokens: number; cachedTokens: number; replies: number }): void {
	let reply: IRecordedReply;
	try {
		reply = JSON.parse(line);
	} catch {
		return;
	}
	if (reply.type !== 'gemini' || typeof reply.id !== 'string' || seen.has(reply.id) || typeof reply.timestamp !== 'string' || Date.parse(reply.timestamp) < midnight) {
		return;
	}
	seen.add(reply.id);
	const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
	usage.inputTokens += count(reply.tokens?.input);
	// Thinking is billed as output.
	usage.outputTokens += count(reply.tokens?.output) + count(reply.tokens?.thoughts);
	usage.cachedTokens += count(reply.tokens?.cached);
	usage.replies++;
}
