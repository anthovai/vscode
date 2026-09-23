/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Writes the ADE's settings screen — its sidebar, every pane, section and row,
 * in the ADE's order and wording — as data the Agents Window's settings screen
 * draws from.
 *
 * Source: `orca-settings-spec.json` beside this file, a row-by-row transcription
 * of `kingu-orca/renderer/src/components/settings/*` (labels are the English
 * fallbacks of the ADE's `translate()` calls; `settingKeys` are the
 * `GlobalSettings` keys each row reads and writes). Behaviour the ADE expresses
 * in code — an inverted toggle, a row shown only under another's value — is
 * carried from the transcription's notes into `inverted` and `when`, and the
 * few the notes phrase loosely are listed in RULES below.
 *
 * Run: node build/kingu-orca/generate-settings-screen.mjs
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const spec = JSON.parse(fs.readFileSync(path.join(root, 'build/kingu-orca/orca-settings-spec.json'), 'utf8'));
const outFile = path.join(root, 'src/vs/sessions/contrib/kingu/common/kinguOrcaSettingsScreen.ts');

/** The ADE's sidebar icons, lucide by name, and the ones drawn by a custom component. */
const ICONS = {
	Bot: 'bot', UserCog: 'user-cog', Network: 'network', MousePointerClick: 'mouse-pointer-click', Mic: 'mic',
	CircleUserRound: 'circle-user-round', SlidersHorizontal: 'sliders-horizontal', Blocks: 'blocks', Smartphone: 'smartphone',
	CalendarClock: 'calendar-clock', Files: 'files', BookOpen: 'book-open', History: 'history', GitBranch: 'git-branch',
	ListChecks: 'list-checks', SquareTerminal: 'square-terminal', Play: 'play', Globe: 'globe', TabletSmartphone: 'tablet-smartphone',
	PanelsTopLeft: 'panels-top-left', Palette: 'palette', TextCursorInput: 'text-cursor-input', Bell: 'bell', Keyboard: 'keyboard',
	BarChart3: 'chart-column', Cable: 'cable', Server: 'server', ShieldCheck: 'shield-check', Lock: 'lock', Wrench: 'wrench',
	Bug: 'bug', FlaskConical: 'flask-conical',
};

/**
 * Rows whose ADE behaviour the transcription states only in prose: a toggle
 * that reads the opposite of its key, a row shown only when another setting
 * has a value. Keyed `pane/label`.
 */
const RULES = {
	'agents/Timer Duration': { when: { key: 'promptCacheTimerEnabled', equals: true } },
	'terminal/Contrast target': { when: { key: 'terminalMinimumContrastRatio', notEquals: [1, 4.5, 7] } },
	'appearance/Match dark mode': { inverted: true },
};

/** The ADE's group titles, as written before its CSS uppercases them. */
const GROUP_TITLES = {
	capabilities: 'AI Capabilities', setup: 'Set Up', workflows: 'Workflows', interface: 'Interface',
	remote: 'Remote Hosts', security: 'Privacy & Security', advanced: 'Advanced', experimental: 'Experimental',
};

/** Panes the Agents Window does not have: the ADE's dev-build tools and its per-project panes (drawn separately). */
const SKIPPED_PANES = new Set(['dev']);

const lines = [];
let keyIndex = 0;
const str = (id, text) => `localize('${id}', ${JSON.stringify(text)})`;
const placeholder = text => /<[^>]+>/.test(text ?? '');
/** A string that is not shown to the user, single-quoted as the codebase requires. */
const literal = text => `'${String(text).replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`;

function rowKind(row) {
	return row.control;
}

function emitRow(paneId, row) {
	const id = `kingu.orcaScreen.${paneId}.${keyIndex++}`;
	const rule = RULES[`${paneId}/${row.label}`] ?? {};
	const notes = row.notes ?? '';
	const inverted = rule.inverted ?? /\bInverted\b/.test(notes);
	const parts = [
		`label: ${str(`${id}.label`, row.label)}`,
		`control: '${rowKind(row)}'`,
		`keys: [${(row.settingKeys ?? []).map(literal).join(', ')}]`,
	];
	if (row.description && !placeholder(row.description)) {
		parts.push(`description: ${str(`${id}.description`, row.description)}`);
	}
	const options = (row.options ?? []).filter(option => !placeholder(option.value) && !placeholder(option.label));
	if (options.length > 0) {
		parts.push(`options: [${options.map((option, index) => `{ value: ${literal(option.value)}, label: ${str(`${id}.option${index}`, option.label)} }`).join(', ')}]`);
	}
	if (inverted) {
		parts.push('inverted: true');
	}
	if (rule.when) {
		parts.push(`when: { ${Object.entries(rule.when).map(([name, value]) => `${name}: ${typeof value === 'string' ? literal(value) : JSON.stringify(value)}`).join(', ')} }`);
	}
	if (placeholder(row.label)) {
		parts.push('dynamic: true');
	}
	return `{ ${parts.join(', ')} }`;
}

const panes = spec.panes.filter(pane => !SKIPPED_PANES.has(pane.id) && !String(pane.id).startsWith('repo-'));

