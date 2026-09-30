/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { kinguChatTabsAfterClose, kinguChatTabsWith } from '../../common/kinguChatTabs.js';

suite('kinguChatTabs', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const [a, b, c] = ['a', 'b', 'c'].map(id => URI.parse(`agent-host-arkai:/${id}`));
	const ids = (tabs: readonly URI[] | undefined) => tabs?.map(tab => tab.path);

	test('adds only the chats it lacks, at the end, in order', () => {
		assert.deepStrictEqual(ids(kinguChatTabsWith([a], [b, a, c])), ['/a', '/b', '/c']);
	});

	test('shows the next tab after closing the open one, the previous at the end, and nothing when none is left', () => {
		const shown = (tabs: URI[], closed: URI, active: URI | undefined) => {
			const result = kinguChatTabsAfterClose(tabs, closed, active);
			return { tabs: ids(result.tabs), next: result.next?.path };
		};
		assert.deepStrictEqual([
			shown([a, b, c], b, b),
			shown([a, b, c], c, c),
			shown([a, b, c], a, c),
			shown([a], a, a),
		], [
			{ tabs: ['/a', '/c'], next: '/c' },
			{ tabs: ['/a', '/b'], next: '/b' },
			{ tabs: ['/b', '/c'], next: undefined },
			{ tabs: [], next: undefined },
		]);
	});
});
