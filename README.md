# workers-proxy

A Cloudflare Worker that proxies requests to a target encoded in the URL path. The host and everything after it is the target; the rest of the request is forwarded as-is.

## Usage

```
https://<worker-host>/<target>
```

| Prefix | Behavior |
| --- | --- |
| `http://`, `https://` | Proxies the request over `fetch`. Cloudflare-injected headers (`cf-*`, `x-forwarded-*`, …) are stripped, redirects are not followed, and 3xx `Location` headers are rewritten back through the Worker. |
| `tcp://`, `tls://` | Bridges a binary WebSocket to a raw TCP/TLS socket, the server side of `websocat -b ws://host/<target>`. Requires a WebSocket upgrade (`426` otherwise). |

Any other path returns `404 not found`.

```sh
# HTTP target
curl https://proxy.example.workers.dev/https://example.com/path?q=1

# TCP target (websocat)
websocat -b -t ws-c:binary ws://proxy.example.workers.dev/tcp://example.com:1234 -
```

Malformed stream targets fail fast: `400 missing port` / `400 bad target`, or `502 upstream connect failed` if the dial fails.

## Development

```sh
bun install
bunx wrangler dev
bunx wrangler deploy
```
