/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { asCssVariable } from '../../../../../platform/theme/common/colorUtils.js';
import { ChatConfiguration, ChatProgressAnimation } from '../../common/constants.js';
import { chatWorkingProgressInsidersIconForeground, chatWorkingProgressStableIconForeground } from '../../common/widget/chatColors.js';
import './media/chatWorkingLogo.css';

export type ChatWorkingLogoMotion =
	| 'fold' | 'weave' | 'weave-v' | 'draw' | 'relay' | 'stack' | 'orbit' | 'shutter'
	| 'aperture' | 'accordion' | 'dial' | 'magnet' | 'trace' | 'pendulum' | 'prism'
	| 'ladder' | 'carousel' | 'piston' | 'bridge' | 'fan' | 'comb' | 'braid' | 'sling' | 'folio' | 'helix';

const durations: Record<ChatWorkingLogoMotion, number> = {
	fold: 2800,
	weave: 1200,
	'weave-v': 1200,
	draw: 2400,
	relay: 3000,
	stack: 3200,
	orbit: 3000,
	shutter: 2800,
	aperture: 1600,
	accordion: 1500,
	dial: 1600,
	magnet: 1600,
	trace: 1800,
	pendulum: 1800,
	prism: 2000,
	ladder: 1800,
	carousel: 1800,
	piston: 1600,
	bridge: 1900,
	fan: 1700,
	comb: 1800,
	braid: 1800,
	sling: 1700,
	folio: 2000,
	helix: 1800,
};

/**
 * The Kingu mark in three pieces, each animated on its own: the crown, the shades and the
 * smile. The names are the motions' (`chatWorkingLogo.css` moves each piece by them).
 * Traced by build/kingu-brand/generate.py.
 */
const faces = [
	{
		name: 'ascending',
		path: 'M79.23 7.99 L79.09 8.03 L64.04 21.40 L63.90 21.36 L61.23 19.03 L48.00 7.15 L47.83 7.18 L39.09 15.15 L32.03 21.40 L31.90 21.40 L18.29 9.34 L16.87 8.09 L16.70 8.03 L16.67 8.23 L17.34 11.00 L18.29 15.49 L18.56 16.47 L20.08 23.49 L21.80 30.85 L22.10 32.47 L23.29 37.60 L23.39 37.67 L26.90 36.08 L28.79 35.31 L31.90 34.19 L36.01 33.01 L39.53 32.30 L42.43 31.90 L46.95 31.56 L51.31 31.63 L55.63 32.06 L55.43 31.93 L53.71 31.42 L49.89 30.58 L45.91 30.04 L42.26 29.77 L38.78 29.80 L34.60 30.17 L31.25 30.71 L28.79 31.29 L25.95 32.13 L25.82 32.13 L25.72 32.03 L24.47 27.07 L23.93 24.57 L23.39 22.61 L22.48 18.66 L22.51 18.46 L22.71 18.53 L31.52 26.19 L31.93 26.53 L32.10 26.53 L40.17 19.47 L47.86 12.58 L48.00 12.58 L63.94 26.53 L64.91 25.75 L70.15 21.06 L73.32 18.36 L73.39 18.42 L73.39 18.63 L71.23 27.20 L69.95 31.93 L69.71 31.96 L65.79 30.58 L60.66 29.23 L56.61 28.45 L53.30 28.01 L50.84 27.78 L48.74 27.68 L45.97 27.71 L42.90 27.91 L40.17 28.28 L39.63 28.45 L42.53 28.52 L45.57 28.79 L47.66 29.06 L50.84 29.60 L55.87 30.85 L59.31 31.93 L64.21 33.79 L66.97 35.00 L72.34 37.64 L72.55 37.09 L73.09 34.56 L73.49 33.08 L73.90 31.12 L75.65 23.83 L76.33 20.59 L76.87 18.53 L78.62 10.69 L78.99 9.31Z',
	},
	{
		name: 'descending',
		path: 'M23.39 60.86 L23.39 61.54 L23.56 62.96 L24.00 64.95 L24.33 65.93 L24.70 66.67 L25.45 67.75 L26.43 68.73 L27.44 69.44 L28.42 69.91 L29.26 70.22 L30.82 70.45 L64.27 70.45 L65.59 70.35 L66.87 69.98 L68.19 69.34 L69.34 68.46 L70.32 67.35 L70.99 66.27 L71.60 64.81 L71.97 63.13 L72.14 61.71 L72.14 60.63 L71.87 60.19 L71.40 59.78 L70.59 59.51 L69.98 59.51 L69.14 59.82 L68.83 60.02 L68.39 60.46 L68.26 60.69 L68.26 62.01 L68.09 63.06 L67.72 64.14 L67.14 65.18 L66.50 65.89 L65.76 66.43 L64.71 66.87 L63.94 67.01 L50.33 67.11 L31.79 67.04 L30.55 66.74 L29.60 66.27 L28.79 65.56 L28.18 64.71 L27.71 63.73 L27.44 62.79 L27.30 61.94 L27.30 60.63 L27.20 60.39 L26.70 59.92 L26.12 59.61 L25.65 59.51 L25.21 59.51 L24.57 59.65 L24.03 59.95 L23.66 60.32Z',
	},
	{
		name: 'spine',
		path: 'M19.81 40.88 L19.84 44.12 L20.05 44.69 L20.32 45.00 L20.55 45.13 L22.04 45.20 L22.17 45.37 L22.21 48.74 L22.48 50.80 L23.05 53.23 L23.42 54.21 L23.96 55.23 L24.47 55.87 L24.97 56.34 L25.68 56.85 L26.53 57.28 L27.24 57.52 L28.52 57.79 L31.09 58.06 L35.81 58.09 L38.88 57.93 L40.00 57.79 L41.32 57.52 L42.19 57.25 L42.94 56.88 L43.37 56.58 L43.78 56.17 L44.59 54.92 L45.13 53.47 L45.54 51.95 L45.94 49.32 L46.24 48.91 L46.51 48.78 L48.95 48.78 L49.35 49.05 L49.59 49.59 L49.76 50.73 L50.33 53.30 L50.84 54.79 L51.38 55.77 L51.95 56.44 L52.66 56.98 L53.44 57.35 L54.31 57.55 L55.97 57.79 L59.99 58.09 L62.28 58.09 L65.49 57.93 L67.62 57.69 L69.03 57.39 L70.11 56.85 L71.19 55.87 L71.84 54.95 L72.55 53.44 L73.09 51.65 L73.36 49.99 L73.49 48.51 L73.63 45.30 L73.73 45.20 L75.08 45.13 L75.41 44.96 L75.68 44.69 L75.89 44.22 L75.89 40.81 L75.75 40.47 L75.52 40.20 L75.18 40.00 L74.74 39.90 L60.96 39.49 L57.96 39.49 L55.29 39.59 L53.30 39.80 L52.42 40.03 L51.78 40.34 L51.31 40.64 L50.70 41.21 L50.33 41.72 L50.03 42.40 L49.62 44.59 L49.22 45.10 L48.81 45.27 L46.92 45.27 L46.48 45.20 L46.21 45.03 L45.94 44.62 L45.77 43.41 L45.50 42.43 L45.23 41.89 L44.79 41.28 L44.15 40.67 L43.51 40.27 L42.53 39.93 L41.62 39.76 L37.40 39.49 L33.21 39.49 L21.06 39.90 L20.69 39.96 L20.25 40.17 L19.91 40.54Z',
	},
] as const;

