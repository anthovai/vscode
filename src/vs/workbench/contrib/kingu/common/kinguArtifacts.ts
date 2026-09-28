/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/*
 * The ADE's Artifacts model (`shared/artifacts.ts`,
 * `components/artifacts/artifact-display-labels.ts`): shared pages published to
 * Kingu's cloud, read through the ADE's runtime (`artifacts.*` over `runtime:call`).
 */

import { localize } from '../../../../nls.js';

export const KINGU_ARTIFACTS_VIEW_ID = 'kingu.customView.artifacts';
export const KINGU_SHOW_ARTIFACTS_COMMAND_ID = 'kingu.artifacts.show';
export const KINGU_SHARE_ARTIFACT_COMMAND_ID = 'kingu.artifacts.shareActiveFile';

/** The ADE's `ArtifactMetadata` and `ArtifactListItem`. */
export interface IKinguArtifact {
	readonly artifact: {
		readonly slug: string;
		readonly title: string | null;
		readonly originalFileName: string | null;
		readonly sourceContentType: string;
		readonly createdAt: string;
		readonly updatedAt: string;
		readonly expiresAt: string;
		readonly byteSize: number;
	};
	readonly shareUrl: string;
}

export interface IKinguArtifactPage {
	readonly artifacts: readonly IKinguArtifact[];
	readonly nextCursor?: string;
}

/** The ADE's `RuntimeRpcResponse` around an `ArtifactCloudOperation`. */
export type KinguRuntimeResponse<T> =
	| { readonly ok: true; readonly result: KinguArtifactOperation<T> }
	| { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

export type KinguArtifactOperation<T> =
	| { readonly status: 'ok'; readonly value: T }
	| { readonly status: 'reconnect-required' }
	| { readonly status: 'unconfigured'; readonly message: string };

export type KinguArtifactOutcome<T> =
	| { readonly kind: 'ok'; readonly value: T }
	| { readonly kind: 'signIn' }
	| { readonly kind: 'unconfigured'; readonly message: string }
	| { readonly kind: 'error'; readonly message: string };

/** One answer from the ADE's runtime, read as what the page should show. */
export function readArtifactOperation<T>(response: KinguRuntimeResponse<T> | undefined): KinguArtifactOutcome<T> {
	if (!response) {
		return { kind: 'error', message: localize('kingu.artifacts.noAnswer', "Kingu's runtime did not answer.") };
	}
	if (!response.ok) {
		return { kind: 'error', message: response.error.message || response.error.code };
	}
	switch (response.result.status) {
		case 'ok': return { kind: 'ok', value: response.result.value };
		case 'reconnect-required': return { kind: 'signIn' };
		case 'unconfigured': return { kind: 'unconfigured', message: response.result.message };
	}
}

/** What a file is shared as, by its name; `undefined` for a file that cannot be an artifact. */
export function artifactContentTypeForFile(fileName: string): 'text/markdown' | 'text/html' | undefined {
	const extension = /\.(?<ext>[^./\\]+)$/.exec(fileName.toLowerCase())?.groups?.ext;
	switch (extension) {
		case 'md':
		case 'markdown':
			return 'text/markdown';
		case 'html':
		case 'htm':
			return 'text/html';
		default:
			return undefined;
	}
}

/** The ADE's `artifactDisplayTitle`: the title, else the file name, else the slug. */
export function artifactDisplayTitle(item: IKinguArtifact): string {
	return item.artifact.title?.trim() || item.artifact.originalFileName || item.artifact.slug;
}

export function artifactTypeLabel(contentType: string): string {
	return contentType === 'text/markdown' ? localize('kingu.artifacts.markdown', "Markdown") : contentType === 'text/html' ? localize('kingu.artifacts.html', "HTML") : contentType;
}

export function formatArtifactBytes(bytes: number): string {
	if (bytes < 1024) {
		return localize('kingu.artifacts.bytes', "{0} B", bytes);
	}
	if (bytes < 1024 * 1024) {
		return localize('kingu.artifacts.kilobytes', "{0} KB", (bytes / 1024).toFixed(1));
	}
	return localize('kingu.artifacts.megabytes', "{0} MB", (bytes / (1024 * 1024)).toFixed(1));
}

/** When a link stops working, in whole days from `now`. */
export function artifactExpiryLabel(expiresAt: string, now: Date): string {
	const days = Math.ceil((new Date(expiresAt).getTime() - now.getTime()) / 86_400_000);
	if (Number.isNaN(days)) {
		return '-';
	}
	if (days <= 0) {
		return localize('kingu.artifacts.expired', "Expired");
	}
	return days === 1 ? localize('kingu.artifacts.oneDayLeft', "1 day left") : localize('kingu.artifacts.daysLeft', "{0} days left", days);
}
