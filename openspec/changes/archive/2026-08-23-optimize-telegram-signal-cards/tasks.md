## 1. Display Facts

- [x] 1.1 Strictly parse GMGN name and symbol, and expose latest market cap, rank, same-source current gain and persisted activation reason in radar/signal presentation snapshots without new API requests.
- [x] 1.2 Add legacy-snapshot compatibility and fixtures for missing, malicious and maximum-length display fields.

## 2. Telegram Cards

- [x] 2.1 Implement one fused HTML card renderer with prominent SOL/BSC identity, front-loaded full CA, compact market/momentum/risk facts, chain-specific security rows and no internal rule fields.
- [x] 2.2 Extend send/edit transport with HTML, disabled link previews and exactly one deterministic chain-specific GMGN token-page button; preserve the button on status edits.
- [x] 2.3 Implement the compact non-formal radar card and Chinese user-facing status/reason mappings.

## 3. Verification

- [x] 3.1 Add renderer and transport tests for both chains, CA code formatting, GMGN URL identity, HTML escaping, message length, single-button invariant and edit lifecycle.
- [x] 3.2 Run Telegram-disabled previews, full lint/typecheck/test/build, strict OpenSpec validation and a final review focused on signal correctness and maintainability.
