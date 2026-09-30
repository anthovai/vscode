/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { basename, dirname, extUri } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { isRecentFolder, isRecentWorkspace, IWorkspacesService } from '../../../../platform/workspaces/common/workspaces.js';
import { registerEditorGroupWatermarkContribution } from '../../../browser/parts/editor/editorGroupWatermark.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IAgentSessionsService } from '../../chat/browser/agentSessions/agentSessionsService.js';
import { AgentSessionStatus, IAgentSession } from '../../chat/browser/agentSessions/agentSessionsModel.js';
import { openSessionByResource } from '../../chat/browser/agentSessions/agentSessionsOpener.js';
import { KINGU_HOME_SETTING, kinguHomeSessions } from '../common/kinguHome.js';

const MAX_SESSIONS = 5;
const MAX_PROJECTS = 4;
const OPEN_FOLDER_COMMAND_ID = 'workbench.action.files.openFolder';
const TOGGLE_CHAT_COMMAND_ID = 'workbench.action.chat.toggle';

/**
 * Kingu's home: the empty editor area says where the work is, not only which
 * keys to press. Under the logo, the agent chats to pick up again, across
 * every project (status, agent, when), and the projects opened lately; the
 * shortcuts stay below. It fills VS Code's watermark rather than opening a
 * page of its own, so it is there whenever no editor is.
 */
class KinguHome extends Disposable {

	private readonly _element: HTMLElement;
	private readonly _renderDisposables = this._register(new DisposableStore());
	private _projects: { readonly uri: URI; readonly label: string; readonly detail: string; readonly isWorkspace: boolean }[] = [];

	constructor(
		container: HTMLElement,
		@IAgentSessionsService private readonly _agentSessionsService: IAgentSessionsService,
		@IWorkspacesService private readonly _workspacesService: IWorkspacesService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IHostService private readonly _hostService: IHostService,
		@ICommandService private readonly _commandService: ICommandService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILabelService private readonly _labelService: ILabelService,
		@IHoverService private readonly _hoverService: IHoverService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IWorkbenchEnvironmentService private readonly _environmentService: IWorkbenchEnvironmentService,
	) {
		super();
		this._element = append(container, $('.kingu-home'));
		this._register({ dispose: () => this._element.remove() });
		this._register(this._agentSessionsService.model.onDidChangeSessions(() => this._render()));
		this._register(this._workspacesService.onDidChangeRecentlyOpened(() => this._loadProjects()));
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(KINGU_HOME_SETTING)) {
				this._render();
			}
		}));
		this._loadProjects();
		this._render();
	}

	private async _loadProjects(): Promise<void> {
		const recent = await this._workspacesService.getRecentlyOpened();
		const current = this._workspaceContextService.getWorkspace();
		const currentUris = [...current.folders.map(folder => folder.uri.toString()), current.configuration?.toString()];
		this._projects = recent.workspaces
			.map(entry => isRecentFolder(entry)
				? { uri: entry.folderUri, isWorkspace: false }
				: isRecentWorkspace(entry) ? { uri: entry.workspace.configPath, isWorkspace: true } : undefined)
			// Not this window's, and not an Agents Window's own workspace (`agent-sessions.code-workspace`
			// in the user data, of this profile or, in development, of an earlier one).
			.filter((entry): entry is { uri: URI; isWorkspace: boolean } => !!entry
				&& !currentUris.includes(entry.uri.toString())
				&& !extUri.isEqualOrParent(entry.uri, this._environmentService.userRoamingDataHome)
				&& basename(entry.uri) !== basename(this._environmentService.agentSessionsWorkspace))
			.slice(0, MAX_PROJECTS)
			.map(entry => ({
				...entry,
				label: basename(entry.uri) || entry.uri.path,
				detail: this._labelService.getUriLabel(dirname(entry.uri), { relative: false }),
			}));
		this._render();
	}

	private _render(): void {
		this._renderDisposables.clear();
		clearNode(this._element);
		if (this._configurationService.getValue<boolean>(KINGU_HOME_SETTING) === false) {
			return;
		}

		// Continue: the agent chats worth going back to, across every project.
		const sessions = kinguHomeSessions(this._agentSessionsService.model.sessions, MAX_SESSIONS);
		const continueSection = this._section(localize('kingu.home.continue', "Continue"));
		if (sessions.length === 0) {
			this._row(continueSection, Codicon.commentDiscussion, localize('kingu.home.startChat', "Start a chat with your agent"), undefined,
				() => this._commandService.executeCommand(TOGGLE_CHAT_COMMAND_ID));
		}
		for (const session of sessions) {
			const status = statusIcon(session);
			const when = session.timing.lastRequestEnded ?? session.timing.lastRequestStarted ?? session.timing.created;
			this._row(continueSection, status, session.label,
				localize('kingu.home.sessionDetail', "{0} · {1}", session.providerLabel, fromNow(when, true)),
				() => this._instantiationService.invokeFunction(openSessionByResource, session.resource));
		}

		// Recent projects, and a way to open another.
		const projects = this._section(localize('kingu.home.projects', "Recent projects"));
		for (const project of this._projects) {
			this._row(projects, project.isWorkspace ? Codicon.window : Codicon.folder, project.label, project.detail,
				() => this._hostService.openWindow([project.isWorkspace ? { workspaceUri: project.uri } : { folderUri: project.uri }]));
		}
		this._row(projects, Codicon.folderOpened, localize('kingu.home.openFolder', "Open Folder…"), undefined,
			() => this._commandService.executeCommand(OPEN_FOLDER_COMMAND_ID));
	}

	private _section(title: string): HTMLElement {
		const section = append(this._element, $('.kingu-home-section'));
		append(section, $('.kingu-home-title')).textContent = title;
		return append(section, $('.kingu-home-rows'));
	}

	private _row(parent: HTMLElement, icon: ThemeIcon, label: string, detail: string | undefined, run: () => unknown): void {
		const row = append(parent, $('.kingu-home-row', { role: 'button', tabIndex: 0 }));
		append(row, renderIcon(icon)).classList.add('kingu-home-icon');
		append(row, $('span.kingu-home-label')).textContent = label;
		if (detail) {
			append(row, $('span.kingu-home-detail')).textContent = detail;
		}
		this._renderDisposables.add(this._hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), row, detail ? `${label} — ${detail}` : label));
		this._renderDisposables.add(addDisposableListener(row, EventType.CLICK, e => {
			e.preventDefault();
			run();
		}));
		this._renderDisposables.add(addDisposableListener(row, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				run();
			}
		}));
	}
}

function statusIcon(session: IAgentSession): ThemeIcon {
	switch (session.status) {
		case AgentSessionStatus.InProgress: return ThemeIcon.modify(Codicon.loading, 'spin');
		case AgentSessionStatus.NeedsInput: return Codicon.report;
		case AgentSessionStatus.Failed: return Codicon.error;
	}
	return session.isRead() ? Codicon.commentDiscussion : Codicon.circleFilled;
}

// The Agents Window has its own start page; the home is the IDE's.
registerEditorGroupWatermarkContribution((container, instantiationService) => instantiationService.invokeFunction(accessor => accessor.get(IWorkbenchEnvironmentService).isSessionsWindow)
	? Disposable.None
	: instantiationService.createInstance(KinguHome, container));
