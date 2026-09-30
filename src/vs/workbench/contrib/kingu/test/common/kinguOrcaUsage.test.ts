/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { formatPlanLabel, formatResetCreditExpiry, formatUpdatedAgo, hostAccountTargets, IOrcaUsageProvider, sectionShortLabel, usagePanelRows, usageRowState, usageSections } from '../../common/kinguOrcaUsage.js';

const NOW = 1_000_000_000_000;
const HOUR = 3_600_000;

function provider(overrides: Partial<IOrcaUsageProvider>): IOrcaUsageProvider {
	return { provider: 'claude', session: null, weekly: null, status: 'ok', error: null, ...overrides };
}

suite('kinguOrcaUsage', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('lists every agent worst first, with the ADE\'s labels in each mode', () => {
		const claude = provider({
			session: { usedPercent: 20, windowMinutes: 300, resetsAt: NOW + 2 * HOUR },
			weekly: { usedPercent: 4, windowMinutes: 10_080, resetsAt: NOW + 50 * HOUR },
			fableWeekly: { usedPercent: 0, windowMinutes: 10_080, resetsAt: null },
		});
		const codex = provider({ provider: 'codex', session: { usedPercent: 85, windowMinutes: 300, resetsAt: null }, weekly: null });
		const rows = usagePanelRows({ claude, codex, gemini: null }, () => true);
		assert.deepStrictEqual(rows.map(row => [row.slot, row.worst, row.sections.map(section => [sectionShortLabel(section, 'verbose', NOW), sectionShortLabel(section, 'compact', NOW)])]), [
			['codex', 85, [['5h', '5h']]],
			['claude', 20, [['5h', '2h'], ['wk', '2d 2h'], ['Fable', 'Fable']]],
		]);
	});

	test('names a row with nothing to measure as the ADE does', () => {
		assert.deepStrictEqual([
			usageRowState(provider({ status: 'fetching' })),
			usageRowState(provider({ status: 'error', error: 'Not logged in' })),
			usageRowState(provider({ status: 'error', error: 'boom', usageMetadata: { failureKind: 'network' } })),
			usageRowState(provider({ status: 'unavailable' })),
			usageRowState(provider({ status: 'ok' })),
		], [
			{ kind: 'loading', label: 'Loading usage…' },
			{ kind: 'sign-in', label: 'not signed in' },
			{ kind: 'error', label: 'Network issue' },
			{ kind: 'unavailable', label: 'Usage unavailable' },
			{ kind: 'empty', label: 'No usage data' },
		]);
	});

	test('keeps Gemini\'s buckets by name, then the week', () => {
		const gemini = provider({ provider: 'gemini', weekly: { usedPercent: 3, windowMinutes: 10_080, resetsAt: null }, buckets: [{ name: 'Pro', usedPercent: 10, windowMinutes: 1_440, resetsAt: null }] });
		assert.deepStrictEqual(usageSections(gemini).map(section => section.label), ['Pro', 'Weekly']);
	});

	test('formats the panel\'s small print as the ADE does', () => {
		assert.deepStrictEqual([
			formatUpdatedAgo(undefined, NOW),
			formatUpdatedAgo(NOW - 30_000, NOW),
			formatUpdatedAgo(NOW - 5 * 60_000, NOW),
			formatUpdatedAgo(NOW - 3 * HOUR, NOW),
			formatPlanLabel('chatgpt_pro'),
			formatPlanLabel(''),
			formatResetCreditExpiry(NOW + 3 * HOUR, 2, NOW),
			formatResetCreditExpiry(NOW - 1, 1, NOW),
		], ['Not yet updated', 'Updated just now', 'Updated 5m ago', 'Updated 3h ago', 'ChatGPT Pro', undefined, 'Next expires in 3h', 'Expires now']);
	});

	test('offers the system default and the host\'s accounts, the active one marked', () => {
		assert.deepStrictEqual(hostAccountTargets({
			accounts: [{ id: 'a', email: 'a@example.com' }, { id: 'w', email: 'w@example.com', managedAuthRuntime: 'wsl' }],
			activeAccountId: null,
			activeAccountIdsByRuntime: { host: 'a' },
		}), [
			{ id: null, label: 'System default', active: false },
			{ id: 'a', label: 'a@example.com', active: true },
		]);
	});
});
