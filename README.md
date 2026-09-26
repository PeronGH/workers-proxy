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
| `/connect64` | As `/connect`, but every destination goes through the NAT64 gateway. See below. |

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

### Reaching Cloudflare-fronted hosts

A Worker cannot dial Cloudflare's own IP ranges — the edge refuses the
connection outright. That rules out a large slice of the internet directly, so
`NAT64_PREFIX` names a public NAT64 gateway to retry through, on the **original
port**, when the direct dial is refused:

```sh
bunx wrangler secret put NAT64_PREFIX
```

The prefix must form an IPv6 address when a dotted IPv4 address is appended to
it, e.g. `64:ff9b::` or `2a01:4f9:c010:3f02:64:0:`. Domains are resolved to
their first A record over DoH (`cloudflare-dns.com`). Leave it unset to disable
the fallback. The fallback is logged, since a silent switch to a different route
is otherwise invisible.

The gateway operator sees every destination sent through it, and any unencrypted
traffic. IPv6 destinations have no fallback, since NAT64 only reaches IPv4. The
edge reports one message for *every* address it refuses to dial — Cloudflare IPs,
`localhost`, and private ranges alike — so private and loopback addresses are
never sent to the gateway.

`/connect64` skips the direct dial and sends *every* destination through the
gateway, so targets see the gateway's IPv4 address rather than Cloudflare's. It
returns `404` while `NAT64_PREFIX` is unset. IPv6, private and loopback
destinations are refused on this path rather than dialled directly.

Supported coverage is deliberately narrow: TCP, `encryption: "none"` and no
flow. UDP has no outbound socket API on Workers, so the one exception is UDP/53,
which is sent to Google DNS (`8.8.8.8`) over TCP whatever resolver the client
named; other UDP is refused. `xtls-rprx-vision` needs a raw TLS 1.3 record
stream; mux and reverse are multi-connection protocols. Requests outside that
set get the WebSocket closed rather than an error page, since the 101 has
already been sent. A header still incomplete after 60s is dropped, which is
Xray's own handshake timeout.

## Development

```sh
bun install
bunx wrangler dev
bun run deploy
```

Use `bun run deploy` to deploy with lightweight obfuscation, or `bun run deploy:plain` to deploy without it.
