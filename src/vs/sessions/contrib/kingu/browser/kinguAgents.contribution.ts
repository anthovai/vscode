/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import {
	Extensions as ViewContainerExtensions,
	IViewContainersRegistry,
	IViewDescriptor,
	IViewsRegistry,
	WindowEnablement,
} from '../../../../workbench/common/views.js';
import { KINGU_AGENTS_VIEW_ID, KinguAgentsView } from './kinguAgentsView.js';

/**
 * The container the Agents Window's sidebar actually is.
 *
 * Named by its id rather than imported, because `sessions.contribution.ts` does
 * not export it and this port does not need to change that file to add a view
 * beside its own.
 *
 * It has to be *this* container. The first attempt registered a container of
 * its own, which is what an ordinary VS Code window would want — and it was
 * unreachable, because the Agents Window omits the Activity Bar entirely
 * (`LAYOUT.md`: "The workbench omits the standard Activity Bar, Status Bar, and
 * Banner"). With nothing to click and no `View:` command generated for it, the
 * view existed and could not be opened. `LAYOUT.md` says what the sidebar is
 * for in as many words: "Sessions list and Sessions-owned sidebar views".
 */
const SESSIONS_CONTAINER_ID = 'agentic.workbench.view.sessionsContainer';

const KINGU_AGENTS_TITLE = localize2('kingu.agents.title', "Agents");

const kinguAgentsIcon = registerIcon('kingu-agents-icon', Codicon.pulse,
	localize('kingu.agents.icon', 'Icon for the Kingu Agents view'));

const kinguAgentsViewDescriptor: IViewDescriptor = {
	id: KINGU_AGENTS_VIEW_ID,
	containerIcon: kinguAgentsIcon,
	name: KINGU_AGENTS_TITLE,
	// Collapsed by default: the sessions list is what this window opens on and
	// what most people want from the sidebar, and this section answers a
	// narrower question — it should cost nothing until it is asked.
	//
	// No `order`. An explicit order puts this *above* the sessions list, because
	// that descriptor declares none and an unordered view sorts after an ordered
	// one. Leaving both unordered falls back to registration order, and
	// `sessions.contribution.js` is imported first.
	collapsed: true,
	canToggleVisibility: true,
	canMoveView: false,
	ctorDescriptor: new SyncDescriptor(KinguAgentsView),
	windowEnablement: WindowEnablement.Sessions,
};

const containersRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);
const sessionsContainer = containersRegistry.get(SESSIONS_CONTAINER_ID);
if (sessionsContainer) {
	Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([kinguAgentsViewDescriptor], sessionsContainer);
}
