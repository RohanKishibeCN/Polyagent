import type { Strategy } from "./types.ts";
import { Config } from "../../config";

export const scalpStrategy: Strategy = async (ctx) => {
  const releaseLock = ctx.hold();
  const cfg = Config.get();

  const timers: NodeJS.Timeout[] = [];
  let tradesThisWindow = 0;
  let consecutiveLosses = 0;
  let active = true;

  const upTokenId = ctx.clobTokenIds[0];
  const downTokenId = ctx.clobTokenIds[1];

  type Position = { entryPrice: number; shares: number; tokenId: string };
  const positions: Position[] = [];

  const marketOpenMs = ctx.slotEndMs - 300_000;
  const msUntilOpen = marketOpenMs - Date.now();

  if (msUntilOpen > 0) {
    timers.push(setTimeout(() => {
      ctx.log("[scalp] Market window open — starting scalp loop", "cyan");
    }, msUntilOpen));
  }

  const tpDelta = cfg.SCALP_TP_PCT;
  const slDelta = cfg.SCALP_SL_PCT;
  const maxPerWindow = cfg.SCALP_MAX_PER_WINDOW;
  const maxConsecLoss = cfg.SCALP_MAX_CONSEC_LOSS;
  const minRemainingSec = cfg.SCALP_MIN_REMAINING_SEC;
  const spreadMax = cfg.SCALP_SPREAD_MAX;
  const entryMin = cfg.SCALP_ENTRY_MIN;
  const entryMax = cfg.SCALP_ENTRY_MAX;

  function exitAllPositions(reason: string): void {
    const pendingSellIds = ctx.pendingOrders
      .filter((o) => o.action === "sell")
      .map((o) => o.orderId);
    if (pendingSellIds.length > 0) {
      ctx.log(`[scalp] ${reason}`, "red");
      ctx.emergencySells(pendingSellIds);
      positions.length = 0;
    }
  }

  function calcPositionSize(price: number): number {
    const balance = ctx.walletAvailable;
    if (balance <= 0) return 1;

    const rawAtr = ctx.ticker.atr;
    const volRatio = rawAtr > 0
      ? Math.min(1.5, Math.max(0.2, rawAtr / 3.0))
      : 0.2;

    const riskUSD = balance * cfg.POSITION_PCT * volRatio;
    const cappedUSD = Math.min(riskUSD, cfg.MAX_POSITION_USD);
    const shares = Math.floor(cappedUSD / price);

    return Math.max(1, shares);
  }

  function tryScalp(): void {
    if (!active) return;

    // ── Monitor existing positions for stop-loss ─────────────────────────────
    if (positions.length > 0) {
      const bestBidUp = ctx.orderBook.bestBidInfo("UP")?.price;
      const bestBidDown = ctx.orderBook.bestBidInfo("DOWN")?.price;

      for (const pos of positions) {
        const bid = pos.tokenId === upTokenId ? bestBidUp : bestBidDown;
        if (bid != null && bid < pos.entryPrice - slDelta) {
          exitAllPositions(
            `Stop-loss: bid ${bid.toFixed(3)} < entry ${pos.entryPrice.toFixed(2)} - ${slDelta.toFixed(2)}`,
          );
          return;
        }
      }
    }

    if (tradesThisWindow >= maxPerWindow) return;
    if (consecutiveLosses >= maxConsecLoss) {
      ctx.log("[scalp] Consecutive loss limit reached — stopping for this window", "yellow");
      return;
    }

    const remainingSec = Math.max(0, (ctx.slotEndMs - Date.now()) / 1000);
    if (remainingSec < minRemainingSec) return;

    if (ctx.ticker.marketState === "KILLSWITCH") return;

    const bestAskUp = ctx.orderBook.bestAskInfo("UP");
    const bestBidUp = ctx.orderBook.bestBidInfo("UP");
    const bestAskDown = ctx.orderBook.bestAskInfo("DOWN");
    const bestBidDown = ctx.orderBook.bestBidInfo("DOWN");

    if (!bestAskUp || !bestBidUp || !bestAskDown || !bestBidDown) return;

    const spreadUp = bestAskUp.price - bestBidUp.price;
    const spreadDown = bestAskDown.price - bestBidDown.price;

    let side: "UP" | "DOWN";
    let tokenId: string;
    let entryPrice: number;

    const upInRange = bestAskUp.price >= entryMin && bestAskUp.price <= entryMax && spreadUp <= spreadMax;
    const downInRange = bestAskDown.price >= entryMin && bestAskDown.price <= entryMax && spreadDown <= spreadMax;

    if (!upInRange && !downInRange) return;

    if (upInRange && downInRange) {
      // Both sides in range — pick at random to avoid UP bias
      side = Math.random() < 0.5 ? "UP" : "DOWN";
    } else if (upInRange) {
      side = "UP";
    } else {
      side = "DOWN";
    }

    tokenId = side === "UP" ? upTokenId : downTokenId;
    entryPrice = side === "UP" ? bestAskUp.price : bestAskDown.price;

    const shares = calcPositionSize(entryPrice);
    tradesThisWindow++;

    ctx.log(`[scalp] #${tradesThisWindow} BUY ${side} @ ${entryPrice} (${shares} shares, ATR: ${ctx.ticker.atr.toFixed(2)})`, "cyan");

    ctx.postOrders([{
      req: {
        tokenId,
        action: "buy",
        price: entryPrice,
        shares,
        orderType: "GTC",
      },
      expireAtMs: ctx.slotEndMs - 30_000,

      onFilled(filledShares) {
        positions.push({ entryPrice, shares: filledShares, tokenId });

        const tpPrice = parseFloat((entryPrice + tpDelta).toFixed(2));
        const exitExpireMs = ctx.slotEndMs - 30_000;

        ctx.log(`[scalp] #${tradesThisWindow} BUY filled ${filledShares} shares — TP @ ${tpPrice}`, "green");

        ctx.postOrders([{
          req: {
            tokenId,
            action: "sell",
            price: tpPrice,
            shares: filledShares,
            orderType: "GTC",
          },
          expireAtMs: exitExpireMs,
          onFilled() {
            ctx.log(`[scalp] #${tradesThisWindow} TP hit @ ${tpPrice}`, "green");
            consecutiveLosses = 0;
          },
          onExpired() {
            ctx.log(`[scalp] #${tradesThisWindow} TP expired — emergency exit`, "yellow");
            exitAllPositions("TP expired, exiting all positions");
          },
          onFailed(reason) {
            ctx.log(`[scalp] #${tradesThisWindow} TP sell failed: ${reason}`, "red");
            consecutiveLosses++;
          },
        }]);
      },

      onExpired() {
        ctx.log(`[scalp] #${tradesThisWindow} BUY expired without fill`, "yellow");
      },

      onFailed(reason) {
        ctx.log(`[scalp] #${tradesThisWindow} BUY failed: ${reason}`, "red");
      },
    }]);
  }

  const pollInterval = setInterval(() => tryScalp(), 500);
  timers.push(pollInterval);

  return () => {
    active = false;
    for (const t of timers) clearTimeout(t);
    releaseLock();
  };
};