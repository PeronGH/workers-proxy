import { proxyHttp, proxyStream } from './proxy';
import { proxyVless } from './vless';

export default {
	async fetch(request, env): Promise<Response> {
		// Checked first: the target encoding below would otherwise read these paths
		// as literal targets.
		const { pathname } = new URL(request.url);
		if (pathname === '/connect') return proxyVless(request, env);
		if (pathname === '/connect64') return proxyVless(request, env, true);

		// The target is carried in the path: `https://example.com/path`,
		// `tcp://host:port`, or `tls://host:port`.
		const target = pathname.slice(1);

		if (target.startsWith('http://') || target.startsWith('https://')) {
			return proxyHttp(request, target);
		}

		if (target.startsWith('tcp://') || target.startsWith('tls://')) {
			return proxyStream(request, target);
		}

		return new Response('not found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;
