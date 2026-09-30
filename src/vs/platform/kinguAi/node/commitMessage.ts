/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../base/common/path.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { IAcpSpawnCommand, resolveAcpCommand, resolveAcpExecutable } from '../../agentHost/node/acp/acpClient.js';
import {
	buildCommitMessagePrompt,
	cleanCommitMessage,
	hasCommitChanges,
	IKinguCommitChanges,
	IKinguCommitMessageResult,
	KinguCommitMessageAgent,
} from '../common/kinguCommitMessage.js';

const GIT_TIMEOUT_MS = 30_000;
/** A commit message from a small model takes seconds; a CLI still waiting after this is not going to answer. */
const AGENT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 1_000_000;

interface IRunResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}

function run(command: IAcpSpawnCommand, cwd: string, input: string | undefined, timeoutMs: number): Promise<IRunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command.command, [...command.args], { cwd, env: command.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, timeoutMs);
		child.stdout.on('data', (chunk: Buffer) => { stdout = `${stdout}${chunk.toString('utf8')}`.slice(0, MAX_OUTPUT_CHARS); });
		child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-MAX_OUTPUT_CHARS); });
		child.on('error', error => { clearTimeout(timer); reject(error); });
		child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
		child.stdin.on('error', () => { /* the CLI exited before reading its prompt; `close` reports why */ });
		child.stdin.end(input ?? '');
	});
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
	const result = await run({ command: 'git', args, env: process.env }, cwd, undefined, GIT_TIMEOUT_MS);
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
	}
	return result.stdout;
}

/** What a commit made now would take: the staged changes, or with nothing staged every change, as the Source Control view's commit does. */
export async function readCommitChanges(cwd: string): Promise<IKinguCommitChanges> {
	const [branch, recent, stagedStat] = await Promise.all([
		git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).then(out => out.trim(), () => undefined),
		git(cwd, ['log', '-n', '10', '--pretty=format:%s']).catch(() => ''),
		git(cwd, ['diff', '--cached', '--stat']),
	]);
	const recentSubjects = recent.split('\n').map(line => line.trim()).filter(Boolean);
	if (stagedStat.trim()) {
		return { branch, staged: true, stat: stagedStat, diff: await git(cwd, ['diff', '--cached']), untracked: [], recentSubjects };
	}
	const [stat, diff, untracked] = await Promise.all([
		git(cwd, ['diff', '--stat']),
		git(cwd, ['diff']),
		git(cwd, ['ls-files', '--others', '--exclude-standard']),
	]);
	return { branch, staged: false, stat, diff, untracked: untracked.split('\n').map(line => line.trim()).filter(Boolean), recentSubjects };
}

/** Where a build keeps the agent SDKs it ships (`agent-sdks/<id>`), and a source checkout its `node_modules`. */
function sdkRoots(appRoot: string, id: string): string[] {
	return [join(appRoot, 'agent-sdks', id), appRoot];
}

async function firstCommand(candidates: readonly string[], onPath: string, args: readonly string[]): Promise<IAcpSpawnCommand | undefined> {
	for (const candidate of candidates) {
		const command = await resolveAcpExecutable(candidate, args);
		if (command) {
			return command;
		}
	}
	return resolveAcpCommand(onPath, args);
}

/** The model's answer, or an error that says why there is none. */
type Attempt = { readonly text: string; readonly error?: undefined } | { readonly text?: undefined; readonly error: string };

/**
 * Claude Code in print mode, on the login Claude Code already has (the ADE
 * materializes the account it selects into the same place). Haiku, no tools,
 * no settings or MCP servers from anywhere, and run outside the repository so
 * none of its instructions are loaded: this is one sentence, not a session.
 */
async function askClaude(appRoot: string, prompt: string): Promise<Attempt | undefined> {
	const binary = process.platform === 'win32' ? 'claude.exe' : 'claude';
	const pkg = `claude-agent-sdk-${process.platform}-${process.arch}`;
	const args = ['-p', '--model', 'haiku', '--output-format', 'json', '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', ''];
	const command = await firstCommand(sdkRoots(appRoot, 'claude').map(root => join(root, 'node_modules', '@anthropic-ai', pkg, binary)), 'claude', args);
	if (!command) {
		return undefined;
	}
	const result = await run(command, tmpdir(), prompt, AGENT_TIMEOUT_MS);
	if (result.timedOut) {
		return { error: 'did not answer in time' };
	}
	let reply: { readonly is_error?: unknown; readonly result?: unknown } | undefined;
	try {
		reply = JSON.parse(result.stdout.trim().split('\n').pop() ?? '');
	} catch {
		reply = undefined;
	}
	if (!reply || typeof reply.result !== 'string') {
		return { error: lastLine(result.stderr) || lastLine(result.stdout) || `exited with code ${result.code}` };
	}
	return reply.is_error ? { error: reply.result } : { text: reply.result };
}

/** `codexBinaryTriple` in the agent host's Codex agent, for the targets Kingu ships. */
const CODEX_TRIPLES: Readonly<Record<string, string>> = {
	'win32-x64': 'x86_64-pc-windows-msvc',
	'win32-arm64': 'aarch64-pc-windows-msvc',
	'darwin-x64': 'x86_64-apple-darwin',
	'darwin-arm64': 'aarch64-apple-darwin',
	'linux-x64': 'x86_64-unknown-linux-musl',
	'linux-arm64': 'aarch64-unknown-linux-musl',
};

