/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Renames Extensions to Snap wherever the feature is shown to the user: the
 * view, its menus and command category and settings section are "Snap", and
 * what it installs are "snaps". Ids, setting keys (`extensions.autoUpdate`),
 * code and "file extension" (a name's suffix) are left as they are.
 *
 *     node build/kingu-brand/rename-extensions.ts
 *
 * - The feature's name: every `localize` / `localize2` message that is just
 *   "Extensions" becomes "Snap" where it names the feature and "Snaps" where it
 *   names the things installed.
 * - The feature's own text: every message in the extensions view, the
 *   extension services and their platform side.
 *
 * Safe to run again: it only changes text that still says extension.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { files, renameLocalizeMessages } from './rename-copilot.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The keys of the messages that name the feature itself, e.g. the view's title and the command category. */
const FEATURE_NAME_KEYS = new Set(['extensions', 'extensionsConfigurationTitle', 'showExtensions']);

/** Where every message is the feature's own text. */
const FEATURE_DIRS = [
	'src/vs/workbench/contrib/extensions',
	'src/vs/workbench/services/extensionManagement',
	'src/vs/workbench/services/extensionRecommendations',
	'src/vs/workbench/services/extensions',
	'src/vs/platform/extensionManagement',
];

/** Text that says "extension" but is not about the feature: code, setting references, placeholders, a file name's suffix. */
const PROTECTED = /`[^`]*`|#[\w.-]+#|\b[\w-]+\.[\w.-]+|\{\d+\}|\b[Ff]ile extensions?\b|\b[Ll]anguage file extensions?\b/g;

const WORDS: Record<string, string> = { Extensions: 'Snaps', extensions: 'snaps', Extension: 'Snap', extension: 'snap', EXTENSIONS: 'SNAPS', EXTENSION: 'SNAP' };

function renameWords(text: string): string {
	return text
		.replace(/\b([Aa])n ([Ee]xtension)\b/g, (_, article: string, word: string) => `${article} ${word}`)
		.replace(/\b(Extensions|extensions|Extension|extension|EXTENSIONS|EXTENSION)\b/g, word => WORDS[word])
		.replace(/\ba Microsoft online service\b/g, 'Open VSX');
}

/** A message's text with the feature renamed, leaving the protected parts alone. */
export function renameExtensions(raw: string): string {
	let out = '';
	let last = 0;
	for (const match of raw.matchAll(PROTECTED)) {
		out += renameWords(raw.slice(last, match.index)) + match[0];
		last = match.index + match[0].length;
	}
	return out + renameWords(raw.slice(last));
}

function main(): void {
	let total = 0;
	const sources = (dir: string) => files(path.join(ROOT, dir), name => name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.includes('.test.'));
	const mentions = /\b[Ee]xtensions?\b/;
	const feature = new Set(FEATURE_DIRS.flatMap(dir => [...sources(dir)]));
	for (const file of sources('src/vs')) {
		const n = renameLocalizeMessages(file, mentions, (raw, key) => {
			const quote = raw[0];
			if (raw === `${quote}Extensions${quote}`) {
				return `${quote}${key && FEATURE_NAME_KEYS.has(key) ? 'Snap' : 'Snaps'}${quote}`;
			}
			return feature.has(file) ? renameExtensions(raw) : raw;
		});
		if (n) {
			console.log(`${path.relative(ROOT, file)}: ${n}`);
			total += n;
		}
	}
	console.log(`renamed ${total}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
