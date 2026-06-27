import { z } from "zod";

export const ConfigSchema = z.object({
  MARKET_ASSET: z.enum(["btc", "eth", "xrp", "sol", "doge", "hype", "bnb"])
    .default("btc"),
  MARKET_WINDOW: z.enum(["5m", "15m"]).default("5m"),
  TICKER: z.preprocess(
    (v) => (typeof v === "string" ? v.split(",").map(s => s.trim()) : v),
    z.array(z.enum(["polymarket", "binance", "coinbase", "okx", "bybit"]))
      .default(["polymarket", "coinbase"])
  ),

  PRIVATE_KEY: z.string().optional().default(""),
  POLY_FUNDER_ADDRESS: z.string().optional().default(""),
  BUILDER_KEY: z.string().optional().default(""),
  BUILDER_SECRET: z.string().optional().default(""),
  BUILDER_PASSPHRASE: z.string().optional().default(""),

  WALLET_BALANCE: z.coerce.number().positive().default(50),
  MAX_SESSION_LOSS: z.coerce.number().positive().default(3),

  STRATEGY: z.enum(["simulation", "late-entry", "ai-decision"])
    .default("simulation"),

  SIM_BUY_PRICE: z.coerce.number().min(0.01).max(0.99).default(0.49),
  SIM_SELL_PRICE: z.coerce.number().min(0.01).max(0.99).default(0.70),
  SIM_SHARES: z.coerce.number().int().positive().default(5),

  LATE_ENTRY_SHARES: z.coerce.number().int().positive().default(6),
  LATE_ENTRY_GAP_SAFETY: z.coerce.number().positive().default(40),
  LATE_ENTRY_DIVERGENCE: z.coerce.number().positive().default(10),
  LATE_ENTRY_PEAK_GAP_RATIO: z.coerce.number().min(0).max(1).default(0.75),
  LATE_ENTRY_ATR_MAX: z.coerce.number().positive().default(2),
  LATE_ENTRY_CERTAINTY: z.coerce.number().min(0.5).max(0.99).default(0.85),
  LATE_ENTRY_MIN_LIQUIDITY: z.coerce.number().positive().default(20),

  AI_API_KEY: z.string().optional().default(""),
  AI_MODEL: z.string().default("gpt-4o"),
  AI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  AI_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
  AI_MAX_TOKENS: z.coerce.number().int().positive().default(500),
  AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.7),

  MAX_NOTIONAL_USD: z.coerce.number().positive().default(5),
  MAX_DAILY_TRADES: z.coerce.number().int().positive().default(200),
  MAX_POSITION_USD: z.coerce.number().positive().default(200),
  SLIPPAGE_BPS: z.coerce.number().int().nonnegative().default(30),
  DAILY_MAX_LOSS_PCT: z.coerce.number().min(0).max(1).default(0.05),
  MAX_DRAWDOWN_PCT: z.coerce.number().min(0).max(1).default(0.25),

  KILLSWITCH_THRESHOLD: z.coerce.number().positive().default(50.0),
  WHALE_DUMP_THRESHOLD_PCT: z.coerce.number().positive().default(0.0015),
  MAX_STALENESS_MS: z.coerce.number().int().positive().default(1000),

  BUY_MAX_RETRIES: z.coerce.number().int().positive().default(30),
  BUY_RETRY_DELAY_MS: z.coerce.number().int().positive().default(500),
  SIM_DELAY_MS: z.coerce.number().int().nonnegative().optional(),
  SIM_BALANCE_DELAY_MS: z.coerce.number().int().positive().default(4000),

  ORDERBOOK_WS_URL: z.string().url().optional(),
  POLYGON_RPC_URLS: z.preprocess(
    (v) => (typeof v === "string" ? v.split(",").map(s => s.trim()) : v),
    z.array(z.string().url())
      .default(["https://polygon-bor-rpc.publicnode.com"])
  ),

  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PROD: z.preprocess((v) => v === "true", z.boolean().default(false)),
  FORCE_PROD: z.preprocess((v) => v === "true", z.boolean().default(false)),
  LOCK_DIR: z.string().default("state"),
  HEALTH_PORT: z.coerce.number().int().default(4173),
  GLOBAL_PROXY_URL: z.string().url().optional(),

  NOTION_API_KEY: z.string().optional().default(""),
  NOTION_DATABASE_ID: z.string().optional().default(""),
  NOTION_DAILY_SUMMARY_TIME: z.string().default("08:00"),
  NOTION_DAILY_SUMMARY_TZ: z.string().default("UTC"),

  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
  TELEGRAM_CHAT_ID: z.string().optional().default(""),
  DISCORD_WEBHOOK_URL: z.string().url().optional().default(""),
});

export type Config = z.infer<typeof ConfigSchema>;
