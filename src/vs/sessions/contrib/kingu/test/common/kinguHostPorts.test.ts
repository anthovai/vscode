/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	describeListeningPort,
	isInterestingPort,
	nameListeningPorts,
	normalizeListeningPorts,
	parseLsofPorts,
	parseNetstatPorts,
	parseSsPorts,
} from '../../../../../platform/kinguHost/common/kinguHostPorts.js';

suite('Kingu listening ports', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('netstat, on Windows', () => {

		const output = [
			'Active Connections',
			'',
			'  Proto  Local Address          Foreign Address        State           PID',
			'  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       4242',
			'  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       99',
			'  TCP    192.168.1.5:50912      140.82.112.4:443       ESTABLISHED     77',
			'  TCP    [::]:3000              [::]:0                 LISTENING       4242',
			'  UDP    0.0.0.0:5353           *:*                                    12',
		].join('\r\n');

		test('takes the listening TCP sockets and their owners', () => {
			assert.deepStrictEqual(parseNetstatPorts(output), [
				{ port: 3000, address: '0.0.0.0', pid: 4242 },
				{ port: 5173, address: '127.0.0.1', pid: 99 },
				{ port: 3000, address: '::', pid: 4242 },
			]);
		});

		test('an established connection is not a port this machine serves', () => {
			assert.ok(!parseNetstatPorts(output).some(entry => entry.port === 50912));
		});
	});

	suite('lsof, on macOS', () => {

		test('reads the bind out of the last column', () => {
			const output = [
				'COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
				'node    41522   me   23u  IPv4 0x8a1b2c3d4e5f6071      0t0  TCP *:3000 (LISTEN)',
				'node    41522   me   24u  IPv6 0x8a1b2c3d4e5f6072      0t0  TCP [::1]:5173 (LISTEN)',
			].join('\n');
			assert.deepStrictEqual(parseLsofPorts(output), [
				{ port: 3000, address: '*', pid: 41522 },
				{ port: 5173, address: '::1', pid: 41522 },
			]);
		});
	});

	suite('ss, on Linux', () => {

		test('reads the bind and the owner out of the users column', () => {
			const output = [
				'LISTEN 0      511          0.0.0.0:3000       0.0.0.0:*    users:(("node",pid=1234,fd=20))',
				'LISTEN 0      4096           [::1]:5173          [::]:*    users:(("node",pid=1235,fd=21))',
			].join('\n');
			assert.deepStrictEqual(parseSsPorts(output), [
				{ port: 3000, address: '0.0.0.0', pid: 1234 },
				{ port: 5173, address: '::1', pid: 1235 },
			]);
		});

		test('a socket with no owner is read, and dropped later for having none', () => {
			const output = 'LISTEN 0      128          0.0.0.0:22         0.0.0.0:*';
			assert.deepStrictEqual(parseSsPorts(output), [{ port: 22, address: '0.0.0.0', pid: undefined }]);
			assert.deepStrictEqual(normalizeListeningPorts(parseSsPorts(output), new Set([1])), []);
		});
	});

	suite('what counts as a port worth showing', () => {

		test('a loopback or wildcard bind does', () => {
			for (const address of ['0.0.0.0', '::', '*', '127.0.0.1', '::1']) {
				assert.ok(isInterestingPort({ port: 3000, address, pid: undefined }), address);
			}
		});

		test('a bind to one routable address is something else on the network', () => {
			assert.ok(!isInterestingPort({ port: 3000, address: '192.168.1.5', pid: undefined }));
		});

		test('the ephemeral range is outbound machinery, not a server', () => {
			assert.ok(!isInterestingPort({ port: 50912, address: '0.0.0.0', pid: undefined }));
		});
	});

	suite('normalizing', () => {

		const ours = new Set([77, 78]);

		test('one server on v4 and v6 is one port, not two', () => {
			assert.deepStrictEqual(normalizeListeningPorts([
				{ port: 3000, address: '::', pid: 77 },
				{ port: 3000, address: '0.0.0.0', pid: 77 },
			], ours), [{ port: 3000, address: '::', pid: 77 }]);
		});

		test('sorts by port, so the list does not reshuffle between readings', () => {
			const ports = normalizeListeningPorts([
				{ port: 8080, address: '0.0.0.0', pid: 78 },
				{ port: 3000, address: '0.0.0.0', pid: 77 },
			], ours);
			assert.deepStrictEqual(ports.map(entry => entry.port), [3000, 8080]);
		});

		test('a port belonging to the machine rather than to this app is not its news', () => {
			assert.deepStrictEqual(normalizeListeningPorts([{ port: 445, address: '0.0.0.0', pid: 4 }], ours), []);
		});

		test('an unattributable socket is left out rather than counted on a guess', () => {
			assert.deepStrictEqual(normalizeListeningPorts([{ port: 3000, address: '0.0.0.0', pid: undefined }], ours), []);
		});

		test('drops what is not worth showing rather than counting it', () => {
			assert.deepStrictEqual(normalizeListeningPorts([{ port: 3000, address: '10.0.0.4', pid: 77 }], ours), []);
		});
	});

	suite('naming', () => {

		test('attaches the owner the process tree knows', () => {
			const named = nameListeningPorts([{ port: 3000, address: '0.0.0.0', pid: 77 }], new Map([[77, 'node']]));
			assert.strictEqual(named[0].process, 'node');
			assert.strictEqual(describeListeningPort(named[0]), '3000 node');
		});

		test('a port whose owner is not in the tree keeps its number and nothing else', () => {
			const named = nameListeningPorts([{ port: 3000, address: '0.0.0.0', pid: 77 }], new Map());
			assert.strictEqual(named[0].process, undefined);
			assert.strictEqual(describeListeningPort(named[0]), '3000');
		});
	});
});