lines.push(
	'/*---------------------------------------------------------------------------------------------',
	' *  Kingu Intelligence',
	' *  Licensed under the MIT License.',
	' *--------------------------------------------------------------------------------------------*/',
	'',
	'// GENERATED by build/kingu-orca/generate-settings-screen.mjs from the ADE\'s settings panes.',
	'// Do not edit; run the generator again.',
	'',
	'import { localize } from \'../../../../nls.js\';',
	'',
	'/** How a row is edited, as the ADE draws it. */',
	'export type OrcaSettingsControl = \'toggle\' | \'select\' | \'segmented\' | \'text\' | \'textarea\' | \'number\' | \'slider\' | \'path-with-browse\' | \'show-hide-list\' | \'list\' | \'button\' | \'status\' | \'custom\';',
	'',
	'/** A row shown only while another setting has (or has not) a value. */',
	'export interface IOrcaSettingsCondition {',
	'	readonly key: string;',
	'	readonly equals?: unknown;',
	'	readonly notEquals?: readonly unknown[];',
	'}',
	'',
	'export interface IOrcaSettingsRow {',
	'	readonly label: string;',
	'	readonly description?: string;',
	'	readonly control: OrcaSettingsControl;',
	'	/** The `GlobalSettings` keys the row reads and writes; dotted for a nested one. */',
	'	readonly keys: readonly string[];',
	'	readonly options?: readonly { readonly value: string; readonly label: string }[];',
	'	/** A toggle that is on while its key is `false`, as "Ask before deleting" over `skip…Confirm`. */',
	'	readonly inverted?: boolean;',
	'	readonly when?: IOrcaSettingsCondition;',
	'	/** One of a list the ADE draws per item (an account, a host); drawn by the pane, not the row. */',
	'	readonly dynamic?: boolean;',
	'}',
	'',
	'export interface IOrcaSettingsSection {',
	'	readonly id: string;',
	'	readonly title?: string;',
	'	readonly description?: string;',
	'	readonly rows: readonly IOrcaSettingsRow[];',
	'}',
	'',
	'export interface IOrcaSettingsPane {',
	'	readonly id: string;',
	'	readonly title: string;',
	'	readonly subtitle?: string;',
	'	readonly badge?: string;',
	'	readonly sections: readonly IOrcaSettingsSection[];',
	'}',
	'',
	'export interface IOrcaSettingsNavItem {',
	'	readonly id: string;',
	'	readonly label: string;',
	'	/** A lucide icon name. */',
	'	readonly icon: string;',
	'	readonly badge?: string;',
	'}',
	'',
	'export interface IOrcaSettingsNavGroup {',
	'	readonly id: string;',
	'	readonly label: string;',
	'	readonly items: readonly IOrcaSettingsNavItem[];',
	'}',
	'',
);

const paneIds = new Set(panes.map(pane => pane.id));
lines.push('/** The ADE\'s settings sidebar, group by group, in its order. */');
lines.push('export const ORCA_SETTINGS_NAV: readonly IOrcaSettingsNavGroup[] = [');
for (const group of spec.sidebar.groups) {
	const items = group.items.filter(item => paneIds.has(item.id));
	if (items.length === 0) {
		continue;
	}
	const title = GROUP_TITLES[group.id] ?? group.group;
	lines.push(`	{ id: '${group.id}', label: ${str(`kingu.orcaScreen.nav.${group.id}`, title)}, items: [`);
	for (const item of items) {
		const icon = ICONS[item.icon] ?? 'blocks';
		const badge = item.badge ? `, badge: '${item.badge}'` : '';
		lines.push(`		{ id: '${item.id}', label: ${str(`kingu.orcaScreen.nav.${item.id}`, item.label)}, icon: '${icon}'${badge} },`);
	}
	lines.push('	] },');
}
lines.push('];', '');

lines.push('/** Every pane, section and row of the ADE\'s settings screen. */');
lines.push('export const ORCA_SETTINGS_PANES: readonly IOrcaSettingsPane[] = [');
for (const pane of panes) {
	keyIndex = 0;
	const head = [`id: '${pane.id}'`, `title: ${str(`kingu.orcaScreen.${pane.id}.title`, pane.title)}`];
	if (pane.subtitle) {
		head.push(`subtitle: ${str(`kingu.orcaScreen.${pane.id}.subtitle`, pane.subtitle)}`);
	}
	if (pane.badge) {
		head.push(`badge: '${pane.badge}'`);
	}
	lines.push(`	{ ${head.join(', ')}, sections: [`);
	pane.sections.forEach((section, sectionIndex) => {
		const sectionHead = [`id: '${pane.id}-${sectionIndex}'`];
		if (section.title) {
			sectionHead.push(`title: ${str(`kingu.orcaScreen.${pane.id}.section${sectionIndex}`, section.title)}`);
		}
		if (section.description) {
			sectionHead.push(`description: ${str(`kingu.orcaScreen.${pane.id}.section${sectionIndex}.description`, section.description)}`);
		}
		lines.push(`		{ ${sectionHead.join(', ')}, rows: [`);
		for (const row of section.rows ?? []) {
			lines.push(`			${emitRow(pane.id, row)},`);
		}
		lines.push('		] },');
	});
	lines.push('	] },');
}
lines.push('];', '');

fs.writeFileSync(outFile, lines.join('\n'));
const rows = panes.reduce((count, pane) => count + pane.sections.reduce((inner, section) => inner + (section.rows ?? []).length, 0), 0);
console.log(`kingu-orca: ${panes.length} settings panes, ${rows} rows -> ${path.relative(root, outFile)}`);
