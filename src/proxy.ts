import { connect } from 'cloudflare:sockets';

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
export async function proxyHttp(request: Request, target: string): Promise<Response> {
	const url = new URL(request.url);
	const headers = new Headers(request.headers);
	for (const name of CF_INJECTED_HEADERS) {
		headers.delete(name);
	}
	const upstream = new Request(target + url.search, {
		method: request.method,
		headers,
		body: request.body,
		redirect: 'manual',
	});
	const response = await fetch(upstream);
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
export async function proxyStream(request: Request, target: string): Promise<Response> {
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

	const socket = connect(
		{ hostname, port },
		// `allowHalfOpen` keeps the writable side alive after the target EOFs, so a
		// FIN from the target doesn't stop us writing to it.
		{ secureTransport: useTls ? 'on' : 'off', allowHalfOpen: true },
	);

	// Wait for the connection before upgrading, so a failed dial surfaces as an
	// HTTP error instead of a 101 followed by an immediate close.
	try {
		await socket.opened;
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

	// WebSocket -> TCP. Await each write so the socket's backpressure propagates
	// to the WebSocket instead of buffering unboundedly.
	const writer = socket.writable.getWriter();

	let targetClosed = false;
	let clientClosed = false;
	let clientCloseCode: number | undefined;

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

	server.addEventListener('message', async (event) => {
		const data = event.data;
		const chunk = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
		try {
			await writer.write(chunk);
		} catch {
			// write failed — the read loop observes the closed socket and tears down
		}
	});

	// The client half-closed: forward its FIN to the target. Target bytes keep
	// reaching the client until the target itself closes, at which point its
	// close code is echoed back.
	server.addEventListener('close', (event) => {
		clientCloseCode = event.code;
		void closeTarget();
	});

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
			closeClient(clientCloseCode);
		}
	})();

	return new Response(null, { status: 101, webSocket: client });
}
