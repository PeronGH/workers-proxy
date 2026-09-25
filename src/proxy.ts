import { createFetcher } from '@pixel/socket-fetch';
import { sockets, type SocketsEnv } from './sockets';

// Cloudflare-injected headers; stripped so the upstream sees a request
// close to the client's original. A few are re-added by the runtime and
// can't actually be removed from the subrequest.
const CF_INJECTED_HEADERS = [
	'cf-connecting-ip',
	'cf-connecting-ipv6',
	'cf-ipcountry',
	'cf-ray',
	'cf-visitor',
	'cf-ew-via',
	'cf-pseudo-ipv4',
	'cf-worker',
	'cf-request-id',
	'cdn-loop',
	'true-client-ip',
	'x-edge-ip',
	'x-forwarded-for',
	'x-forwarded-proto',
	'x-forwarded-port',
	'x-real-ip',
];

// Forward transparently: strip CF headers, don't auto-follow redirects,
// and rewrite any 3xx `Location` back through this Worker.
export async function proxyHttp(request: Request, target: string, env: SocketsEnv): Promise<Response> {
	const url = new URL(request.url);
	const headers = new Headers(request.headers);
	for (const name of CF_INJECTED_HEADERS) {
		headers.delete(name);
	}
	// The fetcher sends a supplied Host verbatim, which would name this Worker, and
	// a forwarded `Connection: keep-alive` would stop it asking the upstream to
	// close, leaving an unframed response body open forever.
	headers.delete('host');
	headers.delete('connection');
	// The fetcher only decodes gzip and deflate, but the runtime encodes the
	// returned body per its Content-Encoding, so any other coding (such as br)
	// would reach the client encoded twice. Dropping the header lets the fetcher
	// request only codings it can decode.
	headers.delete('accept-encoding');
	const response = await createFetcher(sockets(env))(target + url.search, {
		method: request.method,
		headers,
		body: request.body,
		redirect: 'manual',
	});
	if (response.status >= 300 && response.status < 400) {
		const location = response.headers.get('location');
		if (location) {
			const resolved = new URL(location, response.url || target).toString();
			const rewritten = `${url.origin}/${resolved}`;
			const respHeaders = new Headers(response.headers);
			respHeaders.set('location', rewritten);
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers: respHeaders,
			});
		}
	}
	return response;
}

/**
 * Bridge a binary WebSocket to a raw TCP/TLS socket — the server-side
 * counterpart of `websocat -b ws://host/tcp://target:port`.
 *
 * Incoming WebSocket frames are written verbatim to the socket; bytes read
 * back from the socket are sent as binary WebSocket frames. Half-closes are
 * honoured in both directions: a Close frame from the client sends a FIN to
 * the target without dropping bytes still in flight the other way.
 */
export async function proxyStream(request: Request, target: string, env: SocketsEnv): Promise<Response> {
	const useTls = target.startsWith('tls://');
	const hostPort = target.slice(6);
	const colonIdx = hostPort.lastIndexOf(':');
	if (colonIdx === -1) return new Response('missing port', { status: 400 });
	const hostname = hostPort.slice(0, colonIdx);
	const port = Number.parseInt(hostPort.slice(colonIdx + 1), 10);
	if (!hostname || !Number.isFinite(port)) {
		return new Response('bad target', { status: 400 });
	}

	if (request.headers.get('Upgrade') !== 'websocket') {
		return new Response('expected websocket', { status: 426 });
	}

	// Wait for the connection before upgrading, so a failed dial surfaces as an
	// HTTP error instead of a 101 followed by an immediate close.
	let socket: Socket;
	try {
		const { connect, connectTls } = sockets(env);
		socket = await (useTls ? connectTls : connect)({ hostname, port });
	} catch {
		return new Response('upstream connect failed', { status: 502 });
	}

	const { 0: client, 1: server } = new WebSocketPair();
	// Binary frames arrive as `Blob` by default on current compatibility dates, and
	// `new Uint8Array(blob)` would silently yield an empty array. Convert
	// synchronously so frame order is preserved.
	server.binaryType = 'arraybuffer';
	// Suppress the runtime's automatic Close reply: without it the socket closes
	// as soon as the client half-closes, dropping target bytes still in flight.
	server.accept({ allowHalfOpen: true });
	bridgeSocket(socket, server, new WebSocketFrames(server));

	return new Response(null, { status: 101, webSocket: client });
}

