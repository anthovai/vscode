/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

type Point = [number, number];
export type ChatWorkingLogoDrawBand = 'leg1' | 'leg3' | 'bar';

/**
 * Kingu: the Kingu mark in three pieces, the crown, the smile and the shades, in the bands'
 * paint order (`leg1`, `leg3`, `bar`). Traced by build/kingu-brand/generate.py.
 */
export const chatWorkingLogoFacePaths = [
	'M79.23 7.99 L79.09 8.03 L64.04 21.40 L63.90 21.36 L61.23 19.03 L48.00 7.15 L47.83 7.18 L39.09 15.15 L32.03 21.40 L31.90 21.40 L18.29 9.34 L16.87 8.09 L16.70 8.03 L16.67 8.23 L17.34 11.00 L18.29 15.49 L18.56 16.47 L20.08 23.49 L21.80 30.85 L22.10 32.47 L23.29 37.60 L23.39 37.67 L26.90 36.08 L28.79 35.31 L31.90 34.19 L36.01 33.01 L39.53 32.30 L42.43 31.90 L46.95 31.56 L51.31 31.63 L55.63 32.06 L55.43 31.93 L53.71 31.42 L49.89 30.58 L45.91 30.04 L42.26 29.77 L38.78 29.80 L34.60 30.17 L31.25 30.71 L28.79 31.29 L25.95 32.13 L25.82 32.13 L25.72 32.03 L24.47 27.07 L23.93 24.57 L23.39 22.61 L22.48 18.66 L22.51 18.46 L22.71 18.53 L31.52 26.19 L31.93 26.53 L32.10 26.53 L40.17 19.47 L47.86 12.58 L48.00 12.58 L63.94 26.53 L64.91 25.75 L70.15 21.06 L73.32 18.36 L73.39 18.42 L73.39 18.63 L71.23 27.20 L69.95 31.93 L69.71 31.96 L65.79 30.58 L60.66 29.23 L56.61 28.45 L53.30 28.01 L50.84 27.78 L48.74 27.68 L45.97 27.71 L42.90 27.91 L40.17 28.28 L39.63 28.45 L42.53 28.52 L45.57 28.79 L47.66 29.06 L50.84 29.60 L55.87 30.85 L59.31 31.93 L64.21 33.79 L66.97 35.00 L72.34 37.64 L72.55 37.09 L73.09 34.56 L73.49 33.08 L73.90 31.12 L75.65 23.83 L76.33 20.59 L76.87 18.53 L78.62 10.69 L78.99 9.31Z',
	'M23.39 60.86 L23.39 61.54 L23.56 62.96 L24.00 64.95 L24.33 65.93 L24.70 66.67 L25.45 67.75 L26.43 68.73 L27.44 69.44 L28.42 69.91 L29.26 70.22 L30.82 70.45 L64.27 70.45 L65.59 70.35 L66.87 69.98 L68.19 69.34 L69.34 68.46 L70.32 67.35 L70.99 66.27 L71.60 64.81 L71.97 63.13 L72.14 61.71 L72.14 60.63 L71.87 60.19 L71.40 59.78 L70.59 59.51 L69.98 59.51 L69.14 59.82 L68.83 60.02 L68.39 60.46 L68.26 60.69 L68.26 62.01 L68.09 63.06 L67.72 64.14 L67.14 65.18 L66.50 65.89 L65.76 66.43 L64.71 66.87 L63.94 67.01 L50.33 67.11 L31.79 67.04 L30.55 66.74 L29.60 66.27 L28.79 65.56 L28.18 64.71 L27.71 63.73 L27.44 62.79 L27.30 61.94 L27.30 60.63 L27.20 60.39 L26.70 59.92 L26.12 59.61 L25.65 59.51 L25.21 59.51 L24.57 59.65 L24.03 59.95 L23.66 60.32Z',
	'M19.81 40.88 L19.84 44.12 L20.05 44.69 L20.32 45.00 L20.55 45.13 L22.04 45.20 L22.17 45.37 L22.21 48.74 L22.48 50.80 L23.05 53.23 L23.42 54.21 L23.96 55.23 L24.47 55.87 L24.97 56.34 L25.68 56.85 L26.53 57.28 L27.24 57.52 L28.52 57.79 L31.09 58.06 L35.81 58.09 L38.88 57.93 L40.00 57.79 L41.32 57.52 L42.19 57.25 L42.94 56.88 L43.37 56.58 L43.78 56.17 L44.59 54.92 L45.13 53.47 L45.54 51.95 L45.94 49.32 L46.24 48.91 L46.51 48.78 L48.95 48.78 L49.35 49.05 L49.59 49.59 L49.76 50.73 L50.33 53.30 L50.84 54.79 L51.38 55.77 L51.95 56.44 L52.66 56.98 L53.44 57.35 L54.31 57.55 L55.97 57.79 L59.99 58.09 L62.28 58.09 L65.49 57.93 L67.62 57.69 L69.03 57.39 L70.11 56.85 L71.19 55.87 L71.84 54.95 L72.55 53.44 L73.09 51.65 L73.36 49.99 L73.49 48.51 L73.63 45.30 L73.73 45.20 L75.08 45.13 L75.41 44.96 L75.68 44.69 L75.89 44.22 L75.89 40.81 L75.75 40.47 L75.52 40.20 L75.18 40.00 L74.74 39.90 L60.96 39.49 L57.96 39.49 L55.29 39.59 L53.30 39.80 L52.42 40.03 L51.78 40.34 L51.31 40.64 L50.70 41.21 L50.33 41.72 L50.03 42.40 L49.62 44.59 L49.22 45.10 L48.81 45.27 L46.92 45.27 L46.48 45.20 L46.21 45.03 L45.94 44.62 L45.77 43.41 L45.50 42.43 L45.23 41.89 L44.79 41.28 L44.15 40.67 L43.51 40.27 L42.53 39.93 L41.62 39.76 L37.40 39.49 L33.21 39.49 L21.06 39.90 L20.69 39.96 L20.25 40.17 L19.91 40.54Z',
] as const;

