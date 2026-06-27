import { describe, it, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import sinon, { type SinonFakeTimers, type SinonStub } from "sinon";
import { Polyagent } from "../src/engine/polyagent.ts";
import type { PersistentState } from "../src/engine/state.ts";
import {
  MockAPIQueue,
  FIXTURE_SLUG,
  UP_TOKEN,
  DOWN_TOKEN,
  CONDITION_ID,
} from "./helpers/mock-api-queue.ts";
import { SimTickerTracker } from "./helpers/sim-ticker.ts";
import { ModuleMocker } from "../helpers/mock-module.ts";

// ─── Module mocks ─────────────────────────────────────────────────────────────

const stateStore: { load: PersistentState | null } = { load: null };

const mocker = new ModuleMocker();

await mocker.mock("../src/engine/state.ts", () => ({
  loadState: (_path: string) => stateStore.load,
  saveState: () => {},
}));

await mocker.mock("../src/engine/strategy/index.ts", () => ({
  strategies: { "test-strategy": async () => {} },
  DEFAULT_STRATEGY: "test-strategy",
}));

await mocker.mock("../src/tracker/orderbook.ts", () => ({
  OrderBook: class {
    subscribe() {}
    destroy() {}
    async waitForReady() {}
    bestAskInfo() { return null; }
    bestBidInfo() { return null; }
    bestBidPrice() { return null; }
    getSnapshotData() { return null; }
    getTickSize() { return "0.01"; }
    getFeeRate() { return 1000; }
    getTokenId(_: "UP" | "DOWN") { return ""; }
  },
}));

before(() => {
  process.env.SIM_DELAY_MS = "0";
  process.env.WALLET_BALANCE = "50000";
  process.env.ORDERBOOK_WS_URL = "ws://127.0.0.1:1";
  process.env.MARKET_ASSET = "btc";
});

after(() => {
  delete process.env.SIM_DELAY_MS;
  delete process.env.WALLET_BALANCE;
  delete process.env.ORDERBOOK_WS_URL;
  delete process.env.MARKET_ASSET;
  mocker.clear();
});

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * T_BASE: fake clock anchor.
 *   getSlug(1) at T_BASE = "btc-updown-5m-1777108200" (FIXTURE_SLUG)
 *   getSlug(2) at T_BASE = "btc-updown-5m-1777108500" (NEXT_SLOT_SLUG)
 *
 * FIXTURE_SLUG's slot ends at ~April 2026. Only use it in fake-timer tests
 * where Date.now() is pinned to T_BASE.
 *
 * FUTURE_SLOT_SLUG ends in April 2027, safely past today's real wall-clock
 * date — used in recovery tests that evaluate slotActive with real Date.now().
 */
const T_BASE = 1777107950000;
const NEXT_SLOT_SLUG = "btc-updown-5m-1777108500";

// 1808643900 = BASE_TIMESTAMP + 120250 × 300 (a valid 5-min slot)
const FUTURE_SLOT_SLUG = "btc-updown-5m-1808643900";
const FUTURE_SLOT_END_MS = (1808643900 + 300) * 1000;

const TEST_TIMEOUT = 10_000;

// ─── Harness ──────────────────────────────────────────────────────────────────

type Harness = {
  agent: Polyagent;
  clock: SinonFakeTimers;
  exitStub: SinonStub;
  teardown: () => void;
};

type HarnessOpts = {
  rounds?: number | null;
  slotOffset?: number;
  maxSessionLoss?: number;
  apiQueue?: MockAPIQueue;
};

function makeHarness(opts: HarnessOpts = {}): Harness {
  if (opts.maxSessionLoss !== undefined) {
    process.env.MAX_SESSION_LOSS = String(opts.maxSessionLoss);
  }

  const clock = sinon.useFakeTimers({
    now: T_BASE,
    toFake: [
      "Date",
      "setTimeout",
      "setInterval",
      "clearTimeout",
      "clearInterval",
      "performance",
    ],
    shouldClearNativeTimers: true,
  });

  const exitStub = sinon.stub(process, "exit");

  const agent = new Polyagent(
    "test-strategy",
    opts.slotOffset ?? 1,
    /*prod=*/ false,
    opts.rounds !== undefined ? opts.rounds : null,
  );

  (agent as any)._ticker = new SimTickerTracker();
  (agent as any)._apiQueue = opts.apiQueue ?? new MockAPIQueue();

  return {
    agent,
    clock,
    exitStub,
    teardown() {
      stateStore.load = null;
      clock.restore();
      try {
        exitStub.restore();
      } catch {}
      delete process.env.MAX_SESSION_LOSS;
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Polyagent — rounds", () => {
  let h: Harness;

  afterEach(() => h.teardown());

  it(
    "rounds=1: creates exactly 1 lifecycle then shuts down",
    async () => {
      h = makeHarness({ rounds: 1 });
      await h.agent.start();

      (h.agent as any)._tick();

      assert.strictEqual((h.agent as any)._lifecycles.has(FIXTURE_SLUG), true);
      assert.strictEqual((h.agent as any)._roundsCreated, 1);

      const lc = (h.agent as any)._lifecycles.get(FIXTURE_SLUG)!;
      (lc as any)._state = "DONE";

      (h.agent as any)._tick();

      assert.strictEqual((h.agent as any)._shuttingDown, true);
      assert.strictEqual(h.exitStub.calledWith(0), true);
    },
    TEST_TIMEOUT,
  );

  it(
    "rounds=2: creates exactly 2 lifecycles across a slot boundary then shuts down",
    async () => {
      h = makeHarness({ rounds: 2 });
      await h.agent.start();

      // Tick 1 at T_BASE → lc1 (FIXTURE_SLUG)
      (h.agent as any)._tick();

      assert.strictEqual((h.agent as any)._roundsCreated, 1);
      assert.strictEqual((h.agent as any)._lifecycles.has(FIXTURE_SLUG), true);

      // Force lc1 done; tick processes it (getSlug(1) still = FIXTURE_SLUG → no new lc)
      ((h.agent as any)._lifecycles.get(FIXTURE_SLUG) as any)._state = "DONE";
      (h.agent as any)._tick();

      assert.strictEqual((h.agent as any)._completedSlugs.has(FIXTURE_SLUG), true);
      assert.strictEqual((h.agent as any)._lifecycles.size, 0);

      // Jump past slot boundary → getSlug(1) = NEXT_SLOT_SLUG
      h.clock.setSystemTime(T_BASE + 250_100);

      // Tick 3 → lc2 (NEXT_SLOT_SLUG)
      (h.agent as any)._tick();

      assert.strictEqual((h.agent as any)._lifecycles.has(NEXT_SLOT_SLUG), true);
      assert.strictEqual((h.agent as any)._roundsCreated, 2);

      // Force lc2 done; tick: rounds exhausted + no lifecycles → shutdown → exit(0)
      ((h.agent as any)._lifecycles.get(NEXT_SLOT_SLUG) as any)._state = "DONE";
      (h.agent as any)._tick();

      assert.strictEqual((h.agent as any)._shuttingDown, true);
      assert.strictEqual(h.exitStub.calledWith(0), true);
    },
    TEST_TIMEOUT,
  );
});

describe("Polyagent — slotOffset", () => {
  let h: Harness;

  afterEach(() => h.teardown());

  it(
    "slotOffset=1: lifecycle slug matches getSlug(1) at T_BASE",
    async () => {
      h = makeHarness({ slotOffset: 1 });
      await h.agent.start();

      (h.agent as any)._tick();

      assert.strictEqual((h.agent as any)._lifecycles.has(FIXTURE_SLUG), true);
    },
    TEST_TIMEOUT,
  );

  it(
    "slotOffset=2: lifecycle slug matches getSlug(2) at T_BASE, not getSlug(1)",
    async () => {
      h = makeHarness({ slotOffset: 2 });
      await h.agent.start();

      (h.agent as any)._tick();

      assert.strictEqual((h.agent as any)._lifecycles.has(NEXT_SLOT_SLUG), true);
      assert.strictEqual((h.agent as any)._lifecycles.has(FIXTURE_SLUG), false);
    },
    TEST_TIMEOUT,
  );
});

describe("Polyagent — multiple concurrent lifecycles", () => {
  let h: Harness;

  afterEach(() => h.teardown());

  it(
    "advancing past a slot boundary creates a second lifecycle while the first is still running",
    async () => {
      h = makeHarness({ rounds: null });
      await h.agent.start();

      // Tick at T_BASE: lc1 (FIXTURE_SLUG) created; leave it running
      (h.agent as any)._tick();

      assert.strictEqual((h.agent as any)._lifecycles.size, 1);
      assert.strictEqual((h.agent as any)._lifecycles.has(FIXTURE_SLUG), true);

      // Jump past slot boundary → getSlug(1) = NEXT_SLOT_SLUG
      h.clock.setSystemTime(T_BASE + 250_100);

      // Tick: lc2 (NEXT_SLOT_SLUG) created while lc1 still running
      (h.agent as any)._tick();

      assert.strictEqual((h.agent as any)._lifecycles.size, 2);
      assert.strictEqual((h.agent as any)._lifecycles.has(FIXTURE_SLUG), true);
      assert.strictEqual((h.agent as any)._lifecycles.has(NEXT_SLOT_SLUG), true);
    },
    TEST_TIMEOUT,
  );
});

describe("Polyagent — session loss shutdown", () => {
  let h: Harness;

  afterEach(() => h.teardown());

  it(
    "completing a lifecycle with loss >= MAX_SESSION_LOSS triggers shutdown",
    async () => {
      h = makeHarness({ rounds: null, maxSessionLoss: 1 });
      await h.agent.start();

      (h.agent as any)._tick();

      const lc = (h.agent as any)._lifecycles.get(FIXTURE_SLUG)!;
      (lc as any)._state = "DONE";
      (lc as any)._pnl = -2.0;

      (h.agent as any)._tick();

      assert.strictEqual((h.agent as any)._shuttingDown, true);
      assert.strictEqual(h.exitStub.calledWith(0), true);
    },
    TEST_TIMEOUT,
  );

  it(
    "loss below MAX_SESSION_LOSS does not trigger shutdown",
    async () => {
      h = makeHarness({ rounds: null, maxSessionLoss: 5 });
      await h.agent.start();

      (h.agent as any)._tick();

      const lc = (h.agent as any)._lifecycles.get(FIXTURE_SLUG)!;
      (lc as any)._state = "DONE";
      (lc as any)._pnl = -1.0;

      (h.agent as any)._tick();

      assert.strictEqual((h.agent as any)._shuttingDown, false);
      assert.strictEqual(h.exitStub.called, false);
    },
    TEST_TIMEOUT,
  );
});

describe("Polyagent — recovery", () => {
  afterEach(() => {
    stateStore.load = null;
  });

  it(
    "state with pending sell order: recovered lifecycle is STOPPING",
    async () => {
      // Inject in-memory state — no files written
      stateStore.load = {
        sessionPnl: 0,
        sessionLoss: 0,
        activeMarkets: [
          {
            slug: FUTURE_SLOT_SLUG,
            state: "STOPPING",
            strategyName: "test-strategy",
            conditionId: CONDITION_ID,
            clobTokenIds: [UP_TOKEN, DOWN_TOKEN],
            pendingOrders: [
              {
                orderId: "order-recovery-1",
                tokenId: UP_TOKEN,
                action: "sell",
                price: 0.6,
                shares: 5,
                expireAtMs: FUTURE_SLOT_END_MS,
                placedAtMs: Date.now(),
              },
            ],
            orderHistory: [],
          },
        ],
        completedMarkets: [],
      };

      const agent = new Polyagent("test-strategy", 1, false, null);
      (agent as any)._ticker = new SimTickerTracker();
      (agent as any)._apiQueue = new MockAPIQueue();

      const exitStub = sinon.stub(process, "exit");
      try {
        await agent.start();

        assert.strictEqual((agent as any)._lifecycles.has(FUTURE_SLOT_SLUG), true);
        assert.strictEqual((agent as any)._lifecycles.get(FUTURE_SLOT_SLUG)!.state, "STOPPING");
      } finally {
        exitStub.restore();
      }
    },
    TEST_TIMEOUT,
  );

  it(
    "state with expired slot: stale market is NOT recovered",
    async () => {
      // btc-updown-5m-100 ends at (100 + 300) * 1000 = 400_000 ms — well in the past
      stateStore.load = {
        sessionPnl: 0,
        sessionLoss: 0,
        activeMarkets: [
          {
            slug: "btc-updown-5m-100",
            state: "STOPPING",
            strategyName: "test-strategy",
            conditionId: CONDITION_ID,
            clobTokenIds: [UP_TOKEN, DOWN_TOKEN],
            pendingOrders: [
              {
                orderId: "order-expired-1",
                tokenId: UP_TOKEN,
                action: "sell",
                price: 0.6,
                shares: 5,
                expireAtMs: 400_000,
                placedAtMs: 100_000,
              },
            ],
            orderHistory: [],
          },
        ],
        completedMarkets: [],
      };

      const agent = new Polyagent("test-strategy", 1, false, null);
      (agent as any)._ticker = new SimTickerTracker();
      (agent as any)._apiQueue = new MockAPIQueue();

      const exitStub = sinon.stub(process, "exit");
      try {
        await agent.start();

        assert.strictEqual((agent as any)._lifecycles.has("btc-updown-5m-100"), false);
      } finally {
        exitStub.restore();
      }
    },
    TEST_TIMEOUT,
  );
});
