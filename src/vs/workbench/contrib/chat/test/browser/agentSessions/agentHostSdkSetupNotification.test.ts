/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { mock } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IAgentHostService } from '../../../../../../platform/agentHost/common/agentService.js';
import type { IAgentSdkSetupInfo } from '../../../../../../platform/agentHost/common/agentSdkSetup.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IDefaultAccountService } from '../../../../../../platform/defaultAccount/common/defaultAccount.js';
import { TestInstantiationService } from '../../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { AGENT_SDK_SETUP_DOWNLOAD_COMMAND_ID, AGENT_SDK_SETUP_OPEN_DOCS_COMMAND_ID, AGENT_SDK_SETUP_RELOAD_COMMAND_ID, AGENT_SDK_SETUP_SIGN_IN_COMMAND_ID, AgentHostSdkSetupNotificationContribution, agentSdkSetupNotificationId, createAgentSdkSetupNotification, getAgentDisplayNames, getAgentSdkSetupState, getAgentSdkSetupStateToReport, hasAgentSdkSetupForSessionType, type IAgentSdkSetupStateInputs } from '../../../browser/agentSessions/agentHost/agentHostSdkSetupNotification.js';
import { KINGU_AI_SIGN_IN_COMMAND_ID } from '../../../../kingu/common/kinguAiAccounts.js';
import { IAgentSdkSetupService, type AgentSdkSetupState } from '../../../../../services/agentHost/browser/agentSdkSetupService.js';
import { ChatEntitlement, IChatEntitlementService } from '../../../../../services/chat/common/chatEntitlementService.js';
import { ChatInputNotificationActionKind, IChatInputNotificationService, type IChatInputNotification, type IChatInputNotificationAction } from '../../../browser/widget/input/chatInputNotificationService.js';
import { SessionType } from '../../../common/chatSessionsService.js';
import { ILanguageModelsService, type ILanguageModelChatMetadata } from '../../../common/languageModels.js';

/** Signed out, flag on, entitlement settled, SDK missing — the case this feature exists for. */
const BLOCKED_USER: IAgentSdkSetupStateInputs = {
	allowSignedOutWhenUsable: true,
	signedIn: false,
	entitlementResolved: true,
	download: 'notDownloaded',
	downloadRequested: false,
	hasModels: false,
};

function commandIds(actions: readonly IChatInputNotificationAction[]): string[] {
	return actions.map(action => action.kind === ChatInputNotificationActionKind.Command ? action.commandId : action.kind);
}

