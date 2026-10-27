# Hosted Webhook Delivery Demo

This is a standalone pnpm project that consumes the repository's public
`webhook-delivery-engine` package through a tarball produced by `pnpm pack`.
Its lockfile, scripts, TypeScript, Vite, Vitest, and ESLint
configuration are local to this directory. It uses the actual embedded engine, a fixed
HTTPS receiver, and an in-process SQLite database. It does not publish the
package or add routes to the library.

## Live demo

Try the hosted demo at <https://webhook-delivery-engine-3tu0.onrender.com/>.

## What it demonstrates

- Immediate delivery, a retry that later succeeds, terminal HTTP 401, and
  retry exhaustion ending in the engine's `failed` state.
- SSRF rejection before any request reaches the receiver.
- Custom JSON payloads, idempotency keys, status queries, attempt history, and
  signed request headers.
- Graceful engine shutdown when the host process receives SIGTERM or SIGINT.

The browser can choose a scenario and provide bounded payload/idempotency data.
The server selects the destination and engine configuration; arbitrary URLs,
client identities, and secrets are never accepted from browser input.

## Build

Install and build the package from the repository root, then install and build
the demo independently:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm pack --pack-destination examples/demo/.package
cd examples/demo
pnpm install --frozen-lockfile
pnpm build
```

The demo must run behind a public HTTPS origin that routes to the same process.
The engine intentionally rejects loopback HTTP destinations, so a local-only
`localhost` server cannot exercise delivery to its own receiver. Render sets
`RENDER_EXTERNAL_URL` for the service, which the demo uses as its receiver
origin. The root `render.yaml` defines the Render Free web service; creating or
deploying that service is a separate release action.

For localhost development, copy `.env.example` to `.env` and set
`NGROK_AUTHTOKEN` to the token from your ngrok dashboard. The Node SDK is a
demo dependency, so no separate ngrok agent installation is needed. Start both
the tunnel and the demo from `examples/demo`:

```sh
cp .env.example .env
# edit .env and replace the placeholder with your ngrok authtoken
pnpm dev:tunnel
```

The SDK prints the public HTTPS tunnel address and supplies it to the demo as
its receiver origin. Open `http://localhost:3000` in your browser. The app runs
locally, while receiver requests go through the tunnel back to the same
server. Keep the tunnel process running while using the demo. Requests to the
ngrok address are reachable from the internet, so use demo data only.

The regular `pnpm dev` and production server still need
`DEMO_PUBLIC_ORIGIN` set to a public HTTPS origin because the engine rejects
loopback HTTP destinations. For another host, set `DEMO_PUBLIC_ORIGIN` to that
service's public HTTPS origin and `DEMO_HMAC_SECRET` to a unique demo-only
secret before starting the built server:

```sh
DEMO_PUBLIC_ORIGIN=https://demo.example DEMO_HMAC_SECRET=<demo-only-secret> \
  pnpm start
```

The service listens on `PORT` (default `3000`). `/api/health` returns ready
only after the engine migrations have completed and the HTTP server is serving.

## State and safety

This is an educational demo. Do not submit personal, customer, or production
data. The run index is held in memory and SQLite is stored on the service's
local filesystem. On Render Free, the service can sleep after inactivity and
its local files are lost on sleep, restart, or redeploy; the first request
after sleep can take time to wake the service. Demo state is not durable.

The mock receiver accepts only fresh HMAC-signed requests associated with a
known demo run. Responses expose bounded attempt and signature metadata, never
the signing secret or process logs. The engine's HTTPS validation, DNS checks,
connection pinning, TLS identity verification, and redirect rejection remain
enabled for every delivery.
