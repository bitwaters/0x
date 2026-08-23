export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_state',
    sql: `
      CREATE TABLE rule_versions (
        version TEXT PRIMARY KEY,
        config_json TEXT NOT NULL CHECK (json_valid(config_json)),
        created_at_ms INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE candidates (
        chain TEXT NOT NULL CHECK (chain IN ('sol', 'bsc')),
        token_address TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'DISCOVERED', 'RADAR', 'PREHEAT', 'POOL_BOUND', 'MONITORING',
          'SIGNAL_SENT', 'REJECTED', 'EXPIRED'
        )),
        first_seen_at_ms INTEGER NOT NULL,
        first_seen_price_usd REAL NOT NULL CHECK (first_seen_price_usd > 0),
        high_price_usd REAL NOT NULL CHECK (high_price_usd > 0),
        sampled_max_gain REAL NOT NULL DEFAULT 0,
        first_seen_rank INTEGER NOT NULL CHECK (first_seen_rank > 0),
        first_seen_market_cap_usd REAL NOT NULL CHECK (first_seen_market_cap_usd >= 0),
        first_seen_liquidity_usd REAL CHECK (
          first_seen_liquidity_usd IS NULL OR first_seen_liquidity_usd >= 0
        ),
        discovery_rule_version TEXT NOT NULL REFERENCES rule_versions(version),
        decision_rule_version TEXT REFERENCES rule_versions(version),
        qualification_started_at_ms INTEGER,
        terminal_reason TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (chain, token_address)
      ) STRICT;

      CREATE TABLE rank_snapshots (
        id INTEGER PRIMARY KEY,
        chain TEXT NOT NULL CHECK (chain IN ('sol', 'bsc')),
        interval TEXT NOT NULL CHECK (interval IN ('1m', '5m')),
        fetched_at_ms INTEGER NOT NULL,
        token_address TEXT NOT NULL,
        rank INTEGER NOT NULL CHECK (rank > 0),
        price_usd REAL NOT NULL CHECK (price_usd > 0),
        market_cap_usd REAL NOT NULL CHECK (market_cap_usd >= 0),
        liquidity_usd REAL CHECK (liquidity_usd IS NULL OR liquidity_usd >= 0),
        raw_json TEXT NOT NULL CHECK (json_valid(raw_json)),
        UNIQUE (chain, interval, fetched_at_ms, token_address)
      ) STRICT;

      CREATE INDEX rank_snapshots_candidate_time
        ON rank_snapshots(chain, token_address, fetched_at_ms DESC);

      CREATE TABLE pool_bindings (
        chain TEXT NOT NULL,
        token_address TEXT NOT NULL,
        pool_address TEXT NOT NULL,
        candidate_side TEXT NOT NULL CHECK (candidate_side IN ('base', 'quote')),
        counter_token_address TEXT NOT NULL,
        bound_at_ms INTEGER NOT NULL,
        invalidated_at_ms INTEGER,
        invalidation_reason TEXT,
        PRIMARY KEY (chain, token_address),
        FOREIGN KEY (chain, token_address)
          REFERENCES candidates(chain, token_address) ON DELETE RESTRICT
      ) STRICT;

      CREATE TABLE qualification_events (
        id INTEGER PRIMARY KEY,
        chain TEXT NOT NULL,
        token_address TEXT NOT NULL,
        stage TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('PASS', 'WAIT', 'REJECT', 'ERROR')),
        reason_code TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('gmgn', 'coingecko', 'system')),
        observed_at_ms INTEGER NOT NULL,
        raw_json TEXT NOT NULL CHECK (json_valid(raw_json)),
        normalized_json TEXT NOT NULL CHECK (json_valid(normalized_json)),
        thresholds_json TEXT NOT NULL CHECK (json_valid(thresholds_json)),
        decision_rule_version TEXT NOT NULL REFERENCES rule_versions(version),
        FOREIGN KEY (chain, token_address)
          REFERENCES candidates(chain, token_address) ON DELETE RESTRICT
      ) STRICT;

      CREATE INDEX qualification_events_candidate_time
        ON qualification_events(chain, token_address, observed_at_ms DESC);

      CREATE TABLE message_outbox (
        id INTEGER PRIMARY KEY,
        chain TEXT NOT NULL,
        token_address TEXT NOT NULL,
        message_kind TEXT NOT NULL CHECK (message_kind IN ('radar', 'signal')),
        channel_role TEXT NOT NULL CHECK (channel_role IN ('radar', 'validation', 'formal')),
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'UNCERTAIN')),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        send_requested_at_ms INTEGER,
        receipt_at_ms INTEGER,
        telegram_message_id TEXT,
        last_error TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE (chain, token_address, message_kind),
        FOREIGN KEY (chain, token_address)
          REFERENCES candidates(chain, token_address) ON DELETE RESTRICT
      ) STRICT;

      CREATE TABLE evaluation_points (
        id INTEGER PRIMARY KEY,
        chain TEXT NOT NULL,
        token_address TEXT NOT NULL,
        horizon_seconds INTEGER NOT NULL CHECK (horizon_seconds >= 0),
        scheduled_at_ms INTEGER NOT NULL,
        observed_at_ms INTEGER,
        status TEXT NOT NULL CHECK (status IN (
          'PENDING', 'COMPLETE', 'PROVIDER_MISSING', 'TERMINAL_NEGATIVE', 'AMBIGUOUS'
        )),
        price_usd REAL CHECK (price_usd IS NULL OR price_usd > 0),
        details_json TEXT NOT NULL CHECK (json_valid(details_json)),
        UNIQUE (chain, token_address, horizon_seconds),
        FOREIGN KEY (chain, token_address)
          REFERENCES candidates(chain, token_address) ON DELETE RESTRICT
      ) STRICT;
    `
  },
  {
    version: 2,
    name: 'successful_rank_fetches',
    sql: `
      CREATE TABLE rank_snapshot_fetches (
        chain TEXT NOT NULL CHECK (chain IN ('sol', 'bsc')),
        interval TEXT NOT NULL CHECK (interval IN ('1m', '5m')),
        fetched_at_ms INTEGER NOT NULL,
        item_count INTEGER NOT NULL CHECK (item_count BETWEEN 0 AND 100),
        items_json TEXT NOT NULL CHECK (json_valid(items_json)),
        discovery_rule_version TEXT NOT NULL REFERENCES rule_versions(version),
        PRIMARY KEY (chain, interval, fetched_at_ms)
      ) STRICT;

      CREATE INDEX rank_snapshot_fetches_latest
        ON rank_snapshot_fetches(chain, interval, fetched_at_ms DESC);
    `
  },
  {
    version: 3,
    name: 'compact_rank_fetches',
    sql: `
      DROP INDEX rank_snapshot_fetches_latest;
      ALTER TABLE rank_snapshot_fetches RENAME TO rank_snapshot_fetches_v2;

      CREATE TABLE rank_snapshot_fetches (
        chain TEXT NOT NULL CHECK (chain IN ('sol', 'bsc')),
        interval TEXT NOT NULL CHECK (interval IN ('1m', '5m')),
        fetched_at_ms INTEGER NOT NULL,
        item_count INTEGER NOT NULL CHECK (item_count BETWEEN 0 AND 100),
        discovery_rule_version TEXT NOT NULL REFERENCES rule_versions(version),
        PRIMARY KEY (chain, interval, fetched_at_ms)
      ) STRICT;

      INSERT INTO rank_snapshot_fetches(
        chain, interval, fetched_at_ms, item_count, discovery_rule_version
      )
      SELECT chain, interval, fetched_at_ms, item_count, discovery_rule_version
      FROM rank_snapshot_fetches_v2;

      DROP TABLE rank_snapshot_fetches_v2;
      CREATE INDEX rank_snapshot_fetches_latest
        ON rank_snapshot_fetches(chain, interval, fetched_at_ms DESC);
    `
  },
  {
    version: 4,
    name: 'signal_delivery_followups',
    sql: `
      CREATE TABLE signal_followups (
        chain TEXT NOT NULL CHECK (chain IN ('sol', 'bsc')),
        token_address TEXT NOT NULL,
        outbox_id INTEGER NOT NULL UNIQUE REFERENCES message_outbox(id) ON DELETE RESTRICT,
        pre_send_price_usd REAL NOT NULL CHECK (pre_send_price_usd > 0),
        pre_send_trade_at_ms INTEGER NOT NULL,
        receipt_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        desired_state TEXT NOT NULL CHECK (desired_state IN (
          'ACTIVE', 'DONT_CHASE', 'EXPIRED', 'INVALID'
        )),
        applied_state TEXT NOT NULL CHECK (applied_state IN (
          'ACTIVE', 'DONT_CHASE', 'EXPIRED', 'INVALID'
        )),
        desired_reason TEXT,
        snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
        edit_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (edit_attempt_count >= 0),
        last_edit_error TEXT,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (chain, token_address),
        FOREIGN KEY (chain, token_address)
          REFERENCES candidates(chain, token_address) ON DELETE RESTRICT
      ) STRICT;

      CREATE TABLE signal_rechecks (
        chain TEXT NOT NULL,
        token_address TEXT NOT NULL,
        checkpoint_seconds INTEGER NOT NULL CHECK (checkpoint_seconds IN (30, 60)),
        due_at_ms INTEGER NOT NULL,
        next_attempt_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'RETRY', 'COMPLETE')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 2),
        last_error TEXT,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (chain, token_address, checkpoint_seconds),
        FOREIGN KEY (chain, token_address)
          REFERENCES signal_followups(chain, token_address) ON DELETE RESTRICT
      ) STRICT;

      CREATE INDEX signal_rechecks_due
        ON signal_rechecks(status, next_attempt_at_ms);
    `
  },
  {
    version: 5,
    name: 'signal_evaluation_and_chain_release',
    sql: `
      CREATE TABLE chain_release_state (
        chain TEXT PRIMARY KEY CHECK (chain IN ('sol', 'bsc')),
        state TEXT NOT NULL CHECK (state IN ('VALIDATING', 'BETA', 'SUSPENDED')),
        validation_epoch INTEGER NOT NULL CHECK (validation_epoch > 0),
        next_validation_seq INTEGER NOT NULL CHECK (next_validation_seq > 0),
        suspension_reason TEXT,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;

      INSERT INTO chain_release_state(
        chain, state, validation_epoch, next_validation_seq, updated_at_ms
      ) VALUES
        ('sol', 'VALIDATING', 1, 1, 0),
        ('bsc', 'VALIDATING', 1, 1, 0);

      CREATE TABLE delivered_signal_samples (
        id INTEGER PRIMARY KEY,
        outbox_id INTEGER NOT NULL UNIQUE REFERENCES message_outbox(id) ON DELETE RESTRICT,
        chain TEXT NOT NULL CHECK (chain IN ('sol', 'bsc')),
        token_address TEXT NOT NULL,
        delivery_stage TEXT NOT NULL CHECK (delivery_stage IN ('validation', 'formal')),
        receipt_at_ms INTEGER NOT NULL,
        pre_send_price_usd REAL NOT NULL CHECK (pre_send_price_usd > 0),
        pre_send_trade_at_ms INTEGER NOT NULL,
        entry_status TEXT NOT NULL CHECK (entry_status IN (
          'PENDING', 'COMPLETE', 'PROVIDER_MISSING', 'TERMINAL_NEGATIVE',
          'ENTRY_UNAVAILABLE'
        )),
        entry_price_usd REAL CHECK (entry_price_usd IS NULL OR entry_price_usd > 0),
        entry_trade_at_ms INTEGER,
        discovery_rule_version TEXT NOT NULL REFERENCES rule_versions(version),
        decision_rule_version TEXT NOT NULL REFERENCES rule_versions(version),
        validation_epoch INTEGER,
        validation_seq INTEGER,
        sell_trade_observed INTEGER NOT NULL DEFAULT 0 CHECK (sell_trade_observed IN (0, 1)),
        first_sell_trade_at_ms INTEGER,
        snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        CHECK (
          (delivery_stage = 'validation' AND validation_epoch IS NOT NULL AND validation_seq IS NOT NULL)
          OR (delivery_stage = 'formal' AND validation_epoch IS NULL AND validation_seq IS NULL)
        ),
        UNIQUE (chain, validation_epoch, validation_seq),
        FOREIGN KEY (chain, token_address)
          REFERENCES candidates(chain, token_address) ON DELETE RESTRICT
      ) STRICT;

      CREATE TABLE signal_evaluation_points (
        id INTEGER PRIMARY KEY,
        sample_id INTEGER NOT NULL REFERENCES delivered_signal_samples(id) ON DELETE RESTRICT,
        horizon_seconds INTEGER NOT NULL CHECK (
          horizon_seconds IN (10, 30, 60, 90, 300, 900, 3600, 14400, 86400)
        ),
        scheduled_at_ms INTEGER NOT NULL,
        next_attempt_at_ms INTEGER NOT NULL,
        observed_at_ms INTEGER,
        status TEXT NOT NULL CHECK (status IN (
          'PENDING', 'COMPLETE', 'PROVIDER_MISSING', 'TERMINAL_NEGATIVE',
          'ENTRY_UNAVAILABLE', 'AMBIGUOUS'
        )),
        price_usd REAL CHECK (price_usd IS NULL OR price_usd > 0),
        gross_return REAL,
        mfe REAL,
        mae REAL,
        path_30_15 TEXT CHECK (path_30_15 IN (
          'NONE', 'UP_FIRST', 'DOWN_FIRST', 'AMBIGUOUS'
        )),
        path_2x_30 TEXT CHECK (path_2x_30 IN (
          'NONE', 'UP_FIRST', 'DOWN_FIRST', 'AMBIGUOUS'
        )),
        source TEXT CHECK (source IN ('TRADES', 'OHLCV')),
        granularity TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 1),
        details_json TEXT NOT NULL CHECK (json_valid(details_json)),
        updated_at_ms INTEGER NOT NULL,
        UNIQUE (sample_id, horizon_seconds)
      ) STRICT;

      CREATE INDEX signal_evaluation_points_due
        ON signal_evaluation_points(status, next_attempt_at_ms);

      CREATE TABLE evaluation_reports (
        chain TEXT NOT NULL CHECK (chain IN ('sol', 'bsc')),
        kind TEXT NOT NULL CHECK (kind IN ('MILESTONE', 'PARAMETER_REVIEW')),
        boundary_count INTEGER NOT NULL CHECK (boundary_count > 0),
        generated_at_ms INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
        PRIMARY KEY (chain, kind, boundary_count)
      ) STRICT;
    `
  },
  {
    version: 6,
    name: 'optimized_low_cap_signal_rules',
    sql: `
      ALTER TABLE candidates ADD COLUMN opportunity_type TEXT
        CHECK (opportunity_type IS NULL OR opportunity_type IN ('new_pool', 'revival'));
      ALTER TABLE candidates ADD COLUMN activation_at_ms INTEGER;
      ALTER TABLE candidates ADD COLUMN activation_price_usd REAL
        CHECK (activation_price_usd IS NULL OR activation_price_usd > 0);
      ALTER TABLE candidates ADD COLUMN activation_high_price_usd REAL
        CHECK (activation_high_price_usd IS NULL OR activation_high_price_usd > 0);
      ALTER TABLE candidates ADD COLUMN activation_sampled_max_gain REAL;
      ALTER TABLE candidates ADD COLUMN activation_rule_version TEXT
        REFERENCES rule_versions(version);
      ALTER TABLE candidates ADD COLUMN legacy_reopened_at_ms INTEGER;

      ALTER TABLE pool_bindings ADD COLUMN qualification_reference_price_usd REAL
        CHECK (qualification_reference_price_usd IS NULL OR qualification_reference_price_usd > 0);
      ALTER TABLE pool_bindings ADD COLUMN qualification_reference_at_ms INTEGER;

      ALTER TABLE message_outbox ADD COLUMN applied_payload_hash TEXT;

      ALTER TABLE evaluation_reports RENAME TO evaluation_reports_legacy;
      CREATE TABLE evaluation_reports (
        chain TEXT NOT NULL CHECK (chain IN ('sol', 'bsc')),
        decision_rule_version TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('MILESTONE', 'PARAMETER_REVIEW')),
        boundary_count INTEGER NOT NULL CHECK (boundary_count > 0),
        generated_at_ms INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
        PRIMARY KEY (chain, decision_rule_version, kind, boundary_count)
      ) STRICT;
      INSERT INTO evaluation_reports(
        chain, decision_rule_version, kind, boundary_count, generated_at_ms, snapshot_json
      ) SELECT chain, 'legacy-mixed', kind, boundary_count, generated_at_ms, snapshot_json
        FROM evaluation_reports_legacy;
      DROP TABLE evaluation_reports_legacy;
    `
  },
  {
    version: 7,
    name: 'immutable_radar_initial_payload',
    sql: `
      ALTER TABLE message_outbox ADD COLUMN initial_payload_json TEXT
        CHECK(initial_payload_json IS NULL OR json_valid(initial_payload_json));

      INSERT INTO qualification_events(
        chain, token_address, stage, outcome, reason_code, source,
        observed_at_ms, raw_json, normalized_json, thresholds_json,
        decision_rule_version
      )
      SELECT e.chain, e.token_address,
             'bonding_shortcut_readiness', 'PASS',
             'BONDING_POOL_OPEN_SHORTCUT_READY', e.source,
             e.observed_at_ms, e.raw_json, e.normalized_json, e.thresholds_json,
             e.decision_rule_version
      FROM qualification_events e
      JOIN candidates c
        ON c.chain = e.chain AND c.token_address = e.token_address
      WHERE c.chain = 'bsc' AND c.status = 'RADAR'
        AND e.stage = 'activation'
        AND substr(e.reason_code, -14) = '_BONDING_CURVE'
        AND e.id = (
          SELECT e2.id
          FROM qualification_events e2
          WHERE e2.chain = e.chain AND e2.token_address = e.token_address
            AND e2.stage = 'activation'
            AND substr(e2.reason_code, -14) = '_BONDING_CURVE'
          ORDER BY e2.observed_at_ms, e2.id
          LIMIT 1
        )
        AND NOT EXISTS (
          SELECT 1
          FROM qualification_events x
          WHERE x.chain = e.chain AND x.token_address = e.token_address
            AND x.stage = 'bonding_shortcut_readiness'
            AND x.reason_code = 'BONDING_POOL_OPEN_SHORTCUT_READY'
      );
    `
  },
  {
    version: 8,
    name: 'sol_bonding_shortcut_bridge',
    sql: `
      INSERT INTO qualification_events(
        chain, token_address, stage, outcome, reason_code, source,
        observed_at_ms, raw_json, normalized_json, thresholds_json,
        decision_rule_version
      )
      SELECT e.chain, e.token_address,
             'bonding_shortcut_readiness', 'PASS',
             'BONDING_POOL_OPEN_SHORTCUT_READY', e.source,
             e.observed_at_ms, e.raw_json, e.normalized_json, e.thresholds_json,
             e.decision_rule_version
      FROM qualification_events e
      JOIN candidates c
        ON c.chain = e.chain AND c.token_address = e.token_address
      WHERE c.chain = 'sol' AND c.status = 'RADAR'
        AND c.activation_at_ms IS NULL
        AND e.stage = 'activation'
        AND substr(e.reason_code, -14) = '_BONDING_CURVE'
        AND (c.legacy_reopened_at_ms IS NULL
          OR e.observed_at_ms > c.legacy_reopened_at_ms)
        AND e.id = (
          SELECT e2.id
          FROM qualification_events e2
          WHERE e2.chain = e.chain AND e2.token_address = e.token_address
            AND e2.stage = 'activation'
            AND substr(e2.reason_code, -14) = '_BONDING_CURVE'
            AND (c.legacy_reopened_at_ms IS NULL
              OR e2.observed_at_ms > c.legacy_reopened_at_ms)
          ORDER BY e2.observed_at_ms, e2.id
          LIMIT 1
        )
        AND NOT EXISTS (
          SELECT 1
          FROM qualification_events x
          WHERE x.chain = e.chain AND x.token_address = e.token_address
            AND x.stage = 'bonding_shortcut_readiness'
            AND x.reason_code = 'BONDING_POOL_OPEN_SHORTCUT_READY'
            AND (c.legacy_reopened_at_ms IS NULL
              OR x.observed_at_ms > c.legacy_reopened_at_ms)
        );
    `
  }
] as const;
