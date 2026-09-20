/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { IAgentServerToolDefinition } from '../../../common/agentServerTools.js';
import {
	describeComputerAction,
	IKinguComputerRequest,
	isInputComputerTool,
	KinguComputerResult,
} from '../../../../kinguComputer/common/kinguComputerProtocol.js';
import type { IServerToolDisplay, IServerToolGroup } from '../agentServerToolHost.js';

/** The tool names, which are what an agent writes in a call. */
export const enum KinguComputerToolName {
	ListApps = 'kingu_desktop_list_apps',
	ListWindows = 'kingu_desktop_list_windows',
	ReadWindow = 'kingu_desktop_read_window',
	Type = 'kingu_desktop_type',
	PressKey = 'kingu_desktop_press_key',
	Click = 'kingu_desktop_click',
}

/** Which of these change the machine. Kept beside the names so neither drifts. */
const INPUT_TOOL_NAMES: ReadonlySet<string> = new Set([
	KinguComputerToolName.Type,
	KinguComputerToolName.PressKey,
	KinguComputerToolName.Click,
]);

const appProperty = {
	app: { type: 'string', description: 'The application, by the name `kingu_desktop_list_apps` reported.' },
} as const;

/**
 * What the agent is told these tools do.
 *
 * The descriptions say what the action costs as well as what it does — an
 * agent choosing between reading a window and typing into it should know that
 * one of those is visible to the user and takes their focus.
 */
const definitions: readonly IAgentServerToolDefinition[] = [
	{
		name: KinguComputerToolName.ListApps,
		description: 'List the applications with a window on the user\'s desktop. Reads only.',
		inputSchema: { type: 'object', properties: {}, required: [] },
	},
	{
		name: KinguComputerToolName.ListWindows,
		description: 'List one application\'s windows. Reads only.',
		inputSchema: { type: 'object', properties: { ...appProperty }, required: ['app'] },
	},
	{
		name: KinguComputerToolName.ReadWindow,
		description: 'Read a window\'s accessibility tree: its controls, their labels and their values. This is how to see what is on screen. Reads only.',
		inputSchema: { type: 'object', properties: { ...appProperty }, required: ['app'] },
	},
	{
		name: KinguComputerToolName.Type,
		description: 'Type text into an application. This brings its window to the front and sends real keystrokes to it, so the user sees it happen and loses focus from whatever they were doing. Ask before using it for anything the user did not request.',
		inputSchema: {
			type: 'object',
			properties: { ...appProperty, text: { type: 'string', description: 'Sent as keystrokes, exactly as written.' } },
			required: ['app', 'text'],
		},
	},
	{
		name: KinguComputerToolName.PressKey,
		description: 'Press a key in an application, such as `enter` or `ctrl+s`. Brings its window to the front.',
		inputSchema: {
			type: 'object',
			properties: { ...appProperty, key: { type: 'string', description: 'A key name, or a combination joined with `+`.' } },
			required: ['app', 'key'],
		},
	},
	{
		name: KinguComputerToolName.Click,
		description: 'Click an element reported by `kingu_desktop_read_window`. Brings the window to the front.',
		inputSchema: {
			type: 'object',
			properties: { ...appProperty, element: { type: 'object', description: 'An element exactly as `kingu_desktop_read_window` reported it.' } },
			required: ['app', 'element'],
		},
	},
];

/** What this group needs from the host to actually do anything. */
export interface IKinguComputerToolAccessor {
	/** Whether the desktop can be read at all — false where there is no runtime. */
	readonly isSupported: () => boolean;
	/** Whether the user has permitted acting, which is a separate setting. */
	readonly allowsInput: () => boolean;
	readonly request: (request: IKinguComputerRequest) => Promise<KinguComputerResult>;
}

