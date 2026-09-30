/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { Range } from '../../../../editor/common/core/range.js';
import { Selection } from '../../../../editor/common/core/selection.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IChatEditorLocationData, IChatProgress } from '../../chat/common/chatService/chatService.js';
import { ChatAgentLocation, ChatModeKind } from '../../chat/common/constants.js';
import { ChatMessageRole, IChatMessage, ILanguageModelsService } from '../../chat/common/languageModels.js';
import { IChatAgentData, IChatAgentHistoryEntry, IChatAgentRequest, IChatAgentResult, IChatAgentService } from '../../chat/common/participants/chatAgents.js';
import { kinguInlineEditCode, kinguInlineEditPrompt } from '../common/kinguInlineEdit.js';

/** Arkai's default chat participant, in the place GitHub Copilot's held. */
export const ARKAI_DEFAULT_AGENT_ID = 'kingu.arkai';

const ARKAI_EXTENSION_ID = new ExtensionIdentifier('kingu.arkai');

/** The text of a past answer, for the next request's history. */
function responseText(entry: IChatAgentHistoryEntry): string {
	return entry.response.map(part => part.kind === 'markdownContent' ? part.content.value : '').join('');
}

/** A request and its history as model messages, oldest first. */
export function arkaiChatMessages(request: Pick<IChatAgentRequest, 'message'>, history: readonly IChatAgentHistoryEntry[]): IChatMessage[] {
	const messages: IChatMessage[] = [{ role: ChatMessageRole.System, content: [{ type: 'text', value: 'You are Arkai, the coding agent of Kingu.' }] }];
	for (const entry of history) {
		messages.push({ role: ChatMessageRole.User, content: [{ type: 'text', value: entry.request.message }] });
		const answer = responseText(entry);
		if (answer) {
			messages.push({ role: ChatMessageRole.Assistant, content: [{ type: 'text', value: answer }] });
		}
	}
	messages.push({ role: ChatMessageRole.User, content: [{ type: 'text', value: request.message }] });
	return messages;
}

/**
 * Kingu: Arkai as the default chat participant, where GitHub Copilot's was.
 *
 * With Copilot left out of the product (`kinguDisableCopilot`) no extension
 * contributes a default participant, and chat refuses every request that is not
 * addressed to a participant by name. This one answers them: it sends the
 * conversation to the chat's selected model (Chyle 1, or another model the user
 * set up) and streams the reply. Agent sessions (the Agents Window, agent-host
 * sessions in the IDE) still run on their own agent; this is the plain chat.
 */
export class KinguArkaiAgentContribution extends Disposable {

	static readonly ID = 'workbench.contrib.kingu.arkaiAgent';

	constructor(
		@IProductService productService: IProductService,
		@IChatAgentService chatAgentService: IChatAgentService,
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
		@IModelService private readonly _modelService: IModelService,
	) {
		super();
		if (!productService.kinguDisableCopilot) {
			return;
		}
		const data: IChatAgentData = {
			id: ARKAI_DEFAULT_AGENT_ID,
			name: 'arkai',
			fullName: localize('kingu.arkai.fullName', "Arkai"),
			description: localize('kingu.arkai.description', "Kingu's own agent, on Chyle 1 or the models you set up"),
			extensionId: ARKAI_EXTENSION_ID,
			extensionVersion: undefined,
			extensionPublisherId: 'kingu',
			extensionDisplayName: 'Arkai',
			isDefault: true,
			isDynamic: true,
			isCore: true,
			// The Copilot codicon draws Arkai's mark.
			metadata: { themeIcon: Codicon.copilot },
			slashCommands: [],
			locations: [ChatAgentLocation.Chat, ChatAgentLocation.Terminal, ChatAgentLocation.EditorInline, ChatAgentLocation.Notebook],
			modes: [ChatModeKind.Ask, ChatModeKind.Edit, ChatModeKind.Agent],
			disambiguation: [],
		};
		// Registered as an agent plus its implementation, not as a dynamic agent:
		// only this path marks chat as enabled (`chatIsEnabled`), which the chat
		// input's mode and session-target pickers need to show at all.
		this._register(chatAgentService.registerAgent(data.id, data));
		this._register(chatAgentService.registerAgentImplementation(data.id, {
			invoke: (request, progress, history, token) => this._answer(request, progress, history, token),
		}));
	}

