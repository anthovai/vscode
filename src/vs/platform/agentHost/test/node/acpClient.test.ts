/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ACP_AGENT_CATALOG } from '../../common/acpAgentCatalog.js';
import { candidateEnv } from '../../node/acp/acpAgentProfiles.js';
import { resolveAcpCommand } from '../../node/acp/acpClient.js';

(isWindows ? suite : suite.skip)('resolveAcpCommand (Windows shims)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;

	setup(async () => {
		dir = await fs.mkdtemp(join(tmpdir(), 'acp-shims-'));
		// An npm shim, pointing at the script it runs.
		await fs.writeFile(join(dir, 'npmtool.cmd'), '@ECHO off\r\n"%~dp0\\node_modules\\npmtool\\cli.js" %*\r\n');
		await fs.mkdir(join(dir, 'node_modules', 'npmtool'), { recursive: true });
		await fs.writeFile(join(dir, 'node_modules', 'npmtool', 'cli.js'), '');
		// A shim of another kind, as Cursor's CLI installs: it hands over to PowerShell.
		await fs.writeFile(join(dir, 'othertool.cmd'), '@echo off\r\npowershell.exe -NoProfile -File "%~dp0\\othertool.ps1" %*\r\n');
	});

	teardown(() => fs.rm(dir, { recursive: true, force: true }));

	test('runs an npm shim\'s script directly, and any other shim through cmd', async () => {
		const env = { PATH: dir, ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
		const npm = await resolveAcpCommand('npmtool', ['acp'], env);
		const other = await resolveAcpCommand('othertool', ['acp'], env);
		assert.deepStrictEqual({
			npmScript: npm?.args.slice(-2),
			other: other && { command: other.command, args: other.args },
			missing: await resolveAcpCommand('absent', ['acp'], env),
		}, {
			npmScript: [join(dir, 'node_modules\\npmtool\\cli.js'), 'acp'],
			other: { command: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/c', join(dir, 'othertool.cmd'), 'acp'] },
			missing: undefined,
		});
	});

	test('finds Cursor in its install folder when PATH does not name it', async () => {
		await fs.mkdir(join(dir, 'cursor-agent'));
		await fs.writeFile(join(dir, 'cursor-agent', 'cursor-agent.cmd'), '@echo off\r\n');
		const cursor = ACP_AGENT_CATALOG.find(entry => entry.id === 'cursor')!;
		const env = { Path: join(dir, 'elsewhere'), LOCALAPPDATA: dir, ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
		assert.deepStrictEqual({
			onPath: await resolveAcpCommand('cursor-agent', ['acp'], env),
			withInstallFolder: (await resolveAcpCommand('cursor-agent', ['acp'], candidateEnv(cursor, env)))?.args,
		}, {
			onPath: undefined,
			withInstallFolder: ['/d', '/c', join(dir, 'cursor-agent', 'cursor-agent.cmd'), 'acp'],
		});
	});
});
