# Model proxy

The existing local model proxy and admin page, extracted from Agent Core as a leaf application. No runtime package depends on it.

Build workspace packages first, then run `npm run build:proxy` at the workspace root. Start with `npm start --workspace @turboflux/model-proxy`; development uses `npm run dev --workspace @turboflux/model-proxy`. The existing TURBOFLUX_SERVER_CONFIG setting and proxy API remain unchanged.
