import WebSocket, { type RawData } from 'ws';

import type { Chain } from '../config.js';
import { normalizeAddress } from '../domain/address.js';
import { COINGECKO_NETWORK } from './coingecko.js';
import { numberValue, recordValue, stringValue } from './contracts.js';
import {
  COINGECKO_REALTIME_CHANNEL,
  coinGeckoRealtimeUrl
} from './sourcePolicy.js';

const CHANNEL_IDENTIFIER = JSON.stringify({ channel: 'OnchainTrade' });

export interface G2SocketLike {
  readonly readyState: number;
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: RawData) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'error', listener: () => void): this;
  send(data: string): void;
  close(code?: number): void;
}

export type G2SocketFactory = (
  url: string,
  headers: Readonly<Record<string, string>>
) => G2SocketLike;

const defaultSocketFactory: G2SocketFactory = (url, headers) =>
  new WebSocket(url, { headers });

interface RefreshState {
  dirty: boolean;
  running: boolean;
  lastStartedAtMs: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class PoolRefreshCoordinator {
  private readonly states = new Map<string, RefreshState>();
  private stopped = false;

  constructor(
    private readonly refresh: (chain: Chain, poolAddress: string) => Promise<void>,
    private readonly minimumIntervalMs = 1_000,
    private readonly now: () => number = Date.now,
    private readonly onError: (error: unknown) => void = () => undefined
  ) {}

  start(): void {
    this.stopped = false;
  }

  stop(): void {
    this.stopped = true;
    for (const state of this.states.values()) {
      state.dirty = false;
      if (state.timer !== undefined) clearTimeout(state.timer);
    }
    this.states.clear();
  }

  markDirty(chain: Chain, poolAddress: string): void {
    if (this.stopped) return;
    const normalizedPool = normalizeAddress(chain, poolAddress);
    const key = `${chain}:${normalizedPool}`;
    const state = this.states.get(key) ?? {
      dirty: false,
      running: false,
      lastStartedAtMs: 0,
      timer: undefined
    };
    state.dirty = true;
    this.states.set(key, state);
    this.schedule(key, chain, normalizedPool, state);
  }

  release(chain: Chain, poolAddress: string): void {
    const key = `${chain}:${normalizeAddress(chain, poolAddress)}`;
    const state = this.states.get(key);
    if (state !== undefined) {
      state.dirty = false;
      if (state.timer !== undefined) clearTimeout(state.timer);
      state.timer = undefined;
    }
    this.states.delete(key);
  }

  private schedule(
    key: string,
    chain: Chain,
    poolAddress: string,
    state: RefreshState
  ): void {
    if (this.stopped) return;
    if (this.states.get(key) !== state) return;
    if (state.running || state.timer !== undefined || !state.dirty) return;
    const waitMs = Math.max(0, state.lastStartedAtMs + this.minimumIntervalMs - this.now());
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (this.stopped) return;
      if (this.states.get(key) !== state) return;
      if (!state.dirty || state.running) return;
      state.dirty = false;
      state.running = true;
      state.lastStartedAtMs = this.now();
      void this.refresh(chain, poolAddress)
        .catch(this.onError)
        .finally(() => {
          state.running = false;
          if (this.states.get(key) === state) {
            this.schedule(key, chain, poolAddress, state);
          }
        });
    }, waitMs);
  }
}

export class G2ChainSocket {
  private readonly pools = new Set<string>();
  private socket: G2SocketLike | undefined;
  private channelConfirmed = false;
  private stopped = true;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly chain: Chain,
    private readonly apiKey: string,
    private readonly coordinator: PoolRefreshCoordinator,
    private readonly socketFactory: G2SocketFactory = defaultSocketFactory
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  subscribe(poolAddress: string): void {
    const pool = normalizeAddress(this.chain, poolAddress);
    if (!this.pools.has(pool) && this.pools.size >= 100) {
      throw new Error(`G2 ${this.chain} subscription limit reached`);
    }
    if (this.pools.has(pool)) return;
    this.pools.add(pool);
    if (this.channelConfirmed) this.setPools('set_pools', [pool]);
  }

