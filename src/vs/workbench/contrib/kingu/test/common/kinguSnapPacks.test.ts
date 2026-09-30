/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { KINGU_SNAP_PACKS, kinguPackProgress, kinguPacksForWorkspace } from '../../common/kinguSnapPacks.js';

suite('kinguSnapPacks', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const workspace = (files: Record<string, string>) => async (name: string) => files[name];

	test('picks the packs a workspace\'s root files point to', async () => {
		const ids = async (files: Record<string, string>) => (await kinguPacksForWorkspace(workspace(files))).map(pack => pack.id);
		assert.deepStrictEqual({
			laravelReact: await ids({ 'artisan': '', 'package.json': '{"dependencies":{"react":"^19"}}', 'docker-compose.yml': '' }),
			svelte: await ids({ 'package.json': '{"devDependencies":{"svelte":"^5"}}', 'bun.lock': '' }),
			none: await ids({ 'README.md': '' }),
		}, {
			laravelReact: ['laravel', 'react', 'devops'],
			svelte: ['sveltekit'],
			none: [],
		});
	});

	test('counts installed extensions without regard to case, and every pack has distinct ids', () => {
		const laravel = KINGU_SNAP_PACKS.find(pack => pack.id === 'laravel')!;
		assert.deepStrictEqual(kinguPackProgress(laravel, new Set(['bmewburn.vscode-intelephense-client', 'xdebug.php-debug'])), { installed: 2, total: 5 });
		for (const pack of KINGU_SNAP_PACKS) {
			assert.strictEqual(new Set(pack.extensions).size, pack.extensions.length, pack.id);
		}
	});
});
