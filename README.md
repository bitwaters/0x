# Low-cap Meme Signal Bot

Single-process SOL/BSC Telegram signal service using only GMGN and CoinGecko
Analyst for market data. Telegram is transport only. The service does not trade.

## Local setup

1. Use Node.js 22 or newer.
2. For a first installation only, create `.env.local` from the production
   template. If `.env.local` already exists, do not copy over it; edit the
   existing file and add only missing fields so configured keys are preserved.

```bash
if [ ! -e .env.local ]; then
  install -m 600 .env.production.example .env.local
fi
```

Replace every `<...>` value and keep `.env.local` at mode `600`.
3. Install and verify:

```bash
npm install
npm run config:check
npm run lint
npm run typecheck
npm test
npm run build
```

Telegram remains disabled until `TELEGRAM_ENABLED=true` and all three distinct
channel IDs plus the bot token are configured.

## Verification and operation

Run the complete local gate and the read-only two-chain provider smoke test:

```bash
npm run check
npm run smoke:live
```

`smoke:live` calls only GMGN and CoinGecko. It prints redacted summaries rather
than provider responses or credentials. The service applies a conservative
shared two-requests-per-second GMGN operating ceiling and honors provider
cooldown timestamps after a 429; lower `GMGN_REST_RPM` if the key has a stricter
contract.

Build once and start the single long-running process:

```bash
npm run build
npm start
```

With Telegram disabled, this is a safe preview mode: discovery, fixed-pool
qualification and message rendering run and persist reproducible evidence, but
no Telegram outbox receipt or evaluation sample is created. Stop with
`SIGINT`/`SIGTERM`; the process drains active work before closing SQLite.

When the private channels are ready, set `TELEGRAM_ENABLED=true` and configure
three distinct chat IDs. New confirmed signals first route to the private
validation channel. Each enabled chain reports `validation_progress` in
structured logs. There is no calendar-day gate: Beta routing is independent
per chain after 5 samples with a valid simulated entry have matured through the
15-minute checkpoint. Unavailable entry samples remain auditable but do not
block later samples.

## Versioned signal policy

- GMGN Top100 internal candidates: `$10K–$300K`.
- Public Bonding radar: `$10K–$100K`, with two consecutive fresh dual-rank
  confirmations or three strictly rising 1m ranks. SOL publishes at current
  1m Top1–5; BSC publishes at Top6–10 while Top1–5 stays internal.
- Real-pool qualification remains internal at `$20K–$300K`, current 1m Top20
  and liquidity of at least `$10K`. Public real-pool radar remains Top1–20 on
  SOL and is Top6–10 on BSC. Pools up to 30 minutes are new opportunities;
  older pools can still qualify internally as revival opportunities, but BSC
  revival radar is not published.
- CoinGecko qualification: two fixed-pool details at least 10 seconds apart;
  the latest 5–10 trades must total at least `$500` with both buy-count and
  buy-USD ratios at least 60%.
- Telegram pre-send check: the same fixed pool is rechecked within one shared
  5-second deadline against the immutable qualification price, allowing a
  closed `-5%` to `+8%` range.

These values are code-versioned so old decision snapshots remain reproducible;
they are intentionally not duplicated as environment overrides.

Radar first-send payloads are stored once in the v7 SQLite schema and are not
overwritten by later lifecycle edits. BSC public-readiness and its internal
Top1–5 pool-open shortcut are separate audited facts; a public Top6–10 card
never grants the shortcut by itself.

The service is intentionally one Node process with one SQLite database. For a
server deployment, use the host's existing service supervisor to run:

```bash
node --dns-result-order=ipv4first --no-network-family-autoselection /absolute/project/path/dist/index.js
```

Run it from the project working directory. These Node flags avoid Telegram
IPv4/IPv6 connection races without adding a proxy or network dependency.
Restart on failure and forward `SIGTERM` for graceful shutdown. Back up the
database file and its WAL/SHM companions together while the service is stopped.
The startup migration may reopen only unsent legacy candidates rejected by the
former pool-age or pre-activation chase rules; `LEGACY_TERMINAL_REOPENED`
records each one-time migration.

## Docker Compose deployment

The production container runs as an unprivileged user, keeps its root filesystem
read-only, rotates Docker logs, and persists only SQLite data under `./data`.

```bash
install -d -m 750 -o 1000 -g 1000 data
chmod 600 .env.local
docker compose config --quiet
docker compose build --pull
docker compose up -d --remove-orphans
docker compose ps
docker compose logs --tail=100 bot
```

Before deployment, stop the service and copy the complete SQLite set to a
timestamped backup location. Deploy source updates only after local checks and
push by using `git pull --ff-only`, then rebuild and restart with the same
Compose commands. Do not edit tracked files on the server.

### Compatible policy rollback

The only supported non-destructive rollback for this change is tag
`rollback-bsc-radar-quality-v7-20260823`, exact commit
`c798b6480d451dae84ade5b9a17a6305f79e496d`. It restores BSC Bonding Top1–5,
real-pool Top1–20 and revival radar while retaining the v7 schema, separate
shortcut/public-readiness facts, policy-driven real-pool readiness writer,
atomic `markRadarSent` and immutable first-send envelope.

Use that exact ref with the current v7 database. Do not deploy an older commit
that still treats public `RADAR` status as the BSC pool-open shortcut; a Top6–10
card created by the current build would then gain an invalid shortcut. Restoring
an old database backup is disaster recovery only and discards signals and
evaluation data accumulated after the backup.
