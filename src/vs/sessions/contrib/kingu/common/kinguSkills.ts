/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * Where a skill was found, which is not the same as who can run it.
 *
 * `repo` also covers a plain folder workspace, which is why the page labels it
 * "Workspace" rather than "Repository" — half of them are not repositories.
 */
export type KinguSkillSourceKind = 'home' | 'repo' | 'bundled' | 'plugin';

/** The three skill formats an agent reads. Most agents read the shared one. */
export type KinguSkillProvider = 'codex' | 'claude' | 'agent-skills';

/** Roots like `.agents/skills` that every agent reads, so no single one owns them. */
export const KINGU_SHARED_SKILL_OWNER = 'shared';

export interface IKinguSkill {
	/** Stable across rescans: derived from the canonical path of the skill file. */
	readonly id: string;
	readonly name: string;
	readonly description: string | undefined;
	readonly providers: readonly KinguSkillProvider[];
	readonly sourceKind: KinguSkillSourceKind;
	readonly sourceLabel: string;
	/** The discovery root this row was first reached through. */
	readonly rootPath: string;
	/**
	 * Every root that reached this file.
	 *
	 * Path dedup keeps one row, but it must not erase the co-owning roots: a
	 * skill shared into several agents' directories would otherwise lose every
	 * agent but the first, and the agent filter would hide it.
	 */
	readonly rootPaths: readonly string[];
	/**
	 * The directory's URI path, for matching a query against.
	 *
	 * Never drawn: a Windows `file:` URI's path is `/c:/Users/…`, which is not
	 * how anyone on Windows writes a path. The pane renders {@link directory}
	 * through `ILabelService` instead.
	 */
	readonly directoryPath: string;
	/** The skill's own directory, for showing the user where it lives. */
	readonly directory: URI;
	readonly resource: URI;
	readonly updatedAt: number | undefined;
}

/** Why a root contributed nothing, when the difference matters. */
export type KinguSkillSkipReason = 'missing' | 'unreadable';

export interface IKinguSkillSource {
	readonly id: string;
	readonly label: string;
	readonly path: string;
	readonly resource: URI;
	readonly sourceKind: KinguSkillSourceKind;
	readonly providers: readonly KinguSkillProvider[];
	/** The agent that owns this root, or {@link KINGU_SHARED_SKILL_OWNER}. */
	readonly owner: string;
	readonly exists: boolean;
	/**
	 * `missing` is a root that is simply not there, which is the ordinary case
	 * and says nothing. `unreadable` is a root that exists and would not open,
	 * so its skills are *unknown* rather than absent — the page says so, because
	 * an unreadable root silently reported as empty is a wrong answer that looks
	 * like a right one.
	 */
	readonly skippedReason: KinguSkillSkipReason | undefined;
}

export interface IKinguSkillScan {
	readonly skills: readonly IKinguSkill[];
	readonly sources: readonly IKinguSkillSource[];
	readonly scannedAt: number;
}

export const IKinguSkillsService = createDecorator<IKinguSkillsService>('kinguSkillsService');

export interface IKinguSkillsService {

	readonly _serviceBrand: undefined;

	/** Fires when the set of skills may have changed and a rescan is worth doing. */
	readonly onDidChangeSkills: Event<void>;

	/** Every skill this machine's agents can see, scanned once and then reused. */
	getSkills(token: CancellationToken): Promise<IKinguSkillScan>;

	/** The skill file itself, for the detail pane. */
	readSkill(resource: URI): Promise<string>;

	/** Drops the cached scan, so the next {@link getSkills} walks disk again. */
	invalidate(): void;
}

/**
 * Drops the codepoints that let an untrusted name redraw a row.
 *
 * Skill names and descriptions come out of files this window did not write, and
 * a bidi override or a zero-width joiner in one is enough to make a row read as
 * something it is not. Ported from the ADE, where the main process and the
 * renderer had drifted into two copies of this predicate; here there is one.
 */
export function isSafeDisplayCharacter(character: string): boolean {
	const code = character.codePointAt(0) ?? 0;
	return !(
		code <= 0x1f
		|| (code >= 0x7f && code <= 0x9f)
		|| code === 0x200b
		|| code === 0x200e
		|| code === 0x200f
		|| code === 0x061c
		|| code === 0x2060
		|| code === 0xfeff
		|| code === 0x2028
		|| code === 0x2029
		|| (code >= 0x202a && code <= 0x202e)
		|| (code >= 0x2066 && code <= 0x2069)
	);
}

export function stripUnsafeDisplayCharacters(value: string): string {
	return [...value].filter(isSafeDisplayCharacter).join('');
}