/**
 * Frames read off an accepted WebSocket.
 *
 * workerd dispatches incoming frames straight out of its read loop, with no
 * buffer in between, so a frame that arrives while no `message` listener is
 * attached is discarded for good. Attaching one listener for the lifetime of
 * the connection and queueing here lets whichever phase owns the connection
 * change over without losing bytes in the handoff — notably across the dial,
 * which is real I/O and can outlast the arrival of the next frame.
 */
export class WebSocketFrames {
	private readonly queue: Uint8Array[] = [];
	private waiter: (() => void) | null = null;
	private ended = false;
	/** Close code from the peer, when it closed cleanly rather than errored. */
	closeCode: number | undefined;

	constructor(readonly server: WebSocket) {
		server.addEventListener('message', this.onMessage);
		server.addEventListener('close', this.onClose);
		server.addEventListener('error', this.onError);
	}

	private onMessage = (event: MessageEvent): void => {
		this.queue.push(frameBytes(event.data));
		this.wake();
	};

	private onClose = (event: CloseEvent): void => {
		this.closeCode = event.code;
		this.end();
	};

	private onError = (): void => {
		this.end();
	};

	private end(): void {
		this.ended = true;
		this.wake();
	}

	private wake(): void {
		const waiter = this.waiter;
		this.waiter = null;
		waiter?.();
	}

	/** The next frame, or null once the peer has closed or errored. */
	async next(): Promise<Uint8Array | null> {
		for (;;) {
			const frame = this.queue.shift();
			if (frame !== undefined) return frame;
			if (this.ended) return null;
			await new Promise<void>((resolve) => {
				this.waiter = resolve;
			});
		}
	}
}

/**
 * Pump bytes between a raw socket and an already-accepted WebSocket.
 *
 * Incoming WebSocket frames are written verbatim to the socket; bytes read back
 * from the socket are sent as binary WebSocket frames. Half-closes are honoured
 * in both directions: a Close frame from the client sends a FIN to the target
 * without dropping bytes still in flight the other way.
 *
 * `prefix` is written to the socket before any client frame, to flush the tail
 * of a protocol header that spanned several frames.
 */
export function bridgeSocket(socket: Socket, server: WebSocket, frames: WebSocketFrames, prefix?: Uint8Array): void {
	// Each write is awaited in one loop, so a congested socket stalls this side
	// rather than other work. The runtime does not flow-control incoming frames,
	// so a slow target can still queue in memory — there is nothing to push back
	// against.
	const writer = socket.writable.getWriter();
	if (prefix && prefix.length > 0) void writer.write(prefix).catch(() => {});

	let targetClosed = false;
	let clientClosed = false;

	// Half-close the target: flush queued writes, then send FIN. Idempotent.
	async function closeTarget(): Promise<void> {
		if (targetClosed) return;
		targetClosed = true;
		try {
			await writer.close();
		} catch {
			// already closed, or aborted by the peer
		}
	}

	function closeClient(code?: number): void {
		if (clientClosed) return;
		clientClosed = true;
		server.close(code);
	}

	// The client half-closed: forward its FIN to the target. Target bytes keep
	// reaching the client until the target itself closes, at which point its
	// close code is echoed back.
	(async () => {
		for (;;) {
			const frame = await frames.next();
			if (frame === null) break;
			try {
				await writer.write(frame);
			} catch {
				// write failed — the read loop observes the closed socket and tears down
				break;
			}
		}
		await closeTarget();
	})();

	// A socket error rejects `closed`; close the client with an abnormal code
	// rather than waiting for a FIN that will never arrive.
	socket.closed.catch(() => closeClient(1006));

	// TCP -> WebSocket (binary frames). On EOF, FIN the target before closing
	// the WebSocket so the Close frame is the last thing the caller sees.
	(async () => {
		try {
			for await (const chunk of socket.readable) {
				server.send(chunk);
			}
		} catch {
			// socket error — fall through to close
		} finally {
			await closeTarget();
			closeClient(frames.closeCode);
		}
	})();
}

/**
 * Binary frames arrive as `Blob` by default on current compatibility dates, and
 * `new Uint8Array(blob)` would silently yield an empty array. Convert
 * synchronously so frame order is preserved.
 */
function frameBytes(data: string | ArrayBuffer): Uint8Array {
	return typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
}
