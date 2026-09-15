# TurboFlux Desktop Remote Control

Browser PWA for controlling an authorized TurboFlux Desktop runtime. Run development commands at the repository root.

```bash
npm install
npm run dev:remote
```

Deploy the static `apps/remote-mobile/dist` directory through trusted HTTPS. The PWA does not require a TurboFlux account or a hosted API. It connects to the endpoint embedded in the one-time pairing invite and keeps the device private key in IndexedDB.

Plain HTTP is accepted only for loopback debugging (`localhost`, `127.0.0.0/8`, or `::1`). A phone browser must use a trusted HTTPS endpoint because Web Crypto, camera access, and service workers require a secure context.

The PWA encrypts its saved connection and device private keys with a non-extractable AES-GCM key stored by the same browser origin. This protects against an offline IndexedDB dump; script running in the origin can still request decryption. Revoked or expired grants are cleared locally and require an explicit new desktop pairing; the PWA never silently creates a replacement identity.

The Desktop can generate a directly openable URL when a Web control page is configured. The one-time pairing code is carried in the URL fragment (`#pair=...`), parsed locally, and removed from browser history before pairing. The fragment is not sent in the HTTP request for the static page.

Only one browser page controls a Desktop at a time. A second page shows an explicit takeover screen; takeover replaces the old page's short control lease without expanding its device capabilities or workspace allowlist.
