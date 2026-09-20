/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IKinguVaultSession, KinguVaultSource } from '../../common/kinguVault.js';
import { KinguVaultDescriptionCache } from '../../common/kinguVaultCache.js';

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

	test('counts what it saved, which is what a scan reports', () => {
		const cache = new KinguVaultDescriptionCache();
		cache.set('a', { mtime: 1, size: 1 }, session('a'));
		cache.set('b', { mtime: 1, size: 1 }, session('b'));
		cache.get('a', { mtime: 1, size: 1 });
		cache.get('b', { mtime: 2, size: 1 });
		assert.deepStrictEqual(cache.stats, { reused: 1, read: 2 });
		cache.resetStats();
		assert.deepStrictEqual(cache.stats, { reused: 0, read: 0 });
		// Resetting the counters must not throw away the work they counted.
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
