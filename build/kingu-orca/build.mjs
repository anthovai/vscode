/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Bundles the vendored ADE backend (`kingu-orca/`) into a single CommonJS file
 * the fork's main process can require.
 *
 * Why a separate bundle rather than `src/vs`: that tree is 11k files written
 * against electron-vite, with its own module graph and its own idioms. Rewriting
 * it into the fork's layers would be a year of work and would break every time
 * the ADE moves. Bundling it whole keeps it as it is — the fork calls into it
 * across one seam instead of absorbing it.
 *
 * **Why it sits beside `src/` rather than inside it.** It lived at
 * `src/kingu-orca` first, on the reasoning that `src/tsconfig.json` includes
 * only `./vs/**` so nothing there would be type-checked. That was true and it
 * was not enough: `compileTask` streams `gulp.src('src/**')`, every file under
 * `src/` regardless of the tsconfig, and hands each to the transpiler — which
 * then asks tsc for an output name for a file that is not in its program and
 * fails the whole build with `Expected fileName to be present in command line`.
 * Out of `src/` entirely, no upstream build file has to learn about it.
 */

import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(root, 'out-kingu-orca');
const assetDir = path.join(outDir, 'assets');

/**
 * electron-vite's `import icon from './x.png?asset'`, which the ADE uses for
 * tray icons, app icons and notification sounds.
 *
 * The suffix means "do not inline this; give me a path to it at runtime". So the
 * file is copied next to the bundle and the import becomes that path. The
 * `&asarUnpack` variant means the same thing to us — we do not ship an asar.
 */
const vendored = path.join(root, 'kingu-orca');

/**
 * Where an asset import actually points.
 *
 * The ADE reaches its `resources/` from its own repository root, so a file at
 * `main/ipc/x.ts` writes `../../../resources/…`. Vendored here that climbs one
 * level too far and lands on the *fork's* root — which has a `resources/` of
 * its own. So the rule is positional, not "whichever file happens to exist":
 * anything that escapes the vendored tree is re-rooted back into it, and an
 * asset is only ever read from `kingu-orca/`. Preferring an existing file would
 * mean a name the fork also uses silently resolving to the fork's copy.
 */
function locateAsset(resolveDir, request) {
	const direct = path.resolve(resolveDir, request);
	const inside = path.relative(vendored, direct);
	if (inside && !inside.startsWith('..') && !path.isAbsolute(inside)) {
		return direct;
	}
	return path.join(vendored, path.relative(root, direct));
}

/**
 * One asset store, however many bundles. Each bundle resolves the store
 * relative to its own `__dirname`, so a bundle that does not live in
 * `out-kingu-orca` — the sidecar entries below do not — still finds the copy.
 */
function createAssetPlugin(bundleDir) {
	return {
		name: 'kingu-orca-asset',
		setup(build) {
			build.onResolve({ filter: /\?asset(&asarUnpack)?$/ }, args => ({
				path: locateAsset(args.resolveDir, args.path.replace(/\?asset(&asarUnpack)?$/, '')),
				namespace: 'kingu-asset',
			}));
			build.onLoad({ filter: /.*/, namespace: 'kingu-asset' }, args => {
				fs.mkdirSync(assetDir, { recursive: true });
				// Named by content location rather than basename: two directories both
				// hold an `icon.png`, and copying them to one name would lose one.
				const name = path.relative(vendored, args.path).replace(/[\\/]/g, '_');
				fs.copyFileSync(args.path, path.join(assetDir, name));
				const storeFromBundle = path.relative(bundleDir, assetDir);
				return {
					contents: `module.exports = require('path').join(__dirname, ${JSON.stringify(storeFromBundle)}, ${JSON.stringify(name)});`,
					loader: 'js',
					resolveDir: outDir,
				};
			});
		},
	};
}

/** Native modules and anything the fork already resolves for itself. */
const external = [
	'electron',
	'node-pty',
	'@parcel/watcher',
	'ssh2',
	'sherpa-onnx',
	// Ships a UMD wrapper whose require() esbuild cannot follow; node resolves it.
	'jsonc-parser',
	'*.node',
];

/** Everything the bundles agree on; only the entry and the output differ. */
function shared(bundleDir) {
	return {
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'node20',
		external,
		plugins: [createAssetPlugin(bundleDir)],
		sourcemap: true,
		logLevel: 'info',
		metafile: true,
		logLimit: 0,
	};
}

/**
 * Where the startup bundle finds the ADE's worker threads.
 *
 * The ADE resolves a worker entry (`usage-scan-worker-entry.js`, the port
 * scanner, the theme parser, ...) next to the module asking, by `__dirname`,
 * rather than under its app path as it does for forked sidecars. The startup
 * bundle lives in `out-kingu-orca/`, the worker entries in `kingu-orca/out/main/`
 * with the other sidecars, so the ADE's resolver is pointed there; without it
 * every worker fails to spawn (the Usage scans read nothing).
 */
const workerEntryDir = path.relative(outDir, path.join(vendored, 'out/main')).split(path.sep).join('/');
const workerEntryPlugin = {
	name: 'kingu-orca-worker-entry',
	setup(build) {
		build.onLoad({ filter: /[\\/]main[\\/]worker-thread-entry-path\.ts$/ }, args => {
			const source = fs.readFileSync(args.path, 'utf8');
			// Both branches: the fork is "packaged" to the ADE's app environment even
			// in development, and its resources tree holds no ADE `app.asar` either.
			const resolver = /(export function resolveWorkerThreadEntryPath\([^)]*\)[^{]*\{)[\s\S]*?\n\}/;
			if (!resolver.test(source)) {
				throw new Error(`kingu-orca: ${args.path} no longer declares resolveWorkerThreadEntryPath; update the worker entry plugin.`);
			}
			return { contents: source.replace(resolver, `$1\n  return join(layout.moduleDir, ${JSON.stringify(workerEntryDir)}, entryFileName)\n}`), loader: 'ts' };
		});
	},
};

