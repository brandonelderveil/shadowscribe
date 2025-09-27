# ShadowScribe

ShadowScribe is an experimental, ephemeral chat service that layers client-side encryption on top of short-lived rooms. Every participant joins with a UUID and a private passphrase that never leaves their browser. Ciphertexts traverse the server; plaintext only exists on the clients that possess the matching passphrase.

> **Security disclaimer:** ShadowScribe is a community driven project, not a production-ready secure messenger. Treat it as a baseline that still needs stronger cryptographic protocols and operational polish before it can carry sensitive material. ALWAYS connect to and use ShadowScribe behind a trusted client VPN and ALWAYS host ShadowScribe behind a reverse proxy.

## Feature Overview

- **Ephemeral rooms** Room state is in-memory only. When the last socket disconnects or 24 hours elapse, the room is invalidated forever.
- **Per-user passphrases** Everyone derives an AES-GCM key from their phrase and salt (PBKDF2-SHA256 w/250k iterations). Others must supply the same phrase to decrypt that user s feed.
- **No historical replay** Clients joining late never receive earlier messages.
- **TLS-first transport** The server refuses to boot without TLS unless you opt into an insecure development mode. If you omit `TLS_CERT_PATH`/`TLS_KEY_PATH`, a self-signed snakeoil cert is minted automatically under `certs/`.
- **Self-contained stack** Vanilla HTML/CSS/JS front-end, Node.js + `ws` broker. No database, no external services.

## Quick Start

1. Install dependencies:
   ```bash
   npm install
   ```
2. Provide TLS material (serves the static bundle and hosts the WebSocket broker):
   ```bash
   export TLS_CERT_PATH=certs/server.crt
   export TLS_KEY_PATH=certs/server.key
   npm start
   ```
   You can also set `TLS_CA_PATH` (colon/semicolon separated) if you need to present an intermediate chain.
   If you skip `TLS_CERT_PATH`/`TLS_KEY_PATH`, the server will mint a self-signed dev certificate in `certs/` on first start.
3. Browse to `https://localhost:3000` (accept the self-signed cert if prompted).
4. Generate a room UUID, pick a passphrase (long and unique!), and share both over a trusted channel with your peers.

For quick local experiments you can bypass TLS with `ALLOW_INSECURE=true npm start`, but never deploy that configuration to users it falls back to plain HTTP/WS.

## HTTPS / TLS Configuration

- `TLS_CERT_PATH`: Path to the PEM-encoded certificate file.
- `TLS_KEY_PATH`: Path to the PEM-encoded private key.
- `TLS_CA_PATH` (optional): Delimiter-separated list of CA / intermediate bundle files.
- `ALLOW_INSECURE`: Set to `true` to force HTTP/WS for local development.
- Auto-generated development certs live in `certs/` and regenerate if missing.

When TLS is enabled the server emits HSTS, CSP, and other security headers. Clients served over plain HTTP are rejected unless they originate from `localhost`.

## Security Model (Current)

- **Confidentiality** is provided per user through AES-GCM. Losing your passphrase compromises all of your messages in that room.
- **Integrity** relies on AES-GCM auth tags; tampering corrupts messages but there is no explicit signature or identity validation.
- **Availability** is best-effort. Any participant can flood the room; there is no rate limiting or PoW.
- **Forward secrecy** is absent; phrases reuse the same derived key throughout a room session.
- **Metadata** (room IDs, UUIDs, timing) is visible to the server. TLS only protects data in transit from passive observers.

## Known Attack Vectors & Pitfalls

- **Weak passphrases** PBKDF2 makes brute force slower but not impossible; short or reused phrases collapse security.
- **Compromised host** Root access to the server or reverse proxy allows JS injection, traffic logging, or key theft.
- **Endpoint compromise** Malicious extensions, keyloggers, or XSS can steal passphrases and plaintext.
- **Timing & traffic analysis** Adversaries observing both ends of your VPN/Tor circuit can correlate packet timing to deanonymize.
- **Replay/flooding** The broker forwards whatever it receives; no anti-replay counters or rate limits exist.
- **Stylometry/PII leakage** Even with strong crypto, messages themselves can betray identity.
- **MITM of TLS** Accepting forged certificates or running with `ALLOW_INSECURE` lets an attacker intercept phrases.

## Hardening Ideas for Hosts

- Run behind a hardened reverse proxy with strict TLS configs (modern cipher suites, ALPN enforcement, HTTP/2 disabled if unnecessary).
- Terminate TLS with real certificates (ACME/Let s Encrypt) and pin fingerprints at the proxy; keep auto-generated dev certs strictly local.
- Deploy on minimal OS images, apply updates, enable SELinux/AppArmor, and run the Node process under a constrained user.
- Isolate the broker (containers/VMs), add seccomp profiles, and restrict outbound network egress.
- Store secrets (TLS keys, future room metadata) in a dedicated vault or HSM; avoid flat files on disk.
- Monitor and log securely: tamper-evident append-only logs, remote syslog, and intrusion detection tuned to alert on bundle changes.
- Add DoS protections (rate limiting, SYN cookies, reverse proxy shields) to prevent resource exhaustion.
- Consider trusted execution (TPM-backed sealing, SGX/SEV) if you aim to protect against host compromise.

## Hardening Ideas for Clients

- Use strong, unique passphrases. Prefer randomly generated secrets over memorable phrases.
- Run the app in hardened browsers (Firefox with resistFingerprinting, Brave with Fingerprinting Protections, Tor Browser).
- Disable WebRTC or force it through the VPN/Tor tunnel to prevent real-IP leakage.
- Keep systems patched, enable full-disk encryption, and avoid installing untrusted extensions.
- Use hardware security modules or password managers to store passphrases safely.
- Consider dedicated clients (Electron, native apps) that can sandbox key material away from general browsing.
- Layer additional anonymity: reputable VPN + Tor, or multi-hop proxies you control.

## Future Enhancements (toward the mythical 100/100 )

- Stronger key exchange: X3DH with Double Ratchet for forward secrecy and post-compromise security.
- Post-quantum hybrid encryption (e.g., Kyber + X25519) for long-term confidentiality.
- Message authentication with per-user signatures and optional transparency logs.
- Pairwise secure channels so a compromised phrase only exposes conversations with consenting peers.
- Rate limiting, PoW, and replay protection inside the broker.
- Signed/reproducible builds and SRI hashes for all static assets.
- Automated dependency auditing, SBOMs, and continuous vulnerability scanning.
- Independent security audits and penetration tests.

## Limitations & Reality Check

ShadowScribe intentionally avoids persistence and heavy infrastructure, but that also limits resilience. This codebase should be viewed as a foundation: it demonstrates client-side crypto, room lifecycle, and secure-by-default transport, yet it lacks the rigorous engineering, extensive threat modeling, and operational discipline needed to withstand nation-state adversaries.

If you adopt or extend it:

- assume hosts and clients can be compromised, plan for remediation,
- educate users about endpoint hygiene and metadata hygiene,
- and schedule formal audits before moving sensitive conversations onto it.

Stay paranoid, patch often, and treat passphrases like the keys to the kingdom.
