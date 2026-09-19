/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { KinguVaultSource } from '../../common/kinguVault.js';
import {
	getKinguVaultEnvironmentSource,
	KINGU_VAULT_ROOT_OVERRIDES,
	normalizeAgentSessionsDir,
	registerKinguVaultEnvironmentSource,
	resolveRootOverride,
	wslDistroFromProfileName,
	wslDistroRoot,
} from '../../common/kinguVaultEnvironment.js';

suite('Kingu vault environment', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('resolveRootOverride', () => {

		const codex = KINGU_VAULT_ROOT_OVERRIDES.get(KinguVaultSource.Codex)![0];

		test('appends the suffix to the directory the variable names', () => {
			assert.strictEqual(resolveRootOverride(codex, '/opt/codex'), '/opt/codex/sessions');
			assert.strictEqual(resolveRootOverride(codex, 'C:\\codex'), 'C:\\codex\\sessions');
		});

		test('accepts a UNC path, which is how a WSL root is named from the host', () => {
			assert.strictEqual(resolveRootOverride(codex, '\\\\wsl.localhost\\Ubuntu\\opt'), '\\\\wsl.localhost\\Ubuntu\\opt\\sessions');
		});

		test('drops a relative value rather than resolving it', () => {
			// It would resolve against the reading process's working directory, which is
			// not the one the agent had when it set the variable.
			assert.strictEqual(resolveRootOverride(codex, 'codex'), undefined);
			assert.strictEqual(resolveRootOverride(codex, './codex'), undefined);
			assert.strictEqual(resolveRootOverride(codex, '../codex'), undefined);
		});

		test('drops an empty or absent value', () => {
			assert.strictEqual(resolveRootOverride(codex, undefined), undefined);
			assert.strictEqual(resolveRootOverride(codex, '   '), undefined);
		});

		test('trims a trailing separator rather than doubling it', () => {
			assert.strictEqual(resolveRootOverride(codex, '/opt/codex/'), '/opt/codex/sessions');
		});

		test('a variable that names the sessions directory outright gets no suffix', () => {
			const cline = KINGU_VAULT_ROOT_OVERRIDES.get(KinguVaultSource.Cline)![0];
			assert.strictEqual(resolveRootOverride(cline, '/srv/cline-sessions'), '/srv/cline-sessions');
		});
	});

	suite('normalizeAgentSessionsDir', () => {

		test('takes a sessions directory as given', () => {
			assert.strictEqual(normalizeAgentSessionsDir('/home/me/.pi/agent/sessions', '.pi'), '/home/me/.pi/agent/sessions');
		});

		test('completes an agent directory', () => {
			assert.strictEqual(normalizeAgentSessionsDir('/home/me/.pi/agent', '.pi'), '/home/me/.pi/agent/sessions');
		});

		test('completes the agent home', () => {
			assert.strictEqual(normalizeAgentSessionsDir('/home/me/.omp', '.omp'), '/home/me/.omp/agent/sessions');
		});

		test('takes anything else at face value', () => {
			assert.strictEqual(normalizeAgentSessionsDir('/srv/elsewhere', '.pi'), '/srv/elsewhere');
		});

		test('reads the leaf for the agent it was asked about, not the other one', () => {
			// `.omp` is not a level of a Pi tree, so it is just a directory name.
			assert.strictEqual(normalizeAgentSessionsDir('/home/me/.omp', '.pi'), '/home/me/.omp');
		});

		test('resolves through the Pi override end to end', () => {
			const pi = KINGU_VAULT_ROOT_OVERRIDES.get(KinguVaultSource.Pi)![0];
			assert.strictEqual(resolveRootOverride(pi, '/home/me/.pi'), '/home/me/.pi/agent/sessions');
		});
	});

	test('Prime Agent prefers its dedicated sessions variable over the agent directory', () => {
		const candidates = KINGU_VAULT_ROOT_OVERRIDES.get(KinguVaultSource.PrimeAgent)!;
		assert.strictEqual(candidates[0].variable, 'PRIME_AGENT_SESSION_DIR');
		assert.strictEqual(candidates.at(-1)!.variable, 'PRIME_AGENT_CODING_AGENT_DIR');
	});

	suite('wslDistroFromProfileName', () => {

		test('reads the distribution out of a terminal profile name', () => {
			assert.strictEqual(wslDistroFromProfileName('Ubuntu (WSL)'), 'Ubuntu');
			assert.strictEqual(wslDistroFromProfileName('Ubuntu-22.04 (WSL)'), 'Ubuntu-22.04');
		});

		test('ignores a profile that is not a distribution', () => {
			assert.strictEqual(wslDistroFromProfileName('PowerShell'), undefined);
			assert.strictEqual(wslDistroFromProfileName('Git Bash'), undefined);
		});

		test('skips the Docker Desktop distributions, which hold no agent history', () => {
			assert.strictEqual(wslDistroFromProfileName('docker-desktop (WSL)'), undefined);
			assert.strictEqual(wslDistroFromProfileName('docker-desktop-data (WSL)'), undefined);
		});
	});

	test('wslDistroRoot names the host-side path of a distribution', () => {
		assert.strictEqual(wslDistroRoot('Ubuntu'), '//wsl.localhost/Ubuntu');
	});

	test('the environment source is absent until a host registers one', () => {
		assert.strictEqual(getKinguVaultEnvironmentSource(), undefined);
		const environment = { homeDirectories: [], rootOverrides: new Map() };
		const registration = registerKinguVaultEnvironmentSource({ resolve: async () => environment });
		assert.ok(getKinguVaultEnvironmentSource());
		registration.dispose();
		// Disposal has to clear it, or a reloaded window keeps answering from a
		// service that has been torn down.
		assert.strictEqual(getKinguVaultEnvironmentSource(), undefined);
	});
});
