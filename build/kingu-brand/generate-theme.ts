/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Writes Kingu's color themes, Kingu Dark and Kingu Light, into
 * `extensions/theme-kingu`: the ADE's palette (the neutral shadcn scale in
 * `kingu-intelligence/src/renderer/src/assets/main.css`) over every key of
 * upstream's current default themes, so nothing still reads as VS Code blue.
 *
 *     node build/kingu-brand/generate-theme.ts
 *
 * Every color of upstream's Dark 2026 / Light 2026 is carried over: a grey
 * becomes the neutral grey of the same lightness; a blue accent becomes the
 * palette's neutral accent; status and syntax hues (red, green, yellow, ...)
 * stay as they are. The surfaces the ADE defines are then set to its tokens
 * outright. Syntax colors come from upstream's theme through `include`.
 * Re-run after a VS Code sync, so keys upstream adds are covered too.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'jsonc-parser';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'extensions', 'theme-kingu');

interface IPalette {
	readonly background: string;
	readonly surface: string;
	readonly foreground: string;
	readonly muted: string;
	readonly subtle: string;
	readonly border: string;
	readonly input: string;
	readonly ring: string;
	readonly primary: string;
	readonly primaryForeground: string;
	readonly primaryHover: string;
	readonly secondary: string;
	readonly secondaryHover: string;
	readonly selection: string;
	readonly hover: string;
	readonly link: string;
	/** Lightness a blue accent is moved to. */
	readonly accentLightness: number;
}

/** `.dark` in the ADE's main.css. */
const DARK: IPalette = {
	background: '#0a0a0a',
	surface: '#171717',
	foreground: '#fafafa',
	muted: '#a1a1a1',
	subtle: '#737373',
	border: '#ffffff12',
	input: '#ffffff26',
	ring: '#737373',
	primary: '#e5e5e5',
	primaryForeground: '#171717',
	primaryHover: '#d4d4d4',
	secondary: '#262626',
	secondaryHover: '#404040',
	selection: '#404040',
	hover: '#262626',
	link: '#93c5fd',
	accentLightness: 0.9,
};

/** `:root` in the ADE's main.css. */
const LIGHT: IPalette = {
	background: '#ffffff',
	surface: '#fafafa',
	foreground: '#0a0a0a',
	muted: '#737373',
	subtle: '#a1a1a1',
	border: '#e5e5e5',
	input: '#e5e5e5',
	ring: '#a1a1a1',
	primary: '#171717',
	primaryForeground: '#fafafa',
	primaryHover: '#262626',
	secondary: '#f5f5f5',
	secondaryHover: '#e5e5e5',
	selection: '#e5e5e5',
	hover: '#f5f5f5',
	link: '#2563eb',
	accentLightness: 0.12,
};

function parseHex(hex: string): [number, number, number, number] | undefined {
	const m = /^#([0-9a-f]{3,8})$/i.exec(hex.trim());
	if (!m) {
		return undefined;
	}
	let h = m[1];
	if (h.length === 3 || h.length === 4) {
		h = [...h].map(c => c + c).join('');
	}
	if (h.length !== 6 && h.length !== 8) {
		return undefined;
	}
	const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
	return [n(0), n(2), n(4), h.length === 8 ? n(6) : 255];
}

function toHex(r: number, g: number, b: number, a: number): string {
	const two = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
	return `#${two(r)}${two(g)}${two(b)}${a === 255 ? '' : two(a)}`;
}

function hsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
	const [R, G, B] = [r / 255, g / 255, b / 255];
	const max = Math.max(R, G, B), min = Math.min(R, G, B);
	const l = (max + min) / 2;
	if (max === min) {
		return { h: 0, s: 0, l };
	}
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	const h = max === R ? ((G - B) / d + (G < B ? 6 : 0)) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
	return { h: h * 60, s, l };
}

