/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { artifactContentTypeForFile, artifactDisplayTitle, artifactExpiryLabel, formatArtifactBytes, IKinguArtifact, readArtifactOperation } from '../../common/kinguArtifacts.js';

function item(title: string | null, originalFileName: string | null): IKinguArtifact {
	return {
		artifact: { slug: 'abc', title, originalFileName, sourceContentType: 'text/markdown', createdAt: '', updatedAt: '', expiresAt: '', byteSize: 1 },
		shareUrl: 'http://127.0.0.1:8787/a/abc',
	};
}

suite('kinguArtifacts', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the runtime’s answer as what the page shows', () => {
		assert.deepStrictEqual([
			readArtifactOperation({ ok: true, result: { status: 'ok', value: 7 } }),
			readArtifactOperation({ ok: true, result: { status: 'reconnect-required' } }),
			readArtifactOperation({ ok: true, result: { status: 'unconfigured', message: 'No cloud' } }),
			readArtifactOperation({ ok: false, error: { code: 'runtime_error', message: 'boom' } }),
			readArtifactOperation(undefined).kind,
		], [
			{ kind: 'ok', value: 7 },
			{ kind: 'signIn' },
			{ kind: 'unconfigured', message: 'No cloud' },
			{ kind: 'error', message: 'boom' },
			'error',
		]);
	});

	test('names files, titles, sizes and expiry as the ADE labels them', () => {
		const now = new Date('2026-09-26T00:00:00Z');
		assert.deepStrictEqual({
			types: ['a.md', 'b.MARKDOWN', 'c.html', 'd.htm', 'e.txt', 'noext'].map(name => artifactContentTypeForFile(name) ?? null),
			titles: [artifactDisplayTitle(item('Report', 'r.md')), artifactDisplayTitle(item('  ', 'r.md')), artifactDisplayTitle(item(null, null))],
			sizes: [512, 2048, 3 * 1024 * 1024].map(formatArtifactBytes),
			expiry: ['2026-10-26T00:00:00Z', '2026-09-26T12:00:00Z', '2026-09-25T00:00:00Z', 'nope'].map(at => artifactExpiryLabel(at, now)),
		}, {
			types: ['text/markdown', 'text/markdown', 'text/html', 'text/html', null, null],
			titles: ['Report', 'r.md', 'abc'],
			sizes: ['512 B', '2.0 KB', '3.0 MB'],
			expiry: ['30 days left', '1 day left', 'Expired', '-'],
		});
	});
});
