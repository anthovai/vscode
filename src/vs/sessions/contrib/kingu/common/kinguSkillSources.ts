/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { KINGU_SHARED_SKILL_OWNER, IKinguSkill, IKinguSkillSource, KinguSkillProvider, KinguSkillSourceKind } from './kinguSkills.js';

/**
 * How deep below a root a `SKILL.md` may sit.
 *
 * One constant rather than two, and expressed on the *file* rather than on the
 * directory, because that is where the ADE's two spellings had drifted: its
 * native walker bounded directories and its WSL `find -maxdepth` bounded the
 * file, and the numbers stopped agreeing. The directory bound is derived.
 */
export const KINGU_SKILL_FILE_MAX_DEPTH = 5;

/** A plugin nests its skills a few levels further inside its own package. */
export const KINGU_PLUGIN_SKILL_FILE_MAX_DEPTH = 10;

export function kinguSkillFileMaxDepth(sourceKind: KinguSkillSourceKind): number {
	return sourceKind === 'plugin' ? KINGU_PLUGIN_SKILL_FILE_MAX_DEPTH : KINGU_SKILL_FILE_MAX_DEPTH;
}

/** The directory the walk may still descend into — one level above the file. */
export function kinguSkillDirectoryMaxDepth(sourceKind: KinguSkillSourceKind): number {
	return kinguSkillFileMaxDepth(sourceKind) - 1;
}

/** The file that makes a directory a skill. Matched case-insensitively. */
export const KINGU_SKILL_FILE_NAME = 'skill.md';

/** A root to walk, before anything has been read from it. */
export interface IKinguSkillRoot {
	readonly id: string;
	readonly label: string;
	/** Path segments below the home directory, or below a workspace folder. */
	readonly segments: readonly string[];
	readonly sourceKind: KinguSkillSourceKind;
	readonly providers: readonly KinguSkillProvider[];
	/** The agent that owns this root, or {@link KINGU_SHARED_SKILL_OWNER}. */
	readonly owner: string;
}

function root(
	id: string,
	label: string,
	segments: readonly string[],
	sourceKind: KinguSkillSourceKind,
	providers: readonly KinguSkillProvider[],
	owner: string,
): IKinguSkillRoot {
	return { id, label, segments, sourceKind, providers, owner };
}

/**
 * Every place an agent on this machine keeps skills, relative to the home
 * directory.
 *
 * A table rather than a resolver per agent, matching the vault's source table
 * next door and ported from the ADE's own: most of these roots exist only
 * because `npx skills add --global` writes into each agent's own home
 * directory, so a scan that knew about two agents would under-report every
 * other one — and an installed skill that does not appear reads as a failed
 * install.
 *
 * The environment overrides the ADE also honours (`HERMES_HOME`, and the moved
 * Claude and Grok roots) are not read here, for the same reason the vault does
 * not read them: this renderer is sandboxed and has no process environment. A
 * user who has moved a root can still open the skill as a file.
 */
export const KINGU_SKILL_HOME_ROOTS: readonly IKinguSkillRoot[] = [
	root('home-claude', localize('kingu.skills.root.claude', "Claude home"), ['.claude', 'skills'], 'home', ['claude'], 'claude'),
	root('home-codex', localize('kingu.skills.root.codex', "Codex home"), ['.codex', 'skills'], 'home', ['codex'], 'codex'),
	root('home-agents', localize('kingu.skills.root.agents', "Agent skills home"), ['.agents', 'skills'], 'home', ['agent-skills'], KINGU_SHARED_SKILL_OWNER),
	root('codex-plugin-cache', localize('kingu.skills.root.codexPlugins', "Codex plugin cache"), ['.codex', 'plugins', 'cache'], 'plugin', ['codex', 'agent-skills'], 'codex'),
	root('home-grok', localize('kingu.skills.root.grok', "Grok home"), ['.grok', 'skills'], 'home', ['agent-skills'], 'grok'),
	root('home-opencode', localize('kingu.skills.root.opencode', "OpenCode home"), ['.config', 'opencode', 'skills'], 'home', ['agent-skills'], 'opencode'),
	root('home-pi', localize('kingu.skills.root.pi', "Pi home"), ['.pi', 'agent', 'skills'], 'home', ['agent-skills'], 'pi'),
	root('home-omp', localize('kingu.skills.root.omp', "OMP home"), ['.omp', 'agent', 'skills'], 'home', ['agent-skills'], 'omp'),
	root('home-hermes', localize('kingu.skills.root.hermes', "Hermes home"), ['.hermes', 'skills'], 'home', ['agent-skills'], 'hermes'),
	root('home-prime-agent', localize('kingu.skills.root.primeAgent', "Prime Agent home"), ['.prime', 'agent', 'skills'], 'home', ['agent-skills'], 'prime-agent'),
	root('home-gemini', localize('kingu.skills.root.gemini', "Gemini home"), ['.gemini', 'skills'], 'home', ['agent-skills'], 'gemini'),
	root('home-antigravity', localize('kingu.skills.root.antigravity', "Antigravity home"), ['.gemini', 'antigravity', 'skills'], 'home', ['agent-skills'], 'antigravity'),
	root('home-cursor', localize('kingu.skills.root.cursor', "Cursor home"), ['.cursor', 'skills'], 'home', ['agent-skills'], 'cursor'),
	root('home-droid', localize('kingu.skills.root.droid', "Droid home"), ['.factory', 'skills'], 'home', ['agent-skills'], 'droid'),
	root('home-continue', localize('kingu.skills.root.continue', "Continue home"), ['.continue', 'skills'], 'home', ['agent-skills'], 'continue'),
	root('home-trae', localize('kingu.skills.root.trae', "Trae home"), ['.trae-cn', 'skills'], 'home', ['agent-skills'], 'trae'),
	root('home-aug', localize('kingu.skills.root.aug', "Augment home"), ['.augment', 'skills'], 'home', ['agent-skills'], 'aug'),
];

