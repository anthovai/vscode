/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

// Arkai's engine: the standalone `omp` CLI built from Kingu's oh-my-pi fork
// (anthovai/oh-my-pi), copied to `arkai-engine/` where Arkai looks for it
// (in a build as in the packaged app, where the gulp build carries it along).
//
//   node build/kingu-arkai/engine.mjs            copy the fork's last build
//   node build/kingu-arkai/engine.mjs --build    build it first (`bun run build`)
//
// The fork is `../arkai-upstream/oh-my-pi` unless ARKAI_OMP_FORK names it. Its
// build embeds the native addon, so the one file is all Arkai needs; on first
// run it unpacks the addon under `~/.omp/natives`.

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

function run(command, args, cwd) {
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
fs.copyFileSync(built, path.join(target, binary));
const engine = {
	source: 'anthovai/oh-my-pi',
	commit: run('git', ['rev-parse', 'HEAD'], fork),
	version: run(path.join(target, binary), ['--version'], target),
};
fs.writeFileSync(path.join(target, 'engine.json'), `${JSON.stringify(engine, undefined, '\t')}\n`);
console.log(`[arkai-engine] ${engine.version} (${engine.commit.slice(0, 7)}) -> ${path.join(target, binary)}`);
