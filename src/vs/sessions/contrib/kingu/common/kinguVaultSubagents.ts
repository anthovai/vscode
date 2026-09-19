/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';

/**
 * A task an agent handed to a worker of its own, as the worker's transcript
 * records it.
 *
 * Claude writes these beside the parent transcript rather than inside it, so
 * they are a separate file with a separate history — and they survive even when
 * the parent conversation persisted no turns at all, which makes them the only
 * recoverable trace of what such a session actually did.
 */
export interface IKinguSubagentDescriptor {
	/** The kind of worker, as the parent named it — "Explore", "Plan", … */
	readonly agentType: string | undefined;
	/** What the parent asked the worker to do. */
	readonly description: string | undefined;
	/** How deep in a chain of workers spawning workers this one sits. */
	readonly spawnDepth: number | undefined;
}

/**
 * Where a transcript's subagent transcripts live.
 *
 * `…/<project>/<id>.jsonl` → `…/<project>/<id>/subagents/`. Derived from the
 * parent's own path rather than looked up, which is also what lets the scanner
 * prune the subtree using the same rule that finds it: the prune and the lookup
 * cannot drift apart.
 */
export function subagentsDirectoryFor(transcriptPath: string): string | undefined {
	const dot = transcriptPath.lastIndexOf('.');
	const slash = Math.max(transcriptPath.lastIndexOf('/'), transcriptPath.lastIndexOf('\\'));
	if (dot <= slash) {
		return undefined;
	}
	return `${transcriptPath.slice(0, dot)}/${SUBAGENT_DIRECTORY_NAME}`;
}

/** The directory name, shared with the scanner's prune rule. */
export const SUBAGENT_DIRECTORY_NAME = 'subagents';

/** The sidecar describing one subagent transcript, beside the transcript itself. */
export function subagentMetaPathFor(transcriptPath: string): string | undefined {
	return transcriptPath.endsWith('.jsonl')
		? `${transcriptPath.slice(0, -'.jsonl'.length)}.meta.json`
		: undefined;
}

/** Whether a file in a subagents directory is a transcript rather than a sidecar. */
export function isSubagentTranscriptName(name: string): boolean {
	return name.endsWith('.jsonl');
}

/** Reads the sidecar, or an empty descriptor when it says nothing usable. */
export function readSubagentMeta(content: string): IKinguSubagentDescriptor {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return { agentType: undefined, description: undefined, spawnDepth: undefined };
	}
	const meta = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
	const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
	return {
		agentType: text(meta.agentType),
		description: text(meta.description),
		spawnDepth: typeof meta.spawnDepth === 'number' && Number.isFinite(meta.spawnDepth) ? meta.spawnDepth : undefined,
	};
}

/**
 * What to call a subagent in a list.
 *
 * The sidecar is preferred over anything in the transcript: the parent wrote it
 * to say what it was delegating, which is a better answer than the opening line
 * of the instructions it then handed over.
 */
export function subagentTitle(meta: IKinguSubagentDescriptor, promptFallback: string | undefined, nameFallback: string): string {
	if (meta.agentType && meta.description) {
		return localize('kingu.vault.subagent.typed', "{0}: {1}", meta.agentType, meta.description);
	}
	return meta.description ?? meta.agentType ?? promptFallback ?? nameFallback;
}
