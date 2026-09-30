/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { kinguAgentStatusText } from '../../common/kinguTitleBar.js';

suite('kinguTitleBar', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('names the agent when one session is in the state, and counts them when several are', () => {
		const claude = { providerLabel: 'Claude' };
		assert.deepStrictEqual([
			kinguAgentStatusText('working', [claude]),
			kinguAgentStatusText('working', [claude, claude, claude]),
			kinguAgentStatusText('waiting', [claude]),
			kinguAgentStatusText('waiting', [claude, claude]),
		], [
			'Claude working',
			'3 working',
			'Claude waiting for you',
			'2 waiting for you',
		]);
	});
});
