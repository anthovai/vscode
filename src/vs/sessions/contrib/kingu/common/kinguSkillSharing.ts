/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/*
 * The ADE's skill sharing model (`shared/skills.ts`, `shared/skill-cloud-contract.ts`,
 * `shared/skill-sharing-contract.ts`, `shared/skill-share-link.ts`,
 * `components/skills/skill-share-selection.ts`, `skill-bundle-name.ts`): the
 * skills on this machine, the unlisted links they are shared behind, and a
 * link someone sent, read through the ADE's `skills:*` handlers.
 */

import { localize } from '../../../../nls.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const KINGU_SKILLS_VIEW_ID = 'kingu.customView.skills';
export const KINGU_SHOW_SKILLS_COMMAND_ID = 'kingu.skills.show';
/** `kingu.skills.installFromLink(link?)`: the Skills page on Install from Link, with the link looked up. */
export const KINGU_INSTALL_SKILL_LINK_COMMAND_ID = 'kingu.skills.installFromLink';
/** Signs this profile in to Kingu cloud (the ADE's `kinguProfiles:connectCurrent`). */
export const KINGU_CONNECT_CLOUD_COMMAND_ID = 'kingu.cloud.connect';

/** The ADE's `DiscoveredSkill`, the part the page reads. */
export interface IKinguDiscoveredSkill {
	readonly id: string;
	readonly name: string;
	readonly description: string | null;
	readonly providers: readonly string[];
	readonly sourceKind: string;
	readonly sourceLabel: string;
	readonly installed: boolean;
	readonly skillFilePath: string;
}

export interface IKinguSkillDiscovery {
	readonly skills: readonly IKinguDiscoveredSkill[];
}

/** The ADE's `SkillSharePreview`. */
export interface IKinguSkillSharePreview {
	readonly preparationId: string;
	readonly packageId: string;
	readonly name: string;
	readonly skillCount?: number;
	readonly skills?: readonly { readonly id: string; readonly name: string; readonly fileCount: number; readonly scriptPaths: readonly string[]; readonly executablePaths: readonly string[] }[];
	readonly fileCount: number;
	readonly totalBytes: number;
	readonly compressedBytes: number;
	readonly scriptPaths: readonly string[];
	readonly executablePaths: readonly string[];
}

/** The ADE's `SkillCloudVersion`, the part the page reads. */
export interface IKinguSkillVersion {
	readonly packageId: string;
	readonly versionId: string;
	readonly name: string;
	readonly description: string;
	readonly createdAt: string;
	readonly manifest: {
		readonly skills?: readonly { readonly id: string; readonly name: string; readonly description: string }[];
		readonly name?: string;
	};
}

/** The ADE's `SkillCloudOwnedShare`. */
export interface IKinguOwnedSkillShare {
	readonly id: string;
	readonly url: string;
	readonly packageId: string;
	readonly name: string;
	readonly description: string;
	readonly createdAt: string;
}

/** The ADE's `SkillCloudOperation`. */
export type KinguSkillCloudOperation<T> =
	| { readonly status: 'ok'; readonly value: T }
	| { readonly status: 'reconnect-required' }
	| { readonly status: 'unconfigured'; readonly message: string }
	| { readonly status: 'unsupported'; readonly message: string };

export type KinguSkillOutcome<T> =
	| { readonly kind: 'ok'; readonly value: T }
	| { readonly kind: 'signIn' }
	| { readonly kind: 'unconfigured'; readonly message: string }
	| { readonly kind: 'error'; readonly message: string };

/** One answer from a `skills:*` handler, read as what the page should show. */
export function readSkillOperation<T>(operation: KinguSkillCloudOperation<T> | undefined, failure?: unknown): KinguSkillOutcome<T> {
	if (!operation) {
		return { kind: 'error', message: skillErrorMessage(failure) };
	}
	switch (operation.status) {
		case 'ok': return { kind: 'ok', value: operation.value };
		case 'reconnect-required': return { kind: 'signIn' };
		case 'unconfigured': return { kind: 'unconfigured', message: operation.message };
		case 'unsupported': return { kind: 'error', message: operation.message };
	}
}

/** The ADE's `SkillBundleInstallResult` and `SkillInstallResult`, the part the page reads. */
export interface IKinguSkillInstallResult {
	readonly status: string;
	readonly skills?: readonly { readonly name: string; readonly status: string }[];
}

/**
 * The ADE's handlers throw codes (`skill-share-source-not-found`); the ones a
 * person can act on get a sentence, the rest pass through.
 */
export function skillErrorMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
	const code = /(?<code>skill[-_][a-z0-9-_]+)/i.exec(raw)?.groups?.code ?? '';
	switch (code) {
		case 'skill_share_not_found':
		case 'skill-share-not-found':
			return localize('kingu.skills.error.shareNotFound', "This link is unavailable. It may be invalid, expired, or revoked.");
		case 'skill-share-source-not-found':
			return localize('kingu.skills.error.sourceNotFound', "A selected skill is no longer on this machine. Refresh and try again.");
		case 'skill-share-preparation-expired':
			return localize('kingu.skills.error.preparationExpired', "The review expired. Start sharing again.");
		case 'skill-cloud-upload-url-invalid':
			return localize('kingu.skills.error.uploadUrl', "Kingu cloud gave an upload address this build does not accept.");
		case 'skill-download-origin-rejected':
		case 'skill-download-url-rejected':
			return localize('kingu.skills.error.downloadOrigin', "This link's package is hosted somewhere this build does not download from.");
	}
	return raw || localize('kingu.skills.error.unknown', "Something went wrong. Try again.");
}

