import { readFileSync } from "fs";
import { join } from "path";
import { Config } from "../config";

interface RoundResult {
  slug: string;
  pnl: number;
  buys: number;
  sells: number;
  strategyName: string;
}

interface DailyStats {
  date: string;
  totalRounds: number;
  wonRounds: number;
  lostRounds: number;
  winRate: number;
  sessionPnl: number;
  totalBuys: number;
  totalSells: number;
  totalInvested: number;
  totalReturned: number;
  avgEntryPrice: number;
  avgExitPrice: number;
  partialFills: number;
  failedOrders: number;
  emergencySells: number;
  bestRound: { slug: string; pnl: number };
  worstRound: { slug: string; pnl: number };
  maxDrawdown: number;
  top5: RoundResult[];
  bottom3: RoundResult[];
  aiCalls: number;
  aiBuys: number;
  aiWaits: number;
  aiAvgConfidence: number;
  runtimeMinutes: number;
  rounds: RoundResult[];
}

export class DailyReporter {
  static aggregate(dateStr: string): DailyStats {
    const state = DailyReporter.loadState();
    const rounds: RoundResult[] = [];

    let partialFills = 0;
    let failedOrders = 0;
    let emergencySells = 0;

    for (const market of state.completedMarkets ?? []) {
      let buys = 0, sells = 0;
      for (const order of market.orderHistory ?? []) {
        if (order.action === "buy") buys++;
        else sells++;
      }
      rounds.push({
        slug: market.slug,
        pnl: market.pnl,
        buys,
        sells,
        strategyName: market.strategyName,
      });

      for (const order of market.orderHistory ?? []) {
        if (order.status === "partially_filled") partialFills++;
        if (order.status === "failed") failedOrders++;
      }
    }

    const won = rounds.filter(r => r.pnl > 0);
    const lost = rounds.filter(r => r.pnl < 0);
    const totalPnl = parseFloat(rounds.reduce((s, r) => s + r.pnl, 0).toFixed(4));
    const best = rounds.reduce((max, r) => r.pnl > max.pnl ? r : max,
      { slug: "N/A", pnl: -Infinity, buys: 0, sells: 0, strategyName: "" });
    const worst = rounds.reduce((min, r) => r.pnl < min.pnl ? r : min,
      { slug: "N/A", pnl: Infinity, buys: 0, sells: 0, strategyName: "" });

    const sorted = [...rounds].sort((a, b) => b.pnl - a.pnl);
    const top5 = sorted.filter(r => r.pnl > 0).slice(0, 5);
    const bottom3 = sorted.filter(r => r.pnl < 0).sort((a, b) => a.pnl - b.pnl).slice(0, 3);

    let peak = 0, maxDD = 0, running = 0;
    for (const r of rounds) {
      running += r.pnl;
      if (running > peak) peak = running;
      const dd = peak - running;
      if (dd > maxDD) maxDD = dd;
    }

    let totalBought = 0, totalSold = 0, boughtCount = 0, soldCount = 0;
    let sumEntryPrice = 0, sumExitPrice = 0;
    for (const market of state.completedMarkets ?? []) {
      for (const order of market.orderHistory ?? []) {
        if (order.action === "buy") {
          totalBought += order.price * order.shares;
          boughtCount++;
          sumEntryPrice += order.price;
        } else {
          totalSold += order.price * order.shares;
          soldCount++;
          sumExitPrice += order.price;
        }
      }
    }

    const now = new Date();
    const start = new Date(state.startedAt ?? now);
    const runtimeMinutes = Math.round((now.getTime() - start.getTime()) / 60000);

    return {
      date: dateStr,
      totalRounds: rounds.length,
      wonRounds: won.length,
      lostRounds: lost.length,
      winRate: rounds.length > 0 ? won.length / rounds.length : 0,
      sessionPnl: totalPnl,
      totalBuys: boughtCount,
      totalSells: soldCount,
      totalInvested: parseFloat(totalBought.toFixed(2)),
      totalReturned: parseFloat(totalSold.toFixed(2)),
      avgEntryPrice: boughtCount > 0 ? parseFloat((sumEntryPrice / boughtCount).toFixed(2)) : 0,
      avgExitPrice: soldCount > 0 ? parseFloat((sumExitPrice / soldCount).toFixed(2)) : 0,
      partialFills,
      failedOrders,
      emergencySells,
      bestRound: best,
      worstRound: worst,
      maxDrawdown: parseFloat(maxDD.toFixed(4)),
      top5,
      bottom3,
      aiCalls: state.aiCalls ?? 0,
      aiBuys: state.aiBuys ?? 0,
      aiWaits: state.aiWaits ?? 0,
      aiAvgConfidence: state.aiAvgConfidence ?? 0,
      runtimeMinutes,
      rounds,
    };
  }

  static loadState(): any {
    try {
      const path = join("state", "polyagent.json");
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return { completedMarkets: [], startedAt: new Date().toISOString() };
    }
  }