/** Animates HTML wrappers around fixed SVG faces instead of changing SVG geometry per frame. */
export class ChatWorkingLogo extends Disposable {
	readonly domNode: HTMLElement;

	get durationMs(): number {
		return durations[this.motion];
	}

	constructor(private motion: ChatWorkingLogoMotion, quality: 'stable' | 'insider' = 'stable') {
		super();
		this.domNode = $('span.chat-working-logo', { 'aria-hidden': 'true', 'data-motion': motion });
		this.domNode.classList.add(`chat-working-logo-${motion}`);
		this.domNode.style.animationDuration = `${this.durationMs}ms`;
		this.domNode.style.color = asCssVariable(quality === 'insider' ? chatWorkingProgressInsidersIconForeground : chatWorkingProgressStableIconForeground);

		for (const face of faces) {
			const wrapper = append(this.domNode, $(`span.chat-working-logo-face.chat-working-logo-${face.name}`));
			wrapper.appendChild($.SVG<SVGSVGElement>('svg', { viewBox: '6 6 84 84', width: '100%', height: '100%', focusable: 'false' },
				$.SVG<SVGPathElement>('path', { d: face.path, fill: 'currentColor' })));
		}
		this.setActive(true);
	}

	setMotion(motion: ChatWorkingLogoMotion): void {
		if (this.motion === motion) {
			return;
		}
		this.domNode.classList.remove(`chat-working-logo-${this.motion}`);
		this.motion = motion;
		this.domNode.classList.add(`chat-working-logo-${motion}`);
		this.domNode.dataset.motion = motion;
		this.domNode.style.animationDuration = `${this.durationMs}ms`;
	}

	setActive(active: boolean): void {
		this.domNode.classList.toggle('chat-working-logo-active', active);
	}

	override dispose(): void {
		this.domNode.remove();
		super.dispose();
	}
}

export class ChatWorkingProgressLogo extends ChatWorkingLogo {
	constructor(
		quality: 'stable' | 'insider',
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
	) {
		const animation = getConfiguredProgressAnimation(configurationService, logService);
		super(animation === ChatProgressAnimation.Off ? ChatProgressAnimation.Weave : animation, quality);
		this.updateAnimation(animation);
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ChatConfiguration.PersistentProgress)) {
				this.updateAnimation(getConfiguredProgressAnimation(configurationService, logService));
			}
		}));
	}

	private updateAnimation(animation: ChatProgressAnimation): void {
		this.setMotion(animation === ChatProgressAnimation.Off ? ChatProgressAnimation.Weave : animation);
		this.domNode.classList.toggle('chat-working-logo-static', animation === ChatProgressAnimation.Off);
		this.domNode.dataset.animation = animation;
	}
}

const warnedUnsupportedAnimations = new Set<string>();

export function getConfiguredProgressAnimation(configurationService: IConfigurationService, logService: ILogService): ChatProgressAnimation {
	const animation = configurationService.getValue<ChatProgressAnimation | undefined>(ChatConfiguration.PersistentProgress);
	switch (animation) {
		case undefined:
			return ChatProgressAnimation.Off;
		case ChatProgressAnimation.Off:
		case ChatProgressAnimation.Weave:
		case ChatProgressAnimation.Draw:
		case ChatProgressAnimation.Orbit:
		case ChatProgressAnimation.Accordion:
		case ChatProgressAnimation.Dial:
			return animation;
		default: {
			// Resolved on render hot paths, so an unknown value (e.g. from an experiment targeting a newer
			// client) must not warn on every call.
			const key = String(animation);
			if (!warnedUnsupportedAnimations.has(key)) {
				warnedUnsupportedAnimations.add(key);
				logService.warn('ChatWorkingProgressLogo: unsupported progress animation, using Off', animation);
			}
			return ChatProgressAnimation.Off;
		}
	}
}
