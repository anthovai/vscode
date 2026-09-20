/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * What an agent may ask about the desktop.
 *
 * Only the four that read. The runtime this talks to is the ADE's own, and it
 * can also click, type, paste and press keys — so the list is enforced here, in
 * TypeScript, before a request reaches it. A capability that exists in the
 * script and is unreachable from the host is a deliberate arrangement: the
 * acting half is a separate, later decision, and until it is made there is no
 * path to it.
 */
export const KINGU_COMPUTER_READ_TOOLS = ['handshake', 'list_apps', 'list_windows', 'get_app_state'] as const;

export type KinguComputerReadTool = typeof KINGU_COMPUTER_READ_TOOLS[number];

export function isReadOnlyComputerTool(tool: string): tool is KinguComputerReadTool {
	return (KINGU_COMPUTER_READ_TOOLS as readonly string[]).includes(tool);
}

/** One request to the runtime. */
export interface IKinguComputerRequest {
	readonly tool: KinguComputerReadTool;
	/** The application to look at, by name. Absent for tools that take none. */
	readonly app?: string;
	/** A specific window of that application, when one is meant. */
	readonly windowId?: string;
	readonly windowIndex?: number;
	/**
	 * Whether the reply should carry a screenshot.
	 *
	 * Off by default. A snapshot is an accessibility tree, which is what an
	 * agent can actually act on; the image is megabytes of base64 that has to
	 * cross two process boundaries, and it is only worth it when something is
	 * going to look at it.
	 */
	readonly includeScreenshot?: boolean;
}

/** What the runtime replied. */
export type KinguComputerResult =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly error: string };

/**
 * The line to send, with the id the reply must echo.
 *
 * The runtime answers out of order and a reply that cannot be matched is a
 * desynchronised stream rather than a usable answer, so every request carries
 * one and every reply is checked against it.
 */
export function encodeComputerRequest(requestId: number, request: IKinguComputerRequest): string {
	return JSON.stringify({
		requestId,
		tool: request.tool,
		...(request.app === undefined ? {} : { app: request.app }),
		...(request.windowId === undefined ? {} : { windowId: request.windowId }),
		...(request.windowIndex === undefined ? {} : { windowIndex: request.windowIndex }),
		// The runtime's flag is the negative one; this is the only place that
		// difference exists, so it is converted here rather than leaked outward.
		noScreenshot: !request.includeScreenshot,
	});
}

/** A reply line, or `undefined` when the line is not one. */
export function decodeComputerReply(line: string): { requestId: number; result: KinguComputerResult } | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		// The runtime writes diagnostics to stderr, but a stray line on stdout is
		// not worth killing a session over.
		return undefined;
	}
	if (!parsed || typeof parsed !== 'object') {
		return undefined;
	}
	const reply = parsed as { requestId?: unknown; ok?: unknown; error?: unknown };
	if (typeof reply.requestId !== 'number') {
		return undefined;
	}
	if (reply.ok === true) {
		return { requestId: reply.requestId, result: { ok: true, value: parsed } };
	}
	return {
		requestId: reply.requestId,
		result: { ok: false, error: typeof reply.error === 'string' && reply.error ? reply.error : 'The desktop runtime reported an unspecified failure.' },
	};
}

/**
 * Splits a stream of stdout chunks into lines.
 *
 * A reply carrying a screenshot runs to megabytes and arrives in many chunks,
 * so a parser that assumed one chunk was one line would see fragments of JSON
 * and discard every large answer.
 */
export class KinguComputerLineReader {

	private _buffer = '';

	constructor(private readonly _maxBufferBytes = 64 * 1024 * 1024) { }

	/** The complete lines in `chunk`, with any partial tail kept for next time. */
	read(chunk: string): string[] {
		this._buffer += chunk;
		if (this._buffer.length > this._maxBufferBytes) {
			// A runtime that never emits a newline would otherwise grow until the
			// process died. Dropping the buffer costs the answer in flight, which
			// the caller's timeout already covers.
			this._buffer = '';
			return [];
		}
		const lines = this._buffer.split('\n');
		this._buffer = lines.pop() ?? '';
		return lines.map(line => line.trim()).filter(Boolean);
	}
}