	private async _answer(request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatAgentResult> {
		const modelId = request.userSelectedModelId ?? (await this._languageModelsService.selectLanguageModels({}))[0];
		if (!modelId) {
			return { errorDetails: { message: localize('kingu.arkai.noModel', "Arkai has no model to answer with yet. Set up Chyle 1, or add a model with Manage Models.") } };
		}
		if (request.locationData?.type === ChatAgentLocation.EditorInline) {
			return this._editInline(modelId, request, request.locationData, progress, token);
		}
		try {
			const response = await this._languageModelsService.sendChatRequest(modelId, ARKAI_EXTENSION_ID, arkaiChatMessages(request, history), {}, token);
			for await (const chunk of response.stream) {
				for (const part of Array.isArray(chunk) ? chunk : [chunk]) {
					if (part.type === 'text' && part.value) {
						progress([{ kind: 'markdownContent', content: new MarkdownString(part.value) }]);
					}
				}
			}
			await response.result;
			return {};
		} catch (error) {
			return { errorDetails: { message: error instanceof Error ? error.message : String(error) } };
		}
	}

	/**
	 * Inline chat (`Ctrl+I`) wants an edit, not an answer: the lines selected (or
	 * the cursor's lines) rewritten as the request asks, sent back as a text edit
	 * the editor shows as a change to keep or undo.
	 */
	private async _editInline(modelId: string, request: IChatAgentRequest, location: IChatEditorLocationData, progress: (parts: IChatProgress[]) => void, token: CancellationToken): Promise<IChatAgentResult> {
		const model = this._modelService.getModel(location.document);
		if (!model) {
			return { errorDetails: { message: localize('kingu.arkai.noDocument', "Arkai could not read this file.") } };
		}
		const selection = Selection.liftSelection(location.selection);
		const region = selection.isEmpty() ? Range.lift(location.wholeRange) : selection;
		// A selection that ends at the start of a line leaves that line out.
		const endLineNumber = region.endColumn === 1 && region.endLineNumber > region.startLineNumber ? region.endLineNumber - 1 : region.endLineNumber;
		const startLineNumber = region.startLineNumber;
		const editRegion = {
			languageId: model.getLanguageId(),
			lines: model.getLinesContent(),
			startLineNumber,
			endLineNumber,
			instruction: request.message,
		};
		const prompt = kinguInlineEditPrompt(editRegion);
		let answer = '';
		try {
			const response = await this._languageModelsService.sendChatRequest(modelId, ARKAI_EXTENSION_ID, [
				{ role: ChatMessageRole.System, content: [{ type: 'text', value: prompt.system }] },
				{ role: ChatMessageRole.User, content: [{ type: 'text', value: prompt.user }] },
			], {}, token);
			for await (const chunk of response.stream) {
				for (const part of Array.isArray(chunk) ? chunk : [chunk]) {
					if (part.type === 'text') {
						answer += part.value;
					}
				}
			}
			await response.result;
		} catch (error) {
			return { errorDetails: { message: error instanceof Error ? error.message : String(error) } };
		}
		const code = kinguInlineEditCode(answer, editRegion);
		if (!code || token.isCancellationRequested) {
			return { errorDetails: { message: localize('kingu.arkai.noEdit', "Arkai did not suggest a change. Try saying what to change more exactly.") } };
		}
		const range = new Range(startLineNumber, 1, endLineNumber, model.getLineMaxColumn(endLineNumber));
		progress([
			{ kind: 'textEdit', uri: location.document, edits: [{ range, text: code }] },
			{ kind: 'textEdit', uri: location.document, edits: [], done: true },
		]);
		return {};
	}
}