suite('Agent SDK setup banner', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	suite('state', () => {
		const cases: readonly { readonly name: string; readonly inputs: IAgentSdkSetupStateInputs; readonly expected: AgentSdkSetupState | undefined }[] = [
			{ name: 'signed-out user with no SDK is offered the download', inputs: BLOCKED_USER, expected: 'downloadOffered' },
			{ name: 'standing consent waits quietly for the SDK to be used', inputs: { ...BLOCKED_USER, download: 'downloadOnUse' }, expected: undefined },
			{ name: 'a fetch in flight has nothing to ask for, since the host shows its own progress', inputs: { ...BLOCKED_USER, download: 'downloading' }, expected: undefined },
			// The host answers a download request over IPC, so it keeps saying
			// `notDownloaded` for a moment after we ask. Offering the button again in
			// that gap would re-ask a user who has already consented.
			{ name: 'a request the host has not answered yet is not a fresh offer', inputs: { ...BLOCKED_USER, downloadRequested: true }, expected: undefined },
			{ name: 'SDK on disk reporting no models means no account', inputs: { ...BLOCKED_USER, download: 'ready' }, expected: 'noAccount' },
			{ name: 'models are the honest end state, whatever the status says', inputs: { ...BLOCKED_USER, download: 'ready', hasModels: true }, expected: 'resolved' },
			{ name: 'nothing shows until entitlement settles, since "signed out" is not yet a fact', inputs: { ...BLOCKED_USER, download: 'ready', entitlementResolved: false }, expected: undefined },
			{ name: 'the missing-account explanation stays behind its flag', inputs: { ...BLOCKED_USER, download: 'ready', allowSignedOutWhenUsable: false }, expected: undefined },
			{ name: 'a signed-in user is never told they have no account', inputs: { ...BLOCKED_USER, download: 'ready', signedIn: true }, expected: undefined },
			{ name: 'a signed-in user mid-download is still shown nothing', inputs: { ...BLOCKED_USER, signedIn: true, download: 'downloading' }, expected: undefined },

			// The download is offered to everyone: each of these users can work
			// today, and still has an SDK we are about to fetch onto their machine.
			{ name: 'a signed-in user is offered the download too', inputs: { ...BLOCKED_USER, signedIn: true }, expected: 'downloadOffered' },
			{ name: 'having models does not hide the download', inputs: { ...BLOCKED_USER, signedIn: true, hasModels: true }, expected: 'downloadOffered' },
			{ name: 'the download offer does not wait for entitlement', inputs: { ...BLOCKED_USER, entitlementResolved: false }, expected: 'downloadOffered' },
			{ name: 'the download offer is not behind the signed-out flag', inputs: { ...BLOCKED_USER, allowSignedOutWhenUsable: false }, expected: 'downloadOffered' },
		];

		for (const { name, inputs, expected } of cases) {
			test(name, () => {
				assert.strictEqual(getAgentSdkSetupState(inputs), expected);
			});
		}
	});

	suite('presentation', () => {
		const claude: IAgentSdkSetupInfo = { agent: 'claude', download: 'notDownloaded', setupDocsUrl: 'https://example.test/claude' };

		test('the download offer names the SDK, explains it, and carries a single Download button', () => {
			const notification = createAgentSdkSetupNotification(claude, 'Claude', 'downloadOffered');

			assert.ok(notification);
			assert.strictEqual(notification.id, agentSdkSetupNotificationId('claude'));
			assert.deepStrictEqual(notification.sessionTypes, [SessionType.AgentHostClaude]);
			assert.strictEqual(notification.message, 'Download the Claude Agent');
			// An ask that expects a decision explains itself, and does so without
			// tying the SDK to an account: the same download serves the Copilot
			// proxy, a Claude subscription and a BYO key alike.
			assert.strictEqual(notification.description, 'To use the Claude Agent, we need to download the Claude Agent SDK.');
			assert.deepStrictEqual(commandIds(notification.actions), [AGENT_SDK_SETUP_DOWNLOAD_COMMAND_ID]);
			assert.deepStrictEqual(notification.actions[0].kind === ChatInputNotificationActionKind.Command ? notification.actions[0].commandArgs : undefined, ['claude']);
		});

		test('models add the send-a-message option without changing the Download action', () => {
			assert.deepStrictEqual(createAgentSdkSetupNotification(claude, 'Claude', 'downloadOffered', true), {
				...createAgentSdkSetupNotification(claude, 'Claude', 'downloadOffered'),
				description: 'Click Download or send a message to download the Claude Agent SDK.',
			});
		});

		test('every noun comes from the agent, so a second agent needs no entry here', () => {
			const codex: IAgentSdkSetupInfo = { agent: 'codex', download: 'notDownloaded', signInProviderName: 'ChatGPT' };

			assert.deepStrictEqual({
				sessionTypes: createAgentSdkSetupNotification(codex, 'Codex', 'downloadOffered')?.sessionTypes,
				download: createAgentSdkSetupNotification(codex, 'Codex', 'downloadOffered')?.message,
				noAccount: createAgentSdkSetupNotification(codex, 'Codex', 'noAccount')?.message,
			}, {
				sessionTypes: [SessionType.AgentHostCodex],
				download: 'Download the Codex Agent',
				noAccount: 'Choose how you want to use Codex.',
			});
		});

		test('a missing account offers the user own AI account, never GitHub', () => {
			// Kingu: Claude and Codex sign in through the ADE's accounts; another
			// agent offers only the sign-in it declares, and none offers GitHub.
			const codex: IAgentSdkSetupInfo = { agent: 'codex', download: 'ready', setupDocsUrl: 'https://example.test/codex', signInProviderName: 'ChatGPT' };
			const buttons = (setup: IAgentSdkSetupInfo, displayName: string) =>
				commandIds(createAgentSdkSetupNotification(setup, displayName, 'noAccount')?.actions ?? []);

			assert.deepStrictEqual({
				claude: buttons({ ...claude, download: 'ready' }, 'Claude'),
				codex: buttons(codex, 'Codex'),
				declared: buttons({ agent: 'some-future-agent', download: 'ready', signInProviderName: 'Acme' }, 'Future'),
				neither: buttons({ agent: 'some-future-agent', download: 'ready' }, 'Future'),
			}, {
				claude: [KINGU_AI_SIGN_IN_COMMAND_ID],
				codex: [KINGU_AI_SIGN_IN_COMMAND_ID],
				declared: [AGENT_SDK_SETUP_SIGN_IN_COMMAND_ID],
				neither: [],
			});
		});

		test('every button is addressed to the agent, and labelled by the account', () => {
			const notification = createAgentSdkSetupNotification({ agent: 'codex', download: 'ready', signInProviderName: 'ChatGPT' }, 'Codex', 'noAccount');

			assert.ok(notification);
			assert.deepStrictEqual({
				args: notification.actions.map(action => action.kind === ChatInputNotificationActionKind.Command ? action.commandArgs : undefined),
				labels: notification.actions.map(action => action.label),
			}, {
				args: [['codex']],
				labels: ['Sign in to ChatGPT'],
			});
		});

		test('the routes named in the copy are the account and the reload, never GitHub', () => {
			const noAccount = (agent: string, setup: Omit<IAgentSdkSetupInfo, 'agent' | 'download'>) => {
				const description = createAgentSdkSetupNotification({ agent, download: 'ready', ...setup }, 'Claude', 'noAccount')?.description;
				return typeof description === 'string' ? description : description?.value;
			};
			const reload = (agent: string) => `[reload the configuration](command:${AGENT_SDK_SETUP_RELOAD_COMMAND_ID}?%255B%2522${agent}%2522%255D) if you have set up Claude elsewhere.`;
			const docs = `For other ways to set up Claude, [learn more](command:${AGENT_SDK_SETUP_OPEN_DOCS_COMMAND_ID}?%255B%2522claude%2522%255D) on their docs.`;

			assert.deepStrictEqual({
				claude: noAccount('claude', {}),
				claudeWithDocs: noAccount('claude', { setupDocsUrl: 'https://example.test/claude' }),
				other: noAccount('other', {}),
			}, {
				claude: `Sign in to Claude to use your Claude account, or ${reload('claude')}`,
				claudeWithDocs: `Sign in to Claude to use your Claude account, or ${reload('claude')} ${docs}`,
				other: `[Reload the configuration](command:${AGENT_SDK_SETUP_RELOAD_COMMAND_ID}?%255B%2522other%2522%255D) if you have set up Claude elsewhere.`,
			});
		});

		test('a name carrying markdown is escaped, so the host cannot forge a third link', () => {
			const description = createAgentSdkSetupNotification(
				{ agent: 'other', download: 'ready', setupDocsUrl: 'https://example.test/claude', signInProviderName: 'Chat[G]PT' },
				'Claude [x](command:evil)',
				'noAccount',
			)?.description;
			const name = 'Claude \\[x\\]\\(command:evil\\)';

			assert.strictEqual(typeof description === 'string' ? description : description?.value,
				`Sign in to Chat\\[G\\]PT to use your Chat\\[G\\]PT account, or [reload the configuration](command:${AGENT_SDK_SETUP_RELOAD_COMMAND_ID}?%255B%2522other%2522%255D) if you have set up ${name} elsewhere. For other ways to set up ${name}, [learn more](command:${AGENT_SDK_SETUP_OPEN_DOCS_COMMAND_ID}?%255B%2522other%2522%255D) on their docs.`);
		});

		test('the copy is trusted for its own two commands alone, so its links render and reach nothing else', () => {
			// Untrusted markdown renders a `command:` link as inert text, which would
			// leave both routes with no affordance at all now that neither has a button.
			const description = createAgentSdkSetupNotification({ agent: 'claude', download: 'ready', setupDocsUrl: 'https://example.test/claude' }, 'Claude', 'noAccount')?.description;

			assert.ok(description !== undefined && typeof description !== 'string');
			assert.deepStrictEqual(description.isTrusted, { enabledCommands: [AGENT_SDK_SETUP_OPEN_DOCS_COMMAND_ID, AGENT_SDK_SETUP_RELOAD_COMMAND_ID] });
		});

		test('the banner cannot be dismissed, since it is the only route to a working agent', () => {
			const notification = createAgentSdkSetupNotification(claude, 'Claude', 'downloadOffered');

			assert.ok(notification);
			assert.strictEqual(notification.dismissible, false);
			assert.strictEqual(notification.autoDismissOnMessage, false);
		});

		test('nothing is rendered once the user is set up, or for an agent the host has not named yet', () => {
			assert.strictEqual(createAgentSdkSetupNotification(claude, 'Claude', undefined), undefined);
			assert.strictEqual(createAgentSdkSetupNotification({ ...claude, download: 'ready' }, 'Claude', 'resolved'), undefined);
			// "Download the  Agent" is worse than no banner; the next root-state
			// change carries the name.
			assert.strictEqual(createAgentSdkSetupNotification({ agent: 'some-future-agent', download: 'notDownloaded' }, '', 'downloadOffered'), undefined);
		});
	});

	suite('model availability', () => {
		function createFixture(initialSessionTypes: readonly (string | undefined)[] = []) {
			const instantiationService = store.add(new TestInstantiationService());
			const onDidChangeLanguageModels = store.add(new Emitter<string>());
			const models = new Map<string, ILanguageModelChatMetadata>();
			const notifications: IChatInputNotification[] = [];
			const deletedNotifications: string[] = [];
			const reportedStates: AgentSdkSetupState[] = [];
			const setModels = (sessionTypes: readonly (string | undefined)[]) => {
				models.clear();
				for (const [index, targetChatSessionType] of sessionTypes.entries()) {
					models.set(`model-${index}`, new class extends mock<ILanguageModelChatMetadata>() {
						override readonly targetChatSessionType = targetChatSessionType;
					}());
				}
				onDidChangeLanguageModels.fire('test');
			};

			instantiationService.stub(IChatInputNotificationService, {
				setNotification: notification => notifications.push(notification),
				deleteNotification: id => deletedNotifications.push(id),
			});
			instantiationService.stub(IAgentSdkSetupService, {
				setups: [{ agent: 'claude', download: 'notDownloaded' }],
				onDidChangeSetups: Event.None,
				isDownloadPending: () => false,
				reportSetupState: (_agent, state) => reportedStates.push(state),
			});
			instantiationService.stub(IDefaultAccountService, {
				currentDefaultAccount: null,
				onDidChangeDefaultAccount: Event.None,
			});
			instantiationService.stub(ILanguageModelsService, {
				onDidChangeLanguageModels: onDidChangeLanguageModels.event,
				getLanguageModelIds: () => [...models.keys()],
				lookupLanguageModel: id => models.get(id),
			});
			instantiationService.stub(IConfigurationService, new TestConfigurationService());
			instantiationService.stub(IChatEntitlementService, {
				entitlement: ChatEntitlement.Pro,
				onDidChangeEntitlement: Event.None,
			});
			instantiationService.stub(IAgentHostService, {
				onAgentHostStart: Event.None,
				rootState: new class extends mock<IAgentHostService['rootState']>() {
					override readonly value = { agents: [{ provider: 'claude', displayName: 'Claude', description: '', models: [] }] };
					override readonly onDidChange = Event.None;
				}(),
			});

			setModels(initialSessionTypes);
			store.add(instantiationService.createInstance(AgentHostSdkSetupNotificationContribution));

			return { notifications, deletedNotifications, reportedStates, setModels };
		}

		test('explains download-on-use when models are already available', () => {
			const fixture = createFixture([SessionType.AgentHostClaude]);

			assert.deepStrictEqual(fixture.notifications.map(notification => notification.description), [
				'Click Download or send a message to download the Claude Agent SDK.',
			]);
		});

		test('updates the visible offer when models for its agent appear and disappear', () => {
			const fixture = createFixture();
			fixture.setModels([SessionType.AgentHostCodex, undefined]);
			fixture.setModels([SessionType.AgentHostCodex, undefined, SessionType.AgentHostClaude]);
			fixture.setModels([SessionType.AgentHostClaude]);
			fixture.setModels([]);

			assert.deepStrictEqual({
				descriptions: fixture.notifications.map(notification => notification.description),
				actions: fixture.notifications.map(notification => commandIds(notification.actions)),
				deletedNotifications: fixture.deletedNotifications,
				reportedStates: fixture.reportedStates,
			}, {
				descriptions: [
					'To use the Claude Agent, we need to download the Claude Agent SDK.',
					'Click Download or send a message to download the Claude Agent SDK.',
					'To use the Claude Agent, we need to download the Claude Agent SDK.',
				],
				actions: [
					[AGENT_SDK_SETUP_DOWNLOAD_COMMAND_ID],
					[AGENT_SDK_SETUP_DOWNLOAD_COMMAND_ID],
					[AGENT_SDK_SETUP_DOWNLOAD_COMMAND_ID],
				],
				deletedNotifications: [],
				reportedStates: ['downloadOffered'],
			});
		});
	});

	suite('display names', () => {
		test('reads each agent name the host published, and skips what it did not', () => {
			assert.deepStrictEqual([...getAgentDisplayNames({
				agents: [
					{ provider: 'claude', displayName: 'Claude', description: '', models: [] },
					{ provider: 'nameless', displayName: '', description: '', models: [] },
				],
			})], [['claude', 'Claude']]);
		});

		test('a host that has not reported, or failed, names nobody', () => {
			assert.deepStrictEqual([...getAgentDisplayNames(undefined)], []);
			assert.deepStrictEqual([...getAgentDisplayNames(new Error('host is down'))], []);
		});
	});

	suite('activation reachability', () => {
		test('an advertised setup is found for its session type and only that one', () => {
			const setups: readonly IAgentSdkSetupInfo[] = [{ agent: 'claude', download: 'ready' }];
			assert.deepStrictEqual({
				claude: hasAgentSdkSetupForSessionType(setups, SessionType.AgentHostClaude),
				codex: hasAgentSdkSetupForSessionType(setups, SessionType.AgentHostCodex),
				copilot: hasAgentSdkSetupForSessionType(setups, SessionType.AgentHostCopilot),
			}, { claude: true, codex: false, copilot: false });
		});

		test('no advertised setup leaves the harness gated', () => {
			assert.strictEqual(hasAgentSdkSetupForSessionType([], SessionType.AgentHostClaude), false);
		});
	});

	suite('funnel', () => {
		const cases: readonly {
			readonly name: string;
			/** The last state *reported* for this agent, not the last one computed. */
			readonly previous: AgentSdkSetupState | undefined;
			readonly state: AgentSdkSetupState | undefined;
			readonly expected: AgentSdkSetupState | undefined;
		}[] = [
				{ name: 'first sight of the offer counts', previous: undefined, state: 'downloadOffered', expected: 'downloadOffered' },
				{ name: 'an SDK that found no account is where users get stuck', previous: 'downloadOffered', state: 'noAccount', expected: 'noAccount' },
				{ name: 'a stuck user who then has models is the conversion', previous: 'noAccount', state: 'resolved', expected: 'resolved' },
				// Counted once per user: re-renders are constant, and a download that
				// failed back to the offer is the same person still being asked.
				{ name: 'a re-render, or a failed download returning to the offer, is not a second offer', previous: 'downloadOffered', state: 'downloadOffered', expected: undefined },
				{ name: 'a conversion is not re-counted on every later render', previous: 'resolved', state: 'resolved', expected: undefined },
				{ name: 'a fetch in flight, or giving up, moves the user nowhere', previous: 'downloadOffered', state: undefined, expected: undefined },
				{ name: 'a user this feature was never for is not a convert', previous: undefined, state: 'resolved', expected: undefined },
			];

		for (const { name, previous, state, expected } of cases) {
			test(name, () => {
				assert.strictEqual(getAgentSdkSetupStateToReport(previous, state), expected);
			});
		}
	});
});
