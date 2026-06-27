import "dotenv/config";
import { ConfigSchema, type Config } from "./schema";

class ConfigManager {
  private static _instance: Config | null = null;

  static get(): Config {
    if (!this._instance) {
      const result = ConfigSchema.safeParse(process.env);
      if (!result.success) {
        console.error("Invalid configuration:");
        for (const issue of result.error.issues) {
          console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
        }
        process.exit(1);
      }
      this._instance = result.data;
    }
    return this._instance;
  }

  static getAssetConfig() {
    const cfg = this.get();
    const map: Record<string, {
      slugPrefix: string;
      binanceStream: string;
      coinbaseProduct: string;
      polymarketSymbol: string;
      apiSymbol: string;
      okxInstId: string;
      bybitSymbol: string;
    }> = {
      btc: { slugPrefix: "btc", binanceStream: "btcusdt", coinbaseProduct: "BTC-USD",
        polymarketSymbol: "btc/usd", apiSymbol: "BTC", okxInstId: "BTC-USD",
        bybitSymbol: "BTCUSDT" },
      eth: { slugPrefix: "eth", binanceStream: "ethusdt", coinbaseProduct: "ETH-USD",
        polymarketSymbol: "eth/usd", apiSymbol: "ETH", okxInstId: "ETH-USD",
        bybitSymbol: "ETHUSDT" },
      xrp: { slugPrefix: "xrp", binanceStream: "xrpusdt", coinbaseProduct: "XRP-USD",
        polymarketSymbol: "xrp/usd", apiSymbol: "XRP", okxInstId: "XRP-USD",
        bybitSymbol: "XRPUSDT" },
      sol: { slugPrefix: "sol", binanceStream: "solusdt", coinbaseProduct: "SOL-USD",
        polymarketSymbol: "sol/usd", apiSymbol: "SOL", okxInstId: "SOL-USD",
        bybitSymbol: "SOLUSDT" },
      doge: { slugPrefix: "doge", binanceStream: "dogeusdt", coinbaseProduct: "DOGE-USD",
        polymarketSymbol: "doge/usd", apiSymbol: "DOGE", okxInstId: "DOGE-USD",
        bybitSymbol: "DOGEUSDT" },
      hype: { slugPrefix: "hype", binanceStream: "hypeusdt", coinbaseProduct: "HYPE-USD",
        polymarketSymbol: "hype/usd", apiSymbol: "HYPE", okxInstId: "HYPE-USD",
        bybitSymbol: "HYPEUSDT" },
      bnb: { slugPrefix: "bnb", binanceStream: "bnbusdt", coinbaseProduct: "BNB-USD",
        polymarketSymbol: "bnb/usd", apiSymbol: "BNB", okxInstId: "BNB-USD",
        bybitSymbol: "BNBUSDT" },
    };
    const config = map[cfg.MARKET_ASSET];
    if (!config) throw new Error(`Invalid MARKET_ASSET: ${cfg.MARKET_ASSET}`);
    return config;
  }
}

export { ConfigManager as Config };
