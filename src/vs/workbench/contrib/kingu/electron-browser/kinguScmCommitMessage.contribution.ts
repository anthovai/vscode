/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { KINGU_AI_CHANNEL_NAME } from '../../../../platform/kinguAi/common/kinguAi.js';
import { IKinguCommitMessageRequest, IKinguCommitMessageResult } from '../../../../platform/kinguAi/common/kinguCommitMessage.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { ISCMService } from '../../scm/common/scm.js';
import { KINGU_AI_SIGN_IN_COMMAND_ID } from '../common/kinguAiAccounts.js';

/** Also `defaultChatAgent.generateCommitMessageCommand` in product.json, so the commit box remembers it as the last action. */
export const KINGU_GENERATE_COMMIT_MESSAGE_COMMAND_ID = 'kingu.scm.generateCommitMessage';

/**
 * The sparkle in the Source Control commit box. Upstream it signs into
 * Copilot and runs Copilot's command, which Kingu does not ship, so the button
 * did nothing; here the agent the user is signed into (Claude, else Codex)
 * writes the message from the repository's diff, in the main process, and
 * Chyle on a running Ollama when neither can.
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: KINGU_GENERATE_COMMIT_MESSAGE_COMMAND_ID,
			title: localize2('kingu.scm.generateCommitMessage', "Generate Commit Message"),
			icon: Codicon.sparkle,
			f1: false,
			menu: {
				id: MenuId.SCMInputBox,
				when: ContextKeyExpr.and(ContextKeyExpr.equals('scmProvider', 'git'), ContextKeyExpr.has('scmProviderHasRootUri')),
			},
		});
	}

	override async run(accessor: ServicesAccessor, rootUri?: unknown, _context?: unknown, token?: CancellationToken): Promise<void> {
		const scmService = accessor.get(ISCMService);
		const mainProcessService = accessor.get(IMainProcessService);
		const progressService = accessor.get(IProgressService);
		const notificationService = accessor.get(INotificationService);
		const commandService = accessor.get(ICommandService);
		const logService = accessor.get(ILogService);

		const root = URI.isUri(rootUri) ? rootUri : undefined;
		const repository = root && [...scmService.repositories].find(candidate => candidate.provider.rootUri?.toString() === root.toString());
		if (!root || !repository || root.scheme !== 'file') {
			return;
		}

		const request: IKinguCommitMessageRequest = { cwd: root.fsPath };
		let result: IKinguCommitMessageResult;
		try {
			result = await progressService.withProgress(
				{ location: ProgressLocation.Scm },
				() => mainProcessService.getChannel(KINGU_AI_CHANNEL_NAME).call<IKinguCommitMessageResult>('generateCommitMessage', request),
			);
		} catch (error) {
			if (token?.isCancellationRequested) {
				return;
			}
			const reason = error instanceof Error ? error.message : String(error);
			logService.warn('[Kingu] could not generate a commit message', reason);
			notificationService.prompt(
				Severity.Warning,
				localize('kingu.scm.generateCommitMessage.failed', "Could not generate a commit message. {0}", reason),
				[{ label: localize('kingu.scm.generateCommitMessage.signIn', "Sign in to an AI account"), run: () => commandService.executeCommand(KINGU_AI_SIGN_IN_COMMAND_ID) }],
			);
			return;
		}
		// Stopped from the commit box while the agent was writing: leave what the user has.
		if (token?.isCancellationRequested) {
			return;
		}
		repository.input.setValue(result.message, false);
	}
});
