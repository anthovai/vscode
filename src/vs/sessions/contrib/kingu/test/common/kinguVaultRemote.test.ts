/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { fromAgentHostUri } from '../../../../../platform/agentHost/common/agentHostUri.js';
import { IKinguRemoteHostCandidate, remoteHomeUri, remoteVaultHosts } from '../../common/kinguVaultRemote.js';

function host(overrides: Partial<IKinguRemoteHostCandidate> = {}): IKinguRemoteHostCandidate {
	return { address: 'build-box', name: 'Build box', defaultDirectory: '/home/dev', status: { kind: 'connected' }, ...overrides };
}

suite('Kingu vault remote hosts', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a connected host becomes a home the file service can walk', () => {
		const [entry] = remoteVaultHosts([host()]);
		assert.strictEqual(entry.label, 'Build box');
		assert.strictEqual(entry.home.scheme, 'vscode-agent-host');
		assert.strictEqual(fromAgentHostUri(entry.home).path, '/home/dev');
	});

	test('only a connected host: a configured one is not dialled to read it', () => {
		for (const kind of ['connecting', 'reconnecting', 'disconnected', 'incompatible']) {
			assert.deepStrictEqual(remoteVaultHosts([host({ status: { kind } })]), [], kind);
		}
	});

	test('a host that never said where its home is gets no guess', () => {
		assert.deepStrictEqual(remoteVaultHosts([host({ defaultDirectory: undefined })]), []);
		assert.deepStrictEqual(remoteVaultHosts([host({ defaultDirectory: '   ' })]), []);
	});

	test('the same home reached twice is one root, not two scans of it', () => {
		assert.strictEqual(remoteVaultHosts([host(), host({ defaultDirectory: '/home/dev/' })]).length, 1);
	});

	test('falls back to the address when the host carries no name', () => {
		assert.strictEqual(remoteVaultHosts([host({ name: '' })])[0].label, 'build-box');
	});

	suite('remoteHomeUri', () => {

		test('keeps a Windows host own path, given the leading slash a URI needs', () => {
			const home = remoteHomeUri('win-box', 'C:\\Users\\me');
			assert.strictEqual(fromAgentHostUri(home!).path, '/C:/Users/me');
		});

		test('two hosts get two authorities, so their sessions cannot be confused', () => {
			assert.notStrictEqual(remoteHomeUri('a', '/home/dev')!.authority, remoteHomeUri('b', '/home/dev')!.authority);
		});

		test('a trailing separator is not part of the path', () => {
			assert.strictEqual(fromAgentHostUri(remoteHomeUri('a', '/home/dev/')!).path, '/home/dev');
		});
	});
});
