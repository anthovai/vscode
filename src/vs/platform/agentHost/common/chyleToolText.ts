/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Kingu: recovering tool calls a local model wrote as text, for Chyle's
 * gateway.
 *
 * Local models (Qwen3-Coder among them) often write a tool call into the
 * message instead of the API's `tool_calls` field: Qwen's XML
 * (`<function=write><parameter=path>a.js</parameter>…</function>`), or a JSON
 * object with `name` and `arguments`. The agent then sees prose and does
 * nothing. This finds such calls and turns them into real ones.
 *
 * Ported from goose (Apache-2.0), crates/goose-local-inference/src/native_tool_parsing.rs,
 * by way of Arkai's chyle-gateway.
 */

/** A tool the request offered: its name and JSON-schema parameters. */
export interface IChyleOfferedTool {
	readonly name: string;
	readonly parameters?: { readonly properties?: Readonly<Record<string, { readonly type?: string | readonly string[] }>> };
}

export interface IChyleRecoveredCall {
	readonly name: string;
	/** JSON text, as the OpenAI API carries arguments. */
	readonly arguments: string;
}

export interface IChyleRecovered {
	/** The text around the calls: what the model said besides them. */
	readonly text: string;
	readonly calls: readonly IChyleRecoveredCall[];
}

const FUNCTION = /<function=([^>\s]+)\s*>([\s\S]*?)<\/function>/g;
const PARAMETER = /<parameter=([^>\s]+)\s*>([\s\S]*?)<\/parameter>/g;
/** Wrappers some chat templates leave around a call, and alone at the end of a reply. */
const WRAPPERS = /<\/?tool_call>|<\|tool_call_(?:begin|end)\|>/g;

/** A parameter's value as its schema wants it: XML carries every value as text. */
function typedValue(raw: string, type: string | readonly string[] | undefined): unknown {
	const value = raw.replace(/^\n/, '').replace(/\n$/, '');
	const types = type === undefined ? [] : typeof type === 'string' ? [type] : type;
	if (types.length === 0 || types.includes('string')) {
		return value;
	}
	try {
		return JSON.parse(value.trim());
	} catch {
		return value;
	}
}

function parseXml(text: string, offered: ReadonlyMap<string, IChyleOfferedTool>): IChyleRecoveredCall[] {
	const calls: IChyleRecoveredCall[] = [];
	for (const match of text.matchAll(FUNCTION)) {
		const tool = offered.get(match[1].trim());
		if (!tool) {
			continue;
		}
		const args: Record<string, unknown> = {};
		for (const parameter of match[2].matchAll(PARAMETER)) {
			const key = parameter[1].trim();
			args[key] = typedValue(parameter[2], tool.parameters?.properties?.[key]?.type);
		}
		calls.push({ name: tool.name, arguments: JSON.stringify(args) });
	}
	return calls;
}

/** Every outermost balanced `{…}` in the text that parses as JSON; objects inside one are not listed again. */
function jsonObjects(text: string): { value: unknown; start: number; end: number }[] {
	const found: { value: unknown; start: number; end: number }[] = [];
	let start = text.indexOf('{');
	while (start !== -1) {
		let next = start + 1;
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let i = start; i < text.length; i++) {
			const ch = text[i];
			if (escaped) {
				escaped = false;
			} else if (ch === '\\' && inString) {
				escaped = true;
			} else if (ch === '"') {
				inString = !inString;
			} else if (!inString && ch === '{') {
				depth++;
			} else if (!inString && ch === '}' && --depth === 0) {
				try {
					found.push({ value: JSON.parse(text.slice(start, i + 1)), start, end: i + 1 });
					next = i + 1;
				} catch {
					// Not JSON; keep looking, inside it too.
				}
				break;
			}
		}
		start = text.indexOf('{', next);
	}
	return found;
}

function asCall(value: unknown, offered: ReadonlyMap<string, IChyleOfferedTool>): IChyleRecoveredCall | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const inner = record.function && typeof record.function === 'object' ? record.function as Record<string, unknown> : record;
	const tool = typeof inner.name === 'string' ? offered.get(inner.name) : undefined;
	const args = inner.arguments ?? inner.parameters;
	if (!tool || args === undefined || (typeof args !== 'object' && typeof args !== 'string')) {
		return undefined;
	}
	return { name: tool.name, arguments: typeof args === 'string' ? args : JSON.stringify(args) };
}

/**
 * The tool calls written into `text`, keeping only tools the request offered
 * (a model inventing a tool gets nothing), or `undefined` when there are none.
 */
export function recoverChyleToolCalls(text: string, tools: readonly IChyleOfferedTool[]): IChyleRecovered | undefined {
	if (!text || tools.length === 0) {
		return undefined;
	}
	const offered = new Map(tools.map(tool => [tool.name, tool]));
	if (text.includes('<function=')) {
		const calls = parseXml(text, offered);
		if (calls.length) {
			return { text: text.replace(FUNCTION, '').replace(WRAPPERS, '').trim(), calls };
		}
	}
	const calls: IChyleRecoveredCall[] = [];
	let rest = text;
	for (const object of jsonObjects(text).reverse()) {
		const call = asCall(object.value, offered);
		if (call) {
			calls.unshift(call);
			rest = rest.slice(0, object.start) + rest.slice(object.end);
		}
	}
	return calls.length ? { text: rest.replace(WRAPPERS, '').replace(/```(?:json)?\s*```/g, '').trim(), calls } : undefined;
}

/** A reply's text with the stray tool-call wrappers some templates leave at its end. */
export function cleanChyleText(text: string): string {
	return text.replace(WRAPPERS, '').trimEnd();
}