/** The ADE's `isSkillShareEligible`: an installed skill of this machine, from home or a repository. */
export function isSkillShareEligible(skill: IKinguDiscoveredSkill): boolean {
	return skill.installed && (skill.sourceKind === 'home' || skill.sourceKind === 'repo');
}

const BUNDLE_NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
const MAX_BUNDLE_NAME = 64;
const FALLBACK_BUNDLE_NAME = 'shared-skills';

function slugify(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/-{2,}/g, '-').replace(/\.{2,}/g, '.').replace(/^[-.]+|[-.]+$/g, '');
}

/** The ADE's `derivedBundleName`: the first skill's name, and how many more there are. */
export function derivedBundleName(skills: readonly Pick<IKinguDiscoveredSkill, 'name'>[]): string {
	const first = slugify(skills[0]?.name ?? '');
	if (!first) {
		return FALLBACK_BUNDLE_NAME;
	}
	const others = skills.length - 1;
	if (others <= 0) {
		return first.slice(0, MAX_BUNDLE_NAME).replace(/[-.]+$/g, '') || FALLBACK_BUNDLE_NAME;
	}
	const suffix = `-and-${others}-more`;
	const head = first.slice(0, MAX_BUNDLE_NAME - suffix.length).replace(/[-.]+$/g, '');
	return head ? `${head}${suffix}` : FALLBACK_BUNDLE_NAME;
}

export function isValidBundleName(value: string): boolean {
	return BUNDLE_NAME_PATTERN.test(value);
}

const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SHARE_HOSTS = new Set(['app.kingu.dev', 'share.onkingu.dev', 'cloud.anthovai.com']);

/** The ADE's `parseSkillShareId`: a bare id, a share page address, or a `kingu://` link. */
export function parseSkillShareId(value: string): string | undefined {
	const trimmed = value.trim();
	if (SHARE_ID_PATTERN.test(trimmed)) {
		return trimmed;
	}
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return undefined;
	}
	if (url.protocol === 'kingu:') {
		return /^skills\/share\/(?<id>[A-Za-z0-9_-]{1,128})\/?$/.exec(`${url.host}${url.pathname}`)?.groups?.id;
	}
	const development = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
	if (url.protocol !== 'https:' && !(development && url.protocol === 'http:')) {
		return undefined;
	}
	if (!SHARE_HOSTS.has(url.hostname) && !development) {
		return undefined;
	}
	return /^\/skills\/share\/(?<id>[A-Za-z0-9_-]{1,128})\/?$/.exec(url.pathname)?.groups?.id;
}

/** The skills a shared version holds: a bundle's list, or the one skill of a single package. */
export function skillsOfVersion(version: IKinguSkillVersion): readonly { readonly id: string; readonly name: string; readonly description: string }[] {
	return version.manifest.skills ?? [{ id: version.manifest.name ?? version.name, name: version.name, description: version.description }];
}

export const IKinguSkillSharingService = createDecorator<IKinguSkillSharingService>('kinguSkillSharingService');

/**
 * Sharing and installing skills through Kingu cloud, by way of the ADE's
 * `skills:*` handlers. The desktop build registers it; elsewhere a stand-in
 * says it is not {@link available}, and the Skills page stays read-only.
 */
export interface IKinguSkillSharingService {
	readonly _serviceBrand: undefined;
	/** False where the ADE is not running (the web build): the Skills page then only reads. */
	readonly available: boolean;
	/** The ADE's view of the skills on this machine; its ids are what {@link prepare} takes. */
	discover(): Promise<readonly IKinguDiscoveredSkill[]>;
	/** Packs and checks the skills for review; throws a `skill-*` code when it cannot. */
	prepare(skillIds: readonly string[], bundleName: string): Promise<IKinguSkillSharePreview>;
	cancel(preparationId: string): Promise<void>;
	publish(preparationId: string, releaseNotes: string): Promise<KinguSkillOutcome<{ readonly url: string }>>;
	listOwnedShares(): Promise<KinguSkillOutcome<readonly IKinguOwnedSkillShare[]>>;
	revoke(shareId: string): Promise<KinguSkillOutcome<void>>;
	resolve(shareId: string): Promise<KinguSkillOutcome<IKinguSkillVersion>>;
	/** Into the home folder, for every agent the ADE detects. */
	install(shareId: string, version: IKinguSkillVersion, skillIds: readonly string[]): Promise<KinguSkillOutcome<IKinguSkillInstallResult>>;
	/** Signs this profile in to Kingu cloud; the account's email, or `undefined` when it did not finish. */
	connect(): Promise<string | undefined>;
}

/** Windows paths compare without case and with either slash. */
export function sameSkillFile(a: string, b: string): boolean {
	const normalize = (value: string) => value.replace(/\\/g, '/').replace(/^\/(?=[a-z]:)/i, '').toLowerCase();
	return normalize(a) === normalize(b);
}