/** One upstream color in the ADE's palette. */
function recolor(value: string, palette: IPalette): string {
	const rgba = parseHex(value);
	if (!rgba) {
		return value;
	}
	const [r, g, b, a] = rgba;
	const { h, s, l } = hsl(r, g, b);
	if (s < 0.2 || l < 0.06 || l > 0.94) {
		// A grey (or near-black/white): the neutral grey of the same lightness.
		const grey = 0.2126 * r + 0.7152 * g + 0.0722 * b;
		return toHex(grey, grey, grey, a);
	}
	if (h >= 180 && h <= 265) {
		// VS Code's blue accent: the palette's neutral accent, alpha kept.
		const v = palette.accentLightness * 255;
		return toHex(v, v, v, a);
	}
	return value;
}

/** The surfaces the ADE defines, set outright. */
function surfaces(p: IPalette): Record<string, string> {
	const chrome = p.surface;
	return {
		'foreground': p.foreground,
		'descriptionForeground': p.muted,
		'disabledForeground': p.subtle,
		'icon.foreground': p.muted,
		'focusBorder': p.ring,
		'contrastBorder': '#00000000',
		'widget.border': p.border,
		'widget.shadow': '#00000059',
		'selection.background': p.selection,
		'textLink.foreground': p.link,
		'textLink.activeForeground': p.link,
		'progressBar.background': p.primary,

		'editor.background': p.background,
		'editorGutter.background': p.background,
		'editor.foreground': p.foreground,
		'editorGroup.border': p.border,
		'editorGroupHeader.tabsBackground': chrome,
		'editorGroupHeader.tabsBorder': p.border,
		'editorGroupHeader.noTabsBackground': chrome,
		'tab.activeBackground': p.background,
		'tab.activeForeground': p.foreground,
		'tab.activeBorderTop': p.foreground,
		'tab.inactiveBackground': chrome,
		'tab.inactiveForeground': p.muted,
		'tab.border': p.border,
		'tab.hoverBackground': p.hover,
		'breadcrumb.background': p.background,

		'sideBar.background': chrome,
		'sideBar.foreground': p.foreground,
		'sideBar.border': p.border,
		'sideBarTitle.foreground': p.foreground,
		'sideBarSectionHeader.background': chrome,
		'sideBarSectionHeader.border': p.border,
		'activityBar.background': chrome,
		'activityBar.foreground': p.foreground,
		'activityBar.inactiveForeground': p.subtle,
		'activityBar.activeBorder': p.foreground,
		'activityBar.border': p.border,
		'activityBarBadge.background': p.primary,
		'activityBarBadge.foreground': p.primaryForeground,
		'titleBar.activeBackground': chrome,
		'titleBar.activeForeground': p.foreground,
		'titleBar.inactiveBackground': chrome,
		'titleBar.inactiveForeground': p.muted,
		'titleBar.border': p.border,
		'statusBar.background': chrome,
		'statusBar.foreground': p.muted,
		'statusBar.border': p.border,
		'statusBar.noFolderBackground': chrome,
		'statusBar.debuggingBackground': chrome,
		'statusBar.debuggingForeground': p.foreground,
		'statusBarItem.remoteBackground': chrome,
		'statusBarItem.remoteForeground': p.foreground,
		'panel.background': chrome,
		'panel.border': p.border,
		'panelTitle.activeForeground': p.foreground,
		'panelTitle.activeBorder': p.foreground,
		'panelTitle.inactiveForeground': p.muted,

		'editorWidget.background': chrome,
		'editorWidget.border': p.border,
		'editorHoverWidget.background': chrome,
		'editorHoverWidget.border': p.border,
		'editorSuggestWidget.background': chrome,
		'editorSuggestWidget.border': p.border,
		'quickInput.background': chrome,
		'quickInputTitle.background': chrome,
		'menu.background': chrome,
		'menu.border': p.border,
		'menu.selectionBackground': p.selection,
		'dropdown.background': chrome,
		'dropdown.border': p.input,
		'notifications.background': chrome,
		'notifications.border': p.border,
		'notificationCenterHeader.background': chrome,

		'input.background': p.background,
		'input.border': p.input,
		'input.placeholderForeground': p.subtle,
		'inputOption.activeBorder': p.ring,
		'checkbox.background': p.background,
		'checkbox.border': p.input,

		'button.background': p.primary,
		'button.foreground': p.primaryForeground,
		'button.hoverBackground': p.primaryHover,
		'button.border': '#00000000',
		'button.secondaryBackground': p.secondary,
		'button.secondaryForeground': p.foreground,
		'button.secondaryHoverBackground': p.secondaryHover,
		'badge.background': p.primary,
		'badge.foreground': p.primaryForeground,

		'list.activeSelectionBackground': p.selection,
		'list.activeSelectionForeground': p.foreground,
		'list.inactiveSelectionBackground': p.hover,
		'list.hoverBackground': p.hover,
		'list.focusOutline': p.ring,
		'list.highlightForeground': p.foreground,

		'scrollbarSlider.background': `${p.subtle}66`,
		'scrollbarSlider.hoverBackground': `${p.subtle}99`,
		'scrollbarSlider.activeBackground': `${p.muted}99`,
		'terminal.background': p.background,
	};
}

