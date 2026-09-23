/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { cpuBetweenSweeps, parseWindowsProcessTable, processSubtree } from '../../../../../platform/kinguHost/common/kinguProcessTable.js';

suite('Kingu process table', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const sweep = '0,0,8192,300,System Idle Process\r\n4,0,12288,700,System\r\n100,4,1000,5000,Kingu.exe\r\n200,100,2000,1000,pwsh.exe\r\n300,200,3000,0,node, the server\r\n400,4,500,0,other.exe\r\n';

	test('reads the sweep, a name with a comma included', () => {
		assert.deepStrictEqual(parseWindowsProcessTable(sweep).map(row => [row.pid, row.ppid, row.memory, row.name]), [
			[0, 0, 8192, 'System Idle Process'],
			[4, 0, 12288, 'System'],
			[100, 4, 1000, 'Kingu.exe'],
			[200, 100, 2000, 'pwsh.exe'],
			[300, 200, 3000, 'node, the server'],
			[400, 4, 500, 'other.exe'],
		]);
	});

	test('walks a subtree, and nothing for a pid that is not there', () => {
		const rows = parseWindowsProcessTable(sweep);
		assert.deepStrictEqual([[...processSubtree(rows, 100)].sort(), [...processSubtree(rows, 999)]], [[100, 200, 300], []]);
	});

	test('derives CPU from two sweeps as the ADE does, a first sweep reading zero', () => {
		const rows = parseWindowsProcessTable(sweep);
		const previous = new Map([[100, 4000], [200, 1000]]);
		// 1000 units of 100ns = 0.1ms over 1ms = 10% of one core.
		assert.deepStrictEqual([...cpuBetweenSweeps(previous, rows, 1).entries()].filter(([pid]) => pid >= 100), [[100, 10], [200, 0], [300, 0], [400, 0]]);
		assert.deepStrictEqual([...cpuBetweenSweeps(undefined, rows, 1).values()].every(value => value === 0), true);
	});
});
