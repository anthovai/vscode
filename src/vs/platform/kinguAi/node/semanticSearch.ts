/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { Dirent, promises as fs, Stats } from 'fs';
import { extname, join, relative } from '../../../base/common/path.js';
import {
	bestLine,
	chunkEmbeddingText,
	chunkText,
	dot,
	IKinguSemanticHit,
	IKinguSemanticSearchRequest,
	IKinguSemanticSearchResult,
	IKinguTextChunk,
	normalize,
	pickEmbeddingModel,
} from '../common/kinguSemanticSearch.js';

const OLLAMA_URL = 'http://127.0.0.1:11434';
const EMBED_BATCH = 32;
const MAX_FILES = 3000;
const MAX_FILE_BYTES = 256 * 1024;
/** Below this a chunk is not related enough to show. */
const MIN_SCORE = 0.35;
const DEFAULT_MAX_RESULTS = 20;
/** How long a search waits for the index before ranking what it has. */
const SEARCH_WAIT_MS = 5_000;
/** A long first index is saved as it goes, so closing Kingu keeps the work done. */
const SAVE_EVERY_MS = 30_000;

/** Text worth searching by meaning; the rest (images, archives, builds) is left out. */
const TEXT_EXTENSIONS = new Set([
	'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.py', '.php', '.go', '.rs', '.java', '.kt', '.cs', '.rb', '.swift', '.c', '.h', '.cpp', '.hpp',
	'.md', '.mdx', '.txt', '.json', '.yml', '.yaml', '.toml', '.ini', '.env', '.xml', '.html', '.css', '.scss', '.less', '.sql', '.sh', '.ps1', '.bat', '.graphql', '.proto',
]);
const SKIPPED_NAMES = /(^|[\\/])(node_modules|\.git|dist|build|out|vendor|\.next|coverage|storage[\\/]framework)([\\/]|$)|(\.min\.(js|css)|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock)$/i;

interface IIndexedFile {
	readonly mtime: number;
	readonly size: number;
	readonly chunks: readonly { readonly startLine: number; readonly lines: readonly string[]; readonly vector: Float32Array }[];
}

interface IFolderIndex {
	model: string;
	files: Map<string, IIndexedFile>;
}

/** On disk: vectors as base64 so the file stays a single JSON document. */
interface IStoredIndex {
	readonly model: string;
	readonly files: Record<string, { mtime: number; size: number; chunks: { startLine: number; lines: string[]; vector: string }[] }>;
}

function run(command: string, args: readonly string[], cwd: string): Promise<string | undefined> {
	return new Promise(resolve => {
		let out = '';
		const child = spawn(command, [...args], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
		child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
		child.on('error', () => resolve(undefined));
		child.on('close', code => resolve(code === 0 ? out : undefined));
	});
}

/** The folder's files as git sees them (tracked and new, not ignored), else a walk that skips builds and dependencies. */
async function listFiles(folder: string): Promise<string[]> {
	const fromGit = await run('git', ['ls-files', '-co', '--exclude-standard', '-z'], folder);
	const relativePaths = fromGit !== undefined
		? fromGit.split('\0').filter(Boolean)
		: await walk(folder);
	return relativePaths
		.filter(path => TEXT_EXTENSIONS.has(extname(path).toLowerCase()) && !SKIPPED_NAMES.test(path))
		.slice(0, MAX_FILES);
}

async function walk(root: string, dir = root, found: string[] = []): Promise<string[]> {
	if (found.length >= MAX_FILES) {
		return found;
	}
	let entries: Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return found;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		const rel = relative(root, path);
		if (SKIPPED_NAMES.test(rel)) {
			continue;
		}
		if (entry.isDirectory()) {
			await walk(root, path, found);
		} else if (entry.isFile()) {
			found.push(rel);
		}
	}
	return found;
}

async function embeddingModel(): Promise<string | undefined> {
	try {
		const response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3_000) });
		const tags = await response.json() as { models?: { name?: unknown }[] };
		return pickEmbeddingModel((tags.models ?? []).map(model => model.name).filter((name): name is string => typeof name === 'string'));
	} catch {
		return undefined;
	}
}

