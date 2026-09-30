/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { KINGU_AI_CHANNEL_NAME } from '../../../../platform/kinguAi/common/kinguAi.js';
import { IKinguSemanticSearchRequest, IKinguSemanticSearchResult } from '../../../../platform/kinguAi/common/kinguSemanticSearch.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IFileMatch, IFileQuery, ISearchComplete, ISearchProgressItem, ISearchResultProvider, ISearchService, ITextQuery, OneLineRange, SearchProviderType, TextSearchCompleteMessageType, TextSearchMatch } from '../../../services/search/common/search.js';
import { SearchContext } from '../../search/common/constants.js';
import { kinguSmartSearchQueryText } from '../common/kinguSmartSearch.js';

/**
 * The Search view's AI results, by meaning, from the user's own Ollama: the
 * main process keeps an embedding index of the workspace (bge-m3) and ranks
 * its passages against the query (`platform/kinguAi/node/semanticSearch.ts`).
 * Upstream fills this section from Copilot's extension, which Kingu does not
 * ship; the results show under the exact matches, so a search that spells a
 * thing differently still finds it.
 */
class KinguSemanticSearchProvider implements ISearchResultProvider {

	private _model: string | undefined;

	constructor(
		private readonly _mainProcessService: IMainProcessService,
		private readonly _logService: ILogService,
	) { }

	async getAIName(): Promise<string | undefined> {
		return this._model
			? localize('kingu.semanticSearch.nameModel', "Related by meaning ({0})", this._model)
			: localize('kingu.semanticSearch.name', "Related by meaning");
	}

	async textSearch(query: ITextQuery, onProgress?: (p: ISearchProgressItem) => void, token?: CancellationToken): Promise<ISearchComplete> {
		const folders = query.folderQueries.map(folderQuery => URI.revive(folderQuery.folder)).filter(uri => uri.scheme === Schemas.file).map(uri => uri.fsPath);
		const pattern = (query as { contentPattern?: unknown }).contentPattern;
		// The Search view hands over the pattern it ran; a smart one (kinguSmartSearch.ts) goes back to the words typed.
		const text = kinguSmartSearchQueryText(typeof pattern === 'string' ? pattern : query.contentPattern?.pattern ?? '');
		const request: IKinguSemanticSearchRequest = { folders, query: text };
		const result = await this._mainProcessService.getChannel(KINGU_AI_CHANNEL_NAME).call<IKinguSemanticSearchResult>('semanticSearch', request);
		if (token?.isCancellationRequested) {
			return { results: [], messages: [] };
		}
		this._model = result.model;
		if (result.error) {
			this._logService.warn('[Kingu] search by meaning:', result.error);
		}
		const byFile = new ResourceMap<IFileMatch>();
		for (const hit of result.hits) {
			const resource = URI.file(hit.file);
			let match = byFile.get(resource);
			if (!match) {
				match = { resource, results: [] };
				byFile.set(resource, match);
			}
			match.results!.push(new TextSearchMatch(hit.text, new OneLineRange(hit.line, 0, hit.text.length)));
		}
		const results = [...byFile.values()];
		results.forEach(match => onProgress?.(match));
		const messages = result.error ? [{ text: result.error, type: TextSearchCompleteMessageType.Warning }] : [];
		if (result.indexing) {
			messages.push({
				text: localize('kingu.semanticSearch.indexing', "Still learning this workspace: {0} of {1} files so far. Search again later for more.", result.indexing.done, result.indexing.total),
				type: TextSearchCompleteMessageType.Information,
			});
		}
		return { results, messages };
	}

	async fileSearch(_query: IFileQuery): Promise<ISearchComplete> {
		return { results: [], messages: [] };
	}

	async clearCache(_cacheKey: string): Promise<void> {
		// The index is the main process's, kept up to date on each search.
	}
}

class KinguSemanticSearchContribution extends Disposable {

	static readonly ID = 'workbench.contrib.kinguSemanticSearch';

	constructor(
		@ISearchService searchService: ISearchService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILogService logService: ILogService,
	) {
		super();
		this._register(searchService.registerSearchResultProvider(Schemas.file, SearchProviderType.aiText, new KinguSemanticSearchProvider(mainProcessService, logService)));
		// What the Search view reads to show its AI results section.
		SearchContext.hasAIResultProvider.bindTo(contextKeyService).set(true);
	}
}

registerWorkbenchContribution2(KinguSemanticSearchContribution.ID, KinguSemanticSearchContribution, WorkbenchPhase.AfterRestored);
