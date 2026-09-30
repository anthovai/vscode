/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/*
 * The Kingu account and its plan, as Kingu cloud reports them
 * (`kingu-intelligence/cloud/apps/api`: `plans.ts`, `account.ts`,
 * `desktop-auth.ts`): who is signed in, on which plan, and a grant code
 * redeemed for a better one.
 */

import { Event } from '../../../../base/common/event.js';
import { localize } from '../../../../nls.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/** `kingu.account.state`: the {@link KinguAccountState} the account service holds, read once if it never was. */
export const KINGU_ACCOUNT_STATE_COMMAND_ID = 'kingu.account.state';

/** A plan, as `GET /v1/account` (`planView`) or the capability flags name it. */
export interface IKinguPlan {
	/** `free`, `arkai_pro`, … */
	readonly id: string;
	/** The cloud's own name for it (`Free`, `Arkai Pro`). */
	readonly name: string;
	/** Kingu-cloud model tokens a day; `null` where none are metered. Unknown from flags alone. */
	readonly dailyTokens?: number | null;
	/** When the entitlement giving this plan ends, as an ISO date; absent when it does not. */
	readonly endsAt?: string;
}

export type KinguAccountState =
	| { readonly kind: 'checking' }
	/** This build has no Kingu cloud to sign in to. */
	| { readonly kind: 'unavailable' }
	| { readonly kind: 'signedOut' }
	/** Was signed in; the session needs a fresh sign-in. */
	| { readonly kind: 'expired'; readonly email?: string }
	| { readonly kind: 'signedIn'; readonly email: string; readonly plan?: IKinguPlan };

