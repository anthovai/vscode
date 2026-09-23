/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { formatFooterWindow, formatOrcaMemory, formatOrcaWindowLabel, IOrcaProviderRateLimits, isProviderShown, normalizeOrcaAwakeMode, providerFooterWindows, tightestFooterWindow } from '../../common/kinguOrcaFooter.js';

const NOW = 1_000_000_000_000;
const HOUR = 3_600_000;

function provider(overrides: Partial<IOrcaProviderRateLimits>): IOrcaProviderRateLimits {
	return { provider: 'claude', session: null, weekly: null, status: 'ok', error: null, ...overrides };
}

suite('kinguOrcaFooter', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads Claude as the ADE does: session and week counted down, the Fable week by name', () => {
		const claude = provider({
			session: { usedPercent: 6, windowMinutes: 300, resetsAt: NOW + 4 * HOUR + 5 * 60_000 },
			weekly: { usedPercent: 90, windowMinutes: 10_080, resetsAt: NOW + 11 * HOUR + 25 * 60_000 },
			fableWeekly: { usedPercent: 16, windowMinutes: 10_080, resetsAt: NOW + 2 * HOUR },
		});
		assert.deepStrictEqual(
			providerFooterWindows(claude, NOW).map(window => formatFooterWindow(window, 'used')),
			['6% used 4h 5m', '90% used 11h 25m', '16% used Fable']);
	});

	test('fills the bar from the most consumed window, whichever way the label counts', () => {
		const windows = providerFooterWindows(provider({
			session: { usedPercent: 6, windowMinutes: 300, resetsAt: null },
			weekly: { usedPercent: 90, windowMinutes: 10_080, resetsAt: null },
		}), NOW);
		assert.deepStrictEqual([tightestFooterWindow(windows)?.key, formatFooterWindow(windows[1], 'remaining')], ['weekly', '10% left wk']);
	});

	test('shows Gemini by bucket name, and a monthly window only when there is nothing else', () => {
		const gemini = provider({
			provider: 'gemini',
			buckets: [
				{ name: 'Pro', usedPercent: 12, windowMinutes: 1_440, resetsAt: null },
				{ name: 'Embedding', usedPercent: 3, windowMinutes: 1_440, resetsAt: null },
			],
		});
		const monthlyOnly = provider({ provider: 'opencode-go', monthly: { usedPercent: 40, windowMinutes: 43_200, resetsAt: null } });
		const monthlyBeside = provider({ session: { usedPercent: 1, windowMinutes: 300, resetsAt: null }, monthly: { usedPercent: 40, windowMinutes: 43_200, resetsAt: null } });
		assert.deepStrictEqual(
			[providerFooterWindows(gemini, NOW), providerFooterWindows(monthlyOnly, NOW), providerFooterWindows(monthlyBeside, NOW)].map(windows => windows.map(window => formatFooterWindow(window, 'used'))),
			[['Pro 12% used'], ['40% used 30d'], ['1% used 5h']]);
	});

	test('earns a segment only with something real to show', () => {
		assert.deepStrictEqual(
			[
				isProviderShown(null),
				isProviderShown(false),
				isProviderShown(provider({ status: 'unavailable' })),
				isProviderShown(provider({ status: 'fetching' })),
				isProviderShown(provider({ status: 'fetching', session: { usedPercent: 1, windowMinutes: 300, resetsAt: null } })),
				isProviderShown(provider({ status: 'error' })),
			],
			[false, false, false, false, true, true]);
	});

	test('names windows and memory the way the ADE does', () => {
		assert.deepStrictEqual(
			[formatOrcaWindowLabel(300), formatOrcaWindowLabel(10_080), formatOrcaWindowLabel(20_160), formatOrcaWindowLabel(4_320), formatOrcaWindowLabel(90), formatOrcaMemory(2.61 * 1024 ** 3), formatOrcaMemory(840 * 1024 ** 2), formatOrcaMemory(900 * 1024)],
			['5h', 'wk', '2wk', '3d', '90m', '2.61 GB', '840.0 MB', '900 KB']);
	});

	test('reads the legacy keep-awake boolean as auto', () => {
		assert.deepStrictEqual(
			[normalizeOrcaAwakeMode(undefined, true), normalizeOrcaAwakeMode(undefined, false), normalizeOrcaAwakeMode('on', false)],
			['auto', 'off', 'on']);
	});
});
