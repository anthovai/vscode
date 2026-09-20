/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	classifyHost,
	isBetterAdvertisedUrl,
	isUnspecifiedHost,
	KinguAdvertisedUrlCache,
	KinguHostKind,
	readAdvertisedUrl,
	readAdvertisedUrls,
} from '../../common/kinguAdvertisedUrls.js';

const NOW = 1_800_000_000_000;

suite('Kingu advertised URLs', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('reading a line a dev server printed', () => {

		test('reads the address out of the line Vite prints', () => {
			const [url] = readAdvertisedUrls('  ➜  Local:   http://localhost:5173/', NOW);
			assert.strictEqual(url.url, 'http://localhost:5173/');
			assert.strictEqual(url.port, 5173);
			assert.strictEqual(url.hostKind, KinguHostKind.Loopback);
		});

		test('keeps the path, which is the part a port number cannot carry', () => {
			const [url] = readAdvertisedUrls('Serving on http://localhost:8000/admin/', NOW);
			assert.strictEqual(url.url, 'http://localhost:8000/admin/');
		});

		test('keeps https, which is the other part a port number cannot carry', () => {
			const [url] = readAdvertisedUrls('Listening at https://localhost:8443/', NOW);
			assert.strictEqual(url.protocol, 'https');
			assert.strictEqual(url.port, 8443);
		});

		test('a line naming several addresses yields each of them', () => {
			const urls = readAdvertisedUrls('Local: http://localhost:3000/  Network: http://192.168.1.5:3000/', NOW);
			assert.deepStrictEqual(urls.map(url => url.hostKind), [KinguHostKind.Loopback, KinguHostKind.PrivateIp]);
		});

		test('a bind-everything address is rewritten to somewhere that can be opened', () => {
			// `http://0.0.0.0:3000` is what the server bound to, not an address to visit.
			const [url] = readAdvertisedUrls('Running on http://0.0.0.0:3000', NOW);
			assert.strictEqual(url.url, 'http://localhost:3000/');
		});

		test('the punctuation that ended the sentence is not part of the address', () => {
			const [url] = readAdvertisedUrls('Open http://localhost:3000/app.', NOW);
			assert.strictEqual(url.url, 'http://localhost:3000/app');
		});

		test('a default port is implied when the address states none', () => {
			assert.strictEqual(readAdvertisedUrls('See http://example.test/', NOW)[0].port, 80);
			assert.strictEqual(readAdvertisedUrls('See https://example.test/', NOW)[0].port, 443);
		});

		test('a line with no address costs nothing and yields nothing', () => {
			assert.deepStrictEqual(readAdvertisedUrls('compiled 42 modules in 310ms', NOW), []);
			assert.deepStrictEqual(readAdvertisedUrls('', NOW), []);
		});

		test('a line long enough to be a bundle is not scanned', () => {
			const bundle = `http://localhost:3000/ ${'x'.repeat(4000)}`;
			assert.deepStrictEqual(readAdvertisedUrls(bundle, NOW), []);
		});

		test('a scheme that is not the web is not an address to open', () => {
			assert.strictEqual(readAdvertisedUrl('ws://localhost:3000', NOW), undefined);
			assert.strictEqual(readAdvertisedUrl('postgres://localhost:5432/db', NOW), undefined);
			assert.strictEqual(readAdvertisedUrl('not a url', NOW), undefined);
		});
	});

	suite('classifying where an address points', () => {

		test('loopback in each of its spellings', () => {
			for (const host of ['localhost', '127.0.0.1', '::1', '[::1]']) {
				assert.strictEqual(classifyHost(host), KinguHostKind.Loopback, host);
			}
		});

		test('the private ranges a machine can reach and nobody else can', () => {
			for (const host of ['10.1.2.3', '172.16.0.1', '192.168.1.5', '169.254.1.1', 'fd00::1', 'fe80::1']) {
				assert.strictEqual(classifyHost(host), KinguHostKind.PrivateIp, host);
			}
		});

		test('anything else routable is public', () => {
			assert.strictEqual(classifyHost('8.8.8.8'), KinguHostKind.PublicIp);
			assert.strictEqual(classifyHost('2606:4700::1'), KinguHostKind.PublicIp);
		});

		test('a name is a name, which is what a project arranges deliberately', () => {
			assert.strictEqual(classifyHost('app.localhost'), KinguHostKind.Custom);
			assert.strictEqual(classifyHost('myproject.test'), KinguHostKind.Custom);
		});

		test('a bind-everything placeholder is recognised as one', () => {
			for (const host of ['0.0.0.0', '::', '[::]', '*']) {
				assert.ok(isUnspecifiedHost(host), host);
			}
			assert.ok(!isUnspecifiedHost('localhost'));
		});
	});

	suite('choosing between two addresses for one port', () => {

		const at = (url: string, seenAt = NOW) => readAdvertisedUrl(url, seenAt)!;

		test('a name the project arranged beats loopback', () => {
			assert.ok(isBetterAdvertisedUrl(at('http://localhost:3000'), at('http://app.localhost:3000')));
			assert.ok(!isBetterAdvertisedUrl(at('http://app.localhost:3000'), at('http://localhost:3000')));
		});

		test('loopback beats a LAN address, because this machine is the one asking', () => {
			assert.ok(isBetterAdvertisedUrl(at('http://192.168.1.5:3000'), at('http://localhost:3000')));
		});

		test('https beats http when the server announced both', () => {
			assert.ok(isBetterAdvertisedUrl(at('http://localhost:3000'), at('https://localhost:3000')));
			assert.ok(!isBetterAdvertisedUrl(at('https://localhost:3000'), at('http://localhost:3000')));
		});

		test('otherwise the newer announcement wins, because a restart is news', () => {
			assert.ok(isBetterAdvertisedUrl(at('http://localhost:3000/old', NOW), at('http://localhost:3000/new', NOW + 1)));
			assert.ok(!isBetterAdvertisedUrl(at('http://localhost:3000/new', NOW + 1), at('http://localhost:3000/old', NOW)));
		});
	});

	suite('what the window remembers', () => {

		test('keeps the best address per port and says when it changed', () => {
			const cache = new KinguAdvertisedUrlCache();
			assert.deepStrictEqual(cache.record(readAdvertisedUrls('Local: http://localhost:3000/', NOW)), [3000]);
			// A worse address for the same port changes nothing.
			assert.deepStrictEqual(cache.record(readAdvertisedUrls('Network: http://192.168.1.5:3000/', NOW + 1)), []);
			assert.strictEqual(cache.get(3000)?.url, 'http://localhost:3000/');
		});

		test('a repeated announcement is not a change, so nothing redraws', () => {
			const cache = new KinguAdvertisedUrlCache();
			cache.record(readAdvertisedUrls('Local: http://localhost:3000/', NOW));
			assert.deepStrictEqual(cache.record(readAdvertisedUrls('Local: http://localhost:3000/', NOW + 1)), []);
		});

		test('a port that stopped listening loses its address', () => {
			// The line stays in the scrollback after the server is gone; without this
			// the next server on that port would inherit its URL and path.
			const cache = new KinguAdvertisedUrlCache();
			cache.record(readAdvertisedUrls('Local: http://localhost:3000/admin', NOW));
			cache.retain(new Set([5173]));
			assert.strictEqual(cache.get(3000), undefined);
		});

		test('is bounded, because the keys come from terminal output', () => {
			const cache = new KinguAdvertisedUrlCache(2);
			for (const port of [3000, 3001, 3002]) {
				cache.record(readAdvertisedUrls(`Local: http://localhost:${port}/`, NOW));
			}
			assert.strictEqual(cache.size, 2);
			assert.strictEqual(cache.get(3000), undefined);
			assert.ok(cache.get(3002));
		});
	});
});
