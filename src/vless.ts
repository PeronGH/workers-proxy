import { bridgeSocket, WebSocketFrames } from './proxy';
import { sockets, type SocketsEnv } from './sockets';

const VERSION = 0;
// Response header: protocol version, then addons length 0. Xray only sends addons
// for `xtls-rprx-vision`, which we reject, so the server never sends any either.
const RESPONSE_HEADER = new Uint8Array([VERSION, 0]);

const COMMAND_TCP = 0x01;

const ADDRESS_IPV4 = 0x01;
const ADDRESS_DOMAIN = 0x02;
const ADDRESS_IPV6 = 0x03;

// A header is at most 1 + 16 + 1 + 1 + 2 + 1 + 1 + 255 bytes: version, UUID,
// addons length, command, port, address type, domain length, domain. Non-zero
// addons are rejected, so 255 bytes of them can never occur. Anything past this
// is a client dribbling frames that will never finish the header.
const MAX_HEADER = 2048;

// Xray aligns its handshake timeout with nginx's client_header_timeout "so that
// this value will not indicate server identity" (features/policy/policy.go).
const HANDSHAKE_TIMEOUT = 60_000;

export interface VlessEnv extends SocketsEnv {
	/**
	 * Comma-separated VLESS UUIDs allowed to connect. Unset or empty accepts any
	 * UUID, which makes the Worker an open proxy for anyone who finds the path.
	 */
	VLESS_USERS?: string;
}

type Header =
	{ status: 'incomplete' } | { status: 'invalid' } | { status: 'ok'; userId: Uint8Array; hostname: string; port: number; consumed: number };

/**
 * Parse a VLESS request header off the front of the byte stream, returning how
 * many bytes it consumed. Ports precede addresses in VLESS.
 */
function parseHeader(buf: Uint8Array): Header {
	let offset = 0;
	// `subarray` on a short buffer silently yields fewer bytes than asked for, so
	// every read has to check the length first.
	const take = (n: number): Uint8Array | null => {
		if (buf.length - offset < n) return null;
		const slice = buf.subarray(offset, offset + n);
		offset += n;
		return slice;
	};

	const version = take(1);
	if (version === null) return { status: 'incomplete' };
	if (version[0] !== VERSION) return { status: 'invalid' };

	const userId = take(16);
	if (userId === null) return { status: 'incomplete' };

	const addonsLength = take(1);
	if (addonsLength === null) return { status: 'incomplete' };
	// Only `xtls-rprx-vision` writes addons, and it needs a raw TLS 1.3 record
	// stream that a Worker cannot provide.
	if (take(addonsLength[0]) === null) return { status: 'incomplete' };
	if (addonsLength[0] !== 0) return { status: 'invalid' };

	const command = take(1);
	if (command === null) return { status: 'incomplete' };
	// UDP has no outbound socket API here; mux and reverse are multi-connection
	// protocols over one stream.
	if (command[0] !== COMMAND_TCP) return { status: 'invalid' };

	const port = take(2);
	if (port === null) return { status: 'incomplete' };

	const addressType = take(1);
	if (addressType === null) return { status: 'incomplete' };

	let hostname: string;
	switch (addressType[0]) {
		case ADDRESS_IPV4: {
			const bytes = take(4);
			if (bytes === null) return { status: 'incomplete' };
			hostname = bytes.join('.');
			break;
		}
		case ADDRESS_IPV6: {
			const bytes = take(16);
			if (bytes === null) return { status: 'incomplete' };
			const groups: string[] = [];
			for (let i = 0; i < 16; i += 2) {
				groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
			}
			hostname = groups.join(':');
			break;
		}
		case ADDRESS_DOMAIN: {
			const length = take(1);
			if (length === null) return { status: 'incomplete' };
			const domain = take(length[0]);
			if (domain === null) return { status: 'incomplete' };
			hostname = new TextDecoder().decode(domain);
			break;
		}
		default:
			return { status: 'invalid' };
	}

	return { status: 'ok', userId, hostname, port: (port[0] << 8) | port[1], consumed: offset };
}

