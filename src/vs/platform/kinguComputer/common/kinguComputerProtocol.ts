/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * What may be asked about the desktop without changing it.
 *
 * Always allowed. Reading which windows exist is the half that makes an agent
 * useful and cannot, by itself, do anything to the machine.
 */
export const KINGU_COMPUTER_READ_TOOLS = ['handshake', 'list_apps', 'list_windows', 'get_app_state'] as const;

/**
 * What changes the desktop.
 *
 * Every one of these is somebody's hands on the machine: a click can accept a
 * dialog, a keystroke can go into whatever holds focus, a paste puts text on
 * the clipboard first. They are listed apart from the reads because the
 * difference between the two lists is the entire safety property here — the
 * host refuses this list unless it was explicitly, separately permitted.
 */
export const KINGU_COMPUTER_INPUT_TOOLS = [
	'click', 'perform_secondary_action', 'scroll', 'drag',
	'type_text', 'press_key', 'hotkey', 'paste_text', 'set_value',
] as const;

export type KinguComputerReadTool = typeof KINGU_COMPUTER_READ_TOOLS[number];
export type KinguComputerInputTool = typeof KINGU_COMPUTER_INPUT_TOOLS[number];
export type KinguComputerTool = KinguComputerReadTool | KinguComputerInputTool;

export function isReadOnlyComputerTool(tool: string): tool is KinguComputerReadTool {
	return (KINGU_COMPUTER_READ_TOOLS as readonly string[]).includes(tool);
}

export function isInputComputerTool(tool: string): tool is KinguComputerInputTool {
	return (KINGU_COMPUTER_INPUT_TOOLS as readonly string[]).includes(tool);
}

/**
 * Whether this request may be sent, given what was permitted.
 *
 * A tool in neither list is refused rather than passed through: the runtime
 * accepts names this host has never heard of, and forwarding one would mean the
 * gate only covers what it happens to know about.
 */
export function isComputerToolAllowed(tool: string, allowInput: boolean): boolean {
	if (isReadOnlyComputerTool(tool)) {
		return true;
	}
	return allowInput && isInputComputerTool(tool);
}

/**
 * What an action will do, in a sentence a person can refuse.
 *
 * Built from the request rather than from the runtime's own reply, because it
 * has to be shown *before* the action happens. The text it will type is quoted
 * in full: an agent asking to type something into another application is
 * exactly the moment where a summary would hide the thing worth seeing.
 */
export function describeComputerAction(request: IKinguComputerRequest): string {
	const where = request.app ? ` in ${request.app}` : '';
	switch (request.tool) {
		case 'click': return `Click${where}`;
		case 'perform_secondary_action': return `Right-click${where}`;
		case 'scroll': return `Scroll${where}`;
		case 'drag': return `Drag${where}`;
		case 'type_text': return `Type ${JSON.stringify(request.text ?? '')}${where}`;
		case 'paste_text': return `Paste ${JSON.stringify(request.text ?? '')}${where}, via the clipboard`;
		case 'press_key': return `Press ${request.key ?? '?'}${where}`;
		case 'hotkey': return `Press ${request.key ?? '?'}${where}`;
		case 'set_value': return `Set a value to ${JSON.stringify(request.value ?? '')}${where}`;
		default: return `Read${where}`;
	}
}

/**
 * The setting that permits acting on the desktop.
 *
 * Named here so the refusal message and the schema cannot drift apart: a
 * refusal that names a setting which does not exist is worse than one that
 * names none.
 */
export const KINGU_ALLOW_INPUT_SETTING = 'kingu.computerUse.allowInput';

/** One request to the runtime. */
export interface IKinguComputerRequest {
	readonly tool: KinguComputerTool;
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
	/** The element to act on, as `get_app_state` reported it. */
	readonly element?: unknown;
	/** For `type_text` and `paste_text`. */
	readonly text?: string;
	/** For `press_key` and `hotkey`, in the runtime's own notation. */
	readonly key?: string;
	/** For `set_value`. */
	readonly value?: string;
	/** For `click`: `left` unless stated. */
	readonly mouseButton?: 'left' | 'right' | 'middle';
	readonly clickCount?: number;
	/**
	 * Bring the target window to the front before acting.
	 *
	 * The runtime refuses keyboard input to a window that does not have focus,
	 * and it is right to: keystrokes go wherever focus is, so typing at an
	 * unfocused window means typing into whatever the user was actually using.
	 * Acting therefore has to take focus, which is a visible thing to do and is
	 * why the confirmation says so.
	 */
	readonly restoreWindow?: boolean;
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
		...(request.element === undefined ? {} : { element: request.element }),
		...(request.text === undefined ? {} : { text: request.text }),
		...(request.key === undefined ? {} : { key: request.key }),
		...(request.value === undefined ? {} : { value: request.value }),
		// The runtime's own spellings, which are snake_case on the wire.
		...(request.mouseButton === undefined ? {} : { mouse_button: request.mouseButton }),
		...(request.clickCount === undefined ? {} : { click_count: request.clickCount }),
		...(request.restoreWindow === undefined ? {} : { restoreWindow: request.restoreWindow }),
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
