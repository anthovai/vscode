/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ACP_STALL_EVIDENCE_CHARS, ACP_STALL_QUESTIONS, acpOutputLines, acpRetryHint, AcpStallReason, acpStallReason, acpStallState } from '../../common/acpStall.js';

suite('acpStall', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads plain stderr and structured log lines, keeping only warnings and errors from the log', () => {
		const omp = [
			'{"timestamp":"2026-09-27T15:27:00.376+07:00","level":"debug","message":"agent.continue scheduled","source":"automatic-retry"}',
			'{"timestamp":"2026-09-27T15:27:00.376+07:00","level":"warn","message":"agent turn ended with provider error","errorMessage":"Google API error (429): You exceeded your current quota\\n* Quota exceeded for metric"}',
			'{"level":"info","message":"agent_end maintenance routing"}',
			'',
			'  Retrying in 60s  ',
			'{ not json',
		].join('\r\n');
		assert.deepStrictEqual(acpOutputLines(omp), [
			'Google API error (429): You exceeded your current quota * Quota exceeded for metric',
			'Retrying in 60s',
			'{ not json',
		]);
	});

	test('takes the last line that explains a wait', () => {
		assert.deepStrictEqual([
			acpRetryHint(['error: 429 Too Many Requests', 'connecting', 'quota exceeded for model']),
			acpRetryHint(['all good']),
			acpRetryHint([`rate limit ${'x'.repeat(400)}`])?.length,
		], ['quota exceeded for model', undefined, 303]);
	});

	test('tells Jev the agent, the silence and the latest output, cut from the start', () => {
		const long = acpStallState('OMP', 50, ['a'.repeat(ACP_STALL_EVIDENCE_CHARS), 'last']);
		assert.deepStrictEqual([
			JSON.parse(acpStallState('OMP', 45, ['one', 'two'])),
			(JSON.parse(long).latestOutput as string).endsWith('\nlast'),
			(JSON.parse(long).latestOutput as string).length,
		], [
			{ agent: 'OMP', secondsQuiet: 45, latestOutput: 'one\ntwo' },
			true,
			ACP_STALL_EVIDENCE_CHARS,
		]);
		assert.deepStrictEqual(Object.keys(ACP_STALL_QUESTIONS), ['reason']);
	});

	test('trusts only a confident answer naming a known reason', () => {
		const choice = (value: string, confidence: number) => ({ ok: true as const, model: 'jev-1.13.0', answers: { reason: { type: 'choice' as const, choice: value, confidence, probabilities: { [value]: confidence } } } });
		assert.deepStrictEqual([
			acpStallReason(choice(AcpStallReason.QuotaExhausted, 0.93)),
			acpStallReason(choice(AcpStallReason.RateLimited, 0.4)),
			acpStallReason(choice(AcpStallReason.Unknown, 0.99)),
			acpStallReason(choice('made_up', 0.99)),
			acpStallReason({ ok: false, problem: 'no-key' }),
			acpStallReason({ ok: true, model: '', answers: { reason: { type: 'noul', probability: 0.9, confidence: 0.9 } } }),
		], [AcpStallReason.QuotaExhausted, undefined, undefined, undefined, undefined, undefined]);
	});
});
