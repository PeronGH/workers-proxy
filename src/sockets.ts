import { connect as open } from 'cloudflare:sockets';

/** Open a plain TCP connection, resolving once it is established. */
export function connect(address: SocketAddress): Promise<Socket> {
	return dial(address, 'off');
}

/** Open a TLS connection, resolving once it is established. */
export function connectTls(address: SocketAddress): Promise<Socket> {
	return dial(address, 'on');
}

async function dial({ hostname, port }: SocketAddress, secureTransport: 'on' | 'off'): Promise<Socket> {
	const socket = open(
		{ hostname: bracketIpv6(hostname), port },
		// `allowHalfOpen` keeps the writable side alive after the target EOFs, so a
		// FIN from the target doesn't stop us writing to it.
		{ secureTransport, allowHalfOpen: true },
	);
	await socket.opened;
	return socket;
}

// The runtime only accepts IPv6 literals in brackets, while URL parsing and VLESS
// headers yield them bare.
function bracketIpv6(hostname: string): string {
	return hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
}