function build(upstreamFile: string, label: string, uiTheme: string, palette: IPalette): { file: string; json: object } {
	// Upstream's colors with its whole `include` chain resolved, the including file winning.
	const resolve = (file: string): Record<string, string> => {
		const theme = parse(fs.readFileSync(file, 'utf8')) as { include?: string; colors?: Record<string, string> };
		const inherited = theme.include ? resolve(path.join(path.dirname(file), theme.include)) : {};
		return { ...inherited, ...theme.colors };
	};
	const upstreamColors = resolve(path.join(ROOT, 'extensions', 'theme-defaults', 'themes', upstreamFile));
	const colors: Record<string, string> = {};
	for (const [key, value] of Object.entries(upstreamColors)) {
		colors[key] = recolor(value, palette);
	}
	Object.assign(colors, surfaces(palette));
	return {
		file: `${label.toLowerCase().replace(/\s+/g, '-')}.json`,
		json: {
			$schema: 'vscode://schemas/color-theme',
			name: label,
			type: uiTheme === 'vs' ? 'light' : 'dark',
			// Syntax colors, and any key not listed here, from upstream's theme.
			include: `../../theme-defaults/themes/${upstreamFile}`,
			colors: Object.fromEntries(Object.entries(colors).sort(([a], [b]) => a.localeCompare(b))),
		},
	};
}

function main(): void {
	const themes = [
		{ ...build('2026-dark.json', 'Kingu Dark', 'vs-dark', DARK), label: 'Kingu Dark', uiTheme: 'vs-dark' },
		{ ...build('2026-light.json', 'Kingu Light', 'vs', LIGHT), label: 'Kingu Light', uiTheme: 'vs' },
	];
	fs.mkdirSync(path.join(OUT, 'themes'), { recursive: true });
	for (const theme of themes) {
		fs.writeFileSync(path.join(OUT, 'themes', theme.file), JSON.stringify(theme.json, null, '\t') + '\n');
		console.log(`wrote extensions/theme-kingu/themes/${theme.file} (${Object.keys((theme.json as { colors: object }).colors).length} colors)`);
	}
	const manifest = {
		name: 'theme-kingu',
		displayName: '%displayName%',
		description: '%description%',
		version: '1.0.0',
		publisher: 'vscode',
		license: 'MIT',
		engines: { vscode: '*' },
		categories: ['Themes'],
		contributes: {
			themes: themes.map(t => ({ id: t.label, label: t.label, uiTheme: t.uiTheme, path: `./themes/${t.file}` })),
		},
	};
	fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify(manifest, null, '\t') + '\n');
	fs.writeFileSync(path.join(OUT, 'package.nls.json'), JSON.stringify({ displayName: 'Kingu Themes', description: 'Kingu Dark and Kingu Light, in the ADE\'s palette.' }, null, '\t') + '\n');
	console.log('wrote extensions/theme-kingu/package.json');
}

main();