/**
 * How many of the embedder's layers go on the GPU. Left to Ollama, bge-m3
 * takes the whole GPU and unloads Chyle, whose next answer then waits minutes
 * for it to load again; on the CPU alone it indexes 27× slower (166 s against
 * 6 s for 8 chunks on an RTX 3050 6 GB). Half of bge-m3's 24 layers (~0.4 GB)
 * fit beside Chyle.
 */
const EMBEDDER_GPU_LAYERS = 12;

async function embed(model: string, inputs: readonly string[]): Promise<Float32Array[]> {
	const response = await fetch(`${OLLAMA_URL}/api/embed`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		// Kept loaded a while: loading it again takes most of a minute.
		body: JSON.stringify({ model, input: inputs, keep_alive: '30m', options: { num_gpu: EMBEDDER_GPU_LAYERS } }),
		signal: AbortSignal.timeout(300_000),
	});
	const reply = await response.json() as { embeddings?: number[][]; error?: string };
	if (!response.ok || !reply.embeddings) {
		throw new Error(reply.error ?? `Ollama answered ${response.status}`);
	}
	return reply.embeddings.map(normalize);
}

function toBase64(vector: Float32Array): string {
	return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64');
}

function fromBase64(text: string): Float32Array {
	const bytes = Buffer.from(text, 'base64');
	return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/**
 * The workspace's meaning index, kept per folder in `cacheDir` and brought up
 * to date on each search: only files that changed since are embedded again.
 */
export class KinguSemanticSearch {

	private readonly _indexes = new Map<string, IFolderIndex>();
	private readonly _updating = new Map<string, Promise<IFolderIndex>>();
	private readonly _progress = new Map<string, { done: number; total: number }>();

	constructor(private readonly _cacheDir: string) { }

	/**
	 * Ranks what the index holds after at most a few seconds: a first index of
	 * a large workspace takes minutes on a laptop GPU, so it goes on in the
	 * background (recently changed files first) and each later search finds
	 * more; the result says how far it has come.
	 */
	async search(request: IKinguSemanticSearchRequest): Promise<IKinguSemanticSearchResult> {
		const query = request.query.trim();
		if (!query || request.folders.length === 0) {
			return { hits: [] };
		}
		const model = await embeddingModel();
		if (!model) {
			return { hits: [], error: 'Search by meaning needs Ollama running with an embedding model (bge-m3): `ollama pull bge-m3`.' };
		}
		try {
			const updates = request.folders.map(folder => this._update(folder, model));
			await Promise.race([Promise.all(updates), new Promise(resolve => setTimeout(resolve, SEARCH_WAIT_MS))]);
			const [queryVector] = await embed(model, [query]);
			const hits: IKinguSemanticHit[] = [];
			request.folders.forEach(folder => {
				for (const [rel, file] of this._indexes.get(folder)?.files ?? []) {
					for (const chunk of file.chunks) {
						const score = dot(queryVector, chunk.vector);
						if (score >= MIN_SCORE) {
							const { line, text } = bestLine(chunk, query);
							hits.push({ file: join(folder, rel), line, text, score });
						}
					}
				}
			});
			hits.sort((a, b) => b.score - a.score);
			const progress = request.folders.map(folder => this._progress.get(folder)).filter((entry): entry is { done: number; total: number } => !!entry);
			const indexing = progress.length
				? { done: progress.reduce((sum, entry) => sum + entry.done, 0), total: progress.reduce((sum, entry) => sum + entry.total, 0) }
				: undefined;
			return { hits: hits.slice(0, request.maxResults ?? DEFAULT_MAX_RESULTS), model, indexing };
		} catch (error) {
			return { hits: [], model, error: error instanceof Error ? error.message : String(error) };
		}
	}

	private _update(folder: string, model: string): Promise<IFolderIndex> {
		let pending = this._updating.get(folder);
		if (!pending) {
			pending = this._doUpdate(folder, model).finally(() => {
				this._updating.delete(folder);
				this._progress.delete(folder);
			});
			this._updating.set(folder, pending);
		}
		return pending;
	}

	private async _doUpdate(folder: string, model: string): Promise<IFolderIndex> {
		let index = this._indexes.get(folder) ?? await this._load(folder);
		if (!index || index.model !== model) {
			index = { model, files: new Map() };
		}
		this._indexes.set(folder, index);

		const files = await listFiles(folder);
		const present = new Set(files);
		let unsaved = false;
		for (const rel of [...index.files.keys()]) {
			if (!present.has(rel)) {
				index.files.delete(rel);
				unsaved = true;
			}
		}

		// Files new or changed since they were embedded; the latest work first.
		const pending: { rel: string; mtime: number; size: number }[] = [];
		for (const rel of files) {
			let stat: Stats;
			try {
				stat = await fs.stat(join(folder, rel));
			} catch {
				continue;
			}
			const known = index.files.get(rel);
			if (stat.size <= MAX_FILE_BYTES && !(known && known.mtime === stat.mtimeMs && known.size === stat.size)) {
				pending.push({ rel, mtime: stat.mtimeMs, size: stat.size });
			}
		}
		pending.sort((a, b) => b.mtime - a.mtime);
		const progress = { done: 0, total: pending.length };
		if (pending.length) {
			this._progress.set(folder, progress);
		}

		// Chunks from several files make a batch; a file joins the index once all its chunks are in.
		let lastSave = Date.now();
		let queue: { rel: string; mtime: number; size: number; chunk: IKinguTextChunk; slot: Float32Array[] }[] = [];
		const flush = async () => {
			if (!queue.length) {
				return;
			}
			const batch = queue;
			queue = [];
			const vectors = await embed(model, batch.map(item => chunkEmbeddingText(item.rel, item.chunk)));
			batch.forEach((item, i) => {
				item.slot.push(vectors[i]);
			});
		};
		for (const file of pending) {
			const text = await fs.readFile(join(folder, file.rel), 'utf8').catch(() => undefined);
			if (text !== undefined && !text.includes('\0')) {
				const chunks = chunkText(text);
				const slot: Float32Array[] = [];
				for (const chunk of chunks) {
					queue.push({ ...file, chunk, slot });
					if (queue.length >= EMBED_BATCH) {
						await flush();
					}
				}
				await flush();
				index.files.set(file.rel, {
					mtime: file.mtime,
					size: file.size,
					chunks: chunks.map((chunk, i) => ({ startLine: chunk.startLine, lines: chunk.lines, vector: slot[i] })),
				});
				unsaved = true;
			}
			progress.done++;
			if (unsaved && Date.now() - lastSave > SAVE_EVERY_MS) {
				await this._save(folder, index);
				unsaved = false;
				lastSave = Date.now();
			}
		}
		if (unsaved) {
			await this._save(folder, index);
		}
		return index;
	}

	private _path(folder: string): string {
		return join(this._cacheDir, `${createHash('sha1').update(folder.toLowerCase()).digest('hex')}.json`);
	}

	private async _load(folder: string): Promise<IFolderIndex | undefined> {
		try {
			const stored = JSON.parse(await fs.readFile(this._path(folder), 'utf8')) as IStoredIndex;
			const files = new Map<string, IIndexedFile>();
			for (const [rel, file] of Object.entries(stored.files)) {
				files.set(rel, { mtime: file.mtime, size: file.size, chunks: file.chunks.map(chunk => ({ startLine: chunk.startLine, lines: chunk.lines, vector: fromBase64(chunk.vector) })) });
			}
			return { model: stored.model, files };
		} catch {
			return undefined;
		}
	}

	private async _save(folder: string, index: IFolderIndex): Promise<void> {
		const stored: IStoredIndex = {
			model: index.model,
			files: Object.fromEntries([...index.files].map(([rel, file]) => [rel, {
				mtime: file.mtime,
				size: file.size,
				chunks: file.chunks.map(chunk => ({ startLine: chunk.startLine, lines: [...chunk.lines], vector: toBase64(chunk.vector) })),
			}])),
		};
		await fs.mkdir(this._cacheDir, { recursive: true });
		await fs.writeFile(this._path(folder), JSON.stringify(stored), 'utf8');
	}
}
