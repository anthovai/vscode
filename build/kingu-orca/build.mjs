/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Bundles the vendored ADE backend (`src/kingu-orca`) into a single CommonJS file
 * the fork's main process can require.
 *
 * Why a separate bundle rather than `src/vs`: that tree is 11k files written
 * against electron-vite, with its own module graph and its own idioms. Rewriting
 * it into the fork's layers would be a year of work and would break every time
 * the ADE moves. Bundling it whole keeps it as it is — the fork calls into it
 * across one seam instead of absorbing it.
 *
 * `src/tsconfig.json` includes only `./vs/**`, so nothing here is type-checked or
 * layering-linted by the fork's own build. That is deliberate: this is vendored
 * code, and holding it to the fork's rules would mean editing all of it.
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
const vendored = path.join(root, 'src/kingu-orca');

/**
 * Where an asset import actually points.
 *
 * The ADE reaches its `resources/` from the repository root, so a file at
 * `src/main/ipc/x.ts` writes `../../../resources/…`. Vendored one directory
 * deeper, that same relative path lands on the fork's `src/` instead. Rather
 * than editing 11k files, the escape is caught here and re-rooted into the
 * vendored tree — which is why `resources/` was copied to sit beside `main/`.
 */
function locateAsset(resolveDir, request) {
	const direct = path.resolve(resolveDir, request);
	if (fs.existsSync(direct)) {
		return direct;
	}
	const escaped = path.relative(path.join(root, 'src'), direct);
	return path.join(vendored, escaped);
}

const assetPlugin = {
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
			return {
				contents: `module.exports = require('path').join(__dirname, 'assets', ${JSON.stringify(name)});`,
				loader: 'js',
				resolveDir: outDir,
			};
		});
	},
};

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

const result = await esbuild.build({
	entryPoints: [path.join(root, 'src/kingu-orca/main/index.ts')],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node20',
	outfile: path.join(outDir, 'main.cjs'),
	external,
	plugins: [assetPlugin],
	sourcemap: true,
	logLevel: 'info',
	metafile: true,
	logLimit: 0,
});

fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(result.metafile));
const bytes = fs.statSync(path.join(outDir, 'main.cjs')).size;
console.log(`kingu-orca: ${(bytes / 1024 / 1024).toFixed(1)} MB from ${Object.keys(result.metafile.inputs).length} inputs`);