/** The request a tool call means, or `undefined` when the arguments do not make one. */
export function toComputerRequest(toolName: string, rawArgs: unknown): IKinguComputerRequest | undefined {
	const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
	const app = typeof args.app === 'string' && args.app ? args.app : undefined;
	switch (toolName) {
		case KinguComputerToolName.ListApps:
			return { tool: 'list_apps' };
		case KinguComputerToolName.ListWindows:
			return app ? { tool: 'list_windows', app } : undefined;
		case KinguComputerToolName.ReadWindow:
			return app ? { tool: 'get_app_state', app } : undefined;
		case KinguComputerToolName.Type:
			return app && typeof args.text === 'string' ? { tool: 'type_text', app, text: args.text, restoreWindow: true } : undefined;
		case KinguComputerToolName.PressKey:
			return app && typeof args.key === 'string' && args.key ? { tool: 'press_key', app, key: args.key, restoreWindow: true } : undefined;
		case KinguComputerToolName.Click:
			return app && args.element ? { tool: 'click', app, element: args.element, restoreWindow: true } : undefined;
		default:
			return undefined;
	}
}

/**
 * The desktop, as tools any agent can call.
 *
 * Contributed as one group so every provider gets it at once — this is the
 * fork's own seam, and it is why Claude, Codex and Copilot need no per-agent
 * work here. The ADE reaches the same end by writing a hook into each agent's
 * own configuration, one integration per agent.
 *
 * Two gates, and they are different in kind:
 *
 * - **Advertisement.** When the user has not permitted acting, the three input
 *   tools are not enabled, so they are never advertised and the agent is not
 *   told they exist. That is stronger than refusing a call: an agent cannot be
 *   talked into using a tool it has never heard of.
 * - **Confirmation.** When they are advertised, every one of them declares
 *   {@link canRequireConfirmation}, which keeps providers from auto-approving
 *   it and routes each call through the user.
 *
 * The runtime refuses the acting tools independently of both. Three checks for
 * one property is deliberate: this is the capability where being wrong means an
 * agent used somebody's keyboard.
 */
export function createKinguComputerServerToolGroup(accessor?: IKinguComputerToolAccessor): IServerToolGroup {
	const isEnabled = (toolName: string) => {
		if (accessor?.isSupported() !== true) {
			return false;
		}
		return INPUT_TOOL_NAMES.has(toolName) ? accessor.allowsInput() : true;
	};
	return {
		definitions,
		isEnabled,
		isEnabledForSession: isEnabled,
		// Every acting tool asks. A provider that auto-approved one of these would
		// be auto-approving "use the user's keyboard".
		canRequireConfirmation: toolName => INPUT_TOOL_NAMES.has(toolName),
		async execute(_stateManager, _context, toolName, rawArgs): Promise<string> {
			const request = toComputerRequest(toolName, rawArgs);
			if (!request) {
				throw new Error(`${toolName} was called with arguments it cannot use.`);
			}
			if (!accessor) {
				throw new Error('Reading the desktop is not available in this host.');
			}
			// Checked again at the moment of use, not only at advertisement: a
			// session advertised these before the user withdrew the permission.
			if (isInputComputerTool(request.tool) && !accessor.allowsInput()) {
				throw new Error('Acting on the desktop is turned off.');
			}
			const result = await accessor.request(request);
			if (!result.ok) {
				throw new Error(result.error);
			}
			return JSON.stringify(result.value);
		},
		getDisplay(toolName, args): IServerToolDisplay | undefined {
			const request = toComputerRequest(toolName, args);
			switch (toolName) {
				case KinguComputerToolName.ListApps:
					return { displayName: 'List Applications', invocationMessage: 'List the applications on screen', pastTenseMessage: 'Listed the applications on screen' };
				case KinguComputerToolName.ListWindows:
					return { displayName: 'List Windows', invocationMessage: `List the windows of ${request?.app ?? 'an application'}`, pastTenseMessage: `Listed the windows of ${request?.app ?? 'an application'}` };
				case KinguComputerToolName.ReadWindow:
					return { displayName: 'Read Window', invocationMessage: `Read ${request?.app ?? 'a window'}`, pastTenseMessage: `Read ${request?.app ?? 'a window'}` };
				default:
					// The acting tools describe themselves in full — the same sentence
					// the user is asked to approve, so the confirmation and the
					// transcript cannot describe the same action differently.
					return request
						? { displayName: 'Use the Desktop', invocationMessage: describeComputerAction(request), pastTenseMessage: describeComputerAction(request) }
						: undefined;
			}
		},
	};
}
