import type { Strategy } from "./types.ts";
import { Config } from "../../config";

export const comboStrategy: Strategy = async (ctx) => {
  const { ticker } = ctx;

  const state = ticker.marketState;

  ctx.log(`[combo] Market state: ${state} (ATR: ${ticker.atr.toFixed(2)}, Divergence: ${ticker.divergence ?? 0})`, "cyan");

  let result: (() => void) | void;

  switch (state) {
    case "KILLSWITCH":
      ctx.log("[combo] Killswitch active — skipping all trading", "yellow");
      result = () => {};
      break;

    case "OSCILLATING":
      ctx.log("[combo] Oscillating market — running Scalp strategy", "cyan");
      result = await runSubStrategy(ctx, "scalp");
      break;

    case "TRENDING": {
      const hasAI = !!(Config.get().AI_API_KEY);
      if (hasAI) {
        ctx.log("[combo] Trending market with AI — would run AI Decision (not yet implemented), falling back to Scalp", "cyan");
        result = await runSubStrategy(ctx, "scalp");
      } else {
        ctx.log("[combo] Trending market (no AI key) — running Scalp fallback", "cyan");
        result = await runSubStrategy(ctx, "scalp");
      }
      break;
    }

    case "HOT":
      ctx.log("[combo] Hot market — running Late-Entry strategy", "cyan");
      result = await runSubStrategy(ctx, "late-entry");
      break;

    default:
      ctx.log("[combo] Unknown state — running Scalp as default", "cyan");
      result = await runSubStrategy(ctx, "scalp");
      break;
  }

  return result ?? (() => {});
};

async function runSubStrategy(ctx: any, name: string): Promise<(() => void) | void> {
  const mod = await import("./index.ts");
  const strategy = mod.strategies[name];
  if (!strategy) return () => {};
  return await strategy(ctx);
}
