import { Config } from "../config";
import { DailyReporter } from "./reporter";
import { NotionClient } from "./client";

export class NotionScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private enabled: boolean;

  constructor() {
    const apiKey = Config.get().NOTION_API_KEY;
    const dbId = Config.get().NOTION_DATABASE_ID;
    this.enabled = !!(apiKey && dbId);
  }

  start() {
    if (!this.enabled) {
      console.log("[notion] NOTION_API_KEY or NOTION_DATABASE_ID not set. Skipping.");
      return;
    }
    this.scheduleNext();
    console.log("[notion] Daily summary scheduler started.");
  }

  private scheduleNext() {
    const delay = this.calcMsUntilNextRun();
    console.log(`[notion] Next report in ~${Math.round(delay / 60000)}min`);
    this.timer = setTimeout(() => this.execute(), delay);
  }

  private calcMsUntilNextRun(): number {
    const [h, m] = Config.get().NOTION_DAILY_SUMMARY_TIME.split(":").map(Number) as [number, number];
    const tz = Config.get().NOTION_DAILY_SUMMARY_TZ;
    const now = new Date();
    const local = new Date(now.toLocaleString("en-US", { timeZone: tz }));
    const target = new Date(local);
    target.setHours(h, m, 0, 0);
    if (target <= local) target.setDate(target.getDate() + 1);
    return target.getTime() - local.getTime();
  }

  async execute() {
    try {
      const date = DailyReporter.getYesterday();
      const stats = DailyReporter.aggregate(date);
      const summary = DailyReporter.render(stats);

      const client = new NotionClient(
        Config.get().NOTION_API_KEY,
        Config.get().NOTION_DATABASE_ID,
      );
      const pageId = await client.createDailyPage(date, summary);
      console.log(`[notion] Report sent → page ${pageId}  (${stats.totalRounds} rounds, PnL: $${stats.sessionPnl})`);
    } catch (err) {
      console.error(`[notion] Failed: ${err}`);
    } finally {
      this.scheduleNext();
    }
  }

  stop() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
}