  static getYesterday(): string {
    const tz = Config.get().NOTION_DAILY_SUMMARY_TZ;
    const now = new Date();
    const local = new Date(now.toLocaleString("en-US", { timeZone: tz }));
    local.setDate(local.getDate() - 1);
    return local.toISOString().split("T")[0]!;
  }

  static render(stats: DailyStats): string {
    const cfg = Config.get();
    const lines: string[] = [];

    const padR = (label: string, value: string) =>
      `   ${label.padEnd(16)} ${value}`;

    const sign = (n: number) => n >= 0 ? "+" : "";
    const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

    lines.push("───────────────────────────");
    lines.push(`Polyagent Daily Report`);
    lines.push(`${stats.date} | Strategy: ${cfg.STRATEGY} | Asset: ${cfg.MARKET_ASSET.toUpperCase()}/USD | Window: ${cfg.MARKET_WINDOW}`);
    lines.push("───────────────────────────");
    lines.push("");

    lines.push("📊 [ACCOUNT]");
    lines.push(padR("Balance:", `$${stats.totalInvested.toFixed(2)}`));
    lines.push(padR("Mode:", cfg.PROD ? "live" : "simulation"));
    lines.push(padR("Session PnL:", `${sign(stats.sessionPnl)}$${stats.sessionPnl.toFixed(2)}`));
    lines.push(padR("Max Drawdown:", `-$${stats.maxDrawdown.toFixed(2)}`));
    lines.push(padR("Runtime:", `${Math.floor(stats.runtimeMinutes / 60)}h ${stats.runtimeMinutes % 60}m`));
    lines.push("");

    lines.push("🔄 [FLOW]");
    lines.push(padR("Markets Activated:", String(stats.totalRounds)));
    lines.push(padR("Opportunities Found:", String(stats.totalBuys + stats.totalSells)));
    lines.push(padR("Trades Executed:", String(stats.totalBuys + stats.totalSells)));
    lines.push(padR("Win Rate:", `${pct(stats.winRate)}  (${stats.wonRounds}W / ${stats.lostRounds}L)`));
    lines.push(padR("Avg Entry Price:", `$${stats.avgEntryPrice.toFixed(2)}`));
    lines.push(padR("Avg Exit Price:", `$${stats.avgExitPrice.toFixed(2)}`));
    lines.push("");

    lines.push("📦 [TRADING]");
    lines.push(padR("Total Invested:", `$${stats.totalInvested.toFixed(2)}`));
    lines.push(padR("Total Returned:", `$${stats.totalReturned.toFixed(2)}`));
    const avgProfit = stats.totalSells > 0
      ? (stats.sessionPnl / stats.totalSells)
      : 0;
    lines.push(padR("Avg Profit/Trade:", `${sign(avgProfit)}$${Math.abs(avgProfit).toFixed(3)}`));
    lines.push(padR("Best Trade:", `${sign(stats.bestRound.pnl)}$${Math.abs(stats.bestRound.pnl).toFixed(2)}  (${stats.bestRound.slug})`));
    lines.push(padR("Worst Trade:", `${sign(stats.worstRound.pnl)}$${Math.abs(stats.worstRound.pnl).toFixed(2)}  (${stats.worstRound.slug})`));
    lines.push("");

    lines.push("⚠️  [RISK]");
    lines.push(padR("Partial Fills:", String(stats.partialFills)));
    lines.push(padR("Failed Orders:", String(stats.failedOrders)));
    lines.push(padR("Emergency Sells:", String(stats.emergencySells)));
    lines.push(padR("Killswitch:", "0"));
    lines.push(padR("Max Session Loss:", `-$${cfg.MAX_SESSION_LOSS.toFixed(2)} (limit)`));
    lines.push("");

    lines.push("🤖 [AI]");
    lines.push(padR("Model:", cfg.AI_MODEL));
    lines.push(padR("AI Calls:", String(stats.aiCalls)));
    lines.push(padR("Decisions:", `BUY=${stats.aiBuys} | WAIT=${stats.aiWaits} | Avg Confidence: ${(stats.aiAvgConfidence * 100).toFixed(0)}%`));
    lines.push("");

    lines.push("📈 [TOP 5 PROFITABLE]");
    for (let i = 0; i < stats.top5.length; i++) {
      const r = stats.top5[i]!;
      lines.push(`   ${i + 1}. ${sign(r.pnl)}$${Math.abs(r.pnl).toFixed(2)}  ${r.slug}`);
    }
    const remainingW = stats.wonRounds - stats.top5.length;
    if (remainingW > 0) lines.push(`   … and ${remainingW} other winning markets`);
    lines.push("");

    lines.push("💸 [TOP 3 LOSERS]");
    for (let i = 0; i < stats.bottom3.length; i++) {
      const r = stats.bottom3[i]!;
      lines.push(`   ${i + 1}. ${sign(r.pnl)}$${Math.abs(r.pnl).toFixed(2)}  ${r.slug}`);
    }
    const remainingL = stats.lostRounds - stats.bottom3.length;
    if (remainingL > 0) lines.push(`   … and ${remainingL} other losing markets`);

    return lines.join("\n");
  }
}
