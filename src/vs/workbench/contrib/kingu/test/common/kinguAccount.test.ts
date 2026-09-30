/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { describeKinguPlan, kinguPlanSummary, planFromFlags, readKinguAccountBody, readKinguAccountReply, readKinguAuthStatus } from '../../common/kinguAccount.js';
import { arkaiPlanLine } from '../../common/kinguAiAccountSummary.js';

suite('kinguAccount', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the ADE\'s sign-in, the plan from its capability flags', () => {
		const connected = (flags: Record<string, boolean>) => ({ activeProfileId: 'p', configured: true, state: 'connected', persistence: 'encrypted', cloud: { email: 'a@b.c' }, capabilities: { flags, refreshedAt: 1 } });
		assert.deepStrictEqual([
			readKinguAuthStatus(connected({ arkai: true, 'arkai.pro': true, share: true })),
			readKinguAuthStatus(connected({ arkai: true, share: true })),
			readKinguAuthStatus(connected({})),
			readKinguAuthStatus({ state: 'reconnect-required', cloud: { email: 'a@b.c' } }),
			readKinguAuthStatus({ state: 'unconfigured' }),
			readKinguAuthStatus({ state: 'local' }),
			readKinguAuthStatus(undefined),
			planFromFlags(undefined),
		], [
			{ kind: 'signedIn', email: 'a@b.c', plan: { id: 'arkai_pro', name: 'Arkai Pro' } },
			{ kind: 'signedIn', email: 'a@b.c', plan: { id: 'free', name: 'Free' } },
			{ kind: 'signedIn', email: 'a@b.c' },
			{ kind: 'expired', email: 'a@b.c' },
			{ kind: 'unavailable' },
			{ kind: 'signedOut' },
			{ kind: 'unavailable' },
			undefined,
		]);
	});

	test('reads /v1/account and redeem replies, and words the plan', () => {
		const account = {
			email: 'a@b.c',
			displayName: null,
			plan: { id: 'arkai_pro', name: 'Arkai Pro', dailyTokens: 2_000_000, features: ['arkai', 'arkai.pro'] },
			entitlement: { id: 'ent_1', endsAt: '2026-12-31T00:00:00.000Z', source: 'code' },
		};
		const pro = readKinguAccountBody(account)!.plan;
		const free = readKinguAccountBody({ email: 'a@b.c', plan: { id: 'free', name: 'Free', dailyTokens: null, features: [] }, entitlement: null })!.plan;
		assert.deepStrictEqual([
			pro,
			free,
			readKinguAccountBody({ email: 'a@b.c' }),
			readKinguAccountReply({ kind: 'response', status: 200, body: account }).kind,
			readKinguAccountReply({ kind: 'response', status: 401, body: { code: 'invalid_access_token' } }),
			readKinguAccountReply({ kind: 'response', status: 404, body: { code: 'invalid_code', message: 'x' } }),
			readKinguAccountReply({ kind: 'response', status: 500, body: { message: 'Boom.' } }),
			readKinguAccountReply({ kind: 'signedOut' }),
			readKinguAccountReply({ kind: 'unavailable', reason: 'No cloud.' }),
			describeKinguPlan(pro),
			describeKinguPlan(free),
			kinguPlanSummary({ kind: 'signedIn', email: 'a@b.c', plan: free }),
			kinguPlanSummary({ kind: 'signedOut' }),
			arkaiPlanLine('Arkai Pro plan'),
			arkaiPlanLine(undefined),
		], [
			{ id: 'arkai_pro', name: 'Arkai Pro', dailyTokens: 2_000_000, endsAt: '2026-12-31T00:00:00.000Z' },
			{ id: 'free', name: 'Free', dailyTokens: null },
			undefined,
			'ok',
			{ kind: 'signIn' },
			{ kind: 'error', message: 'This code is not valid or has been used up.' },
			{ kind: 'error', message: 'Boom.' },
			{ kind: 'signIn' },
			{ kind: 'error', message: 'No cloud.' },
			'Arkai Pro, until 2026-12-31',
			'Free',
			'Free plan',
			undefined,
			'On this computer · Arkai Pro plan',
			'On this computer',
		]);
	});
});
