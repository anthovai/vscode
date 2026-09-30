/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Search by meaning, for the Search view's AI results: the workspace's text,
 * in overlapping chunks, embedded by a model on the user's own Ollama
 * (bge-m3, which reads Thai as well as English), and ranked against the
 * query's embedding. Nothing leaves the machine.
 */

/** What the Search view asks the main process for. */
export interface IKinguSemanticSearchRequest {
	/** The workspace folders to search, as file system paths. */
	readonly folders: readonly string[];
	readonly query: string;
	readonly maxResults?: number;
}

export interface IKinguSemanticHit {
	/** Absolute path. */
	readonly file: string;
	/** 0-based line of the chunk's most relevant line. */
	readonly line: number;
	/** That line's text. */
	readonly text: string;
	/** Cosine similarity, 0 to 1. */
	readonly score: number;
}

export interface IKinguSemanticSearchResult {
	readonly hits: readonly IKinguSemanticHit[];
	/** The embedding model used, for the section's name. */
	readonly model?: string;
	/** Why there are no hits, when it is not that nothing matched. */
	readonly error?: string;
	/** While the index is still being built: files done, of how many. */
	readonly indexing?: { readonly done: number; readonly total: number };
}

/** A piece of a file, the unit that is embedded and ranked. */
export interface IKinguTextChunk {
	/** 0-based first line. */
	readonly startLine: number;
	readonly lines: readonly string[];
}

const CHUNK_LINES = 60;
const CHUNK_STEP = 50;
const MAX_CHUNK_CHARS = 1500;

/**
 * `text` in windows of 60 lines, 10 shared with the next, so a passage cut at
 * a boundary is still whole in one chunk. Blank chunks are left out.
 */
export function chunkText(text: string): IKinguTextChunk[] {
	const lines = text.split(/\r?\n/);
	const chunks: IKinguTextChunk[] = [];
	for (let start = 0; start < lines.length; start += CHUNK_STEP) {
		const window = lines.slice(start, start + CHUNK_LINES);
		if (window.some(line => line.trim())) {
			chunks.push({ startLine: start, lines: window });
		}
		if (start + CHUNK_LINES >= lines.length) {
			break;
		}
	}
	return chunks;
}

/**
 * What is embedded for a chunk: its path first, so a file's name counts
 * towards what it is about, then the text, cut to what the model reads well.
 */
export function chunkEmbeddingText(relativePath: string, chunk: IKinguTextChunk): string {
	return `${relativePath}\n${chunk.lines.join('\n')}`.slice(0, MAX_CHUNK_CHARS);
}

/** Lines that open a file rather than say what it does. */
const BOILERPLATE = /^(<\?php|namespace\s|use\s|import\s|package\s|#include|'use strict'|"use strict"|\/\/|\/\*|\*)/;

/** The line of a chunk to show and jump to: the one sharing most words with the query, else the first that says something. */
export function bestLine(chunk: IKinguTextChunk, query: string): { readonly line: number; readonly text: string } {
	const words = query.toLowerCase().split(/[\s_\-.]+/).filter(word => word.length > 1);
	let best = -1;
	let bestCount = 0;
	chunk.lines.forEach((line, index) => {
		const lower = line.toLowerCase();
		const count = words.filter(word => lower.includes(word)).length;
		if (count > bestCount) {
			best = index;
			bestCount = count;
		}
	});
	if (best < 0) {
		// No shared word (a Thai query over English code, say): the first line that says something.
		const says = chunk.lines.findIndex(line => /\p{L}/u.test(line) && line.trim().length >= 12 && !BOILERPLATE.test(line.trim()));
		best = says >= 0 ? says : Math.max(0, chunk.lines.findIndex(line => line.trim()));
	}
	return { line: chunk.startLine + best, text: chunk.lines[best]?.trim() ?? '' };
}

/** `vector` scaled to length 1, so a dot product is its cosine. */
export function normalize(vector: readonly number[]): Float32Array {
	const out = Float32Array.from(vector);
	const length = Math.hypot(...out) || 1;
	for (let i = 0; i < out.length; i++) {
		out[i] /= length;
	}
	return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < a.length && i < b.length; i++) {
		sum += a[i] * b[i];
	}
	return sum;
}

/** The embedding models Kingu looks for on Ollama, best first. */
export const EMBEDDING_MODEL_PREFERENCE = ['bge-m3', 'nomic-embed-text', 'mxbai-embed-large', 'snowflake-arctic-embed'];

/** The installed model to embed with, by the preference above, else any whose name says it embeds. */
export function pickEmbeddingModel(installed: readonly string[]): string | undefined {
	for (const preferred of EMBEDDING_MODEL_PREFERENCE) {
		const found = installed.find(name => name === preferred || name.startsWith(`${preferred}:`));
		if (found) {
			return found;
		}
	}
	return installed.find(name => /embed/i.test(name));
}
