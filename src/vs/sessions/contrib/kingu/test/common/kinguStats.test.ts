/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	emptyStats,
	formatDuration,
	KinguRunState,
	KinguRunTracker,
	readStats,
	recordRun,
} from '../../common/kinguStats.js';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

suite('Kingu agent statistics', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('turning session states into runs', () => {

		test('working then not working is one run, timed', () => {
			const tracker = new KinguRunTracker();
			assert.deepStrictEqual(tracker.observe('s', 'local', KinguRunState.Working, NOW), { kind: 'started' });
			assert.deepStrictEqual(
				tracker.observe('s', 'local', KinguRunState.Idle, NOW + 90_000),
				{ kind: 'stopped', startedAt: NOW, durationMs: 90_000 });
		});

		test('being told the same state twice is not a transition', () => {
			// A status observable re-fires for a re-render, a reconnect replaying the
			// last state, a title change. Counting those inflates every number.
			const tracker = new KinguRunTracker();
			tracker.observe('s', 'local', KinguRunState.Working, NOW);
			assert.deepStrictEqual(tracker.observe('s', 'local', KinguRunState.Working, NOW + 1000), { kind: 'none' });
			assert.strictEqual(tracker.openCount, 1);
		});

		test('a session first seen already finished is not a run that happened here', () => {
			const tracker = new KinguRunTracker();
			assert.deepStrictEqual(tracker.observe('s', 'local', KinguRunState.Idle, NOW), { kind: 'none' });
		});

		test('two sessions are timed independently', () => {
			const tracker = new KinguRunTracker();
			tracker.observe('a', 'local', KinguRunState.Working, NOW);
			tracker.observe('b', 'remote', KinguRunState.Working, NOW + 1000);
			assert.strictEqual(tracker.openCount, 2);
			const stopped = tracker.observe('a', 'local', KinguRunState.Idle, NOW + 5000);
			assert.deepStrictEqual(stopped, { kind: 'stopped', startedAt: NOW, durationMs: 5000 });
			assert.strictEqual(tracker.openCount, 1);
		});

		test('a run that starts again after stopping is a second run', () => {
			const tracker = new KinguRunTracker();
			tracker.observe('s', 'local', KinguRunState.Working, NOW);
			tracker.observe('s', 'local', KinguRunState.Idle, NOW + 1000);
			assert.deepStrictEqual(tracker.observe('s', 'local', KinguRunState.Working, NOW + 2000), { kind: 'started' });
		});

		test('a session that goes away closes its run rather than losing it', () => {
			const tracker = new KinguRunTracker();
			tracker.observe('s', 'local', KinguRunState.Working, NOW);
			assert.deepStrictEqual(
				tracker.forget('s', NOW + 3000),
				{ kind: 'stopped', startedAt: NOW, durationMs: 3000 });
		});

		test('forgetting a session that was not running counts nothing', () => {
			assert.deepStrictEqual(new KinguRunTracker().forget('s', NOW), { kind: 'none' });
		});

		test('a closing window counts what is still open at its length so far', () => {
			const tracker = new KinguRunTracker();
			tracker.observe('a', 'local', KinguRunState.Working, NOW);
			tracker.observe('b', 'remote', KinguRunState.Working, NOW + 1000);
			const closed = tracker.closeAll(NOW + 10_000);
			assert.deepStrictEqual(closed.map(run => run.durationMs).sort((x, y) => x - y), [9000, 10_000]);
			assert.strictEqual(tracker.openCount, 0);
		});

		test('a clock that went backwards cannot produce a negative run', () => {
			const tracker = new KinguRunTracker();
			tracker.observe('s', 'local', KinguRunState.Working, NOW);
			const stopped = tracker.observe('s', 'local', KinguRunState.Idle, NOW - 5000);
			assert.deepStrictEqual(stopped, { kind: 'stopped', startedAt: NOW, durationMs: 0 });
		});

		test('tracking is bounded, so a long-lived window cannot grow without limit', () => {
			const tracker = new KinguRunTracker(2);
			for (const id of ['a', 'b', 'c']) {
				tracker.observe(id, 'local', KinguRunState.Working, NOW);
			}
			// The coldest was evicted, costing at most its unfinished run.
			assert.strictEqual(tracker.openCount, 2);
			assert.deepStrictEqual(tracker.observe('a', 'local', KinguRunState.Idle, NOW + 1000), { kind: 'none' });
		});
	});

	suite('the counters', () => {

		test('a run is counted in the total and against its type', () => {
			const state = emptyStats();
			recordRun(state, 'local', NOW, 5 * MINUTE);
			recordRun(state, 'local', NOW, 5 * MINUTE);
			recordRun(state, 'remote', NOW, MINUTE);
			assert.deepStrictEqual(state.totals, { runs: 3, workingMs: 11 * MINUTE });
			assert.deepStrictEqual(state.byType.local, { runs: 2, workingMs: 10 * MINUTE });
			assert.deepStrictEqual(state.byType.remote, { runs: 1, workingMs: MINUTE });
		});

		test('the start of counting is written once and never moved', () => {
			// "3 hours of agent time" means nothing without it, and a value that
			// crept forward would quietly make every rate look higher.
			const state = emptyStats();
			recordRun(state, 'local', NOW, MINUTE);
			recordRun(state, 'local', NOW + 10 * MINUTE, MINUTE);
			assert.strictEqual(state.firstRunAt, NOW);
		});
	});

	suite('what survives a restart', () => {

		test('a round trip keeps every counter', () => {
			const state = emptyStats();
			recordRun(state, 'local', NOW, 90_000);
			assert.deepStrictEqual(readStats(JSON.stringify(state)), state);
		});

		test('nothing stored yet is not an error', () => {
			assert.deepStrictEqual(readStats(undefined), emptyStats());
			assert.deepStrictEqual(readStats(''), emptyStats());
		});

		test('a shape that does not parse starts again rather than half-restoring', () => {
			// Half-restored counters are a number that is wrong without saying so.
			assert.deepStrictEqual(readStats('not json'), emptyStats());
			assert.deepStrictEqual(readStats('{"version":99}'), emptyStats());
		});

		test('a negative or nonsensical counter reads as nothing, not as itself', () => {
			const restored = readStats('{"version":1,"totals":{"runs":-5,"workingMs":null},"byType":{}}');
			assert.deepStrictEqual(restored.totals, { runs: 0, workingMs: 0 });
		});
	});

	suite('how a duration reads', () => {

		test('the unit a person would say', () => {
			assert.strictEqual(formatDuration(12_000), '12s');
			assert.strictEqual(formatDuration(45 * MINUTE), '45m');
			assert.strictEqual(formatDuration(3 * 60 * MINUTE), '3h');
			assert.strictEqual(formatDuration(200 * MINUTE), '3h 20m');
		});

		test('nothing is nothing, not blank', () => {
			assert.strictEqual(formatDuration(0), '0s');
		});
	});
});
