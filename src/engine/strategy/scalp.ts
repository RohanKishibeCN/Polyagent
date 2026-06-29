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

  function calcPositionSize(): number {
    const rawAtr = ctx.ticker.atr || 3;
    const atr = rawAtr < 0.1 ? 0.1 : rawAtr;
    const volMultiplier = atr / 3.0;
    const safeMultiplier = Math.max(0.5, Math.min(2.0, 1 / volMultiplier));
    const size = cfg.MAX_POSITION_USD * safeMultiplier * 0.20;
    return Math.max(1, Math.round(size));
  }

  function tryScalp(): void {
    if (!active) return;
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

    if (bestAskUp.price >= entryMin && bestAskUp.price <= entryMax && spreadUp <= spreadMax) {
      side = "UP";
      tokenId = upTokenId;
      entryPrice = bestAskUp.price;
    } else if (bestAskDown.price >= entryMin && bestAskDown.price <= entryMax && spreadDown <= spreadMax) {
      side = "DOWN";
      tokenId = downTokenId;
      entryPrice = bestAskDown.price;
    } else {
      return;
    }

    const shares = calcPositionSize();
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
        const tpPrice = parseFloat((entryPrice + tpDelta).toFixed(2));
        const slPrice = parseFloat((entryPrice - slDelta).toFixed(2));
        const exitExpireMs = ctx.slotEndMs - 30_000;

        ctx.log(`[scalp] #${tradesThisWindow} BUY filled ${filledShares} shares — placing TP @ ${tpPrice}, SL @ ${slPrice}`, "green");

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
            ctx.log(`[scalp] #${tradesThisWindow} TP order expired — emergency selling`, "yellow");
            const pendingSellIds = ctx.pendingOrders
              .filter((o) => o.action === "sell")
              .map((o) => o.orderId);
            if (pendingSellIds.length > 0) {
              ctx.emergencySells(pendingSellIds);
            }
          },
          onFailed(reason) {
            ctx.log(`[scalp] #${tradesThisWindow} sell failed: ${reason}`, "red");
            consecutiveLosses++;
          },
        }]);

        const msUntilEmergency = ctx.slotEndMs - 30_000 - Date.now();
        if (msUntilEmergency > 0) {
          timers.push(setTimeout(() => {
            const pendingSellIds = ctx.pendingOrders
              .filter((o) => o.action === "sell")
              .map((o) => o.orderId);
            if (pendingSellIds.length > 0) {
              ctx.log("[scalp] Emergency exit triggered", "red");
              ctx.emergencySells(pendingSellIds);
            }
          }, msUntilEmergency));
        }
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