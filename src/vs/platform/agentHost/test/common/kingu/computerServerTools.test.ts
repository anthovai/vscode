/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	createKinguComputerServerToolGroup,
	IKinguComputerToolAccessor,
	KinguComputerToolName,
	toComputerRequest,
} from '../../../node/shared/kingu/computerServerTools.js';
import { KinguComputerResult } from '../../../../kinguComputer/common/kinguComputerProtocol.js';

function accessor(overrides: Partial<IKinguComputerToolAccessor> = {}): IKinguComputerToolAccessor {
	return {
		isSupported: () => true,
		allowsInput: () => true,
		request: async (): Promise<KinguComputerResult> => ({ ok: true, value: { ok: true } }),
		...overrides,
	};
}

const READ_TOOLS = [KinguComputerToolName.ListApps, KinguComputerToolName.ListWindows, KinguComputerToolName.ReadWindow];
const INPUT_TOOLS = [KinguComputerToolName.Type, KinguComputerToolName.PressKey, KinguComputerToolName.Click];

suite('Kingu desktop server tools', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('what an agent is offered', () => {

		test('reading is offered whenever there is a runtime', () => {
			const group = createKinguComputerServerToolGroup(accessor({ allowsInput: () => false }));
			for (const tool of READ_TOOLS) {
				assert.ok(group.isEnabled(tool), tool);
			}
		});

		test('acting is not offered at all until it is permitted', () => {
			// Not advertised, rather than advertised and refused: an agent cannot be
			// talked into using a tool it has never heard of.
			const group = createKinguComputerServerToolGroup(accessor({ allowsInput: () => false }));
			for (const tool of INPUT_TOOLS) {
				assert.ok(!group.isEnabled(tool), tool);
			}
		});

		test('nothing is offered where there is no runtime', () => {
			const group = createKinguComputerServerToolGroup(accessor({ isSupported: () => false }));
			for (const tool of [...READ_TOOLS, ...INPUT_TOOLS]) {
				assert.ok(!group.isEnabled(tool), tool);
			}
		});

		test('every acting tool declares that it asks', () => {
			// A provider that auto-approved one of these would be auto-approving
			// "use the user's keyboard".
			const group = createKinguComputerServerToolGroup(accessor());
			for (const tool of INPUT_TOOLS) {
				assert.ok(group.canRequireConfirmation?.(tool), tool);
			}
			for (const tool of READ_TOOLS) {
				assert.ok(!group.canRequireConfirmation?.(tool), tool);
			}
		});

		test('the definitions and the names agree', () => {
			const group = createKinguComputerServerToolGroup(accessor());
			const names = new Set(group.definitions.map(definition => definition.name));
			for (const tool of [...READ_TOOLS, ...INPUT_TOOLS]) {
				assert.ok(names.has(tool), tool);
			}
			assert.strictEqual(names.size, READ_TOOLS.length + INPUT_TOOLS.length);
		});
	});

	suite('turning a call into a request', () => {

		test('an acting call always takes focus, because keystrokes follow it', () => {
			const request = toComputerRequest(KinguComputerToolName.Type, { app: 'Notepad', text: 'hi' });
			assert.strictEqual(request?.restoreWindow, true);
			assert.strictEqual(request?.tool, 'type_text');
		});

		test('a call missing what it needs makes no request', () => {
			assert.strictEqual(toComputerRequest(KinguComputerToolName.Type, { app: 'Notepad' }), undefined);
			assert.strictEqual(toComputerRequest(KinguComputerToolName.Type, { text: 'hi' }), undefined);
			assert.strictEqual(toComputerRequest(KinguComputerToolName.ListWindows, {}), undefined);
			assert.strictEqual(toComputerRequest('kingu_desktop_nonsense', { app: 'x' }), undefined);
		});

		test('listing applications needs nothing', () => {
			assert.deepStrictEqual(toComputerRequest(KinguComputerToolName.ListApps, {}), { tool: 'list_apps' });
		});
	});

	suite('executing', () => {

		const nothing = undefined as never;

		test('a permitted action reaches the runtime', async () => {
			const asked: string[] = [];
			const group = createKinguComputerServerToolGroup(accessor({
				request: async request => { asked.push(request.tool); return { ok: true, value: { ok: true } }; },
			}));
			await group.execute(nothing, nothing, KinguComputerToolName.Type, { app: 'Notepad', text: 'hi' });
			assert.deepStrictEqual(asked, ['type_text']);
		});

		test('acting is refused again at the moment of use', async () => {
			// A session advertised these before the user withdrew the permission.
			let reached = false;
			const group = createKinguComputerServerToolGroup(accessor({
				allowsInput: () => false,
				request: async () => { reached = true; return { ok: true, value: {} }; },
			}));
			await assert.rejects(() => Promise.resolve(group.execute(nothing, nothing, KinguComputerToolName.Type, { app: 'Notepad', text: 'hi' })));
			assert.strictEqual(reached, false, 'the runtime must not have been asked');
		});

		test('a refusal from the runtime reaches the agent as a failure', async () => {
			const group = createKinguComputerServerToolGroup(accessor({
				request: async () => ({ ok: false, error: 'window_not_focused' }),
			}));
			await assert.rejects(
				() => Promise.resolve(group.execute(nothing, nothing, KinguComputerToolName.ReadWindow, { app: 'Notepad' })),
				/window_not_focused/);
		});
	});

	test('an acting tool displays the same sentence the user is asked to approve', () => {
		const group = createKinguComputerServerToolGroup(accessor());
		const display = group.getDisplay?.(KinguComputerToolName.Type, { app: 'Notepad', text: 'secret' });
		// The confirmation and the transcript must not describe the action
		// differently, so both come from `describeComputerAction`.
		const message = typeof display?.invocationMessage === 'string' ? display.invocationMessage : display?.invocationMessage?.markdown ?? '';
		assert.ok(message.includes('"secret"'), message);
		assert.ok(message.includes('Notepad'), message);
	});
});
