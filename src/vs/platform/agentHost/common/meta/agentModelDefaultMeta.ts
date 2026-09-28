/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Kingu: model metadata marking the model the agent itself starts on (an ACP
 * CLI's current model, e.g. Chyle 1 for Arkai), so the model picker opens on it
 * rather than on the first model by name.
 */
const KINGU_MODEL_DEFAULT_META_KEY = 'kingu.defaultModel';

interface IHasModelDefaultMeta {
	readonly _meta?: Record<string, unknown>;
}

/** Whether the agent starts on this model, dropping a wrong-typed value. */
export function readAgentModelDefaultMeta(source: IHasModelDefaultMeta): boolean {
	return source._meta?.[KINGU_MODEL_DEFAULT_META_KEY] === true;
}

/** Adds the default-model mark to an open model metadata bag. */
export function withAgentModelDefaultMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
	return { ...(meta ?? {}), [KINGU_MODEL_DEFAULT_META_KEY]: true };
}
