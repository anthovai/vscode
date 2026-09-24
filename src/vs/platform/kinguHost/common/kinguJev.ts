/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * TypeSafe's Jev, a "System One" decision model: given a state and typed
 * questions it answers each with a choice, a score or a yes/no probability,
 * with calibrated confidence, in one forward pass. It writes no text.
 *
 * `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`,
 * body `{ state, model, questions: { [key]: { type, instructions, criteria } } }`,
 * answers `{ model, answers: { [key]: { type, choice | score | probability,
 * probabilities, confidence } }, usage }`.
 */
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_DEFAULT_MODEL = 'jev-latest';

/** The budget the API allows for the state and every question together, in tokens; the state is kept well under it. */
export const JEV_MAX_STATE_CHARS = 12_000;

export type JevQuestion =
	| { readonly type: 'choice'; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> }
	| { readonly type: 'score'; readonly instructions: string; readonly criteria: readonly string[] }
	| { readonly type: 'noul'; readonly instructions: string };

export interface IJevRequest {
	readonly state: string;
	readonly model?: string;
	/** Another address serving the same endpoint (a gateway, a proxy); the official one when absent. */
	readonly endpoint?: string;
	readonly questions: Readonly<Record<string, JevQuestion>>;
}

export type JevAnswer =
	| { readonly type: 'choice'; readonly choice: string; readonly confidence: number; readonly probabilities: Readonly<Record<string, number>> }
	| { readonly type: 'score'; readonly score: number; readonly confidence: number; readonly probabilities: Readonly<Record<string, number>> }
	| { readonly type: 'noul'; readonly probability: number; readonly confidence: number };

export type JevResult =
	| { readonly ok: true; readonly model: string; readonly answers: Readonly<Record<string, JevAnswer>> }
	| { readonly ok: false; readonly problem: 'no-key' | 'unauthorized' | 'rate-limited' | 'unavailable' | 'invalid' };

/** The body the endpoint takes, the state trimmed to its budget from the end — the latest output is what matters. */
export function jevRequestBody(request: IJevRequest): string {
	const state = request.state.length > JEV_MAX_STATE_CHARS ? request.state.slice(-JEV_MAX_STATE_CHARS) : request.state;
	return JSON.stringify({ state, model: request.model || JEV_DEFAULT_MODEL, questions: request.questions });
}

function isNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function isProbabilities(value: unknown): value is Record<string, number> {
	return !!value && typeof value === 'object' && Object.values(value).every(isNumber);
}

/**
 * The answers from a response body, each checked against its type; an answer
 * of the wrong shape is dropped rather than trusted, and a body with none is
 * `invalid`.
 */
export function parseJevResponse(body: unknown): JevResult {
	if (!body || typeof body !== 'object') {
		return { ok: false, problem: 'invalid' };
	}
	const { model, answers } = body as { model?: unknown; answers?: unknown };
	if (!answers || typeof answers !== 'object') {
		return { ok: false, problem: 'invalid' };
	}
	const parsed: Record<string, JevAnswer> = {};
	for (const [key, raw] of Object.entries(answers as Record<string, unknown>)) {
		if (!raw || typeof raw !== 'object') {
			continue;
		}
		const answer = raw as Record<string, unknown>;
		const confidence = isNumber(answer.confidence) ? answer.confidence : 0;
		if (answer.type === 'choice' && typeof answer.choice === 'string' && isProbabilities(answer.probabilities)) {
			parsed[key] = { type: 'choice', choice: answer.choice, confidence, probabilities: answer.probabilities };
		} else if (answer.type === 'score' && isNumber(answer.score) && isProbabilities(answer.probabilities)) {
			parsed[key] = { type: 'score', score: answer.score, confidence, probabilities: answer.probabilities };
		} else if (answer.type === 'noul' && isNumber(answer.probability)) {
			parsed[key] = { type: 'noul', probability: answer.probability, confidence };
		}
	}
	if (Object.keys(parsed).length === 0) {
		return { ok: false, problem: 'invalid' };
	}
	return { ok: true, model: typeof model === 'string' ? model : '', answers: parsed };
}

/** What an HTTP status means for the caller. */
export function jevProblemForStatus(status: number): 'unauthorized' | 'rate-limited' | 'unavailable' | 'invalid' {
	if (status === 401 || status === 403) {
		return 'unauthorized';
	}
	if (status === 429) {
		return 'rate-limited';
	}
	return status >= 500 ? 'unavailable' : 'invalid';
}

/**
 * The address a request may go to: the official endpoint, any `https:` one, or
 * `http:` on this machine. Anything else is refused, so a key is never sent in
 * the clear across a network.
 */
export function resolveJevEndpoint(endpoint: string | undefined): string | undefined {
	if (!endpoint) {
		return JEV_ENDPOINT;
	}
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return undefined;
	}
	if (url.username || url.password) {
		return undefined;
	}
	if (url.protocol === 'https:') {
		return url.toString();
	}
	return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]') ? url.toString() : undefined;
}
