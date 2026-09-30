/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/** Lines of the file on either side of the region the model reads, nearest kept. */
const CONTEXT_LINES = 120;

/** What Arkai is asked to rewrite in the editor, as whole lines. */
export interface IKinguInlineEditRegion {
	readonly languageId: string;
	/** The file's lines, first line at index 0. */
	readonly lines: readonly string[];
	/** The first line of the region, 1-based. */
	readonly startLineNumber: number;
	/** The last line of the region, 1-based, inclusive. */
	readonly endLineNumber: number;
	readonly instruction: string;
}

/**
 * The prompt for inline chat (`Ctrl+I`): the region marked in the file, the
 * code around it, and the instruction. A small model follows "rewrite these
 * lines, code only" far more reliably than an edit tool or a diff format, so
 * the answer replaces the region whole.
 */
export function kinguInlineEditPrompt(region: IKinguInlineEditRegion): { system: string; user: string } {
	const before = region.lines.slice(Math.max(0, region.startLineNumber - 1 - CONTEXT_LINES), region.startLineNumber - 1);
	const inside = region.lines.slice(region.startLineNumber - 1, region.endLineNumber);
	const after = region.lines.slice(region.endLineNumber, region.endLineNumber + CONTEXT_LINES);
	const system = [
		'You are Arkai, the coding agent of Kingu, editing code in the user\'s editor.',
		'Rewrite the lines between <edit> and </edit> as the instruction asks.',
		'Reply with only the new code for those lines, keeping their indentation. No explanation, no markdown fences, no <edit> tags, nothing from outside the marked lines.',
	].join('\n');
	const user = [
		`Language: ${region.languageId}`,
		'',
		...before,
		'<edit>',
		...inside,
		'</edit>',
		...after,
		'',
		`Instruction: ${region.instruction}`,
	].join('\n');
	return { system, user };
}

/**
 * The code in a model's answer: the first fenced block when it wrote one
 * anyway, the `<edit>` tags it may have echoed gone, blank lines at either end
 * trimmed, and the unmarked lines around the region it copied along (a small
 * model often rewrites the whole function) left out.
 */
export function kinguInlineEditCode(answer: string, region?: IKinguInlineEditRegion): string | undefined {
	let code = answer.replace(/<think>[\s\S]*?<\/think>/g, '');
	const fence = /```[^\n]*\n(?<body>[\s\S]*?)(?:```|$)/.exec(code);
	if (fence?.groups) {
		code = fence.groups.body;
	}
	code = code.replace(/<\/?edit>/g, '').replace(/^(?:[ \t]*\r?\n)+/, '').replace(/(?:\r?\n[ \t]*)+$/, '');
	if (region) {
		let lines = code.split(/\r?\n/);
		const before = region.lines.slice(0, region.startLineNumber - 1);
		const after = region.lines.slice(region.endLineNumber);
		const echoedBefore = echoLength(lines, before.slice(-lines.length).reverse(), true);
		lines = lines.slice(echoedBefore);
		const echoedAfter = echoLength(lines, after.slice(0, lines.length), false);
		lines = lines.slice(0, lines.length - echoedAfter);
		code = lines.join('\n');
	}
	return code.trim() ? code : undefined;
}

/**
 * How many lines at the start (or end) of `lines` copy the file's lines next
 * to the region, `neighbours` ordered outward from it, blank lines not counted
 * as a copy on their own.
 */
function echoLength(lines: readonly string[], neighbours: readonly string[], atStart: boolean): number {
	for (let count = Math.min(lines.length, neighbours.length); count > 0; count--) {
		const part = atStart ? lines.slice(0, count) : lines.slice(lines.length - count);
		const near = (atStart ? neighbours.slice(0, count).reverse() : neighbours.slice(0, count));
		if (part.some(line => line.trim()) && part.every((line, index) => line.trim() === near[index].trim())) {
			return count;
		}
	}
	return 0;
}
