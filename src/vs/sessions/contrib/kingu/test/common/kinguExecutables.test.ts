/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { executableNames, executableSearchDirectories } from '../../../../../platform/kinguHost/common/kinguExecutables.js';
import { KINGU_AGENT_COMMANDS, KNOWN_AGENT_COMMANDS } from '../../../../../platform/kinguHost/common/kinguAgentCommands.js';
import { KINGU_VAULT_SOURCES } from '../../common/kinguVaultSources.js';

suite('Kingu agent detection', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('what a command is called on disk', () => {

		test('on Windows a command is usually not the bare name', () => {
			// npm writes `claude.cmd` for a package with a bin entry; looking only
			// for `claude` finds nothing and reports every agent as absent.
			assert.deepStrictEqual(executableNames('win32', 'claude'), ['claude.cmd', 'claude.exe', 'claude.bat', 'claude']);
		});

		test('elsewhere it is the name itself', () => {
			assert.deepStrictEqual(executableNames('linux', 'claude'), ['claude']);
			assert.deepStrictEqual(executableNames('darwin', 'claude'), ['claude']);
		});
	});

	suite('where to look', () => {

		test('PATH comes first, because it is what would actually run', () => {
			const directories = executableSearchDirectories({ platform: 'linux', pathEnv: '/usr/bin:/opt/tools', home: '/home/dev' });
			assert.deepStrictEqual(directories.slice(0, 2), ['/usr/bin', '/opt/tools']);
		});

		test('the installer directories follow, because a desktop app never saw the login shell PATH', () => {
			const directories = executableSearchDirectories({ platform: 'linux', pathEnv: '/usr/bin', home: '/home/dev' });
			assert.ok(directories.includes('/home/dev/.local/bin'));
			assert.ok(directories.includes('/home/dev/.bun/bin'));
		});

		test('a directory already on PATH is not searched twice', () => {
			const directories = executableSearchDirectories({ platform: 'linux', pathEnv: '/home/dev/.local/bin', home: '/home/dev' });
			assert.strictEqual(directories.filter(entry => entry === '/home/dev/.local/bin').length, 1);
		});

		test('Windows splits on its own separator and joins with its own', () => {
			const directories = executableSearchDirectories({ platform: 'win32', pathEnv: 'C:\\bin;C:\\tools', home: 'C:\\Users\\me' });
			assert.deepStrictEqual(directories.slice(0, 2), ['C:\\bin', 'C:\\tools']);
			assert.ok(directories.includes('C:\\Users\\me\\AppData\\Roaming\\npm'));
		});

		test('Windows path comparison ignores case, because the filesystem does', () => {
			const directories = executableSearchDirectories({ platform: 'win32', pathEnv: 'C:\\Bin;c:\\bin', home: 'C:\\Users\\me' });
			assert.strictEqual(directories.filter(entry => entry.toLowerCase() === 'c:\\bin').length, 1);
		});

		test('an empty or absent PATH still searches where installers put things', () => {
			assert.ok(executableSearchDirectories({ platform: 'linux', pathEnv: undefined, home: '/home/dev' }).length > 0);
			assert.ok(executableSearchDirectories({ platform: 'linux', pathEnv: '', home: '/home/dev' }).length > 0);
		});

		test('Homebrew on Apple Silicon is only looked for on macOS', () => {
			assert.ok(executableSearchDirectories({ platform: 'darwin', pathEnv: '', home: '/Users/me' }).includes('/opt/homebrew/bin'));
			assert.ok(!executableSearchDirectories({ platform: 'linux', pathEnv: '', home: '/home/dev' }).includes('/opt/homebrew/bin'));
		});
	});

	suite('the command table', () => {

		test('every agent the vault knows can be looked for', () => {
			// The two tables are joined by id, so an id in one and not the other is
			// an agent that silently reports "not found" forever.
			for (const source of KINGU_VAULT_SOURCES) {
				assert.ok(KINGU_AGENT_COMMANDS[source.id]?.length, `${source.id} has no command to look for`);
			}
		});

		test('it names nothing the vault does not know', () => {
			const known = new Set(KINGU_VAULT_SOURCES.map(source => source.id as string));
			for (const id of Object.keys(KINGU_AGENT_COMMANDS)) {
				assert.ok(known.has(id), `${id} is not a vault source`);
			}
		});

		test('the flattened list is what the scan asks each directory for', () => {
			assert.strictEqual(new Set(KNOWN_AGENT_COMMANDS).size, KNOWN_AGENT_COMMANDS.length);
			for (const commands of Object.values(KINGU_AGENT_COMMANDS)) {
				for (const command of commands) {
					assert.ok(KNOWN_AGENT_COMMANDS.includes(command), command);
				}
			}
		});
	});
});
