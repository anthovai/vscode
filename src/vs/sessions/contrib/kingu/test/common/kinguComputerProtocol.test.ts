/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	decodeComputerReply,
	describeComputerAction,
	encodeComputerRequest,
	isComputerToolAllowed,
	isReadOnlyComputerTool,
	KINGU_COMPUTER_INPUT_TOOLS,
	KINGU_COMPUTER_READ_TOOLS,
	KinguComputerLineReader,
} from '../../../../../platform/kinguComputer/common/kinguComputerProtocol.js';

suite('Kingu desktop protocol', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('what may be asked', () => {

		test('the four that read', () => {
			assert.deepStrictEqual([...KINGU_COMPUTER_READ_TOOLS], ['handshake', 'list_apps', 'list_windows', 'get_app_state']);
		});

		test('nothing that acts is a read', () => {
			for (const tool of KINGU_COMPUTER_INPUT_TOOLS) {
				assert.ok(!isReadOnlyComputerTool(tool), tool);
			}
		});

		test('the two lists do not overlap, which is the whole safety property', () => {
			const reads = new Set<string>(KINGU_COMPUTER_READ_TOOLS);
			for (const tool of KINGU_COMPUTER_INPUT_TOOLS) {
				assert.ok(!reads.has(tool), tool);
			}
		});
	});

	suite('the gate', () => {

		test('reading needs no permission', () => {
			for (const tool of KINGU_COMPUTER_READ_TOOLS) {
				assert.ok(isComputerToolAllowed(tool, false), tool);
			}
		});

		test('acting is refused until it is permitted', () => {
			for (const tool of KINGU_COMPUTER_INPUT_TOOLS) {
				assert.ok(!isComputerToolAllowed(tool, false), tool);
				assert.ok(isComputerToolAllowed(tool, true), tool);
			}
		});

		test('a tool in neither list is refused even when acting is permitted', () => {
			// The runtime accepts names this host has never heard of; forwarding one
			// would mean the gate only covers what it happens to know about.
			assert.ok(!isComputerToolAllowed('run_script', true));
			assert.ok(!isComputerToolAllowed('', true));
		});
	});

	suite('what a confirmation says', () => {

		test('quotes the text in full, because that is the thing worth seeing', () => {
			const text = describeComputerAction({ tool: 'type_text', app: 'Notepad', text: 'rm -rf /' });
			assert.ok(text.includes('"rm -rf /"'), text);
			assert.ok(text.includes('Notepad'), text);
		});

		test('says that a paste goes through the clipboard, which a type does not', () => {
			assert.ok(describeComputerAction({ tool: 'paste_text', app: 'Notepad', text: 'x' }).includes('clipboard'));
			assert.ok(!describeComputerAction({ tool: 'type_text', app: 'Notepad', text: 'x' }).includes('clipboard'));
		});

		test('names the key a keystroke will send', () => {
			assert.ok(describeComputerAction({ tool: 'press_key', app: 'Notepad', key: 'enter' }).includes('enter'));
		});

		test('a read describes itself as one', () => {
			assert.ok(describeComputerAction({ tool: 'list_apps' }).startsWith('Read'));
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

		test('an action carries what it needs, under the runtime spellings', () => {
			const line = JSON.parse(encodeComputerRequest(1, { tool: 'click', app: 'Notepad', mouseButton: 'right', clickCount: 2 }));
			assert.strictEqual(line.mouse_button, 'right');
			assert.strictEqual(line.click_count, 2);
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
