import type { Strategy } from "./types.ts";
import { simulationStrategy } from "./simulation.ts";
import { lateEntry } from "./late-entry.ts";
import { scalpStrategy } from "./scalp.ts";

export const comboStrategy: Strategy = async (ctx) => {
  const releaseLock = ctx.hold();
  const { ticker } = ctx;

  const state = ticker.marketState;

  ctx.log(`[combo] Market state: ${state} (ATR: ${ticker.atr.toFixed(2)}, Divergence: ${ticker.divergence ?? 0})`, "cyan");

  switch (state) {
    case "KILLSWITCH":
      ctx.log("[combo] Killswitch active — skipping all trading", "yellow");
      return () => releaseLock();

    case "OSCILLATING":
      ctx.log("[combo] Oscillating market — running Scalp strategy", "cyan");
      return await scalpStrategy(ctx);

    case "TRENDING": {
      const hasAI = !!(process.env.AI_API_KEY);
      if (hasAI) {
        ctx.log("[combo] Trending market with AI — would run AI Decision (not yet implemented), falling back to Scalp", "cyan");
        return await scalpStrategy(ctx);
      }
      ctx.log("[combo] Trending market (no AI key) — running Scalp fallback", "cyan");
      return await scalpStrategy(ctx);
    }

    case "HOT":
      ctx.log("[combo] Hot market — running Late-Entry strategy", "cyan");
      return await lateEntry(ctx);

    default:
      ctx.log("[combo] Unknown state — running Scalp as default", "cyan");
      return await scalpStrategy(ctx);
  }
};