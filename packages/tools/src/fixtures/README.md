# Local TLS test fixtures

`web-test-cert.pem` and `web-test-key.pem` are a self-signed certificate and its test-only key for `rebind.test`. They authenticate an HTTPS server bound to loopback in `webResearchService.test.ts`; requests never reach a public server. These files are public fixtures, not deployment credentials.

The certificate expires on September 13, 2036. Replace the certificate and matching key together when renewing the fixture.