/** The per-workspace roots, which differ from the home ones only in the dot directory. */
const WORKSPACE_ROOTS: readonly {
	readonly suffix: string;
	readonly segments: readonly string[];
	readonly providers: readonly KinguSkillProvider[];
	readonly owner: string;
}[] = [
		{ suffix: '.agents', segments: ['.agents', 'skills'], providers: ['agent-skills'], owner: KINGU_SHARED_SKILL_OWNER },
		{ suffix: '.claude', segments: ['.claude', 'skills'], providers: ['claude'], owner: 'claude' },
		{ suffix: '.factory', segments: ['.factory', 'skills'], providers: ['agent-skills'], owner: 'droid' },
		{ suffix: '.continue', segments: ['.continue', 'skills'], providers: ['agent-skills'], owner: 'continue' },
		{ suffix: '.trae', segments: ['.trae', 'skills'], providers: ['agent-skills'], owner: 'trae' },
		{ suffix: '.grok', segments: ['.grok', 'skills'], providers: ['agent-skills'], owner: 'grok' },
		{ suffix: '.augment', segments: ['.augment', 'skills'], providers: ['agent-skills'], owner: 'aug' },
	];

/**
 * The roots a single open folder contributes.
 *
 * `folderKey` rather than the folder's name: two open folders can share a
 * basename, and a row keyed on the name alone would collapse them into one and
 * report half the skills as belonging to the other project.
 */
export function kinguSkillWorkspaceRoots(folderName: string, folderKey: string): IKinguSkillRoot[] {
	return WORKSPACE_ROOTS.map(entry => root(
		`repo-${entry.suffix.slice(1)}-${folderKey}`,
		localize('kingu.skills.root.workspace', "{0} {1}", folderName, entry.suffix),
		entry.segments,
		'repo',
		entry.providers,
		entry.owner,
	));
}

/**
 * The kind a skill actually has, which can be narrower than its root's.
 *
 * A home root's `.system` subtree is what the agent shipped with rather than
 * what the user installed, and the two want telling apart: the bundled ones are
 * numerous, identical on every machine, and never the answer to "what did I
 * install".
 */
export function kinguSkillSourceKind(rootKind: KinguSkillSourceKind, relativeSegments: readonly string[]): KinguSkillSourceKind {
	return rootKind === 'home' && relativeSegments[0] === '.system' ? 'bundled' : rootKind;
}

export function kinguSkillSourceLabel(rootLabel: string, sourceKind: KinguSkillSourceKind, rootKind: KinguSkillSourceKind): string {
	return sourceKind === 'bundled' && rootKind !== 'bundled'
		? localize('kingu.skills.bundledLabel', "{0} bundled", rootLabel)
		: rootLabel;
}

/** Name, then where it came from, then path — so two rows of one name stay adjacent. */
export function sortKinguSkills(skills: IKinguSkill[]): IKinguSkill[] {
	if (skills.length < 2) {
		return skills;
	}
	const compare = new Intl.Collator(undefined, { sensitivity: 'base' }).compare;
	return skills.sort((a, b) =>
		compare(a.name, b.name)
		|| compare(a.sourceLabel, b.sourceLabel)
		|| a.resource.toString().localeCompare(b.resource.toString()));
}

export function sortKinguSkillSources(sources: IKinguSkillSource[]): IKinguSkillSource[] {
	if (sources.length < 2) {
		return sources;
	}
	const compare = new Intl.Collator(undefined, { sensitivity: 'base' }).compare;
	return sources.sort((a, b) => compare(a.label, b.label));
}
