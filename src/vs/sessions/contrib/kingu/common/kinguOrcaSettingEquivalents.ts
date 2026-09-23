/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { equals } from '../../../../base/common/objects.js';

/**
 * One of the ADE's settings that means the same as one of this window's own.
 *
 * Bound, the two are one setting: the terminal font size a user sets is the
 * size of every terminal they see, whichever window drew it. The VS Code
 * setting is the one kept, because it is what this window's terminals and
 * editors actually read; the ADE's follows it.
 */
export interface IKinguSettingEquivalent {
	/** The key in the ADE's `GlobalSettings`. */
	readonly orcaKey: string;
	/** The setting this window registers for the same thing. */
	readonly vscodeKey: string;
	/**
	 * The ADE's value for a VS Code value, or `undefined` for "the ADE has no
	 * single spelling of this; leave it as it is".
	 */
	readonly toOrca: (vscode: unknown) => unknown;
	/**
	 * The VS Code value for an ADE value. `current` is the VS Code value in
	 * force, kept where the ADE value does not decide it — Orca's *auto
	 * save: on* says nothing about which of VS Code's three ways of saving to
	 * use.
	 */
	readonly toVsCode: (orca: unknown, current: unknown) => unknown;
}

function same(orcaKey: string, vscodeKey: string): IKinguSettingEquivalent {
	return { orcaKey, vscodeKey, toOrca: value => value, toVsCode: value => value };
}

/** A font weight as the ADE stores it: a number. VS Code also accepts `normal` and `bold`. */
function fontWeight(value: unknown): unknown {
	if (value === 'normal') {
		return 400;
	}
	if (value === 'bold') {
		return 700;
	}
	const number = typeof value === 'string' ? Number(value) : value;
	return typeof number === 'number' && Number.isFinite(number) ? number : undefined;
}

/**
 * A font family, where empty means "no opinion" on both sides — VS Code's
 * editor falls back to its own font, the ADE to its default. Carrying an empty
 * one across would set the other side's font to nothing.
 */