/** Normalised UUIDs allowed to connect, or null when any UUID is accepted. */
function allowedIds(env: VlessEnv): Set<string> | null {
	const raw = env.VLESS_USERS?.trim();
	if (!raw) return null;
	return new Set(
		raw.split(',').map((id) =>
			id
				.trim()
				.replace(/[{}\-]/g, '')
				.toLowerCase(),
		),
	);
}

function toHex(bytes: Uint8Array): string {
	let hex = '';
	for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
	return hex;
}

/**
 * Xray clients configured with `ed` send the first bytes of the VLESS stream in
 * the `Sec-WebSocket-Protocol` header instead of a frame, base64url-encoded and
 * unpadded, and expect the header echoed back.
 */
function decodeEarlyData(header: string | null): Uint8Array | null {
	if (!header) return null;
	try {
		const base64 = header.replace(/[-_]/g, (c) => (c === '-' ? '+' : '/'));
		const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
		return bytes.length > 0 ? bytes : null;
	} catch {
		// Not early data — a client using the header for something else.
		return null;
	}
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	if (a.length === 0) return b;
	const merged = new Uint8Array(a.length + b.length);
	merged.set(a);
	merged.set(b, a.length);
	return merged;
}

/** Resolves with the next frame, or null once the peer has gone away. */
function nextFrame(frames: WebSocketFrames, timeout: number): Promise<Uint8Array | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), timeout);
	});
	return Promise.race([frames.next(), deadline]).finally(() => clearTimeout(timer));
}

/**
 * Serve VLESS over a WebSocket at `/connect`: authenticate the request header,
 * dial the requested destination, then bridge the two.
 *
 * The 101 has to go back before any frame can arrive, so this runs detached and
 * reports failure by closing the WebSocket.
 */
async function handshake(frames: WebSocketFrames, env: VlessEnv, early: Uint8Array | null): Promise<void> {
	const ids = allowedIds(env);
	let buf = early ?? new Uint8Array(0);
	let header: Extract<Header, { status: 'ok' }>;

	for (;;) {
		const parsed = parseHeader(buf);
		if (parsed.status === 'ok') {
			header = parsed;
			break;
		}
		if (parsed.status === 'invalid' || buf.length > MAX_HEADER) {
			frames.server.close(1008);
			return;
		}
		const frame = await nextFrame(frames, HANDSHAKE_TIMEOUT);
		if (frame === null) {
			// Either the peer gave up mid-header or the handshake timed out.
			frames.server.close(1008);
			return;
		}
		buf = concat(buf, frame);
	}

	if (ids !== null && !ids.has(toHex(header.userId))) {
		frames.server.close(1008);
		return;
	}

	let socket: Socket;
	try {
		socket = await sockets(env).connect({ hostname: header.hostname, port: header.port });
	} catch {
		frames.server.close(1011);
		return;
	}

	frames.server.send(RESPONSE_HEADER);
	// Frames that arrived while either dial was in flight are queued, not lost.
	bridgeSocket(socket, frames.server, frames, buf.subarray(header.consumed));
}

/** VLESS over WebSocket — the server side of an Xray `network: ws` outbound. */
export async function proxyVless(request: Request, env: VlessEnv): Promise<Response> {
	if (request.headers.get('Upgrade') !== 'websocket') {
		return new Response('expected websocket', { status: 426 });
	}

	const { 0: client, 1: server } = new WebSocketPair();
	// Binary frames arrive as `Blob` by default on current compatibility dates, and
	// `new Uint8Array(blob)` would silently yield an empty array.
	server.binaryType = 'arraybuffer';
	// Suppress the runtime's automatic Close reply so a half-closed client
	// doesn't drop target bytes still in flight.
	server.accept({ allowHalfOpen: true });

	// Shared with the bridge, so no frame can be lost in the handoff.
	const frames = new WebSocketFrames(server);

	// The 101 has to go back before any frame can arrive, so the handshake runs
	// detached and reports failure by closing the WebSocket.
	const early = decodeEarlyData(request.headers.get('sec-websocket-protocol'));
	void handshake(frames, env, early).catch(() => server.close(1011));

	// Echo the client's early-data header back, as Xray's WebSocket listener does.
	const protocol = request.headers.get('sec-websocket-protocol');
	const headers = early && protocol ? { 'Sec-WebSocket-Protocol': protocol } : undefined;

	return new Response(null, { status: 101, webSocket: client, headers });
}
