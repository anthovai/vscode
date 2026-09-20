/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IKinguVaultSession, KinguVaultSource } from '../../common/kinguVault.js';
import { createScanTally, KinguVaultDescriptionCache } from '../../common/kinguVaultCache.js';

function session(title: string): IKinguVaultSession {
	return {
		id: `claude:/home/dev/${title}`,
		source: KinguVaultSource.Claude,
		sourceLabel: 'Claude Code',
		rootRelativeSegments: ['p', `${title}.jsonl`],
		resource: URI.file(`/home/dev/${title}.jsonl`),
		contentResource: undefined,
		title,
		workingDirectory: '/home/dev',
		modified: 1,
	};
}

suite('Kingu vault description cache', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('answers a transcript whose stat has not moved', () => {
		const cache = new KinguVaultDescriptionCache();
		cache.set('a', { mtime: 10, size: 100 }, session('first'));
		assert.strictEqual(cache.get('a', { mtime: 10, size: 100 })?.title, 'first');
	});

	test('a transcript that was appended to is read again', () => {
		const cache = new KinguVaultDescriptionCache();
		cache.set('a', { mtime: 10, size: 100 }, session('first'));
		assert.strictEqual(cache.get('a', { mtime: 11, size: 100 }), undefined);
	});

	test('a same-second rewrite is caught by the length, which mtime alone would miss', () => {
		const cache = new KinguVaultDescriptionCache();
		cache.set('a', { mtime: 10, size: 100 }, session('first'));
		assert.strictEqual(cache.get('a', { mtime: 10, size: 140 }), undefined);
	});

	test('a filesystem that stopped reporting a size is not a match', () => {
		// It is a different statement about the file, not a weaker one.
		const cache = new KinguVaultDescriptionCache();
		cache.set('a', { mtime: 10, size: 100 }, session('first'));
		assert.strictEqual(cache.get('a', { mtime: 10, size: undefined }), undefined);
	});

	test('a size neither side reports cannot disagree', () => {
		const cache = new KinguVaultDescriptionCache();
		cache.set('a', { mtime: 10, size: undefined }, session('first'));
		assert.strictEqual(cache.get('a', { mtime: 10, size: undefined })?.title, 'first');
	});

	test('keys do not cross machines, because the same path exists on both', () => {
		const cache = new KinguVaultDescriptionCache();
		const stamp = { mtime: 10, size: 100 };
		cache.set('vscode-agent-host://a/home/dev/s.jsonl', stamp, session('theirs'));
		assert.strictEqual(cache.get('file:///home/dev/s.jsonl', stamp), undefined);
	});

	test('counts into the tally the caller brought, which is what a scan reports', () => {
		const cache = new KinguVaultDescriptionCache();
		const tally = createScanTally();
		cache.set('a', { mtime: 1, size: 1 }, session('a'), tally);
		cache.set('b', { mtime: 1, size: 1 }, session('b'), tally);
		cache.get('a', { mtime: 1, size: 1 }, tally);
		cache.get('b', { mtime: 2, size: 1 }, tally);
		assert.deepStrictEqual(tally, { reused: 1, read: 2 });
	});

	test('two overlapping scans each count only their own work', () => {
		// Which is why the tally is the caller's: the window invalidates several
		// times in a row while WSL homes resolve and a host connects, and a counter
		// on the cache would report the sum of whichever scans were in flight.
		const cache = new KinguVaultDescriptionCache();
		const first = createScanTally();
		const second = createScanTally();
		cache.set('a', { mtime: 1, size: 1 }, session('a'), first);
		cache.get('a', { mtime: 1, size: 1 }, second);
		assert.deepStrictEqual(first, { reused: 0, read: 1 });
		assert.deepStrictEqual(second, { reused: 1, read: 0 });
	});

	test('a lookup without a tally still works, for a caller that is not a scan', () => {
		const cache = new KinguVaultDescriptionCache();
		cache.set('a', { mtime: 1, size: 1 }, session('a'));
		assert.strictEqual(cache.get('a', { mtime: 1, size: 1 })?.title, 'a');
	});

	test('a deleted transcript is forgotten, so a new file cannot inherit its title', () => {
		const cache = new KinguVaultDescriptionCache();
		cache.set('a', { mtime: 10, size: 100 }, session('old'));
		cache.invalidate('a');
		assert.strictEqual(cache.get('a', { mtime: 10, size: 100 }), undefined);
	});

	test('evicts the least recently used, not the least recently written', () => {
		const cache = new KinguVaultDescriptionCache(2);
		const stamp = { mtime: 1, size: 1 };
		cache.set('a', stamp, session('a'));
		cache.set('b', stamp, session('b'));
		// Touching `a` makes `b` the coldest entry.
		cache.get('a', stamp);
		cache.set('c', stamp, session('c'));
		assert.strictEqual(cache.size, 2);
		assert.ok(cache.get('a', stamp), 'a was used most recently and should survive');
		assert.strictEqual(cache.get('b', stamp), undefined);
	});
});