export const chatWorkingLogoDrawDuration = 2667;

export interface IChatWorkingLogoDrawFrame {
	readonly paths: Readonly<Record<ChatWorkingLogoDrawBand, string>>;
	readonly tail: number;
	readonly head: number;
	readonly assembled: boolean;
}

interface ICrossSection {
	readonly a: Point;
	readonly b: Point;
}

interface IFoldBand {
	readonly splitAt: number;
	readonly before: ChatWorkingLogoDrawBand;
	readonly after: ChatWorkingLogoDrawBand;
}

type SpanBand = ChatWorkingLogoDrawBand | IFoldBand;
type DrawMark = [number, number, ChatWorkingLogoDrawBand];

const point = (x: number, y: number): Point => [x, y];

// Kingu: the ribbon zigzags down the Kingu mark in the masks' 0-100 space (screen = 6 + 0.84 * p):
// across the crown, back across the shades, then across the smile.
const P = {
	left: 12,
	right: 86,
	foldLeft: 4,
	foldRight: 94,
	top: 0,
	crownShades: 39,
	shadesSmile: 63,
	bottom: 80,
};

export const CHAT_WORKING_LOGO_DRAW_PAINT_ORDER: readonly ChatWorkingLogoDrawBand[] = ['leg1', 'leg3', 'bar'];

const subtract = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1]];
const multiply = (value: Point, scalar: number): Point => [value[0] * scalar, value[1] * scalar];
const midpoint = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const length = (value: Point): number => Math.hypot(value[0], value[1]);
const normalize = (value: Point): Point => {
	const valueLength = length(value) || 1;
	return [value[0] / valueLength, value[1] / valueLength];
};
const interpolate = (a: Point, b: Point, amount: number): Point => [
	a[0] + (b[0] - a[0]) * amount,
	a[1] + (b[1] - a[1]) * amount,
];
const clamp = (value: number): number => value < 0 ? 0 : value > 1 ? 1 : value;
const crossSectionMidpoint = (section: ICrossSection): Point => midpoint(section.a, section.b);

const tieDuration = 0.4;
const holdEnd = 0.55;
const untieEnd = 0.95;

function easeOutCubic(value: number): number {
	const amount = clamp(value);
	const remaining = 1 - amount;
	return 1 - remaining * remaining * remaining;
}

function easeInCubic(value: number): number {
	const amount = clamp(value);
	return amount * amount * amount;
}

