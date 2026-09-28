/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { orcaKeyForSettingId, orcaSettingIdForKey, orcaSettingsById, orcaSettingsPatch } from '../../common/kinguOrcaSettings.js';
import { KINGU_ORCA_SETTINGS, KINGU_ORCA_SETTINGS_PAGES } from '../../common/kinguOrcaSettingsSchema.js';

suite('kinguOrcaSettings', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('names a setting by the ADE page it is on, and turns the name back into the ADE key', () => {
		const id = orcaSettingIdForKey('branchPrefix');
		assert.deepStrictEqual([id, id && orcaKeyForSettingId(id), orcaSettingIdForKey('opencodeSessionCookie')], ['kingu.git.branchPrefix', 'branchPrefix', undefined]);
	});

	test('never offers a credential, a grant of trust or a migration marker', () => {
		const keys = new Set(KINGU_ORCA_SETTINGS.map(setting => setting.key));
		const forbidden = ['opencodeSessionCookie', 'claudeManagedAccounts', 'codexManagedAccounts', 'telemetry', 'pluginConsents', 'floatingTerminalTrustedCwds', 'agentDefaultEnv', 'keepComputerAwakeWhileAgentsRun', 'terminalMacOptionAsAltMigrated'];
		assert.deepStrictEqual(forbidden.filter(key => keys.has(key)), []);
	});

	test('files every setting under a page that exists, and ids are unique', () => {
		const pages = new Set(KINGU_ORCA_SETTINGS_PAGES.map(page => page.id));
		const ids = KINGU_ORCA_SETTINGS.map(setting => `kingu.${setting.page}.${setting.key}`);
		assert.deepStrictEqual([KINGU_ORCA_SETTINGS.filter(setting => !pages.has(setting.page)).length, new Set(ids).size === ids.length], [0, true]);
	});

	test('reads the ADE settings object by id, dropping what is not offered', () => {
		assert.deepStrictEqual(
			orcaSettingsById({ branchPrefix: 'custom', opencodeSessionCookie: 'secret', telemetry: { optedIn: true } }),
			{ 'kingu.git.branchPrefix': 'custom' });
	});

	test('reads keep-awake from the legacy boolean when a profile has only that', () => {
		const awake = orcaSettingIdForKey('computerAwakeMode')!;
		assert.deepStrictEqual(
			[orcaSettingsById({ keepComputerAwakeWhileAgentsRun: false })[awake], orcaSettingsById({ keepComputerAwakeWhileAgentsRun: true })[awake], orcaSettingsById({ computerAwakeMode: 'on', keepComputerAwakeWhileAgentsRun: false })[awake]],
			['off', 'auto', 'on']);
	});

	test('writes keep-awake as the ADE does, with the legacy boolean beside it', () => {
		const awake = orcaSettingIdForKey('computerAwakeMode')!;
		assert.deepStrictEqual(
			[orcaSettingsPatch({ [awake]: 'off' }), orcaSettingsPatch({ [awake]: 'auto', 'kingu.nothing.here': 1 })],
			[{ computerAwakeMode: 'off', keepComputerAwakeWhileAgentsRun: false }, { computerAwakeMode: 'auto', keepComputerAwakeWhileAgentsRun: true }]);
	});
});
