/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Writes the ADE's settings as a schema the Agents Window can register.
 *
 * Generated, not hand-written, for the same reason the codicon CSS is: the
 * ADE's `GlobalSettings` has over two hundred keys and moves with every ADE
 * release, and a hand-kept list would be wrong the first time it moved.
 *
 * Every input is the ADE's own:
 *
 * - **Keys, types and comments** from `shared/global-settings-types.ts`, read
 *   with the TypeScript checker so an alias like `BranchPrefixStrategy`
 *   resolves to the literal values it stands for.
 * - **Pages** from the ADE's page renderers (`settings-*-section-renderers.tsx`,
 *   called in order by `settings-page-renderer.tsx`): each `<SettingsSection>`
 *   is a page, with the id, title and description the ADE gives it.
 * - **Which page a key belongs to**: the first page, in that order, whose
 *   section — or a component it renders, or a file that component imports —
 *   reads or writes the key.
 *
 * Left out, by the rules in {@link excluded}: credentials, account records,
 * grants of trust, state the ADE keeps for itself, and the one-shot markers it
 * uses to run a migration once. None of those are preferences, and
 * `settings.json` can be uploaded by Settings Sync. Also left out: any key no
 * settings page touches — a rollout switch or internal flag, several of which
 * gate how terminals deliver output.
 *
 * Defaults are deliberately not written: several depend on the machine (the
 * workspace folder, the platform's fonts), so the window takes them from the
 * running ADE instead.
 *
 * Run: node build/kingu-orca/generate-settings-schema.mjs
 */

import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const vendored = path.join(root, 'kingu-orca');
const typesFile = path.join(vendored, 'shared/global-settings-types.ts');
const settingsDir = path.join(vendored, 'renderer/src/components/settings');
const outFile = path.join(root, 'src/vs/sessions/contrib/kingu/common/kinguOrcaSettingsSchema.ts');

/** Keys that are not preferences, by name. */
const EXCLUDED_KEYS = new Set([
	// Credentials and account identity.
	'opencodeSessionCookie', 'opencodeWorkspaceId', 'minimaxGroupId',
	'codexManagedAccounts', 'claudeManagedAccounts',
	'activeCodexManagedAccountId', 'activeCodexManagedAccountIdsByRuntime',
	'activeClaudeManagedAccountId', 'activeClaudeManagedAccountIdsByRuntime',
	'telemetry',
	// Grants of trust: a synced settings file must not carry them to another machine.
	'pluginConsents', 'floatingTerminalTrustedCwds', 'devPluginPaths',
	// Environment variables per agent routinely hold API keys.
	'agentDefaultEnv',
	// State the ADE keeps for itself rather than a choice the user makes.
	'workspaceDirHistory', 'activeRuntimeEnvironmentId', 'defaultRepoSelection', 'defaultLinearTeamSelection',
	'nativeChatSessionOptions', 'codexSessionSourceHome', 'browserSshWorkspaceRoutingDisabledTargetIds',
	'browserSshWorkspaceRoutingProbeSkippedTargetIds', 'dismissedSkillFreshnessNudges', 'tabSwitchKeybindingSeed',
	'githubProjects', 'gitlabProjects', 'hostSettingOverrides', 'prBotAuthorOverrides',
	// Keybindings are the window's own keybinding editor's, not a setting.
	'keybindings',
	// The legacy boolean behind `computerAwakeMode`; written alongside it, never on its own.
	'keepComputerAwakeWhileAgentsRun',
]);

/** Keys that are not preferences, by shape: the markers of a migration that runs once. */
const EXCLUDED_PATTERNS = [
	/Migrated(To\w*)?$/, /Defaulted\w*$/, /Dismissed$/, /Prompted$/, /IntroShown$/, /ForAllUsers$/,
];

function excluded(key) {
	return EXCLUDED_KEYS.has(key) || EXCLUDED_PATTERNS.some(pattern => pattern.test(key));
}

// #region Types

const program = ts.createProgram([typesFile], { strict: true, target: ts.ScriptTarget.ES2022, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, skipLibCheck: true, noEmit: true });
const checker = program.getTypeChecker();
const source = program.getSourceFile(typesFile);
const alias = source.statements.find(statement => ts.isTypeAliasDeclaration(statement) && statement.name.text === 'GlobalSettings');
if (!alias) {
	throw new Error('GlobalSettings not found');
}
const settingsType = checker.getTypeAtLocation(alias.name);

/** A property's type as JSON schema, or undefined for one the editor cannot draw. */
function schemaOf(type) {
	const parts = type.isUnion() ? type.types : [type];
	let nullable = false;
	const literals = [];
	const kinds = new Set();
	for (const part of parts) {
		if (part.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) {
			nullable ||= !!(part.flags & ts.TypeFlags.Null);
			continue;
		}
		if (part.flags & ts.TypeFlags.BooleanLiteral || part.flags & ts.TypeFlags.Boolean) {
			kinds.add('boolean');
		} else if (part.flags & ts.TypeFlags.StringLiteral) {
			literals.push(part.value);
			kinds.add('enum');
		} else if (part.flags & ts.TypeFlags.String) {
			kinds.add('string');
		} else if (part.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) {
			kinds.add('number');
		} else if (checker.isArrayType(part)) {
			kinds.add('array');
		} else {
			kinds.add('object');
		}
	}
	const base = kinds.size === 1 ? [...kinds][0] : kinds.has('string') && kinds.has('enum') && kinds.size === 2 ? 'string' : undefined;
	if (!base) {
		return undefined;
	}
	const types = base === 'enum' ? ['string'] : [base];
	return {
		type: nullable ? [...types, 'null'] : types[0],
		...(base === 'enum' ? { enum: [...new Set(literals)] } : {}),
	};
}

/**
 * The comment on a key, as a sentence a user can read, or undefined.
 *
 * The ADE's comments are written for its developers — `Why:` notes, issue
 * numbers, file references — so those parts are dropped rather than shown.
 */
function descriptionOf(symbol) {
	const text = ts.displayPartsToString(symbol.getDocumentationComment(checker)).replace(/\s+/g, ' ').trim();
	if (!text) {
		return undefined;
	}
	const cleaned = text
		.replace(/^Why:\s*/i, '')
		.replace(/\s*\(#\d+\)/g, '')
		.replace(/\s*\([^)]*\.(ts|tsx|md)[^)]*\)/g, '')
		.replace(/\s*See [^.]*\.(ts|tsx|md)\.?/g, '')
		.trim();
	if (!cleaned || /\b(migration|one-shot|cohort|mixed-version)\b/i.test(cleaned)) {
		return undefined;
	}
	const sentence = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

// #endregion

// #region Pages

const files = fs.readdirSync(settingsDir).filter(file => /\.tsx?$/.test(file) && !file.includes('.test.'));
const text = new Map(files.map(file => [file.replace(/\.tsx?$/, ''), fs.readFileSync(path.join(settingsDir, file), 'utf8')]));

/** The files each file imports from this directory. */
const imports = new Map();
for (const [name, body] of text) {
	const found = new Set();
	for (const match of body.matchAll(/from '\.\/(?<module>[\w-]+)'/g)) {
		if (text.has(match.groups.module)) {
			found.add(match.groups.module);
		}
	}
	imports.set(name, found);
}

/** Every file a component reaches, the component included, to six levels. */
function reach(component) {
	const seen = new Set([component]);
	let frontier = [component];
	for (let depth = 0; depth < 6; depth++) {
		const next = [];
		for (const file of frontier) {
			for (const imported of imports.get(file) ?? []) {
				if (!seen.has(imported)) {
					seen.add(imported);
					next.push(imported);
				}
			}
		}
		frontier = next;
	}
	return seen;
}

function mentions(body, key) {
	return new RegExp(`settings\\??\\.${key}\\b|\\b${key}\\s*:`).test(body);
}

function camel(id) {
	return id.replace(/-(\w)/g, (_, letter) => letter.toUpperCase());
}

/**
 * The ADE's settings pages, in the order its Settings view renders them, each
 * with its id, title, description, the text of its section and the components
 * it renders.
 */
function readPages() {
	const renderer = text.get('settings-page-renderer') ?? '';
	const order = [...renderer.matchAll(/\{(?<fn>render\w+)\(context\)\}/g)].map(match => match.groups.fn);
	const blocks = new Map();
	for (const [name, body] of text) {
		if (!/^settings-.*-section-renderers?$/.test(name)) {
			continue;
		}
		const starts = [...body.matchAll(/export function (?<fn>render\w+)/g)];
		starts.forEach((match, index) => {
			blocks.set(match.groups.fn, body.slice(match.index, starts[index + 1]?.index ?? body.length));
		});
	}
	const pages = [];
	for (const fn of order) {
		const block = blocks.get(fn);
		if (!block) {
			continue;
		}
		const sections = [...block.matchAll(/<SettingsSection\s+id="(?<id>[a-z-]+)"/g)];
		if (sections.length === 0) {
			// A page drawn by a component that wraps its own section, as Plugins is.
			const component = block.match(/<(?<name>[A-Z]\w+)\b/)?.groups.name;
			const name = fn.replace(/^render/, '').replace(/SettingsSection$/, '');
			if (component) {
				pages.push({ id: camel(name.replace(/^./, letter => letter.toLowerCase())), title: name, description: undefined, block, components: [component] });
			}
			continue;
		}
		sections.forEach((section, index) => {
			const body = block.slice(section.index, sections[index + 1]?.index ?? block.length);
			const title = body.match(/title=\{translate\(\s*'[^']+',\s*'(?<text>[^']+)'/)?.groups.text ?? section.groups.id;
			const description = body.match(/description=\{translate\(\s*'[^']+',\s*'(?<text>[^']+)'/)?.groups.text;
			const components = [...body.matchAll(/<(?<name>[A-Z]\w+)\b/g)].map(match => match.groups.name).filter(name => name !== 'SettingsSection');
			pages.push({ id: camel(section.groups.id), title, description, block: body, components });
		});
	}
	return pages;
}

// #endregion

const pages = readPages();
const entries = [];
const unpaged = [];
for (const property of settingsType.getProperties()) {
	const key = property.getName();
	if (excluded(key)) {
		continue;
	}
	const declaration = property.valueDeclaration ?? property.declarations?.[0];
	const schema = schemaOf(checker.getTypeOfSymbolAtLocation(property, declaration));
	if (!schema) {
		continue;
	}
	const page = pages.find(candidate => mentions(candidate.block, key)
		|| candidate.components.some(component => [...reach(component)].some(file => text.has(file) && mentions(text.get(file), key))));
	if (!page) {
		unpaged.push(key);
		continue;
	}
	entries.push({ key, page, ...schema, description: descriptionOf(property) });
}

function quoted(value) {
	return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`;
}

const usedPages = pages.filter(page => entries.some(entry => entry.page === page));
const lines = [
	'/*---------------------------------------------------------------------------------------------',
	' *  Kingu Intelligence',
	' *  Licensed under the MIT License.',
	' *--------------------------------------------------------------------------------------------*/',
	'',
	'// GENERATED by build/kingu-orca/generate-settings-schema.mjs from the ADE\'s',
	'// `GlobalSettings` and settings pages. Do not edit; run the generator again.',
	'',
	'import { localize } from \'../../../../nls.js\';',
	'',
	'/** One of the ADE\'s settings pages, as the ADE titles it. */',
	'export interface IKinguOrcaSettingsPage {',
	'\treadonly id: string;',
	'\treadonly title: string;',
	'\treadonly description?: string;',
	'}',
	'',
	'/** One of the ADE\'s settings, as the Agents Window registers it. */',
	'export interface IKinguOrcaSettingSchema {',
	'\t/** The key in the ADE\'s `GlobalSettings`, verbatim. */',
	'\treadonly key: string;',
	'\t/** The id of the ADE settings page it is filed under. */',
	'\treadonly page: string;',
	'\treadonly type: string | readonly string[];',
	'\treadonly enum?: readonly string[];',
	'\treadonly description?: string;',
	'}',
	'',
	'/** The ADE\'s settings pages, in the order its Settings view renders them. */',
	'export const KINGU_ORCA_SETTINGS_PAGES: readonly IKinguOrcaSettingsPage[] = [',
	...usedPages.map(page => `\t{ id: ${quoted(page.id)}, title: localize(${quoted(`kingu.orcaSettings.page.${page.id}`)}, ${JSON.stringify(page.title)})${page.description ? `, description: localize(${quoted(`kingu.orcaSettings.page.${page.id}.description`)}, ${JSON.stringify(page.description)})` : ''} },`),
	'];',
	'',
	'/**',
	` * ${entries.length} settings.`,
	' *',
	' * Not offered, because no ADE settings page reads or writes them:',
	...wrap(unpaged.join(', '), 76).map(line => ` * ${line}`),
	' */',
	'export const KINGU_ORCA_SETTINGS: readonly IKinguOrcaSettingSchema[] = [',
	...entries.map(entry => {
		const parts = [`key: ${quoted(entry.key)}`, `page: ${quoted(entry.page.id)}`, `type: ${Array.isArray(entry.type) ? `[${entry.type.map(quoted).join(', ')}]` : quoted(entry.type)}`];
		if (entry.enum) {
			parts.push(`enum: [${entry.enum.map(quoted).join(', ')}]`);
		}
		if (entry.description) {
			parts.push(`description: localize(${quoted(`kingu.orcaSettings.${entry.key}`)}, ${JSON.stringify(entry.description)})`);
		}
		return `\t{ ${parts.join(', ')} },`;
	}),
	'];',
	'',
];
fs.writeFileSync(outFile, lines.join('\n'));

function wrap(value, width) {
	const out = [];
	let line = '';
	for (const word of value.split(' ')) {
		if (line && line.length + word.length + 1 > width) {
			out.push(line);
			line = word;
		} else {
			line = line ? `${line} ${word}` : word;
		}
	}
	if (line) {
		out.push(line);
	}
	return out;
}

const byPage = new Map();
for (const entry of entries) {
	byPage.set(entry.page.title, (byPage.get(entry.page.title) ?? 0) + 1);
}
console.log(`kingu-orca: ${entries.length} settings across ${byPage.size} pages -> ${path.relative(root, outFile)}`);
console.log([...byPage].map(([title, count]) => `${title} ${count}`).join(', '));
console.log(`not offered (${unpaged.length}): ${unpaged.join(', ')}`);