/** What redeeming a code came to. */
export type KinguRedeemOutcome =
	| { readonly kind: 'ok'; readonly plan: IKinguPlan }
	| { readonly kind: 'signIn' }
	| { readonly kind: 'error'; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The plan the capability flags stand for (`planFlags`): `arkai.pro` only on
 * Arkai Pro; `arkai` or sharing on every plan, so Free. `undefined` from a
 * cloud that sends neither.
 */
export function planFromFlags(flags: unknown): IKinguPlan | undefined {
	if (!isRecord(flags)) {
		return undefined;
	}
	if (flags['arkai.pro'] === true) {
		return { id: 'arkai_pro', name: 'Arkai Pro' };
	}
	return flags.arkai === true || flags.share === true ? { id: 'free', name: 'Free' } : undefined;
}

/** The ADE's `kinguProfiles:authStatus` (`KinguProfileAuthStatus`), as the account's state. */
export function readKinguAuthStatus(status: unknown): KinguAccountState {
	if (!isRecord(status)) {
		return { kind: 'unavailable' };
	}
	const cloud = isRecord(status.cloud) ? status.cloud : undefined;
	const email = typeof cloud?.email === 'string' && cloud.email ? cloud.email : undefined;
	switch (status.state) {
		case 'connected': {
			const plan = planFromFlags(isRecord(status.capabilities) ? status.capabilities.flags : undefined);
			return email ? { kind: 'signedIn', email, ...(plan ? { plan } : {}) } : { kind: 'expired' };
		}
		case 'reconnect-required':
			return { kind: 'expired', ...(email ? { email } : {}) };
		case 'unconfigured':
			return { kind: 'unavailable' };
		default:
			return { kind: 'signedOut' };
	}
}

/**
 * `GET /v1/account` and `POST /v1/account/redeem`'s body:
 * `{ email, displayName, plan: { id, name, dailyTokens, features }, entitlement: { id, endsAt, source } | null }`.
 */
export function readKinguAccountBody(body: unknown): { readonly email: string; readonly plan: IKinguPlan } | undefined {
	if (!isRecord(body) || typeof body.email !== 'string' || !isRecord(body.plan)) {
		return undefined;
	}
	const { id, name, dailyTokens } = body.plan;
	if (typeof id !== 'string' || !id) {
		return undefined;
	}
	const endsAt = isRecord(body.entitlement) && typeof body.entitlement.endsAt === 'string' ? body.entitlement.endsAt : undefined;
	return {
		email: body.email,
		plan: {
			id,
			name: typeof name === 'string' && name ? name : id,
			dailyTokens: typeof dailyTokens === 'number' ? dailyTokens : null,
			...(endsAt ? { endsAt } : {}),
		},
	};
}

/** The cloud's `{ code, message }` error, in words a person can act on. */
function errorMessage(body: unknown): string {
	const code = isRecord(body) && typeof body.code === 'string' ? body.code : undefined;
	switch (code) {
		case 'invalid_code':
			return localize('kingu.account.error.invalidCode', "This code is not valid or has been used up.");
		case 'code_already_redeemed':
			return localize('kingu.account.error.alreadyRedeemed', "This account already redeemed this code.");
		case 'invalid_request':
			return localize('kingu.account.error.invalidRequest', "Enter a code to redeem.");
		case 'account_not_found':
			return localize('kingu.account.error.accountNotFound', "Kingu cloud has no account for this sign-in. Sign in again.");
	}
	const message = isRecord(body) && typeof body.message === 'string' ? body.message : undefined;
	return message || localize('kingu.account.error.unknown', "Kingu cloud could not do that. Try again.");
}

/** `kinguProfiles:accountRequest`: the signed-in Kingu account (`GET /v1/account`), or a grant code redeemed for it. */
export interface IKinguCloudAccountRequest {
	/** Redeems this code (`POST /v1/account/redeem`) instead of reading the account. */
	readonly redeemCode?: string;
}

/**
 * Kingu cloud's answer as the ADE passes it on (it makes the request, holding
 * the session): the status and JSON body as they came, or why no request was
 * made — no one is signed in, or there is no cloud to ask.
 */
export type KinguCloudAccountReply =
	| { readonly kind: 'response'; readonly status: number; readonly body: unknown }
	| { readonly kind: 'signedOut' }
	| { readonly kind: 'unavailable'; readonly reason: string };

/** A `kinguProfiles:accountRequest` reply, read as the account's plan, a need to sign in, or what went wrong. */
export function readKinguAccountReply(reply: KinguCloudAccountReply | undefined): KinguRedeemOutcome {
	if (!reply) {
		return { kind: 'error', message: localize('kingu.account.error.unreachable', "Kingu cloud could not be reached.") };
	}
	switch (reply.kind) {
		case 'signedOut':
			return { kind: 'signIn' };
		case 'unavailable':
			return { kind: 'error', message: reply.reason };
		case 'response': {
			if (reply.status === 401) {
				return { kind: 'signIn' };
			}
			const account = reply.status >= 200 && reply.status < 300 ? readKinguAccountBody(reply.body) : undefined;
			return account ? { kind: 'ok', plan: account.plan } : { kind: 'error', message: errorMessage(reply.body) };
		}
	}
}

/** A plan's name as Kingu shows it: `Free` in the display language, others by the cloud's name. */
export function kinguPlanLabel(plan: IKinguPlan): string {
	return plan.id === 'free' ? localize('kingu.account.plan.free', "Free") : plan.name;
}

/** The Plan row: the plan's name, and until when a granted plan lasts. */
export function describeKinguPlan(plan: IKinguPlan): string {
	const label = kinguPlanLabel(plan);
	return plan.endsAt ? localize('kingu.account.plan.until', "{0}, until {1}", label, plan.endsAt.slice(0, 10)) : label;
}

/** The account's plan in a line beside other AIs' (`Free plan`, `Arkai Pro plan`); `undefined` while it is not known. */
export function kinguPlanSummary(state: KinguAccountState | undefined): string | undefined {
	return state?.kind === 'signedIn' && state.plan ? localize('kingu.account.plan.summary', "{0} plan", kinguPlanLabel(state.plan)) : undefined;
}

/** The Kingu account row's line for each state, in the ADE's words where it has them. */
export function describeKinguAccount(state: KinguAccountState): string {
	switch (state.kind) {
		case 'checking':
			return localize('kingu.account.status.checking', "Checking account status…");
		case 'unavailable':
			return localize('kingu.account.status.unavailable', "Kingu sign-in is unavailable in this build.");
		case 'signedOut':
			return localize('kingu.account.status.signedOut', "Sign in to extend Kingu with cloud features, including Artifacts and Kingu Relay.");
		case 'expired':
			return localize('kingu.account.status.expired', "Your session expired. Sign in again to use cloud features.");
		case 'signedIn':
			return localize('kingu.account.status.signedIn', "Signed in as {0}", state.email);
	}
}

export const IKinguAccountService =createDecorator<IKinguAccountService>('kinguAccountService');

/**
 * The Kingu account: signed in through the ADE's cloud sign-in, its plan from
 * `GET /v1/account`, and grant codes redeemed for it. The desktop build
 * registers it.
 */
export interface IKinguAccountService {
	readonly _serviceBrand: undefined;
	readonly state: KinguAccountState;
	readonly onDidChange: Event<void>;
	/** Reads the sign-in and the plan again. */
	refresh(): Promise<void>;
	/** The ADE's "Sign in to Kingu"; the account's email, or `undefined` when it did not finish. */
	signIn(): Promise<string | undefined>;
	/** The ADE's sign-out: ends the session and unlinks this profile from the account. */
	signOut(): Promise<void>;
	redeem(code: string): Promise<KinguRedeemOutcome>;
}
