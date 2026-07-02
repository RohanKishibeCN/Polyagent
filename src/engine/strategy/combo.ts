import type { Strategy, StrategyContext } from "./types.ts";
import { Config } from "../../config";

/**
 * Combo strategy routes all non-KILLSWITCH market states to Late-Entry.
 *
 * Why only Late-Entry?
 * Binary prediction markets resolve to $0 or $1 — not a continuous price range.
 * Scalp (buy low, sell high within a window) is fundamentally incompatible
 * with 5-minute binary markets because:
 *   - It buys BOTH UP and DOWN in the same window, guaranteeing losses
 *   - The winning side's price may never reach a limit take-profit before expiry
 *   - The losing side collapses to ~$0.001 at resolution
 *
 * Late-Entry waits until T-90s, picks ONE direction based on price action
 * signals (gap, divergence, RSI, liquidity), and enters only when confidence
 * is high. This is the only viable approach for 5-min binary markets.
 */
export const comboStrategy: Strategy = async (ctx) => {
  const { ticker } = ctx;

  const state = ticker.marketState;

  ctx.log(`[combo] Market state: ${state} (ATR: ${ticker.atr.toFixed(2)}, Divergence: ${ticker.divergence ?? 0})`, "cyan");

  if (state === "KILLSWITCH") {
    ctx.log("[combo] Killswitch active — skipping all trading", "yellow");
    return () => {};
  }

  ctx.log("[combo] Running Late-Entry strategy", "cyan");
  const result = await runSubStrategy(ctx, "late-entry");
  return result ?? (() => {});
};

async function runSubStrategy(ctx: StrategyContext, name: string): Promise<(() => void) | void> {
  const mod = await import("./index.ts");
  const strategy = mod.strategies[name];
  if (!strategy) return () => {};
  return await strategy(ctx);
}
