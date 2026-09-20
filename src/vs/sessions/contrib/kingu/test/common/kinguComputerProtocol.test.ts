/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	decodeComputerReply,
	encodeComputerRequest,
	isReadOnlyComputerTool,
	KINGU_COMPUTER_READ_TOOLS,
	KinguComputerLineReader,
} from '../../../../../platform/kinguComputer/common/kinguComputerProtocol.js';

suite('Kingu desktop protocol', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('what may be asked', () => {

		test('the four that read', () => {
			assert.deepStrictEqual([...KINGU_COMPUTER_READ_TOOLS], ['handshake', 'list_apps', 'list_windows', 'get_app_state']);
		});

		test('nothing that acts', () => {
			// The runtime can do all of these. This host is the reason it cannot be
			// asked to, so the refusal is the contract and not an oversight.
			for (const tool of ['click', 'type_text', 'press_key', 'hotkey', 'paste_text', 'drag', 'scroll', 'set_value']) {
				assert.ok(!isReadOnlyComputerTool(tool), tool);
			}
		});
	});

	suite('encoding a request', () => {

		test('carries the id the reply must echo', () => {
			const line = JSON.parse(encodeComputerRequest(7, { tool: 'list_apps' }));
			assert.strictEqual(line.requestId, 7);
			assert.strictEqual(line.tool, 'list_apps');
		});

		test('a screenshot is off unless it was asked for', () => {
			// Megabytes of base64 across two process boundaries, for an image only
			// worth sending when something is going to look at it.
			assert.strictEqual(JSON.parse(encodeComputerRequest(1, { tool: 'get_app_state', app: 'Kingu' })).noScreenshot, true);
			assert.strictEqual(JSON.parse(encodeComputerRequest(1, { tool: 'get_app_state', app: 'Kingu', includeScreenshot: true })).noScreenshot, false);
		});

		test('an absent field is absent rather than null', () => {
			const line = JSON.parse(encodeComputerRequest(1, { tool: 'list_apps' })) as Record<string, unknown>;
			assert.deepStrictEqual(Object.keys(line).sort(), ['noScreenshot', 'requestId', 'tool']);
		});
	});

	suite('decoding a reply', () => {

		test('a success carries its payload', () => {
			const reply = decodeComputerReply('{"requestId":3,"ok":true,"apps":["Kingu"]}');
			assert.strictEqual(reply?.requestId, 3);
			assert.strictEqual(reply?.result.ok, true);
		});

		test('a failure carries the reason the runtime gave', () => {
			const reply = decodeComputerReply('{"requestId":3,"ok":false,"error":"No such application"}');
			assert.deepStrictEqual(reply?.result, { ok: false, error: 'No such application' });
		});

		test('a failure with no reason still reads as a failure', () => {
			const reply = decodeComputerReply('{"requestId":3,"ok":false}');
			assert.strictEqual(reply?.result.ok, false);
		});

		test('a line that is not a reply is ignored rather than fatal', () => {
			// The runtime's own diagnostics go to stderr, but a stray line on stdout
			// is not worth killing a session over.
			assert.strictEqual(decodeComputerReply('PowerShell banner text'), undefined);
			assert.strictEqual(decodeComputerReply('{"ok":true}'), undefined);
			assert.strictEqual(decodeComputerReply('null'), undefined);
		});
	});

	suite('reading the stream', () => {

		test('a reply split across chunks is one line', () => {
			// A snapshot with a screenshot runs to megabytes and never arrives whole.
			const reader = new KinguComputerLineReader();
			assert.deepStrictEqual(reader.read('{"requestId":1,'), []);
			assert.deepStrictEqual(reader.read('"ok":true}\n'), ['{"requestId":1,"ok":true}']);
		});

		test('several replies in one chunk are several lines', () => {
			const reader = new KinguComputerLineReader();
			assert.deepStrictEqual(reader.read('a\nb\n'), ['a', 'b']);
		});

		test('a partial tail waits rather than being emitted', () => {
			const reader = new KinguComputerLineReader();
			assert.deepStrictEqual(reader.read('whole\npartial'), ['whole']);
			assert.deepStrictEqual(reader.read('\n'), ['partial']);
		});

		test('a runtime that never sends a newline cannot grow the buffer forever', () => {
			const reader = new KinguComputerLineReader(16);
			assert.deepStrictEqual(reader.read('x'.repeat(32)), []);
			// The buffer was dropped, so the next complete line still reads.
			assert.deepStrictEqual(reader.read('after\n'), ['after']);
		});
	});
});
