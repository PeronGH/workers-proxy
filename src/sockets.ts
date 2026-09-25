import { connect as open } from 'cloudflare:sockets';

// The edge reports this for every destination it refuses to dial. Cloudflare
// IPs are one case, but localhost and private ranges share the message, so the
// fallback fires for all of them and not only Cloudflare.
const REFUSED_ADDRESS = 'cannot connect to the specified address';

export interface SocketsEnv {
	/**
	 * Hostname to dial instead of the destination when the edge refuses it
	 * outright, keeping the original port. Unset disables the fallback.
	 */
	CF_PROXY_HOSTNAME?: string;
}

export interface Sockets {
	/** Open a plain TCP connection, resolving once it is established. */
	connect(address: SocketAddress): Promise<Socket>;
	/** Open a TLS connection, resolving once it is established. */
	connectTls(address: SocketAddress): Promise<Socket>;
}

/** `connect`/`connectTls` that retry via `CF_PROXY_HOSTNAME` when the edge refuses the destination. */
export function sockets(env: SocketsEnv): Sockets {
	const fallback = env.CF_PROXY_HOSTNAME?.trim() || undefined;
	return {
		connect: (address) => dial(address, fallback, false),
		connectTls: (address) => dial(address, fallback, true),
	};
}

async function dial({ hostname, port }: SocketAddress, fallback: string | undefined, tls: boolean): Promise<Socket> {
	try {
		return await opened(hostname, port, tls ? 'on' : 'off');
	} catch (error) {
		if (fallback === undefined || !isRefusedAddress(error)) throw error;
	}

	console.warn(`direct dial of ${hostname}:${port} refused, retrying via ${fallback}:${port}`);
	if (!tls) return opened(fallback, port, 'off');
	// The fallback relays raw TLS, so the handshake must still name and verify the
	// original host rather than the fallback.
	const socket = await opened(fallback, port, 'starttls');
	const secure = socket.startTls({ expectedServerHostname: hostname });
	await secure.opened;
	return secure;
}

async function opened(hostname: string, port: number, secureTransport: 'on' | 'off' | 'starttls'): Promise<Socket> {
	const socket = open(
		{ hostname: bracketIpv6(hostname), port },
		// `allowHalfOpen` keeps the writable side alive after the target EOFs, so a
		// FIN from the target doesn't stop us writing to it.
		{ secureTransport, allowHalfOpen: true },
	);
	await socket.opened;
	return socket;
}

function isRefusedAddress(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes(REFUSED_ADDRESS);
}

// The runtime only accepts IPv6 literals in brackets, while URL parsing and VLESS
// headers yield them bare.
function bracketIpv6(hostname: string): string {
	return hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
}
