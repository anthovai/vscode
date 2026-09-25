/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';

/**
 * Kingu: the Claude CLI offers one row per family (`opus[1m]`, `sonnet`,
 * `haiku`, the newest Fable) and resolves each to its newest model. It still
 * runs any pinned version it knows, by its full id, so these are offered
 * beside the family rows for anyone who needs a particular one. The ids are the
 * ones the bundled CLI knows, each run once to check it answers as itself:
 * retired ones (Opus 4.1, Sonnet 4) are left out, since the CLI either refuses
 * them or quietly runs a newer model, and Opus 5.5 needs a newer CLI than the
 * one bundled.
 */
interface IPinnedClaudeModel {
	readonly id: string;
	readonly name: string;
	/** The family row whose thinking levels it shares, when it thinks adaptively (Opus 4.6 and later). */
	readonly family?: 'opus' | 'sonnet' | 'fable';
	readonly oneMillionContext?: boolean;
}

const PINNED_CLAUDE_MODELS: readonly IPinnedClaudeModel[] = [
	{ id: 'claude-fable-5', name: 'Fable 5', family: 'fable' },
	{ id: 'claude-opus-5', name: 'Opus 5', family: 'opus' },
	{ id: 'claude-opus-4-8[1m]', name: 'Opus 4.8', family: 'opus', oneMillionContext: true },
	{ id: 'claude-opus-4-8', name: 'Opus 4.8', family: 'opus' },
	{ id: 'claude-opus-4-7', name: 'Opus 4.7', family: 'opus' },
	{ id: 'claude-opus-4-6', name: 'Opus 4.6', family: 'opus' },
	{ id: 'claude-opus-4-5-20251101', name: 'Opus 4.5' },
	{ id: 'claude-sonnet-5[1m]', name: 'Sonnet 5', family: 'sonnet', oneMillionContext: true },
	{ id: 'claude-sonnet-4-6[1m]', name: 'Sonnet 4.6', family: 'sonnet', oneMillionContext: true },
	{ id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', family: 'sonnet' },
	{ id: 'claude-sonnet-4-5-20250929', name: 'Sonnet 4.5' },
];

/** The family a CLI row stands for, from its alias or resolved id. */
function familyOf(model: ModelInfo): string | undefined {
	return /(?<family>fable|opus|sonnet|haiku)/i.exec(`${model.value} ${model.resolvedModel ?? ''}`)?.groups?.family.toLowerCase();
}

/**
 * The CLI's rows followed by the pinned versions it does not already offer
 * (by alias or by the model an alias resolves to), in the shape the CLI
 * reports so they are projected the same way.
 */
export function withPinnedClaudeModels(models: readonly ModelInfo[]): ModelInfo[] {
	const offered = new Set<string>();
	for (const model of models) {
		offered.add(model.value);
		if (model.resolvedModel) {
			offered.add(model.resolvedModel);
		}
	}
	const pinned = PINNED_CLAUDE_MODELS.filter(model => !offered.has(model.id)).map((model): ModelInfo => {
		const family = model.family ? models.find(candidate => familyOf(candidate) === model.family && candidate.supportedEffortLevels?.length) : undefined;
		return {
			value: model.id,
			resolvedModel: model.id,
			displayName: model.oneMillionContext ? `${model.name} (1M context)` : model.name,
			description: `${model.name}${model.oneMillionContext ? ' with 1M context' : ''} · Pinned version`,
			...(family ? {
				supportsEffort: family.supportsEffort,
				supportedEffortLevels: family.supportedEffortLevels,
				supportsAdaptiveThinking: family.supportsAdaptiveThinking,
			} : {}),
		};
	});
	return [...models, ...pinned];
}
