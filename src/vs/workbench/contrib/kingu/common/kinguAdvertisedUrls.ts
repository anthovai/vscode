/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/** What kind of address a dev server printed, which decides which one to prefer. */
export const enum KinguHostKind {
	/** A DNS name the developer arranged for: `app.localhost`, a project domain. */
	Custom = 'custom',
	Loopback = 'loopback',
	/** A LAN address: reachable, but not from this machine's own certificates and cookies. */
	PrivateIp = 'privateIp',
	PublicIp = 'publicIp',
}

/** A URL a process announced for a port it is serving. */
export interface IKinguAdvertisedUrl {
	/** What to open. Normalized: an unspecified bind becomes loopback. */
	readonly url: string;
	readonly port: number;
	readonly protocol: 'http' | 'https';
	readonly hostKind: KinguHostKind;
	/** When it was last printed, in milliseconds since the epoch. */
	readonly seenAt: number;
}

/**
 * A line no longer than this is worth scanning.
 *
 * Terminal output includes minified bundles and base64 blobs on one line. The
 * scan is a regex over every line a terminal prints, so it has to be cheap on
 * the lines that are not announcements — and an announcement is short.
 */
const MAX_LINE_LENGTH = 2048;

/** A URL longer than this is not something a dev server printed for a person to click. */
const MAX_URL_LENGTH = 512;

/**
 * Permissive on purpose: `new URL` does the real validation below. It stops at
 * whitespace and at the quoting a terminal puts around things, so the trailing
 * punctuation of a sentence is not absorbed into the address.
 */
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;

/** Punctuation that ends a sentence, not a URL. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"`]+$/;

/**
 * The URLs a line of terminal output announced.
 *
 * Fed from the terminal's own line events, which arrive already stripped of
 * escape sequences and already unwrapped — so unlike the ADE, which buffers raw
 * PTY chunks and strips ANSI, OSC and cursor movement itself, there is nothing
 * to undo here. The terminal has done it.
 */
export function readAdvertisedUrls(line: string, now: number): IKinguAdvertisedUrl[] {
	if (line.length > MAX_LINE_LENGTH || !line.includes('://')) {
		return [];
	}
	const found: IKinguAdvertisedUrl[] = [];
	for (const match of line.matchAll(URL_PATTERN)) {
		const candidate = match[0].replace(TRAILING_PUNCTUATION, '');
		if (candidate.length > MAX_URL_LENGTH) {
			continue;
		}
		const advertised = readAdvertisedUrl(candidate, now);
		if (advertised) {
			found.push(advertised);
		}
	}
	return found;
}

/**
 * One candidate, validated and normalized, or `undefined` when it is not an
 * address this may open.
 *
 * The input is terminal output, which is whatever any process an agent ran
 * chose to print — a build script, a dependency's postinstall, a compromised
 * package. So this is a trust boundary, and the rule is narrow: the address is
 * only used when it names *this machine*, because the only claim being made is
 * "the port you can see listening here is reached like this".
 *
 * A non-loopback host is therefore refused rather than ranked lower. Ranking it
 * lower would still open it whenever a server announced nothing else, and the
 * whole attack is one line of output. What a refused announcement costs is a
 * path and a scheme; what accepting it would cost is sending the user to
 * somebody else's site from a control that says "open this port".
 */
export function readAdvertisedUrl(candidate: string, now: number): IKinguAdvertisedUrl | undefined {
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return undefined;
	}
	// Only the two web schemes. `file:`, `javascript:` and the rest are not
	// addresses for a listening port and must never reach an opener.
	const protocol = url.protocol === 'https:' ? 'https' : url.protocol === 'http:' ? 'http' : undefined;
	if (!protocol || !url.hostname) {
		return undefined;
	}
	// Credentials in the authority are a phishing device — `http://localhost@evil`
	// reads as localhost and resolves to `evil` — and no dev server prints them.
	if (url.username || url.password) {
		return undefined;
	}
	const port = url.port ? Number.parseInt(url.port, 10) : protocol === 'https' ? 443 : 80;
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		return undefined;
	}
	if (isUnspecifiedHost(url.hostname)) {
		// A server that printed its bind address rather than an address to visit.
		// `http://0.0.0.0:3000` is not openable; the machine asking is this one, so
		// the address it should use is loopback.
		url.hostname = 'localhost';
	}
	if (!isLocalhostEquivalent(url.hostname)) {
		return undefined;
	}
	return {
		url: url.toString(),
		port,
		protocol,
		hostKind: classifyHost(url.hostname),
		seenAt: now,
	};
}

/**
 * Whether a hostname is guaranteed to be this machine.
 *
 * The literals, and any name under `.localhost` — which RFC 6761 reserves for
 * loopback, so `app.localhost` cannot be pointed anywhere else. Every other
 * name is excluded even though some of them are genuinely local (`myapp.test`
 * through a local resolver): this cannot tell those apart from a name a
 * malicious line invented, and the safe answer is the one that does not
 * navigate.
 */
export function isLocalhostEquivalent(hostname: string): boolean {
	const bare = hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (bare === 'localhost' || bare === '::1' || bare.endsWith('.localhost')) {
		return true;
	}
	// The whole 127.0.0.0/8 block, not just 127.0.0.1: a dev server bound to
	// 127.0.0.2 is still only reachable from here.
	return isIpv4(bare) && bare.startsWith('127.');
}

/** Whether a hostname is a bind-everything placeholder rather than somewhere to go. */
export function isUnspecifiedHost(hostname: string): boolean {
	const bare = hostname.toLowerCase().replace(/^\[|\]$/g, '');
	return bare === '0.0.0.0' || bare === '::' || bare === '*';
}