function binarySearch(values: readonly number[], target: number): number {
	let low = 0;
	let high = values.length - 2;
	while (low < high) {
		const middle = (low + high + 1) >> 1;
		if (values[middle] <= target) {
			low = middle;
		} else {
			high = middle - 1;
		}
	}
	return low;
}

class Chain {
	readonly cumulative: number[] = [0];
	readonly length: number;

	constructor(readonly points: readonly Point[]) {
		for (let index = 1; index < points.length; index++) {
			this.cumulative.push(this.cumulative[index - 1] + length(subtract(points[index], points[index - 1])));
		}
		this.length = this.cumulative[this.cumulative.length - 1];
	}

	vertexFractions(): number[] {
		return this.length === 0 ? [] : this.cumulative.slice(1, -1).map(value => value / this.length);
	}

	pointAt(fraction: number): Point {
		if (this.length === 0) {
			return [...this.points[0]];
		}
		const target = clamp(fraction) * this.length;
		const index = binarySearch(this.cumulative, target);
		const segmentLength = this.cumulative[index + 1] - this.cumulative[index];
		return interpolate(this.points[index], this.points[index + 1], segmentLength > 0 ? (target - this.cumulative[index]) / segmentLength : 0);
	}
}

class Span {
	private sectionLengths: number[] = [];
	private readonly vertexFractions: readonly number[];
	sLength = 0;

	constructor(
		readonly sideA: Chain,
		readonly sideB: Chain,
		readonly band: SpanBand,
	) {
		this.vertexFractions = sideA.vertexFractions().concat(sideB.vertexFractions()).sort((a, b) => a - b);
		this.measure();
	}

	crossSection(amount: number): ICrossSection {
		return { a: this.sideA.pointAt(amount), b: this.sideB.pointAt(amount) };
	}

	breaks(start: number, end: number): number[] {
		const low = Math.min(start, end);
		const high = Math.max(start, end);
		const result: number[] = [];
		for (const value of this.vertexFractions) {
			if (value <= low + 1e-9 || value >= high - 1e-9) {
				continue;
			}
			if (!result.length || value - result[result.length - 1] > 1e-6) {
				result.push(value);
			}
		}
		return result;
	}

	private measure(): void {
		const steps = 200;
		const lengths = [0];
		let previous = crossSectionMidpoint(this.crossSection(0));
		for (let index = 1; index <= steps; index++) {
			const current = crossSectionMidpoint(this.crossSection(index / steps));
			lengths.push(lengths[index - 1] + length(subtract(current, previous)));
			previous = current;
		}
		this.sectionLengths = lengths;
		this.sLength = lengths[steps];
	}

	tOfS(localLength: number): number {
		if (this.sLength === 0) {
			return 0;
		}
		const count = this.sectionLengths.length - 1;
		const target = Math.min(Math.max(localLength, 0), this.sLength);
		const index = binarySearch(this.sectionLengths, target);
		const segmentLength = this.sectionLengths[index + 1] - this.sectionLengths[index];
		return (index + (segmentLength > 0 ? (target - this.sectionLengths[index]) / segmentLength : 0)) / count;
	}

	sOfT(amount: number): number {
		const count = this.sectionLengths.length - 1;
		const scaled = clamp(amount) * count;
		const index = Math.min(Math.floor(scaled), count - 1);
		return this.sectionLengths[index] + (this.sectionLengths[index + 1] - this.sectionLengths[index]) * (scaled - index);
	}
}

function buildLogoSpans(): Span[] {
	const { left, right, foldLeft, foldRight, top, crownShades, shadesSmile, bottom } = P;
	return [
		new Span(new Chain([point(left, crownShades), point(right, crownShades)]), new Chain([point(left, top), point(right, top)]), 'leg1'),
		new Span(new Chain([point(right, crownShades)]), new Chain([point(right, top), point(foldRight, top), point(foldRight, shadesSmile), point(right, shadesSmile)]), 'leg1'),
		new Span(new Chain([point(right, crownShades), point(left, crownShades)]), new Chain([point(right, shadesSmile), point(left, shadesSmile)]), 'bar'),
		new Span(new Chain([point(left, crownShades), point(foldLeft, crownShades), point(foldLeft, bottom), point(left, bottom)]), new Chain([point(left, shadesSmile)]), 'bar'),
		new Span(new Chain([point(left, bottom), point(right, bottom)]), new Chain([point(left, shadesSmile), point(right, shadesSmile)]), 'leg3'),
	];
}