  release(poolAddress: string): void {
    const pool = normalizeAddress(this.chain, poolAddress);
    if (!this.pools.delete(pool)) return;
    if (this.channelConfirmed) this.setPools('unset_pools', [pool]);
    this.coordinator.release(this.chain, pool);
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.channelConfirmed) {
      this.socket?.send(
        JSON.stringify({ command: 'unsubscribe', identifier: CHANNEL_IDENTIFIER })
      );
    }
    this.socket?.close(1000);
    this.socket = undefined;
    this.channelConfirmed = false;
  }

  get subscriptionCount(): number {
    return this.pools.size;
  }

  get atHighWatermark(): boolean {
    return this.pools.size >= 90;
  }

  private connect(): void {
    if (this.stopped || this.socket !== undefined) return;
    const socket = this.socketFactory(coinGeckoRealtimeUrl(), {
      'x-cg-pro-api-key': this.apiKey
    });
    this.socket = socket;
    socket.on('open', () => {
      if (this.socket !== socket || this.stopped) return;
      socket.send(
        JSON.stringify({ command: 'subscribe', identifier: CHANNEL_IDENTIFIER })
      );
    });
    socket.on('message', (data) => this.handleMessage(socket, data));
    socket.on('error', () => socket.close());
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.channelConfirmed = false;
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private handleMessage(socket: G2SocketLike, data: RawData): void {
    if (socket !== this.socket || this.stopped) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString()) as unknown;
    } catch {
      return;
    }
    try {
      const message = recordValue('coingecko', 'g2', 'message', parsed);
      if (message.type === 'confirm_subscription' && message.identifier === CHANNEL_IDENTIFIER) {
        this.channelConfirmed = true;
        this.reconnectAttempt = 0;
        if (this.pools.size > 0) {
          this.setPools('set_pools', [...this.pools]);
          for (const pool of this.pools) this.coordinator.markDirty(this.chain, pool);
        }
        return;
      }
      if (message.c !== COINGECKO_REALTIME_CHANNEL) return;
      const network = stringValue('coingecko', 'g2', 'message.n', message.n);
      if (network !== COINGECKO_NETWORK[this.chain]) return;
      const pool = normalizeAddress(
        this.chain,
        stringValue('coingecko', 'g2', 'message.pa', message.pa)
      );
      if (!this.pools.has(pool)) return;
      numberValue('coingecko', 'g2', 'message.t', message.t, {
        integer: true,
        positive: true
      });
      this.coordinator.markDirty(this.chain, pool);
    } catch {
      // G2 is trigger-only; malformed events cannot become decision facts.
    }
  }

  private setPools(action: 'set_pools' | 'unset_pools', pools: readonly string[]): void {
    const entries = pools.map((pool) => `${COINGECKO_NETWORK[this.chain]}:${pool}`);
    this.socket?.send(
      JSON.stringify({
        command: 'message',
        identifier: CHANNEL_IDENTIFIER,
        data: JSON.stringify({ 'network_id:pool_addresses': entries, action })
      })
    );
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined || this.stopped) return;
    const delay = Math.min(30_000, 500 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }
}

export class G2SocketManager {
  readonly sol: G2ChainSocket;
  readonly bsc: G2ChainSocket;

  constructor(
    apiKey: string,
    private readonly coordinator: PoolRefreshCoordinator,
    socketFactory?: G2SocketFactory
  ) {
    this.sol = new G2ChainSocket('sol', apiKey, coordinator, socketFactory);
    this.bsc = new G2ChainSocket('bsc', apiKey, coordinator, socketFactory);
  }

  start(): void {
    this.coordinator.start();
    this.sol.start();
    this.bsc.start();
  }

  stop(): void {
    this.sol.stop();
    this.bsc.stop();
    this.coordinator.stop();
  }

  forChain(chain: Chain): G2ChainSocket {
    return chain === 'sol' ? this.sol : this.bsc;
  }
}