function fontFamily(value: unknown): unknown {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

/** A setting that is on unless it is `off`, with VS Code's non-`off` choice kept when switching on. */
function onUnlessOff(orcaKey: string, vscodeKey: string, onValue: string): IKinguSettingEquivalent {
	return {
		orcaKey,
		vscodeKey,
		toOrca: value => value !== 'off',
		toVsCode: (value, current) => value ? (typeof current === 'string' && current !== 'off' ? current : onValue) : 'off',
	};
}

/**
 * Every pair, and nothing that is only nearly the same.
 *
 * Left unbound on purpose: the ADE's theme (VS Code chooses a named theme; the
 * ADE only light, dark or system), its shell choices (VS Code chooses profiles,
 * not executables), and the few with no VS Code counterpart at all — focus
 * follows mouse, hiding the pointer while typing.
 */
export const KINGU_SETTING_EQUIVALENTS: readonly IKinguSettingEquivalent[] = [
	// The terminal.
	same('terminalFontSize', 'terminal.integrated.fontSize'),
	{ orcaKey: 'terminalFontFamily', vscodeKey: 'terminal.integrated.fontFamily', toOrca: fontFamily, toVsCode: fontFamily },
	{ orcaKey: 'terminalFontWeight', vscodeKey: 'terminal.integrated.fontWeight', toOrca: fontWeight, toVsCode: value => value },
	{ orcaKey: 'terminalFontWeightBold', vscodeKey: 'terminal.integrated.fontWeightBold', toOrca: fontWeight, toVsCode: value => value },
	// Both are multipliers of the font size; the ADE accepts one to three.
	{ orcaKey: 'terminalLineHeight', vscodeKey: 'terminal.integrated.lineHeight', toOrca: value => typeof value === 'number' ? Math.min(3, Math.max(1, value)) : undefined, toVsCode: value => value },
	{ orcaKey: 'terminalCursorStyle', vscodeKey: 'terminal.integrated.cursorStyle', toOrca: value => value === 'line' ? 'bar' : value, toVsCode: value => value === 'bar' ? 'line' : value },
	same('terminalCursorBlink', 'terminal.integrated.cursorBlinking'),
	same('terminalScrollbackRows', 'terminal.integrated.scrollback'),
	same('terminalScrollSensitivity', 'terminal.integrated.mouseWheelScrollSensitivity'),
	same('terminalFastScrollSensitivity', 'terminal.integrated.fastScrollSensitivity'),
	same('terminalGpuAcceleration', 'terminal.integrated.gpuAcceleration'),
	same('terminalMinimumContrastRatio', 'terminal.integrated.minimumContrastRatio'),
	same('terminalClipboardOnSelect', 'terminal.integrated.copyOnSelection'),
	same('terminalWordSeparator', 'terminal.integrated.wordSeparators'),
	{
		orcaKey: 'terminalRightClickToPaste',
		vscodeKey: 'terminal.integrated.rightClickBehavior',
		toOrca: value => value === 'paste',
		toVsCode: (value, current) => value ? 'paste' : current === 'paste' || typeof current !== 'string' ? 'default' : current,
	},
	{
		orcaKey: 'terminalLigatures',
		vscodeKey: 'terminal.integrated.fontLigatures.enabled',
		toOrca: value => value ? 'on' : 'off',
		toVsCode: (value, current) => value === 'on' ? true : value === 'off' ? false : current === true,
	},
	{
		orcaKey: 'terminalMacOptionAsAlt',
		vscodeKey: 'terminal.integrated.macOptionIsMeta',
		toOrca: value => value ? 'true' : 'false',
		toVsCode: (value, current) => value === 'false' ? false : value === 'auto' ? current === true : true,
	},
	// Editors.
	onUnlessOff('editorAutoSave', 'files.autoSave', 'afterDelay'),
	same('editorAutoSaveDelayMs', 'files.autoSaveDelay'),
	same('editorMinimapEnabled', 'editor.minimap.enabled'),
	{ orcaKey: 'editorFontFamily', vscodeKey: 'editor.fontFamily', toOrca: fontFamily, toVsCode: fontFamily },
	onUnlessOff('editorWordWrap', 'editor.wordWrap', 'on'),
	same('primarySelectionMiddleClickPaste', 'editor.selectionClipboard'),
	// Diffs. `inherit` follows the editor's own wrapping, which the ADE cannot say.
	{ orcaKey: 'diffWordWrap', vscodeKey: 'diffEditor.wordWrap', toOrca: value => value === 'inherit' ? undefined : value === 'on', toVsCode: value => value ? 'on' : 'off' },
	{ orcaKey: 'diffDefaultView', vscodeKey: 'diffEditor.renderSideBySide', toOrca: value => value ? 'side-by-side' : 'inline', toVsCode: value => value !== 'inline' },
	{ orcaKey: 'diffShowWhitespace', vscodeKey: 'diffEditor.ignoreTrimWhitespace', toOrca: value => value === false, toVsCode: value => value !== true },
	// The network. The ADE keeps the bypass list as one `;`-separated string; VS Code as a list.
	same('httpProxyUrl', 'http.proxy'),
	{
		orcaKey: 'httpProxyBypassRules',
		vscodeKey: 'http.noProxy',
		toOrca: value => Array.isArray(value) ? value.filter((rule): rule is string => typeof rule === 'string').map(rule => rule.trim()).filter(Boolean).join(';') : '',
		toVsCode: value => typeof value === 'string' ? value.split(/[;,\n]/).map(rule => rule.trim()).filter(Boolean) : [],
	},
];

/**
 * The ADE's value for what VS Code holds, keeping the ADE's own spelling when
 * it already means the same — `auto` ligatures stay `auto` while VS Code's
 * ligatures are off, rather than being flattened to `off` for no reason.
 * `undefined` means leave the ADE alone.
 */
export function orcaValueFor(equivalent: IKinguSettingEquivalent, vscodeValue: unknown, currentOrca: unknown): unknown {
	if (currentOrca !== undefined && equals(equivalent.toVsCode(currentOrca, vscodeValue), vscodeValue)) {
		return currentOrca;
	}
	return equivalent.toOrca(vscodeValue);
}

/** The VS Code value for an ADE value, keeping VS Code's own spelling when it already means the same. */
export function vscodeValueFor(equivalent: IKinguSettingEquivalent, orcaValue: unknown, currentVsCode: unknown): unknown {
	if (currentVsCode !== undefined && equals(equivalent.toOrca(currentVsCode), orcaValue)) {
		return currentVsCode;
	}
	return equivalent.toVsCode(orcaValue, currentVsCode);
}
