/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Updates the vendored ADE in `kingu-orca/` from the ADE repository, keeping
 * the fork's own edits to vendored files.
 *
 *     node build/kingu-orca/revendor.ts <ade-repo> <from-commit> <to-commit>
 *
 * `<from-commit>` is the ADE commit the vendored copy was taken from, `<to-commit>`
 * the one to move to. For every file of the copied folders (MERGE.md's table):
 * the fork did not edit it → the new version; the ADE did not change it → the
 * fork's; both → a three-way merge, reported. Files only the fork has are kept.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VENDORED = path.join(ROOT, 'kingu-orca');

/** `kingu-orca/<to>` is `<from>` in the ADE repository. */
const FOLDERS = [
	['main', 'src/main'],
	['shared', 'src/shared'],
	['preload', 'src/preload'],
	['relay', 'src/relay'],
	['types', 'src/types'],
	['renderer', 'src/renderer'],
	['resources', 'resources'],
];

const [repo, from, to] = process.argv.slice(2);
if (!repo || !from || !to) {
	console.error('usage: revendor.ts <ade-repo> <from-commit> <to-commit>');
	process.exit(2);
}

const git = (cwd: string, args: string[], options: { input?: string } = {}): Buffer => execFileSync('git', ['-C', cwd, ...args], { maxBuffer: 1 << 30, ...options });

function tree(cwd: string, commit: string, folder: string): Map<string, string> {
	const map = new Map<string, string>();
	const out = git(cwd, ['ls-tree', '-r', '-z', '--format=%(objectmode) %(objectname) %(path)', `${commit}:${folder}`]).toString();
	for (const line of out.split('\0')) {
		if (!line) {
			continue;
		}
		const [mode, oid, ...rest] = line.split(' ');
		if (mode !== '160000') {
			map.set(rest.join(' '), oid);
		}
	}
	return map;
}

const blobs = new Map<string, Buffer>();
function prefetch(oids: (string | undefined)[]): void {
	const wanted = [...new Set(oids)].filter((oid): oid is string => !!oid && !blobs.has(oid));
	for (let i = 0; i < wanted.length; i += 2000) {
		const out = git(repo, ['cat-file', '--batch'], { input: `${wanted.slice(i, i + 2000).join('\n')}\n` });
		let at = 0;
		while (at < out.length) {
			const end = out.indexOf(10, at);
			const [oid, , size] = out.subarray(at, end).toString().split(' ');
			const start = end + 1;
			blobs.set(oid, out.subarray(start, start + Number(size)));
			at = start + Number(size) + 1;
		}
	}
}

/** The vendored file as git would store it: line endings normalised, so a CRLF checkout compares equal. */
function oursOid(file: string): string | undefined {
	return fs.existsSync(file) ? execFileSync('git', ['hash-object', '--path', path.relative(ROOT, file).replaceAll('\\', '/'), file], { cwd: ROOT }).toString().trim() : undefined;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kingu-revendor-'));
const report = { updated: 0, kept: 0, added: 0, removed: 0, merged: [] as string[], conflicts: [] as string[] };

for (const [local, source] of FOLDERS) {
	const base = tree(repo, from, source);
	const theirs = tree(repo, to, source);
	prefetch([...base.values(), ...theirs.values()]);
	const paths = new Set([...base.keys(), ...theirs.keys()]);
	for (const rel of paths) {
		const file = path.join(VENDORED, local, rel);
		const b = base.get(rel);
		const t = theirs.get(rel);
		if (b === t) {
			continue;
		}
		const o = oursOid(file);
		if (o === b || (!o && !b)) {
			// The fork left it as vendored: take the ADE's change.
			if (t) {
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, blobs.get(t)!);
				report[b ? 'updated' : 'added']++;
			} else if (fs.existsSync(file)) {
				fs.rmSync(file);
				report.removed++;
			}
			continue;
		}
		if (!t) {
			// The ADE deleted a file the fork edited: keep the fork's, report it.
			report.conflicts.push(`${local}/${rel} (deleted upstream, edited here; kept)`);
			continue;
		}
		const [oursFile, baseFile, theirsFile] = ['ours', 'base', 'theirs'].map(name => path.join(tmp, name));
		// A CRLF checkout of an LF file would read as every line changed; merge the LF text.
		const ours = fs.readFileSync(file);
		const baseBytes = b ? blobs.get(b)! : Buffer.alloc(0);
		fs.writeFileSync(oursFile, baseBytes.includes(13) ? ours : Buffer.from(ours.toString('utf8').replace(/\r\n/g, '\n')));
		fs.writeFileSync(baseFile, baseBytes);
		fs.writeFileSync(theirsFile, blobs.get(t)!);
		let clean = true;
		try {
			execFileSync('git', ['merge-file', '-L', 'kingu-ide', '-L', 'vendored', '-L', 'ade', oursFile, baseFile, theirsFile], { stdio: 'pipe' });
		} catch {
			clean = false;
		}
		fs.writeFileSync(file, fs.readFileSync(oursFile));
		(clean ? report.merged : report.conflicts).push(`${local}/${rel}`);
	}
	report.kept += [...base.keys()].filter(rel => base.get(rel) === theirs.get(rel)).length;
}

console.log(`updated ${report.updated}, added ${report.added}, removed ${report.removed}, unchanged ${report.kept}`);
console.log(`merged (${report.merged.length}):`);
report.merged.forEach(file => console.log(`  ${file}`));
console.log(`conflicts (${report.conflicts.length}):`);
report.conflicts.forEach(file => console.log(`  ${file}`));
