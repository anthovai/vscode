/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Renames the chat agent from Copilot to Arkai wherever the name is shown to
 * the user, and nowhere else: extension ids, commands, setting keys, policy
 * names, URLs and code identifiers keep "copilot", so nothing that reads them
 * breaks.
 *
 *     node build/kingu-brand/rename-copilot.ts
 *
 * - `src/vs`: the message of every `localize` / `localize2` call (tests aside),
 *   found by parsing, so a string that only looks like a message is left alone.
 * - `extensions/*`: every `package.nls.json` value, and in `package.json` only
 *   the values under keys the workbench displays (titles, labels, descriptions).
 *
 * Safe to run again: it only changes text that still says Copilot.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = 'Arkai';

/** The shown text with the new name: "GitHub Copilot" and "Copilot" as a word both become Arkai. */
export function rename(text: string): string {
	return text.replace(/\bGitHub Copilot\b/g, NAME).replace(/\bCopilot\b/g, NAME).replace(/\b([Aa]) Arkai\b/g, '$1n Arkai');
}

export function* files(dir: string, test: (name: string) => boolean): Generator<string> {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== 'node_modules' && entry.name !== 'test' && entry.name !== 'dist' && entry.name !== 'out') {
				yield* files(full, test);
			}
		} else if (test(entry.name)) {
			yield full;
		}
	}
}

function isLocalizeCall(node: ts.Node): node is ts.CallExpression {
	if (!ts.isCallExpression(node)) {
		return false;
	}
	const callee = node.expression;
	const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
	return name === 'localize' || name === 'localize2';
}

/** A `localize` call's key: its first argument, or that argument's `key` property. */
function localizeKey(call: ts.CallExpression): string | undefined {
	const first = call.arguments[0];
	if (first && ts.isStringLiteralLike(first)) {
		return first.text;
	}
	if (first && ts.isObjectLiteralExpression(first)) {
		for (const property of first.properties) {
			if (ts.isPropertyAssignment(property) && property.name.getText() === 'key' && ts.isStringLiteralLike(property.initializer)) {
				return property.initializer.text;
			}
		}
	}
	return undefined;
}

/**
 * Rewrites the message of every `localize` / `localize2` call in a file through `transform`,
 * which gets the message's source text (quotes included) and the call's key. Only files that
 * match `mentions` are parsed.
 */
export function renameLocalizeMessages(file: string, mentions: RegExp, transform: (raw: string, key: string | undefined) => string): number {
	const source = fs.readFileSync(file, 'utf8');
	if (!mentions.test(source)) {
		return 0;
	}
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const edits: { start: number; end: number; text: string }[] = [];
	const visit = (node: ts.Node): void => {
		if (isLocalizeCall(node) && node.arguments.length >= 2) {
			const message = node.arguments[1];
			if (ts.isStringLiteral(message) || ts.isNoSubstitutionTemplateLiteral(message)) {
				const raw = source.slice(message.getStart(tree), message.getEnd());
				const renamed = transform(raw, localizeKey(node));
				if (renamed !== raw) {
					edits.push({ start: message.getStart(tree), end: message.getEnd(), text: renamed });
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(tree);
	if (edits.length) {
		let out = source;
		for (const edit of edits.sort((a, b) => b.start - a.start)) {
			out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
		}
		fs.writeFileSync(file, out);
	}
	return edits.length;
}

/** `package.json` keys whose values the workbench shows as text. */
const SHOWN_KEYS = new Set(['displayName', 'description', 'userDescription', 'fullName', 'label', 'category', 'title', 'shortTitle',
	'markdownDescription', 'enumDescriptions', 'markdownEnumDescriptions', 'deprecationMessage', 'markdownDeprecationMessage',
	'welcomeTitle', 'welcomeMessage', 'inputPlaceholder', 'contents', 'placeholder']);

/** The shown string values that say Copilot, and the ones that say it but are not shown. */
function collectJsonStrings(value: unknown, shown: (key: string | undefined) => boolean): { shownValues: Set<string>; hiddenValues: Set<string> } {
	const shownValues = new Set<string>();
	const hiddenValues = new Set<string>();
	const walk = (node: unknown, key: string | undefined): void => {
		if (typeof node === 'string') {
			if (/\bCopilot\b/.test(node)) {
				(shown(key) ? shownValues : hiddenValues).add(node);
			}
		} else if (Array.isArray(node)) {
			node.forEach(item => walk(item, key));
		} else if (node && typeof node === 'object') {
			for (const [k, v] of Object.entries(node)) {
				walk(v, k);
			}
		}
	};
	walk(value, undefined);
	return { shownValues, hiddenValues };
}

/**
 * Renames the shown values in place in the file's text, so its formatting stays as it is.
 * A value that is also used under a key that is not shown (an id, say) is left alone.
 */
function renameJsonFile(file: string, shown: (key: string | undefined) => boolean): number {
	let text = fs.readFileSync(file, 'utf8');
	if (!/\bCopilot\b/.test(text)) {
		return 0;
	}
	const { shownValues, hiddenValues } = collectJsonStrings(JSON.parse(text), shown);
	let count = 0;
	for (const value of shownValues) {
		if (hiddenValues.has(value)) {
			console.warn(`${path.relative(ROOT, file)}: left ${JSON.stringify(value)}, also used where it is not shown`);
			continue;
		}
		const encoded = JSON.stringify(value).slice(1, -1);
		const pieces = text.split(`"${encoded}"`);
		if (pieces.length > 1) {
			text = pieces.join(`"${JSON.stringify(rename(value)).slice(1, -1)}"`);
			count += pieces.length - 1;
		}
	}
	if (count) {
		fs.writeFileSync(file, text);
	}
	return count;
}

function main(): void {
	let total = 0;
	for (const file of files(path.join(ROOT, 'src', 'vs'), name => name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.includes('.test.'))) {
		const n = renameLocalizeMessages(file, /\bCopilot\b/, raw => rename(raw));
		if (n) {
			console.log(`${path.relative(ROOT, file)}: ${n}`);
			total += n;
		}
	}
	for (const extension of fs.readdirSync(path.join(ROOT, 'extensions'), { withFileTypes: true })) {
		// Test extensions are not shown to anyone.
		if (!extension.isDirectory() || extension.name.includes('test')) {
			continue;
		}
		const dir = path.join(ROOT, 'extensions', extension.name);
		const targets: [string, (key: string | undefined) => boolean][] = [[path.join(dir, 'package.nls.json'), () => true], [path.join(dir, 'package.json'), key => !!key && SHOWN_KEYS.has(key)]];
		for (const [file, shown] of targets) {
			if (fs.existsSync(file)) {
				const n = renameJsonFile(file, shown);
				if (n) {
					console.log(`${path.relative(ROOT, file)}: ${n}`);
					total += n;
				}
			}
		}
	}
	console.log(`renamed ${total}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