export function classifyHost(hostname: string): KinguHostKind {
	// Brackets stripped so both `[::1]` and a bare literal are accepted.
	const bare = hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (bare === 'localhost' || bare === '127.0.0.1' || bare === '::1') {
		return KinguHostKind.Loopback;
	}
	if (isIpv4(bare)) {
		return isPrivateIpv4(bare) ? KinguHostKind.PrivateIp : KinguHostKind.PublicIp;
	}
	if (isIpv6(bare)) {
		return isPrivateIpv6(bare) ? KinguHostKind.PrivateIp : KinguHostKind.PublicIp;
	}
	// A name, which is what a developer arranges deliberately.
	return KinguHostKind.Custom;
}

/**
 * How much a kind of address is preferred, highest first.
 *
 * Only two of these can occur, because {@link readAdvertisedUrl} admits nothing
 * that is not this machine: a `.localhost` name, which classifies as a name,
 * and the loopback literals. The name wins because a project that arranged one
 * did so deliberately and its cookies are issued against it.
 *
 * The other two remain so the ranking is total if the admission rule is ever
 * widened — but widening it is what the rule exists to prevent, so they should
 * stay unreachable.
 */
function hostKindRank(kind: KinguHostKind): number {
	switch (kind) {
		case KinguHostKind.Custom: return 3;
		case KinguHostKind.Loopback: return 2;
		case KinguHostKind.PrivateIp: return 1;
		case KinguHostKind.PublicIp: return 0;
	}
}

/** Whether `candidate` is a better address for its port than `existing`. */
export function isBetterAdvertisedUrl(existing: IKinguAdvertisedUrl, candidate: IKinguAdvertisedUrl): boolean {
	const existingRank = hostKindRank(existing.hostKind);
	const candidateRank = hostKindRank(candidate.hostKind);
	if (existingRank !== candidateRank) {
		return candidateRank > existingRank;
	}
	if (existing.protocol !== candidate.protocol) {
		// A server that serves both announces both; the secure one is the one it
		// means, and the other is usually a redirect to it.
		return candidate.protocol === 'https';
	}
	// Otherwise the newer announcement wins: a restarted server is telling us
	// something has changed, even when the address looks the same.
	return candidate.seenAt >= existing.seenAt;
}

/**
 * How many ports are remembered.
 *
 * One entry is a short string and a few numbers. The bound exists because the
 * keys come from terminal output, which a runaway process can produce without
 * limit.
 */
const MAX_PORTS = 128;

/**
 * The best address seen for each port.
 *
 * Kept in the window rather than asked for, because the announcement happens
 * once — when the server starts — and the question is asked later, when someone
 * looks at the strip. Nothing is persisted: a URL from a previous run of the
 * app would name a server that is no longer listening.
 */
export class KinguAdvertisedUrlCache {

	private readonly _byPort = new Map<number, IKinguAdvertisedUrl>();

	constructor(private readonly _maxPorts = MAX_PORTS) { }

	/**
	 * Records what a line announced.
	 *
	 * Returns the ports whose best address changed, so a caller can redraw only
	 * when there is something new rather than on every line a terminal prints.
	 */
	record(urls: readonly IKinguAdvertisedUrl[]): number[] {
		const changed: number[] = [];
		for (const candidate of urls) {
			const existing = this._byPort.get(candidate.port);
			if (existing && !isBetterAdvertisedUrl(existing, candidate)) {
				continue;
			}
			// Re-inserted so the map's order is least-recently-announced.
			this._byPort.delete(candidate.port);
			this._byPort.set(candidate.port, candidate);
			if (existing?.url !== candidate.url) {
				changed.push(candidate.port);
			}
			if (this._byPort.size > this._maxPorts) {
				const oldest = this._byPort.keys().next();
				if (!oldest.done) {
					this._byPort.delete(oldest.value);
				}
			}
		}
		return changed;
	}

	/** The address announced for a port, when one was. */
	get(port: number): IKinguAdvertisedUrl | undefined {
		return this._byPort.get(port);
	}

	/**
	 * Forgets ports nothing is listening on any more.
	 *
	 * An announcement outlives the server that made it — the line stays in the
	 * scrollback after the process is gone — so a port that has stopped
	 * listening must lose its address, or the next server on that port inherits
	 * the last one's URL and path.
	 */
	retain(listening: ReadonlySet<number>): void {
		for (const port of [...this._byPort.keys()]) {
			if (!listening.has(port)) {
				this._byPort.delete(port);
			}
		}
	}

	get size(): number {
		return this._byPort.size;
	}
}

function isIpv4(value: string): boolean {
	const parts = value.split('.');
	return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** The ranges a machine can reach on its own network but nowhere else. */
function isPrivateIpv4(value: string): boolean {
	const [first, second] = value.split('.').map(Number);
	return first === 10
		|| (first === 172 && second >= 16 && second <= 31)
		|| (first === 192 && second === 168)
		// Link-local: what a machine gives itself when nothing assigned it one.
		|| (first === 169 && second === 254);
}

function isIpv6(value: string): boolean {
	return value.includes(':') && /^[0-9a-f:]+$/.test(value);
}

/** Unique-local (`fc00::/7`) and link-local (`fe80::/10`). */
function isPrivateIpv6(value: string): boolean {
	if (value.startsWith('fc') || value.startsWith('fd')) {
		return true;
	}
	const firstHextet = Number.parseInt(value.split(':', 1)[0], 16);
	return Number.isFinite(firstHextet) && (firstHextet & 0xffc0) === 0xfe80;
}
