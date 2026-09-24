/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Renames VS Code to Kingu wherever the product names itself to the user:
 * "Kingu" for the app, "Kingu IDE" where the editor window is meant as against
 * the Agents window ("Open in Kingu IDE", "the main Kingu IDE window"). Ids,
 * commands, setting keys and code keep "vscode".
 *
 *     node build/kingu-brand/rename-vscode.ts
 *
 * - `src/vs`: the message of every `localize` / `localize2` call (tests aside).
 * - `extensions/*`: every `package.nls.json` value, and the shown values in
 *   `package.json` (titles, labels, descriptions).
 *
 * Messages about VS Code's own services (its newsletter) keep the name, since
 * saying Kingu there would misname someone else's service.
 *
 * Safe to run again: it only changes text that still says VS Code.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { files, renameJsonFile, renameLocalizeMessages, SHOWN_KEYS } from './rename-copilot.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MENTIONS = /\b(VS Code|Visual Studio Code|VSCode)\b/;

/** Text about VS Code's own services, which is left as it is. */
const THEIRS = /\bNewsletter\b/i;

/** Text with the product's name: the editor window as "Kingu IDE", the app as "Kingu". */
export function renameVSCode(text: string): string {
	if (THEIRS.test(text)) {
		return text;
	}
	return text
		.replace(/\b(Open (?:in|using|with)) (?:VS Code|Visual Studio Code)\b/g, '$1 Kingu IDE')
		.replace(/\b(?:VS Code|Visual Studio Code) (windows?)\b/g, 'Kingu IDE $1')
		.replace(/\b(?:Visual Studio Code|VS Code|VSCode)\b/g, 'Kingu');
}

function main(): void {
	let total = 0;
	for (const file of files(path.join(ROOT, 'src', 'vs'), name => name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.includes('.test.'))) {
		const n = renameLocalizeMessages(file, MENTIONS, raw => renameVSCode(raw));
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
				const n = renameJsonFile(file, shown, MENTIONS, renameVSCode);
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
