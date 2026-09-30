/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join } from '../../../../base/common/path.js';
import { ILogService } from '../../../log/common/log.js';
import { IChyleGateway, IChyleUsage, startChyleGateway } from './chyleGateway.js';

/**
 * Kingu: what Arkai needs to run on Chyle, its own model, on this machine:
 * the local model server (Ollama), Chyle's gateway in front of it, and
 * Arkai's provider file pointing at the gateway.
 *
 * Kingu starts them itself, so Arkai works without the user starting
 * anything and without an account. Each part that fails is logged and left;
 * Arkai still runs on any other model the user has.
 */

export const CHYLE_MODEL_ID = 'chyle-1-coder';
export const OLLAMA_URL = 'http://127.0.0.1:11434';
/** The gateway's port; Arkai's provider file names it. */
export const CHYLE_GATEWAY_PORT = 11435;
/** How long Ollama keeps Chyle loaded after its last use; its own default is five minutes. */
const CHYLE_KEEP_ALIVE = '30m';

/**
 * This machine's Chyle settings, `~/.arkai/chyle.json`:
 * `{ "ollamaModels": "E:\\ollama_models" }` says where Ollama keeps its
 * models, when the system's `OLLAMA_MODELS` is missing or wrong.
 */
interface IChyleMachineConfig {
	readonly ollamaModels?: string;
}

/** Arkai's provider file: Chyle through its gateway. Rewritten when it carries this marker. */
const MANAGED_MARKER = '# Managed by Kingu (Chyle runtime).';

export function chyleProviderFile(gatewayPort: number): string {
	return [
		MANAGED_MARKER,
		'# Chyle 1, Arkai\'s model, served by the local Ollama through Chyle\'s gateway,',
		'# which turns tool calls the model writes as text into real ones.',
		'providers:',
		'  chyle:',
		`    baseUrl: http://127.0.0.1:${gatewayPort}/v1`,
		'    auth: none',
		'    api: openai-completions',
		'    models:',
		`      - id: ${CHYLE_MODEL_ID}`,
		'        name: Chyle 1',
		'        reasoning: false',
		'        input: [text]',
		'        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }',
		'        contextWindow: 16384',
		'        maxTokens: 8192',
		'',
	].join('\n');
}

async function answers(url: string, timeoutMs = 1500): Promise<boolean> {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
		return response.ok;
	} catch {
		return false;
	}
}

async function readMachineConfig(): Promise<IChyleMachineConfig> {
	try {
		return JSON.parse(await fs.readFile(join(homedir(), '.arkai', 'chyle.json'), 'utf8')) as IChyleMachineConfig;
	} catch {
		return {};
	}
}

/** The Ollama executable: on PATH, or where its Windows installer puts it. */
function findOllama(): string | undefined {
	const names = process.platform === 'win32' ? ['ollama.exe'] : ['ollama'];
	for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)) {
		for (const name of names) {
			if (existsSync(join(dir, name))) {
				return join(dir, name);
			}
		}
	}
	const installed = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe') : undefined;
	return installed && existsSync(installed) ? installed : undefined;
}

async function ensureOllama(log: ILogService): Promise<boolean> {
	if (await answers(`${OLLAMA_URL}/api/version`)) {
		return true;
	}
	const executable = findOllama();
	if (!executable) {
		log.info('[Chyle] Ollama is not installed; Arkai runs on the user\'s other models');
		return false;
	}
	const config = await readMachineConfig();
	const env = { ...process.env };
	if (config.ollamaModels) {
		env.OLLAMA_MODELS = config.ollamaModels;
	} else if (env.OLLAMA_MODELS && !existsSync(env.OLLAMA_MODELS)) {
		// A models directory that does not exist makes `ollama serve` exit at once.
		delete env.OLLAMA_MODELS;
	}
	// Keep Chyle loaded between questions (Ollama's default is five minutes), unless the user chose otherwise.
	env.OLLAMA_KEEP_ALIVE ??= CHYLE_KEEP_ALIVE;
	// Flash attention and an 8-bit KV cache halve the context's memory, so more
	// of Chyle's layers fit on a small GPU (6 GB here) and it answers faster;
	// unless the user chose otherwise.
	env.OLLAMA_FLASH_ATTENTION ??= '1';
	env.OLLAMA_KV_CACHE_TYPE ??= 'q8_0';
	log.info(`[Chyle] starting Ollama: ${executable} serve${env.OLLAMA_MODELS ? ` (models in ${env.OLLAMA_MODELS})` : ''}`);
	// Started in its own directory: it outlives Kingu, and a working directory
	// inside Kingu's install would keep that folder from being replaced.
	const child = spawn(executable, ['serve'], { cwd: dirname(executable), env, detached: true, stdio: 'ignore', windowsHide: true });
	child.on('error', error => log.warn(`[Chyle] could not start Ollama: ${error.message}`));
	child.unref();
	// It can take a minute to answer, with its models on a slow (external) drive.
	const deadline = Date.now() + 3 * 60 * 1000;
	while (Date.now() < deadline) {
		if (await answers(`${OLLAMA_URL}/api/version`)) {
			log.info('[Chyle] Ollama is up');
			return true;
		}
		await new Promise(resolve => setTimeout(resolve, 1000));
	}
	log.warn('[Chyle] Ollama did not answer within 3 minutes of starting it');
	return false;
}

/**
 * Chyle's use today, `~/.arkai/usage.json`: what the Arkai status shows, since
 * a local model has no account or limit to read one from.
 * `{ "date": "YYYY-MM-DD", "promptTokens", "completionTokens", "requests" }`,
 * started over each day.
 */
