# Watch Together signaling

Watch Together synchronizes playback between separate TorPlay installations. Every participant selects and streams an authorized source from their own TorPlay server. The shared signaling service sees room membership and WebRTC negotiation messages, but it never receives torrent references, debrid links, credentials, filenames, or video traffic.

## Run the signaling service

Install the project dependencies, choose a room store, then start the standalone service. Production deployments should use the Redis store:

```sh
npm ci
WATCH_TOGETHER_STORE=redis \
WATCH_TOGETHER_REDIS_URL=rediss://default:password@redis.example.com:6379 \
  HOST=127.0.0.1 PORT=8787 npm run start:watch-together-signaling
```

The standalone service variables are collected in `services/watch-together-signaling/.env.example`. They do not belong in TorPlay's `.env.local`, because the signaling service is deployed independently.

Put the service behind an HTTPS reverse proxy that forwards WebSocket upgrades for `/signal` and ordinary HTTP requests for `/health`. The public base URL must not include `/signal`:

```text
https://signal.example.com
```

Set that URL under **Settings → Services → Watch Together** on every participating TorPlay installation. Production URLs must use HTTPS; `http://localhost` is accepted for local development.

Optional service variables:

- `WATCH_TOGETHER_ALLOWED_ORIGINS` is a comma-separated exact browser-origin allowlist. When omitted, any browser origin may connect; room limits and rate limits still apply.
- `WATCH_TOGETHER_STORE` selects `memory` or `redis` and defaults to `memory`.
- `WATCH_TOGETHER_REDIS_URL` is the private Redis connection URL used for production room lifecycle persistence. `REDIS_URL` is accepted as a hosting-platform fallback. Use `rediss://` when the provider supports TLS.
- `WATCH_TOGETHER_REDIS_PREFIX` optionally changes the key prefix from `torplay:watch-together`.
- `HOST` and `PORT` select the private listener, defaulting to `127.0.0.1:8787`.

`memory` is the original in-process store and needs no Redis configuration. Its rooms are lost whenever the signaling process restarts. `redis` is the production store: active rooms and live sockets remain in process memory, while lightweight lifecycle records are also persisted to Redis for recovery after a restart. Redis mode requires `WATCH_TOGETHER_REDIS_URL` or `REDIS_URL`; the service fails at startup when it is missing. Rooms expire after 12 hours, accept at most eight participants, and close when the host leaves or cannot reconnect within 15 seconds.

## Redis boundary

Redis stores only infrequent room lifecycle data:

- room code, creation time, and expiry;
- host-selected movie or episode identity;
- participant IDs, display names, roles, and reconnect tokens;
- membership additions and removals.

Redis does not receive playback position, play/pause/seek commands, buffering or readiness state, player heartbeats, WebRTC offers/answers, ICE candidates, source information, or video traffic. There is no Redis polling. Keys use Redis expiry, and disconnects do not write anything unless the participant fails to reconnect within the grace period.

Live WebSocket connections and WebRTC negotiation remain owned by the active signaling process. Once DataChannels open, playback synchronization is peer-to-peer. Run one active signaling process, or use routing that guarantees every participant in a room reaches the same process; Redis is intentionally not used as a high-volume cross-instance signaling bus.

## Network and privacy limits

The data mesh uses the public Cloudflare and Google STUN endpoints by default. Override them with a comma-separated `WATCH_TOGETHER_STUN_URLS` value on each TorPlay installation. No TURN relay is used in v1, so peers behind restrictive NAT or firewalls may be unable to connect.

WebRTC DataChannels are encrypted, but direct peers and the signaling service necessarily process network addresses used during ICE negotiation. Redis contains reconnect tokens and must remain private, authenticated, and inaccessible from browsers. Do not treat a room code as an authentication credential; share it only with the intended participants.
