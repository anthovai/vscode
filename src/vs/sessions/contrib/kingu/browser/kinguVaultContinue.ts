/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IAgentHostImportConversationStore } from '../../../../workbench/contrib/chat/browser/agentSessions/agentHost/agentHostImportConversationStore.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../common/agentHostSessionsProvider.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { IKinguVaultSession } from '../common/kinguVault.js';
import { transcriptToTurns } from '../common/kinguVaultTurns.js';

/** How much of a transcript is read to rebuild its turns. */
const MAX_IMPORT_BYTES = 4 * 1024 * 1024;

export interface IKinguVaultContinueDependencies {
	readonly fileService: IFileService;
	readonly quickInputService: IQuickInputService;
	readonly notificationService: INotificationService;
	readonly logService: ILogService;
	readonly sessionsService: ISessionsService;
	readonly sessionsManagementService: ISessionsManagementService;
	readonly importConversationStore: IAgentHostImportConversationStore;
}

/**
 * Opens a past session from another agent as a live session here.
 *
 * The agent host already knows how to take a conversation it did not run and
 * seed it as real, editable turns, which is what makes this more than pasting a
 * transcript: the continued session forks and truncates like any other. So the
 * vault's job is only to turn a file on disk into those turns.
 *
 * The user is asked what to continue with, rather than the session opening
 * silent: an imported history with no question is a session that has nothing to
 * do, and the prompt is also what tells the agent which part of the past matters.
 */
export async function continueVaultSession(
	session: IKinguVaultSession,
	deps: IKinguVaultContinueDependencies,
): Promise<void> {
	const folder = workspaceFolderFor(session, deps);
	if (!folder) {
		deps.notificationService.notify({
			severity: Severity.Warning,
			message: localize('kingu.vault.continue.noFolder', "This session records no working directory, so there is no folder to continue it in. Open a session in a folder first."),
		});
		return;
	}

	const turns = await readTurns(session, deps);
	if (turns.length === 0) {
		deps.notificationService.notify({
			severity: Severity.Warning,
			message: localize('kingu.vault.continue.noTurns', "This transcript holds no conversation to continue."),
		});
		return;
	}

	const prompt = await deps.quickInputService.input({
		title: localize('kingu.vault.continue.title', "Continue: {0}", session.title),
		// Two strings rather than one with a count: "The 1 turns" reads as a bug in
		// the very dialog that is asking the user to trust an import.
		prompt: turns.length === 1
			? localize('kingu.vault.continue.prompt.one', "What should the agent do next? The turn before it is imported as history.")
			: localize('kingu.vault.continue.prompt.many', "What should the agent do next? The {0} turns before it are imported as history.", turns.length),
		ignoreFocusLost: true,
	});
	if (!prompt?.trim()) {
		return;
	}

	try {
		const created = deps.sessionsManagementService.createNewSession(folder, {
			providerId: LOCAL_AGENT_HOST_PROVIDER_ID,
			sessionTypeId: session.source,
		});
		// Stashed before the request is sent: the turns are seeded when the session
		// materializes, which is what sending the first request causes.
		deps.importConversationStore.set(created.resource, { turns });
		const active = deps.sessionsService.activeSession.get();
		if (active) {
			deps.sessionsService.insertAt(created, active.sessionId, 'right', true);
		}
		await deps.sessionsManagementService.sendNewChatRequest(created, { query: prompt });
	} catch (error) {
		deps.logService.error('[Kingu] could not continue a vault session', error);
		deps.notificationService.notify({
			severity: Severity.Error,
			message: localize('kingu.vault.continue.failed', "Could not continue this session: {0}", error instanceof Error ? error.message : String(error)),
		});
	}
}

/**
 * The folder the continued session runs in.
 *
 * The recorded working directory, when the transcript kept one that still looks
 * like a path. A Claude project directory decodes only well enough to read, so
 * a session whose directory came from the directory name alone cannot be
 * continued there — `E:/Model/Business` is not `E:\Model Business`.
 */
function workspaceFolderFor(session: IKinguVaultSession, deps: IKinguVaultContinueDependencies): URI | undefined {
	const recorded = session.workingDirectory;
	if (recorded && /^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(recorded) && !recorded.includes('//')) {
		return URI.file(recorded);
	}
	// Otherwise continue where the user already is, which is at least a real folder.
	return deps.sessionsService.activeSession.get()?.workspace.get()?.folders.at(0)?.root;
}

async function readTurns(session: IKinguVaultSession, deps: IKinguVaultContinueDependencies) {
	// The turns live in the sibling for the agents that split a session in two.
	for (const resource of [session.contentResource, session.resource]) {
		if (!resource) {
			continue;
		}
		try {
			const content = await deps.fileService.readFile(resource, { position: 0, length: MAX_IMPORT_BYTES });
			const turns = transcriptToTurns(content.value.toString(), generateUuid);
			if (turns.length > 0) {
				return turns;
			}
		} catch {
			// Try the other half rather than failing on the one that was not there.
		}
	}
	return [];
}
