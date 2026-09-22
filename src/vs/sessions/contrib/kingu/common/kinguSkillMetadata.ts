/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { stripUnsafeDisplayCharacters } from './kinguSkills.js';

/** What a `SKILL.md` says about itself, once its front matter has been read. */
export interface IKinguSkillSummary {
	readonly name: string | undefined;
	readonly description: string | undefined;
}

type FrontmatterValue = string | string[];

function stripQuotePair(value: string): string {
	const trimmed = value.trim();
	const quoted = (trimmed.startsWith('"') && trimmed.endsWith('"'))
		|| (trimmed.startsWith('\'') && trimmed.endsWith('\''));
	return quoted && trimmed.length >= 2 ? trimmed.slice(1, -1) : trimmed;
}

/**
 * Reads the handful of YAML shapes a skill's front matter actually uses.
 *
 * Deliberately not a YAML parser. Front matter here is `name:`, `description:`,
 * a block scalar or a short list, and pulling a real parser into `common/` to
 * read two keys would be a dependency for every window that loads this file.
 * Anything it does not recognise is skipped rather than thrown on, because a
 * skill with unusual front matter should still appear in the list under its
 * heading.
 */
function parseFrontmatter(raw: string): Map<string, FrontmatterValue> {
	const lines = raw.replace(/\r\n/g, '\n').replace(/\r$/, '').split('\n');
	const data = new Map<string, FrontmatterValue>();
	let index = 0;
	while (index < lines.length) {
		const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[index]);
		if (!match) {
			index += 1;
			continue;
		}

		const key = match[1];
		const value = match[2].trim();

		// A block scalar: `|` keeps the line breaks, `>` folds them into spaces.
		// Both are collapsed to one line here because the only place either is
		// shown is a single-line description cell.
		if (value === '|' || value === '|-' || value === '>' || value === '>-') {
			const block: string[] = [];
			index += 1;
			while (index < lines.length && /^(?:\s{2,}|\s*$)/.test(lines[index])) {
				block.push(lines[index].replace(/^\s{2}/, ''));
				index += 1;
			}
			data.set(key, block.join(value.startsWith('>') ? ' ' : '\n').replace(/\s+/g, ' ').trim());
			continue;
		}

		if (value === '') {
			const items: string[] = [];
			index += 1;
			while (index < lines.length) {
				const item = /^\s*-\s*(.+)$/.exec(lines[index]);
				if (!item) {
					break;
				}
				items.push(stripQuotePair(item[1]));
				index += 1;
			}
			data.set(key, items.length > 0 ? items : '');
			continue;
		}

		data.set(key, stripQuotePair(value));
		index += 1;
	}
	return data;
}

/** The first `# heading`, which is what a skill with no `name:` is called. */
function firstHeading(body: string): string | undefined {
	return /^#\s+(.+)$/m.exec(body)?.[1].trim() || undefined;
}

/**
 * The first real paragraph, for a skill with no `description:`.
 *
 * Headings and fenced code are skipped rather than ended on, so front matter
 * followed by a title and then prose still finds the prose. It stops once it has
 * enough to fill the cell — a skill whose first paragraph is a page long should
 * not cost a page of string building on every row of the list.
 *
 * A fence is tracked rather than merely recognised on its own line. The ADE
 * skipped the ``` and then took what followed, so a skill that opens on a usage
 * block was described to the user as `npm run deploy` — a command presented as
 * a sentence about what the skill does.
 */
function firstParagraph(body: string): string | undefined {
	const lines = body.replace(/\r\n/g, '\n').split('\n');
	const paragraph: string[] = [];
	let fenced = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
			fenced = !fenced;
			if (paragraph.length > 0) {
				break;
			}
			continue;
		}
		// A horizontal rule is a divider, not prose — and it is also what an
		// unclosed front matter block leaves lying in the body.
		if (fenced || !trimmed || trimmed.startsWith('#') || /^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
			if (paragraph.length > 0 && !fenced) {
				break;
			}
			continue;
		}
		paragraph.push(trimmed);
		if (paragraph.join(' ').length > 240) {
			break;
		}
	}
	return paragraph.length > 0 ? paragraph.join(' ') : undefined;
}

function display(value: string | undefined): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	// Stripped here rather than at the row, because this is the one place the
	// file's own bytes become something the window will draw.
	const safe = stripUnsafeDisplayCharacters(value).trim();
	return safe.length > 0 ? safe : undefined;
}

/**
 * What to call a skill, and what to say it does.
 *
 * Front matter first because it is what the author declared; the body only
 * answers when the front matter did not. A skill that says neither is still a
 * skill — the caller names it after its directory.
 */
export function summarizeKinguSkill(markdown: string): IKinguSkillSummary {
	const normalized = markdown.replace(/^﻿/, '');
	// `\n?` before the closing fence, so an empty front matter block is still a
	// front matter block. Without it `---\n---` was read as body, and the page
	// described the skill as "--- ---".
	const match = /^---\s*\n([\s\S]*?)\n?---\s*(?:\n|$)/.exec(normalized);
	const body = match ? normalized.slice(match[0].length) : normalized;
	const frontmatter = match ? parseFrontmatter(match[1]) : new Map<string, FrontmatterValue>();

	const declaredName = frontmatter.get('name');
	const declaredDescription = frontmatter.get('description');
	const name = typeof declaredName === 'string' && declaredName.trim()
		? declaredName.trim()
		: firstHeading(body);
	const description = typeof declaredDescription === 'string' && declaredDescription.trim()
		? declaredDescription.trim()
		: firstParagraph(body);

	return { name: display(name), description: display(description) };
}