export const CHYLE_USAGE_FILE = join(homedir(), '.arkai', 'usage.json');

interface IChyleDailyUsage {
	readonly date: string;
	readonly promptTokens: number;
	readonly completionTokens: number;
	readonly requests: number;
}

let usageWrites: Promise<void> = Promise.resolve();

/** `YYYY-MM-DD` in local time, as "today" means to the user. */
export function localDate(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Adds a request's tokens to today's total; writes one at a time. */
function recordUsage(usage: IChyleUsage): Promise<void> {
	usageWrites = usageWrites.catch(() => undefined).then(async () => {
		const today = localDate(new Date());
		let current: IChyleDailyUsage | undefined;
		try {
			current = JSON.parse(await fs.readFile(CHYLE_USAGE_FILE, 'utf8')) as IChyleDailyUsage;
		} catch {
			current = undefined;
		}
		const base = current?.date === today ? current : { date: today, promptTokens: 0, completionTokens: 0, requests: 0 };
		const next: IChyleDailyUsage = {
			date: today,
			promptTokens: base.promptTokens + usage.promptTokens,
			completionTokens: base.completionTokens + usage.completionTokens,
			requests: base.requests + 1,
		};
		await fs.mkdir(dirname(CHYLE_USAGE_FILE), { recursive: true });
		await fs.writeFile(CHYLE_USAGE_FILE, JSON.stringify(next), 'utf8');
	});
	return usageWrites;
}

async function ensureGateway(ollama: Promise<boolean>, log: ILogService): Promise<IChyleGateway | undefined> {
	try {
		const gateway = await startChyleGateway(OLLAMA_URL, CHYLE_GATEWAY_PORT, {
			onRepair: (model, count) => log.info(`[Chyle] gateway recovered ${count} tool call(s) ${model} wrote as text`),
			upstreamReady: () => ollama,
			onUsage: usage => { void recordUsage(usage).catch(error => log.trace(`[Chyle] could not record usage: ${error instanceof Error ? error.message : String(error)}`)); },
		});
		log.info(`[Chyle] gateway on http://127.0.0.1:${gateway.port} -> ${OLLAMA_URL}`);
		return gateway;
	} catch (error) {
		// Another Kingu window's agent host already runs it; that one serves this one too.
		if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
			log.info(`[Chyle] gateway already running on port ${CHYLE_GATEWAY_PORT}`);
		} else {
			log.warn(`[Chyle] could not start the gateway: ${error instanceof Error ? error.message : String(error)}`);
		}
		return undefined;
	}
}

/** Points Arkai's provider file at the gateway, unless the user wrote their own. */
async function ensureProviderFile(agentDir: string, log: ILogService): Promise<void> {
	const file = join(agentDir, 'models.yml');
	let current: string | undefined;
	try {
		current = await fs.readFile(file, 'utf8');
	} catch {
		current = undefined;
	}
	const wanted = chyleProviderFile(CHYLE_GATEWAY_PORT);
	if (current === wanted || (current !== undefined && !current.startsWith(MANAGED_MARKER))) {
		return;
	}
	await fs.mkdir(dirname(file), { recursive: true });
	await fs.writeFile(file, wanted, 'utf8');
	log.info(`[Chyle] wrote ${file}`);
}

/**
 * Loads Chyle before the first question: loading a 20 GB model from disk is
 * most of the wait on the first answer. An empty generate request loads it
 * and answers nothing; the keep-alive holds it there between questions.
 */
async function warmChyle(log: ILogService): Promise<void> {
	const started = Date.now();
	try {
		const response = await fetch(`${OLLAMA_URL}/api/generate`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: CHYLE_MODEL_ID, keep_alive: CHYLE_KEEP_ALIVE }),
		});
		await response.text();
		log.info(response.ok
			? `[Chyle] ${CHYLE_MODEL_ID} loaded in ${Math.round((Date.now() - started) / 1000)}s; kept for ${CHYLE_KEEP_ALIVE}`
			: `[Chyle] could not load ${CHYLE_MODEL_ID}: HTTP ${response.status}`);
	} catch (error) {
		log.warn(`[Chyle] could not load ${CHYLE_MODEL_ID}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

let running: Promise<IChyleGateway | undefined> | undefined;
let localChyle: Promise<boolean> | undefined;

/**
 * Starts Ollama if it is not running and loads Chyle, once per process: the
 * IDE's own uses of the local models (completions, inline chat, semantic
 * search) need them as much as an Arkai session does, and would otherwise
 * find nothing until one had started. Resolves whether Ollama is up; Chyle
 * goes on loading in the background.
 */
export function ensureLocalChyle(log: ILogService): Promise<boolean> {
	localChyle ??= (async () => {
		const up = await ensureOllama(log).catch(error => {
			log.warn(`[Chyle] could not start Ollama: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		});
		if (up) {
			void warmChyle(log);
		} else {
			localChyle = undefined; // Installed or started later: try again next time.
		}
		return up;
	})();
	return localChyle;
}

/**
 * Brings Chyle up once per agent host: Arkai's provider file in `agentDir`
 * and the gateway, then Ollama in the background. Resolves once the first
 * two are ready, which is all listing Arkai's models needs; Ollama can take a
 * minute to answer, and the gateway holds requests until it does.
 */
export function ensureChyleRuntime(agentDir: string, log: ILogService): Promise<IChyleGateway | undefined> {
	running ??= (async () => {
		await ensureProviderFile(agentDir, log).catch(error => log.warn(`[Chyle] could not write the provider file: ${error instanceof Error ? error.message : String(error)}`));
		return ensureGateway(ensureLocalChyle(log), log);
	})();
	return running;
}