/** Models the mark as one arc-length-parameterized strip with smooth moving end caps. */
class Ribbon {
	readonly spans = buildLogoSpans();
	readonly spanStarts: number[] = [];
	readonly length: number;
	private readonly marks: DrawMark[];
	private readonly fullBandPaths = new Map<DrawMark, string[]>();

	constructor(private readonly bleed = 0.35) {
		let totalLength = 0;
		for (const span of this.spans) {
			this.spanStarts.push(totalLength);
			totalLength += span.sLength;
		}
		this.length = totalLength;
		this.marks = this.buildMarks();
	}

	private locate(distance: number): { readonly index: number; readonly amount: number } {
		const clamped = Math.min(Math.max(distance, 0), this.length);
		let index = this.spans.length - 1;
		for (let candidate = 0; candidate < this.spans.length; candidate++) {
			if (clamped <= this.spanStarts[candidate] + this.spans[candidate].sLength) {
				index = candidate;
				break;
			}
		}
		return { index, amount: this.spans[index].tOfS(clamped - this.spanStarts[index]) };
	}

	private crossSection(distance: number): ICrossSection {
		const location = this.locate(distance);
		return this.spans[location.index].crossSection(location.amount);
	}

	private travelCap(distance: number, direction: -1 | 1): Point[] {
		const { a, b } = this.crossSection(distance);
		const before = crossSectionMidpoint(this.crossSection(Math.max(0, distance - 0.15)));
		const after = crossSectionMidpoint(this.crossSection(Math.min(this.length, distance + 0.15)));
		let forward = normalize(subtract(after, before));
		if (direction < 0) {
			forward = multiply(forward, -1);
		}
		const start = direction > 0 ? a : b;
		const end = direction > 0 ? b : a;
		const width = length(subtract(a, b));
		const points: Point[] = [];
		for (let index = 0; index <= 8; index++) {
			const amount = index / 8;
			// Cover the mark's rounded tips before the reveal cap starts moving.
			const bow = amount * (1 - amount) * width;
			points.push(add(interpolate(start, end, amount), multiply(forward, bow)));
		}
		return points;
	}

	private sections(startDistance: number, endDistance: number): ICrossSection[] {
		const result: ICrossSection[] = [];
		const start = this.locate(startDistance);
		const total = endDistance - startDistance;
		let spanIndex = start.index;
		let amount = start.amount;
		let completed = 0;
		while (spanIndex < this.spans.length) {
			const span = this.spans[spanIndex];
			const currentLength = span.sOfT(amount);
			const endingLength = Math.min(currentLength + (total - completed), span.sLength);
			const endingAmount = span.tOfS(endingLength);
			result.push(span.crossSection(amount));
			for (const breakpoint of span.breaks(amount, endingAmount)) {
				result.push(span.crossSection(breakpoint));
			}
			result.push(span.crossSection(endingAmount));
			completed += endingLength - currentLength;
			if (completed >= total - 1e-9) {
				break;
			}
			spanIndex++;
			amount = 0;
		}
		return result;
	}

	private buildMarks(): DrawMark[] {
		const marks: DrawMark[] = [];
		for (let index = 0; index < this.spans.length; index++) {
			const span = this.spans[index];
			const start = this.spanStarts[index];
			if (typeof span.band === 'string') {
				marks.push([start, start + span.sLength, span.band]);
			} else {
				const cut = start + span.sOfT(findCrossing(span.sideB, span.band.splitAt));
				marks.push([start, cut, span.band.before]);
				marks.push([cut, start + span.sLength, span.band.after]);
			}
		}
		const merged: DrawMark[] = [];
		for (const mark of marks) {
			const previous = merged[merged.length - 1];
			if (previous && previous[2] === mark[2] && Math.abs(previous[1] - mark[0]) < 1e-9) {
				previous[1] = mark[1];
			} else {
				merged.push([...mark]);
			}
		}
		const paintIndex = (band: ChatWorkingLogoDrawBand): number => CHAT_WORKING_LOGO_DRAW_PAINT_ORDER.indexOf(band);
		for (let index = 0; index < merged.length - 1; index++) {
			if (paintIndex(merged[index][2]) < paintIndex(merged[index + 1][2])) {
				merged[index][1] += this.bleed;
			} else {
				merged[index + 1][0] -= this.bleed;
			}
		}
		return merged;
	}

