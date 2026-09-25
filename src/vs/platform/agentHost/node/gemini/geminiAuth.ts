/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from '../../../../base/common/path.js';

/** How the Gemini CLI is signed in, as it records it in `~/.gemini`. */
export interface IGeminiAuthStatus {
	readonly signedIn: boolean;
	/** `oauth-personal`, `gemini-api-key`, `vertex-ai`, … as the CLI names it. */
	readonly method?: string;
	/** The Google account, for a Google login. */
	readonly email?: string;
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
	try {
		return JSON.parse(await fs.readFile(path, 'utf8'));
	} catch {
		return undefined;
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await fs.access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * The CLI's own record: the selected method (`security.auth.selectedType`, or
 * the older `selectedAuthType`), then what that method needs — a Google login's
 * stored credentials, or an API key in the environment or `~/.gemini/.env`.
 */
export async function readGeminiAuthStatus(env: NodeJS.ProcessEnv = process.env): Promise<IGeminiAuthStatus> {
	const dir = join(homedir(), '.gemini');
	const settings = await readJson(join(dir, 'settings.json'));
	const security = settings?.security as { auth?: { selectedType?: string } } | undefined;
	const method = security?.auth?.selectedType ?? (typeof settings?.selectedAuthType === 'string' ? settings.selectedAuthType : undefined);
	switch (method) {
		case 'oauth-personal': {
			const accounts = await readJson(join(dir, 'google_accounts.json'));
			const email = typeof accounts?.active === 'string' && accounts.active ? accounts.active : undefined;
			return { signedIn: await exists(join(dir, 'oauth_creds.json')), method, email };
		}
		case 'gemini-api-key': {
			let signedIn = !!env.GEMINI_API_KEY;
			if (!signedIn) {
				try {
					signedIn = /^\s*GEMINI_API_KEY\s*=\s*\S/m.test(await fs.readFile(join(dir, '.env'), 'utf8'));
				} catch {
					// No .env.
				}
			}
			return { signedIn, method };
		}
		case 'vertex-ai':
		case 'gateway':
			return { signedIn: true, method };
		default:
			return { signedIn: false, method };
	}
}
