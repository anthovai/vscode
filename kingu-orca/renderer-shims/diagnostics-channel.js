/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * `diagnostics_channel`, for a renderer that has no Node.
 *
 * `lru-cache` v11 opens a metrics channel and a tracing channel at module
 * evaluation — `channel('lru-cache:metrics')`, `tracingChannel('lru-cache')` —
 * and `@xterm/addon-ligatures` pulls it into the desktop entry. The renderer is
 * sandboxed, so vite resolves the builtin to an empty browser stub and the call
 * throws `(0, x.channel) is not a function`, taking the React tree that touched
 * it with it. It surfaced as a blank onboarding modal.
 *
 * Nothing here is diagnostics we consume. lru-cache guards every publish on
 * `hasSubscribers`, so a channel that never has one costs a boolean check and
 * the library behaves exactly as it does with the real builtin and no listener
 * attached.
 *
 * Deliberately not "make the renderer able to require Node builtins": it is
 * browser-only by design and enforced by `renderer-node-builtin-boundary.test.ts`.
 * That test walks the import graph of the ADE's *own* source, which is why it
 * never saw this one — the builtin came in through a dependency's dependency.
 */

const noopChannel = {
	hasSubscribers: false,
	publish() { },
	subscribe() { },
	unsubscribe() { return false; },
	bindStore() { },
	unbindStore() { },
};

const noopTracingChannel = {
	hasSubscribers: false,
	start: noopChannel,
	end: noopChannel,
	asyncStart: noopChannel,
	asyncEnd: noopChannel,
	error: noopChannel,
	subscribe() { },
	unsubscribe() { return false; },
	traceSync(fn, context, thisArg, ...args) { return fn.apply(thisArg, args); },
	tracePromise(fn, context, thisArg, ...args) { return fn.apply(thisArg, args); },
	traceCallback(fn, position, context, thisArg, ...args) { return fn.apply(thisArg, args); },
};

export function channel() { return noopChannel; }
export function tracingChannel() { return noopTracingChannel; }
export function hasSubscribers() { return false; }
export function subscribe() { }
export function unsubscribe() { return false; }

export default { channel, tracingChannel, hasSubscribers, subscribe, unsubscribe };
