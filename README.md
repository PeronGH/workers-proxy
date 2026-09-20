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
| `/connect` | [VLESS](https://xtls.github.io/en/config/protocols/vless.html) over WebSocket, the server side of an Xray `network: ws` outbound. See below. |

Any other path returns `404 not found`.

```sh
# HTTP target
curl https://proxy.example.workers.dev/https://example.com/path?q=1

# TCP target (websocat)
websocat -b -t ws-c:binary ws://proxy.example.workers.dev/tcp://example.com:1234 -
```

Malformed stream targets fail fast: `400 missing port` / `400 bad target`, or `502 upstream connect failed` if the dial fails.

## VLESS over WebSocket

`/connect` terminates a VLESS request header on the WebSocket and bridges the
remainder to the destination it names — one WebSocket per VLESS connection, as
Xray's `network: ws` transport does.

```jsonc
// xray client outbound, pointed at the Worker
{
  "protocol": "vless",
  "settings": { "vnext": [{
    "address": "proxy.example.workers.dev",
    "port": 443,
    "users": [{ "id": "<uuid>", "encryption": "none" }]
  }] },
  "streamSettings": { "network": "ws", "security": "tls", "wsSettings": { "path": "/connect" } }
}
```

Access is gated by the `VLESS_USERS` secret, a comma-separated allowlist of
UUIDs:

```sh
bunx wrangler secret put VLESS_USERS
```

**Unset or empty accepts any UUID**, which makes the Worker an open proxy for
anyone who discovers the path. Query strings on `/connect` are ignored, so
Xray's `?ed=` early-data suffix needs no extra configuration.

Supported coverage is deliberately narrow: TCP only, `encryption: "none"` and no
flow. UDP has no outbound socket API on Workers; `xtls-rprx-vision` needs a raw
TLS 1.3 record stream; mux and reverse are multi-connection protocols. Requests
outside that set get the WebSocket closed rather than an error page, since the
101 has already been sent.

## Development

```sh
bun install
bunx wrangler dev
bunx wrangler deploy
```
