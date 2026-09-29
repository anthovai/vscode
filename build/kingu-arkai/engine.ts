/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Arkai's engine: the standalone `omp` CLI built from Kingu's oh-my-pi fork
// (anthovai/oh-my-pi), copied to `arkai-engine/` where Arkai looks for it
// (in a build as in the packaged app, where the gulp build carries it along).
//
//   node build/kingu-arkai/engine.ts            copy the fork's last build
//   node build/kingu-arkai/engine.ts --build    build it first (`bun run build`)
//
// The fork is `../arkai-upstream/oh-my-pi` unless ARKAI_OMP_FORK names it. Its
// build embeds the native addon, so the one file is all Arkai needs; on first
// run it unpacks the addon under `~/.omp/natives`.
//
// Arkai's OMP extensions (goose's features, from the arkai repo's
// packages/extensions; `../arkai` unless ARKAI_REPO names it) go to
// `arkai-engine/extensions/`, which the engine runs as TypeScript.

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fork = path.resolve(process.env.ARKAI_OMP_FORK ?? path.join(root, '..', 'arkai-upstream', 'oh-my-pi'));
const cli = path.join(fork, 'packages', 'coding-agent');
const binary = process.platform === 'win32' ? 'omp.exe' : 'omp';
const built = path.join(cli, 'dist', binary);
const target = path.join(root, 'arkai-engine');
const extensions = path.join(path.resolve(process.env.ARKAI_REPO ?? path.join(root, '..', 'arkai')), 'packages', 'extensions', 'src');

function run(command: string, args: string[], cwd: string): string {
	return execFileSync(command, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
}

if (!fs.existsSync(cli)) {
	console.error(`[arkai-engine] no oh-my-pi fork at ${fork}; set ARKAI_OMP_FORK to its checkout.`);
	process.exit(1);
}
if (process.argv.includes('--build')) {
	console.log(`[arkai-engine] building ${cli}`);
	execFileSync('bun', ['run', 'build'], { cwd: cli, stdio: 'inherit' });
}
if (!fs.existsSync(built)) {
	console.error(`[arkai-engine] ${built} is missing; run with --build.`);
	process.exit(1);
}

fs.mkdirSync(target, { recursive: true });
const copied = path.join(target, binary);
const same = (a: string, b: string) => fs.existsSync(b) && fs.statSync(a).size === fs.statSync(b).size && fs.statSync(a).mtimeMs <= fs.statSync(b).mtimeMs;
// An unchanged engine is left as it is: it may be running.
if (!same(built, copied)) {
	fs.copyFileSync(built, copied);
}
fs.rmSync(path.join(target, 'extensions'), { recursive: true, force: true });
if (fs.existsSync(extensions)) {
	fs.cpSync(extensions, path.join(target, 'extensions'), { recursive: true, filter: source => fs.statSync(source).isDirectory() || source.endsWith('.ts') });
} else {
	console.warn(`[arkai-engine] no Arkai extensions at ${extensions}; set ARKAI_REPO to the arkai checkout.`);
}
const engine = {
	source: 'anthovai/oh-my-pi',
	commit: run('git', ['rev-parse', 'HEAD'], fork),
	version: run(path.join(target, binary), ['--version'], target),
	extensions: fs.existsSync(extensions) ? { commit: run('git', ['rev-parse', 'HEAD'], extensions), files: fs.readdirSync(path.join(target, 'extensions')) } : undefined,
};
fs.writeFileSync(path.join(target, 'engine.json'), `${JSON.stringify(engine, undefined, '\t')}\n`);
console.log(`[arkai-engine] ${engine.version} (${engine.commit.slice(0, 7)}) -> ${path.join(target, binary)}`);
