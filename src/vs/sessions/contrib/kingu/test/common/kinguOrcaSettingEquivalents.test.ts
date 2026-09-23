/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IKinguSettingEquivalent, KINGU_SETTING_EQUIVALENTS, orcaValueFor, vscodeValueFor } from '../../common/kinguOrcaSettingEquivalents.js';
import { orcaSettingIdForKey } from '../../common/kinguOrcaSettings.js';

function pair(orcaKey: string): IKinguSettingEquivalent {
	const found = KINGU_SETTING_EQUIVALENTS.find(equivalent => equivalent.orcaKey === orcaKey);
	assert.ok(found, orcaKey);
	return found;
}

suite('kinguOrcaSettingEquivalents', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('binds only settings the Agents Window actually offers, each once', () => {
		const orcaKeys = KINGU_SETTING_EQUIVALENTS.map(equivalent => equivalent.orcaKey);
		const vscodeKeys = KINGU_SETTING_EQUIVALENTS.map(equivalent => equivalent.vscodeKey);
		assert.deepStrictEqual(
			[orcaKeys.filter(key => orcaSettingIdForKey(key) === undefined), new Set(orcaKeys).size === orcaKeys.length, new Set(vscodeKeys).size === vscodeKeys.length],
			[[], true, true]);
	});

	test('translates the values the two spell differently', () => {
		assert.deepStrictEqual(
			[
				vscodeValueFor(pair('terminalCursorStyle'), 'bar', 'block'),
				orcaValueFor(pair('terminalCursorStyle'), 'line', 'block'),
				orcaValueFor(pair('terminalFontWeight'), 'bold', 400),
				orcaValueFor(pair('terminalLineHeight'), 5, 1),
				orcaValueFor(pair('diffShowWhitespace'), true, true),
				vscodeValueFor(pair('diffDefaultView'), 'inline', true),
				orcaValueFor(pair('httpProxyBypassRules'), ['localhost', ' *.corp ', ''], ''),
				vscodeValueFor(pair('httpProxyBypassRules'), 'localhost;*.corp', []),
			],
			['line', 'bar', 700, 3, false, false, 'localhost;*.corp', ['localhost', '*.corp']]);
	});

	test('keeps each side\'s own spelling when it already means the same', () => {
		assert.deepStrictEqual(
			[
				// The ADE's `auto` ligatures agree with VS Code's `false`.
				orcaValueFor(pair('terminalLigatures'), false, 'auto'),
				// Switching auto save on keeps VS Code's choice of when.
				vscodeValueFor(pair('editorAutoSave'), true, 'onFocusChange'),
				vscodeValueFor(pair('editorAutoSave'), true, 'off'),
				// VS Code's `normal` is the ADE's 400.
				vscodeValueFor(pair('terminalFontWeight'), 400, 'normal'),
				// Right-click paste switched off falls back to VS Code's default.
				vscodeValueFor(pair('terminalRightClickToPaste'), false, 'paste'),
				vscodeValueFor(pair('terminalRightClickToPaste'), false, 'selectWord'),
			],
			['auto', 'onFocusChange', 'afterDelay', 'normal', 'default', 'selectWord']);
	});

	test('leaves a side alone where the other says nothing it can use', () => {
		assert.deepStrictEqual(
			[orcaValueFor(pair('terminalFontFamily'), '', 'Menlo'), orcaValueFor(pair('diffWordWrap'), 'inherit', undefined), vscodeValueFor(pair('editorFontFamily'), '', 'Consolas')],
			[undefined, undefined, undefined]);
	});
});