/**
 * `codex exec`, read-only and ephemeral, on the Codex account the ADE has
 * selected (`codexHome`) or Codex's own login. The last message goes to a file
 * because stdout carries the whole transcript.
 */
async function askCodex(appRoot: string, prompt: string, codexHome: string | undefined): Promise<Attempt | undefined> {
	const target = `${process.platform}-${process.arch}`;
	const triple = CODEX_TRIPLES[target];
	const binary = process.platform === 'win32' ? 'codex.exe' : 'codex';
	const out = join(tmpdir(), `kingu-commit-message-${generateUuid()}.txt`);
	const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--color', 'never', '--output-last-message', out, '-'];
	const candidates = triple ? sdkRoots(appRoot, 'codex').map(root => join(root, 'node_modules', '@openai', `codex-${target}`, 'vendor', triple, 'bin', binary)) : [];
	const command = await firstCommand(candidates, 'codex', args);
	if (!command) {
		return undefined;
	}
	if (codexHome && await fs.stat(codexHome).then(stat => stat.isDirectory(), () => false)) {
		command.env.CODEX_HOME = codexHome;
	}
	try {
		const result = await run(command, tmpdir(), prompt, AGENT_TIMEOUT_MS);
		if (result.timedOut) {
			return { error: 'did not answer in time' };
		}
		const text = await fs.readFile(out, 'utf8').catch(() => '');
		if (result.code === 0 && text.trim()) {
			return { text };
		}
		const errors = `${result.stderr}\n${result.stdout}`.split('\n').filter(line => /^ERROR:/.test(line.trim()));
		return { error: (errors.pop() ?? lastLine(result.stderr) ?? `exited with code ${result.code}`).replace(/^\s*ERROR:\s*/, '') };
	} finally {
		await fs.rm(out, { force: true }).catch(() => undefined);
	}
}

const OLLAMA_URL = 'http://127.0.0.1:11434';
/** Chyle's first load from disk took ~175 s on the user's GPU; after that it answers in seconds. */
const CHYLE_TIMEOUT_MS = 240_000;

/**
 * Chyle, Arkai's own model, on the Ollama the user already has running. Only
 * asked when Ollama answers at once: starting it (and loading an 18 GB model)
 * for one sentence is not this button's call to make.
 */
async function askChyle(prompt: string): Promise<Attempt | undefined> {
	let models: readonly { readonly name?: unknown }[];
	try {
		const tags = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3_000) });
		models = tags.ok ? ((await tags.json()) as { models?: { name?: unknown }[] }).models ?? [] : [];
	} catch {
		return undefined;
	}
	const model = models.map(entry => entry.name).find((name): name is string => typeof name === 'string' && name.startsWith('chyle'));
	if (!model) {
		return undefined;
	}
	try {
		const response = await fetch(`${OLLAMA_URL}/api/chat`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ model, stream: false, think: false, messages: [{ role: 'user', content: prompt }] }),
			signal: AbortSignal.timeout(CHYLE_TIMEOUT_MS),
		});
		const reply = await response.json() as { message?: { content?: unknown }; error?: unknown };
		if (!response.ok || typeof reply.message?.content !== 'string') {
			return { error: typeof reply.error === 'string' ? reply.error : `Ollama answered ${response.status}` };
		}
		return { text: reply.message.content.replace(/<think>[\s\S]*?<\/think>/g, '') };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function lastLine(text: string): string {
	return text.trim().split('\n').pop()?.trim() ?? '';
}

export class KinguCommitMessageError extends Error { }

/**
 * A commit message for the repository at `cwd`, from the first agent that
 * writes one: Claude, then Codex, then Chyle on a running Ollama. A failure moves on to the next (a Claude
 * account at its weekly limit is the common case), and only when every agent
 * has failed is the error thrown, naming each one's reason.
 */
export async function generateCommitMessage(cwd: string, appRoot: string, codexHome: string | undefined): Promise<IKinguCommitMessageResult> {
	const changes = await readCommitChanges(cwd);
	if (!hasCommitChanges(changes)) {
		throw new KinguCommitMessageError('There are no changes to describe.');
	}
	const prompt = buildCommitMessagePrompt(changes);
	const agents: readonly [KinguCommitMessageAgent, string, () => Promise<Attempt | undefined>][] = [
		['claude', 'Claude', () => askClaude(appRoot, prompt)],
		['codex', 'Codex', () => askCodex(appRoot, prompt, codexHome)],
		['chyle', 'Chyle', () => askChyle(prompt)],
	];
	const failures: string[] = [];
	for (const [agent, label, ask] of agents) {
		let attempt: Attempt | undefined;
		try {
			attempt = await ask();
		} catch (error) {
			attempt = { error: error instanceof Error ? error.message : String(error) };
		}
		if (!attempt) {
			continue;
		}
		if (attempt.text !== undefined) {
			const message = cleanCommitMessage(attempt.text);
			if (message) {
				return { message, agent };
			}
			attempt = { error: 'returned an empty message' };
		}
		failures.push(`${label}: ${attempt.error}`);
	}
	throw new KinguCommitMessageError(failures.length
		? failures.join('\n')
		: 'No agent is available to write it: sign in to Claude or Codex, or start Ollama for Chyle.');
}