	bands(start: number, end: number): Readonly<Record<ChatWorkingLogoDrawBand, string>> {
		const buckets = new Map<ChatWorkingLogoDrawBand, string[]>(
			CHAT_WORKING_LOGO_DRAW_PAINT_ORDER.map(band => [band, []]),
		);
		for (const mark of this.marks) {
			const [markStart, markEnd, band] = mark;
			const low = Math.max(start, markStart);
			const high = Math.min(end, markEnd);
			if (high - low <= 1e-6) {
				continue;
			}
			const capStart = Math.abs(low - start) < 1e-9;
			const capEnd = Math.abs(high - end) < 1e-9;
			let path: string;
			if (low === markStart && high === markEnd) {
				let paths = this.fullBandPaths.get(mark);
				if (!paths) {
					paths = [];
					this.fullBandPaths.set(mark, paths);
				}
				// Four cap combinations per fixed band; moving endpoints are never cached.
				const capIndex = (capStart ? 1 : 0) | (capEnd ? 2 : 0);
				path = paths[capIndex] ??= this.strip(low, high, capStart, capEnd);
			} else {
				path = this.strip(low, high, capStart, capEnd);
			}
			buckets.get(band)!.push(path);
		}
		return {
			leg1: buckets.get('leg1')!.join(''),
			leg3: buckets.get('leg3')!.join(''),
			bar: buckets.get('bar')!.join(''),
		};
	}

	private strip(start: number, end: number, capStart: boolean, capEnd: boolean): string {
		const sections = this.sections(start, end);
		if (sections.length < 2) {
			return '';
		}
		const points: Point[] = [];
		if (capStart) {
			points.push(...this.travelCap(start, -1));
		} else {
			points.push(sections[0].b, sections[0].a);
		}
		for (let index = 1; index < sections.length; index++) {
			points.push(sections[index].a);
		}
		if (capEnd) {
			points.push(...this.travelCap(end, 1).slice(1));
		} else {
			points.push(sections[sections.length - 1].b);
		}
		for (let index = sections.length - 2; index >= 0; index--) {
			points.push(sections[index].b);
		}
		return toPath(points);
	}
}

function findCrossing(chain: Chain, x: number): number {
	const increasing = chain.pointAt(0)[0] < x;
	let low = 0;
	let high = 1;
	for (let index = 0; index < 50; index++) {
		const middle = (low + high) / 2;
		const before = increasing ? chain.pointAt(middle)[0] < x : chain.pointAt(middle)[0] > x;
		if (before) {
			low = middle;
		} else {
			high = middle;
		}
	}
	return (low + high) / 2;
}

function toPath(points: readonly Point[]): string {
	let path = `M${format(points[0][0])} ${format(points[0][1])}`;
	for (let index = 1; index < points.length; index++) {
		path += `L${format(points[index][0])} ${format(points[index][1])}`;
	}
	return `${path}Z`;
}

function format(value: number): string {
	const rounded = Math.round(value * 1000) / 1000;
	return Object.is(rounded, -0) ? '0' : String(rounded);
}

const drawRibbon = new Ribbon();
const emptyPaths = drawRibbon.bands(0, 0);
const tiedPaths = drawRibbon.bands(0, drawRibbon.length);

export function getChatWorkingLogoDrawFrame(progress: number): IChatWorkingLogoDrawFrame {
	const wrapped = progress >= 0 && progress < 1 ? progress : ((progress % 1) + 1) % 1;
	if (wrapped < tieDuration) {
		const head = drawRibbon.length * easeOutCubic(wrapped / tieDuration);
		return { paths: head > 0 ? drawRibbon.bands(0, head) : emptyPaths, tail: 0, head, assembled: false };
	}
	if (wrapped < holdEnd) {
		return { paths: tiedPaths, tail: 0, head: drawRibbon.length, assembled: true };
	}
	if (wrapped < untieEnd) {
		const tail = drawRibbon.length * easeInCubic((wrapped - holdEnd) / (untieEnd - holdEnd));
		return { paths: drawRibbon.bands(tail, drawRibbon.length), tail, head: drawRibbon.length, assembled: false };
	}
	return { paths: emptyPaths, tail: drawRibbon.length, head: drawRibbon.length, assembled: false };
}
