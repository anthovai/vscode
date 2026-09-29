/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Claude and Codex agent SDKs, shipped with Kingu. VS Code downloads them
// from its CDN (`product.agentSdks`); Kingu has no CDN, so the build carries
// them in `agent-sdks/<id>/node_modules`, where the agent host's SDK
// downloader finds them (`_bundledRoot`).
//
//   node build/kingu-agent-sdks/copy.ts
//
// Each SDK is copied with the dependencies it resolves to in this repo's
// node_modules, the same packages the agent host runs on from source, and
// its native package for this platform only.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const target = path.join(root, 'agent-sdks');
const platform = `${process.platform}-${process.arch}`;

/** Each SDK's entry packages: its own and the one carrying its binary for this platform. */
const SDKS: Record<string, string[]> = {
	claude: ['@anthropic-ai/claude-agent-sdk', `@anthropic-ai/claude-agent-sdk-${platform}`],
	codex: ['@openai/codex', `@openai/codex-${platform}`],
};

/** The directory `name` resolves to from `from`, as Node looks it up; undefined when it is not installed. */
function resolvePackage(name: string, from: string): string | undefined {
	for (let dir = from; ; dir = path.dirname(dir)) {
		const candidate = path.join(dir, 'node_modules', name);
		if (fs.existsSync(path.join(candidate, 'package.json'))) {
			return fs.realpathSync(candidate);
		}
		if (path.dirname(dir) === dir) {
			return undefined;
		}
	}
}

interface IManifest {
	readonly version: string;
	readonly dependencies?: Record<string, string>;
	readonly peerDependencies?: Record<string, string>;
	readonly optionalDependencies?: Record<string, string>;
}

function readJson(file: string): IManifest {
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

fs.rmSync(target, { recursive: true, force: true });
for (const [id, entries] of Object.entries(SDKS)) {
	const sdkRoot = path.join(target, id);
	const copied = new Set<string>();
	const queue = entries.map(name => ({ name, from: root, required: true }));
	while (queue.length) {
		const { name, from, required } = queue.shift()!;
		const dir = resolvePackage(name, from);
		if (!dir) {
			if (required) {
				console.error(`[agent-sdks] ${id}: ${name} is not installed; run npm install.`);
				process.exit(1);
			}
			continue;
		}
		if (copied.has(dir)) {
			continue;
		}
		copied.add(dir);
		const relative = path.relative(root, dir);
		if (relative.startsWith('..')) {
			console.error(`[agent-sdks] ${id}: ${name} resolves outside the repo (${dir}).`);
			process.exit(1);
		}
		fs.cpSync(dir, path.join(sdkRoot, relative), { recursive: true, dereference: true });
		const manifest = readJson(path.join(dir, 'package.json'));
		for (const dependency of Object.keys(manifest.dependencies ?? {})) {
			queue.push({ name: dependency, from: dir, required: true });
		}
		// Peers are installed beside the SDK in its own tarball; optional ones are
		// other platforms' binaries, present only for this one.
		for (const dependency of [...Object.keys(manifest.peerDependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})]) {
			queue.push({ name: dependency, from: dir, required: false });
		}
	}
	const versions = Object.fromEntries(entries.map(name => [name, readJson(path.join(resolvePackage(name, root)!, 'package.json')).version]));
	fs.writeFileSync(path.join(sdkRoot, 'sdk.json'), `${JSON.stringify({ platform, packages: copied.size, versions }, undefined, '\t')}\n`);
	fs.writeFileSync(path.join(sdkRoot, '.complete'), '');
	console.log(`[agent-sdks] ${id}: ${copied.size} packages (${Object.values(versions).join(', ')}) -> ${sdkRoot}`);
}