/**
 * `fork-entry.ts`, not `main/index.ts`.
 *
 * The ADE's entry is an application: it takes the single-instance lock,
 * installs quit handlers and calls `app.whenReady()` at import time. Bundling
 * that would give us a file the fork's main process cannot require without
 * starting a second application inside the first. The fork entry exports the
 * three startup functions and runs nothing.
 */
const result = await esbuild.build({
	...shared(outDir),
	plugins: [...shared(outDir).plugins, workerEntryPlugin],
	entryPoints: [path.join(root, 'kingu-orca/fork-entry.ts')],
	outfile: path.join(outDir, 'startup.cjs'),
});

/**
 * The preload, which is what makes the vendored renderer able to say
 * `window.api`.
 *
 * A second bundle rather than an entry in the first: a preload is loaded into a
 * renderer by path, not required by the main process, so it has to be its own
 * file. CommonJS for the same reason — Electron loads a sandboxed preload as
 * CJS regardless of what the rest of the tree is written as.
 */
const preload = await esbuild.build({
	...shared(outDir),
	entryPoints: [path.join(root, 'kingu-orca/preload/index.ts')],
	outfile: path.join(outDir, 'preload.cjs'),
});

/**
 * The sidecar entries: every file the ADE's main process starts *by path* — the
 * daemon `fork()`s, the plugin host, the worker threads, the two webview
 * preloads, and the modules its CLI imports.
 *
 * They land in `kingu-orca/out/main/` because that is where the ADE's own
 * resolvers look: each one asks for `<appPath>/out/main/<name>.js`, and in
 * `--orca` boots the host points `app.getAppPath()` at `kingu-orca/`, which is
 * the vendored stand-in for the ADE's repository root. The names are the entry
 * names from the ADE's own `electron.vite.config.ts`, verbatim, so nothing on
 * the calling side needs to know it is not running in the ADE's checkout.
 *
 * A build of their own rather than more entries in `startup.cjs`: each runs in
 * its own process or worker and is loaded from disk by path, so each has to be
 * its own file.
 */
const sidecarDir = path.join(vendored, 'out', 'main');
// `kingu-orca/package.json` says `"type": "module"` for the renderer's sake,
// which would make Node read these CommonJS bundles as ES modules and die on
// the first `module.exports`. The names cannot change — the ADE's resolvers ask
// for `<name>.js` verbatim — so the scope changes instead.
fs.mkdirSync(sidecarDir, { recursive: true });
fs.writeFileSync(path.join(vendored, 'out', 'package.json'), JSON.stringify({ type: 'commonjs' }));
const sidecars = await esbuild.build({
	...shared(sidecarDir),
	entryPoints: {
		'daemon-entry': path.join(vendored, 'main/daemon/daemon-entry.ts'),
		'plugin-host-entry': path.join(vendored, 'main/plugins/plugin-host-entry.ts'),
		'computer-sidecar': path.join(vendored, 'main/computer/sidecar-entry.ts'),
		'stt-worker': path.join(vendored, 'main/speech/stt-worker.ts'),
		'warp-theme-parser-worker': path.join(vendored, 'main/warp-themes/warp-theme-parser-worker.ts'),
		'session-scanner-opencode-sqlite-worker-entry': path.join(vendored, 'main/ai-vault/session-scanner-opencode-sqlite-worker-entry.ts'),
		'session-scanner-worker-entry': path.join(vendored, 'main/ai-vault/session-scanner-worker-entry.ts'),
		'session-scanner-service-entry': path.join(vendored, 'main/ai-vault/session-scanner-service-entry.ts'),
		'wsl-transcript-fs-process-entry': path.join(vendored, 'main/native-chat/wsl-transcript-fs-process-entry.ts'),
		'port-scan-command-worker-entry': path.join(vendored, 'main/ports/port-scan-command-worker-entry.ts'),
		'usage-scan-worker-entry': path.join(vendored, 'main/usage/usage-scan-worker-entry.ts'),
		'parcel-watcher-process-entry': path.join(vendored, 'main/ipc/parcel-watcher-process-entry.ts'),
		'main-thread-hang-watchdog-entry': path.join(vendored, 'main/hang-watchdog/main-thread-hang-watchdog-entry.ts'),
		'agent-hooks/managed-agent-hook-controls': path.join(vendored, 'main/agent-hooks/managed-agent-hook-controls.ts'),
		'codex/managed-home-shell-preflight': path.join(vendored, 'main/codex/managed-home-shell-preflight.ts'),
		'claude-accounts/keychain': path.join(vendored, 'main/claude-accounts/keychain.ts'),
		'browser-window-close-preload': path.join(vendored, 'preload/browser-window-close.ts'),
		'doc-preview-link-preload': path.join(vendored, 'preload/doc-preview-link.ts'),
	},
	outdir: sidecarDir,
});

fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(result.metafile));
for (const [name, built] of [['startup.cjs', result], ['preload.cjs', preload]]) {
	const bytes = fs.statSync(path.join(outDir, name)).size;
	console.log(`kingu-orca: ${name} ${(bytes / 1024 / 1024).toFixed(1)} MB from ${Object.keys(built.metafile.inputs).length} inputs`);
}
console.log(`kingu-orca: ${Object.keys(sidecars.metafile.outputs).filter(o => o.endsWith('.js')).length} sidecar entries in kingu-orca/out/main from ${Object.keys(sidecars.metafile.inputs).length} inputs`);
