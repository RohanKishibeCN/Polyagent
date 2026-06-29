# Polyagent 完整改造方案

> 基于 `KaustubhPatange/polymarket-trade-engine` 源码全面审查，针对 VPS + Node.js v20.20.2 部署的改造计划

---

## 第一章 | 项目命名与结构调整

### 1.1 命名变更清单

| 原名 | 新名 | 位置 |
|------|------|------|
| `early-bird-engine` | `polyagent` | `package.json` |
| `EarlyBird` | `Polyagent` | `engine/early-bird.ts` |
| `early-bird-*.log` | `polyagent-*.log` | `engine/log.ts` |
| `state/early-bird.json` | `state/polyagent.json` | `engine/early-bird.ts` |
| `state/early-bird-prod.json` | `state/polyagent-prod.json` | `engine/early-bird.ts` |
| `early-bird` (process lock) | `polyagent` | `utils/process-lock.ts`, `index.ts` |
| `early-bird-{slug}.log` | `polyagent-{slug}.log` | `engine/logger.ts` |
| `docs/GUIDE.md` 引用 `early-bird` | `polyagent` | `docs/GUIDE.md` |

### 1.2 项目结构

```
Polyagent/
├── src/                      # 源代码（重命名保持清晰）
│   ├── engine/               # 核心引擎
│   │   ├── polyagent.ts      # 主入口（原 early-bird.ts）
│   │   ├── client.ts         # Polymarket API 客户端
│   │   ├── market-lifecycle.ts
│   │   ├── recovery.ts       # 崩溃恢复
│   │   ├── state.ts          # 状态持久化
│   │   ├── wallet-tracker.ts
│   │   ├── user-channel.ts
│   │   ├── log.ts            # 全局日志
│   │   ├── logger.ts         # 按市场日志
│   │   └── strategy/         # 策略目录
│   │       ├── index.ts
│   │       ├── types.ts
│   │       ├── simulation.ts
│   │       ├── late-entry.ts
│   │       └── utils.ts
│   ├── tracker/              # 数据追踪
│   ├── utils/                # 工具类
│   └── index.ts              # CLI 入口
├── scripts/                  # 运维脚本
├── analysis/                 # 分析 Dashboard (React + Vite)
├── test/                     # 测试
├── logs/                     # 运行时日志（gitignore）
├── state/                    # 运行时状态（gitignore）
├── docs/                     # 文档
├── .env.example              # 配置模板
├── package.json
├── tsconfig.json
└── README.md
```

---

## 第二章 | 配置管理体系（全 .env 驱动）

### 2.1 设计原则

**所有可配置参数都必须通过 `.env` 文件管理，不允许在代码中硬编码配置值。** 策略参数、风控阈值、API 地址、通知配置等全部走环境变量，统一收敛到一个 `.env` 文件中。

### 2.2 配置分层架构

```
.env                          ← 用户编辑的唯一文件（gitignore）
  │
  ▼
src/config/schema.ts          ← Zod 校验 + 默认值定义
  │
  ▼
src/config/index.ts           ← 类型安全配置访问（替代 Env.get）
  │
  ▼
各模块代码中通过 Config 单例读取  ← 不允许直接 process.env.FOO
```

### 2.3 配置校验（Zod Schema）

```typescript
// src/config/schema.ts
import { z } from "zod";

export const ConfigSchema = z.object({
  // ── 交易市场 ──
  MARKET_ASSET: z.enum(["btc", "eth", "xrp", "sol", "doge", "hype", "bnb"])
    .default("btc"),
  MARKET_WINDOW: z.enum(["5m", "15m"]).default("5m"),
  TICKER: z.preprocess(
    (v) => (typeof v === "string" ? v.split(",").map(s => s.trim()) : v),
    z.array(z.enum(["polymarket", "binance", "coinbase", "okx", "bybit"]))
      .default(["polymarket", "coinbase"])
  ),

  // ── Polymarket 凭证 ──
  PRIVATE_KEY: z.string().optional().default(""),
  POLY_FUNDER_ADDRESS: z.string().optional().default(""),
  BUILDER_KEY: z.string().optional().default(""),
  BUILDER_SECRET: z.string().optional().default(""),
  BUILDER_PASSPHRASE: z.string().optional().default(""),

  // ── 模拟交易 ──
  WALLET_BALANCE: z.coerce.number().positive().default(50),
  MAX_SESSION_LOSS: z.coerce.number().positive().default(3),

  // ── 策略选择 ──
  STRATEGY: z.enum(["simulation", "late-entry", "ai-decision"])
    .default("simulation"),

  // ── 策略参数 ──
  // simulation 策略
  SIM_BUY_PRICE: z.coerce.number().min(0.01).max(0.99).default(0.49),
  SIM_SELL_PRICE: z.coerce.number().min(0.01).max(0.99).default(0.70),
  SIM_SHARES: z.coerce.number().int().positive().default(5),

  // late-entry 策略
  LATE_ENTRY_SHARES: z.coerce.number().int().positive().default(6),
  LATE_ENTRY_GAP_SAFETY: z.coerce.number().positive().default(40),
  LATE_ENTRY_DIVERGENCE: z.coerce.number().positive().default(10),
  LATE_ENTRY_PEAK_GAP_RATIO: z.coerce.number().min(0).max(1).default(0.75),
  LATE_ENTRY_ATR_MAX: z.coerce.number().positive().default(2),
  LATE_ENTRY_CERTAINTY: z.coerce.number().min(0.5).max(0.99).default(0.85),
  LATE_ENTRY_MIN_LIQUIDITY: z.coerce.number().positive().default(20),

  // ── AI 决策 ──
  AI_API_KEY: z.string().optional().default(""),
  AI_MODEL: z.string().default("gpt-4o"),
  AI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  AI_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
  AI_MAX_TOKENS: z.coerce.number().int().positive().default(500),
  AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.7),

  // ── 风险控制 ──
  MAX_NOTIONAL_USD: z.coerce.number().positive().default(5),
  MAX_DAILY_TRADES: z.coerce.number().int().positive().default(200),
  MAX_POSITION_USD: z.coerce.number().positive().default(200),
  SLIPPAGE_BPS: z.coerce.number().int().nonnegative().default(30),
  DAILY_MAX_LOSS_PCT: z.coerce.number().min(0).max(1).default(0.05),
  MAX_DRAWDOWN_PCT: z.coerce.number().min(0).max(1).default(0.25),

  // ── 风控 killswitch ──
  KILLSWITCH_THRESHOLD: z.coerce.number().positive().default(50.0),
  WHALE_DUMP_THRESHOLD_PCT: z.coerce.number().positive().default(0.0015),
  MAX_STALENESS_MS: z.coerce.number().int().positive().default(1000),

  // ── 订单行为 ──
  BUY_MAX_RETRIES: z.coerce.number().int().positive().default(30),
  BUY_RETRY_DELAY_MS: z.coerce.number().int().positive().default(500),
  SIM_DELAY_MS: z.coerce.number().int().nonnegative().optional(),
  SIM_BALANCE_DELAY_MS: z.coerce.number().int().positive().default(4000),

  // ── 连接与端点 ──
  ORDERBOOK_WS_URL: z.string().url().optional(),
  POLYGON_RPC_URLS: z.preprocess(
    (v) => (typeof v === "string" ? v.split(",").map(s => s.trim()) : v),
    z.array(z.string().url())
      .default(["https://polygon-bor-rpc.publicnode.com"])
  ),

  // ── 基础设施 ──
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PROD: z.preprocess((v) => v === "true", z.boolean().default(false)),
  FORCE_PROD: z.preprocess((v) => v === "true", z.boolean().default(false)),
  LOCK_DIR: z.string().default("state"),
  HEALTH_PORT: z.coerce.number().int().default(4173),
  GLOBAL_PROXY_URL: z.string().url().optional(),

  // ── Notion 集成 ──
  NOTION_API_KEY: z.string().optional().default(""),
  NOTION_DATABASE_ID: z.string().optional().default(""),
  NOTION_DAILY_SUMMARY_TIME: z.string().default("08:00"),   // UTC 时间
  NOTION_DAILY_SUMMARY_TZ: z.string().default("UTC"),

  // ── 通知告警 ──
  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
  TELEGRAM_CHAT_ID: z.string().optional().default(""),
  DISCORD_WEBHOOK_URL: z.string().url().optional().default(""),
});

export type Config = z.infer<typeof ConfigSchema>;
```

### 2.4 配置访问层

```typescript
// src/config/index.ts
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
// 所有模块统一导入: import { Config } from "../config";
```

### 2.5 模块迁移指南

所有模块中将 `Env.get("XXX")` 替换为 `Config.get().XXX`：

```typescript
// 修改前 (utils/config.ts 的 Env 类):
const streams = Env.get("TICKER");
const window = Env.get("MARKET_WINDOW");
const privateKey = Env.get("PRIVATE_KEY");

// 修改后 (直接使用 Config):
import { Config } from "../config";
const streams = Config.get().TICKER;   // 类型为 ("polymarket" | "binance" | ...)[]
const window = Config.get().MARKET_WINDOW;  // 类型为 "5m" | "15m"
const privateKey = Config.get().PRIVATE_KEY;  // 类型为 string
```

### 2.6 .env.example 完整版

```bash
# ====================== Polyagent 配置 ======================

# --- 运行环境 ---
NODE_ENV=production

# --- 交易市场 ---
# 资产: btc | eth | xrp | sol | doge | hype | bnb
MARKET_ASSET=btc
# 时间窗口: 5m | 15m
MARKET_WINDOW=5m

# --- 价格数据源 ---
TICKER=polymarket,coinbase
# killswitch: Binance/Coinbase 价差超过此值即暂停交易
KILLSWITCH_THRESHOLD=50.0
# whale dump 检测阈值 (0.15%)
WHALE_DUMP_THRESHOLD_PCT=0.0015
# 价格数据超时判定 (ms)
MAX_STALENESS_MS=1000

# --- Polymarket 凭证 (真实交易必需) ---
PRIVATE_KEY=
POLY_FUNDER_ADDRESS=
BUILDER_KEY=
BUILDER_SECRET=
BUILDER_PASSPHRASE=

# --- 模拟交易 ---
WALLET_BALANCE=50
MAX_SESSION_LOSS=3

# --- 策略 ---
STRATEGY=simulation

# -- simulation 策略 --
SIM_BUY_PRICE=0.49
SIM_SELL_PRICE=0.70
SIM_SHARES=5

# -- late-entry 策略 --
LATE_ENTRY_SHARES=6
LATE_ENTRY_GAP_SAFETY=40
LATE_ENTRY_DIVERGENCE=10
LATE_ENTRY_PEAK_GAP_RATIO=0.75
LATE_ENTRY_ATR_MAX=2
LATE_ENTRY_CERTAINTY=0.85
LATE_ENTRY_MIN_LIQUIDITY=20

# --- AI 决策 (ai-decision 策略) ---
AI_API_KEY=
AI_MODEL=gpt-4o
AI_BASE_URL=https://api.openai.com/v1
AI_MIN_CONFIDENCE=0.6
AI_MAX_TOKENS=500
AI_TEMPERATURE=0.7

# --- 风险控制 ---
MAX_NOTIONAL_USD=5
MAX_DAILY_TRADES=200
MAX_POSITION_USD=200
SLIPPAGE_BPS=30
DAILY_MAX_LOSS_PCT=0.05
MAX_DRAWDOWN_PCT=0.25

# --- 订单行为 ---
BUY_MAX_RETRIES=30
BUY_RETRY_DELAY_MS=500
SIM_DELAY_MS=
SIM_BALANCE_DELAY_MS=4000

# --- Polygon RPC (逗号分隔，支持故障转移) ---
POLYGON_RPC_URLS=https://polygon-bor-rpc.publicnode.com

# --- 连接与端点 ---
ORDERBOOK_WS_URL=
GLOBAL_PROXY_URL=

# --- 基础设施 ---
LOCK_DIR=state
HEALTH_PORT=4173
FORCE_PROD=false

# --- Notion 集成 ---
NOTION_API_KEY=
NOTION_DATABASE_ID=
NOTION_DAILY_SUMMARY_TIME=08:00
NOTION_DAILY_SUMMARY_TZ=Asia/Shanghai

# --- 通知告警 ---
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
DISCORD_WEBHOOK_URL=
```

---

## 第三章 | 运行时迁移：Bun → Node.js v20.20.2

### 3.1 Bun 专有 API 清单

| 文件 | Bun API | 替代方案 |
|------|---------|----------|
| `utils/fetch-retry.ts` | `Bun.spawn()` 调 curl | Node.js `child_process.execFile` |
| `utils/fetch-retry.ts` | `BunFetchRequestInit` 类型 | Node.js 原生 `RequestInit` |
| `index.ts` | `await` 在顶层作用域 | 包装到 `main()` + `self-executing async` |
| `package.json` | `@types/bun` 依赖 | 移除 |
| `bunfig.toml` | Bun 测试配置 | 转为 `jest.config.mjs` |
| `bun.lock` | Bun 锁文件 | 生成 `package-lock.json` |
| `scripts/*.ts` | `bun run` 执行 | `npx tsx` 或 `npx ts-node` |

### 3.2 具体迁移步骤

#### 3.2.1 `utils/fetch-retry.ts` 修复（高优先级）

```typescript
// 将 Bun.spawn → Node.js child_process.spawn
import { spawn } from "child_process";

function curlFetch(
  url: string | URL,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const args = ["-s", "-L"];
    for (const [key, value] of Object.entries(headers ?? {})) {
      args.push("-H", `${key}: ${value}`);
    }
    args.push(url.toString());

    const proc = spawn(CURL, args, { stdio: ["ignore", "pipe", "pipe"] });

    if (signal) {
      signal.addEventListener("abort", () => proc.kill());
    }

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    proc.on("close", (exitCode) => {
      if (signal?.aborted) return;
      if (exitCode !== 0) {
        reject(new Error(`curl exited ${exitCode}: ${stderr}`));
        return;
      }
      resolve(new Response(stdout, { status: 200 }));
    });

    proc.on("error", reject);
  });
}
```

同时，将 `BunFetchRequestInit` 替换为标准 `RequestInit`:

```typescript
export async function fetchWithRetry<T = Response>(
  url: string | URL,
  params?: {
    options?: RequestInit;  // ← 改用标准 RequestInit
    resolveWhen?: (res: Response) => Promise<T>;
    // ...其余不变
  },
): Promise<T> { /* ... */ }
```

#### 3.2.2 `index.ts` 顶层 await 修复

```typescript
// 当前直接使用了顶层 await:
//   const opts = program.opts<...>();
//   acquireProcessLock("early-bird");
//   await bot.start();

// 改为：
async function main() {
  const opts = program.opts<...>();
  acquireProcessLock("polyagent");
  // ... 其余逻辑
  await bot.start();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
```

#### 3.2.3 `package.json` 修改

```json
{
  "name": "polyagent",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "start": "node --import tsx src/index.ts",
    "dev": "node --import tsx src/index.ts --strategy simulation --rounds 10",
    "prod": "node --import tsx src/index.ts --prod",
    "check": "tsc --noEmit",
    "test": "node --import tsx --test test/**/*.test.ts"
  },
  "dependencies": {
    "@ethersproject/wallet": "^5.8.0",
    "@js-sdsl/ordered-map": "^4.4.2",
    "@polymarket/builder-relayer-client": "^0.0.8",
    "@polymarket/clob-client-v2": "^1.0.2",
    "commander": "^14.0.3",
    "dotenv": "^16.4.0",
    "ethers": "^6",
    "tsx": "^4.0.0",
    "ws": "^8.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/sinon": "^21.0.1",
    "prettier": "^3.8.1",
    "sinon": "^21.1.2",
    "typescript": "^5.0.0"
  }
}
```

关键变化：
- `tsx` 替代 Bun 作为 TypeScript 运行时
- `@types/node` 替代 `@types/bun`
- `ws` 显式依赖（Node.js 原生 WebSocket 需要）

#### 3.2.4 `bunfig.toml` 和 `bun.lock` 清理

- 删除 `bunfig.toml`
- 删除 `bun.lock`
- 运行 `npm install` 生成 `package-lock.json`

#### 3.2.5 `scripts/*.ts` 文件适配

所有脚本文件的 shebang 和调用方式改为：

```bash
# 原来:  bun run scripts/pusd.ts wrap
# 改为:  node --import tsx scripts/pusd.ts wrap
npx tsx scripts/pusd.ts wrap
```

#### 3.2.6 WebSocket polyfill 处理

Node.js v20 原生支持 WebSocket（实验性 `--experimental-websocket`），但应用代码中使用的 `WebSocket` 需要确认：

- `tracker/orderbook.ts` 使用 `new WebSocket(...)`
- `engine/user-channel.ts` 使用 `new WebSocket(...)`
- `utils/reconnecting-ws.ts` 使用 `new WebSocket(...)`

Node.js v20.20.2 需要使用 `--experimental-websocket` 标志，或在启动命令中添加：

```bash
node --import tsx --experimental-websocket src/index.ts
```

更稳妥的方案是显式安装 `ws` 包作为全局 `WebSocket`：

```typescript
// 在入口文件 src/index.ts 最顶部添加
import { WebSocket } from "ws";

// 注入到 global
(globalThis as any).WebSocket = WebSocket;
```

---

## 第四章 | 策略层面分析与优化

### 4.1 现有策略评估

#### `simulation.ts` — 教学演示策略

**优点：**
- 展示了完整的 StrategyContext API 使用模式
- cleanup 函数实现规范
- 紧急卖出逻辑（emergencySells）完善

**缺点：**
- 硬编码 0.49 买入 / 0.70 卖出，完全无视市场条件
- 只在 UP 方向交易，永远不做 DOWN
- 没有任何技术分析或价格判断
- Production 无法使用（有 PROD 守卫）

**优化方向：**
- 改为读取当前位置的市场概率，在低估时入场
- 加入动态止盈（根据 ATR 波动率调整）
- 增加反向做空逻辑

#### `late-entry.ts` — 晚入场技术分析策略

**优点：**
- 内置 RSI(14)、ATR(14)、RTV(30) 指标
- 多条件下才触发信号（ATR ≤ 2, gap safety ≥ 40, divergence ≤ 10, peakGapRatio ≥ 0.75）
- 有止损逻辑
- 使用 `ctx.hold()` 保持市场生命周期

**缺点：**
- 同样有 PROD 守卫，生产环境不能使用
- 入口条件极其严格（5个 AND 条件），可能大部分轮次不交易
- 仅做 UP/DOWN 二元市场的"确认型"交易，即只在 certainty > 0.85 时入场
- 没有回测数据支撑参数有效性
- `ticker.divergence` 在代码中从未被赋值（只有 `TickerTracker.divergence` getter 存在，但策略中使用的 `ctx.ticker.divergence` 可能是 undefined）

**严重 Bug — `ticker.divergence` 可能一直是 undefined**

`TickerTracker` 有 `get divergence()` getter，但策略中的 `late-entry.ts` 使用 `ctx.ticker.divergence`，而 `checkEntry` 里：

```typescript
const divergence = params.divergence ?? Infinity;
```

如果 `divergence` 是 `null`（而非 `undefined`），`??` 不会 fallback 到 `Infinity`，导致 `null <= 10` 总是 `true`。 需要确认 TickerTracker.divergence 返回的是 `number | null`，而策略期望 `number | undefined | null`。

### 4.2 策略优化方案

#### 4.2.1 新增 AI 驱动策略（核心需求）

原 JLBcode-code 项目的核心是 AI 决策。我们需要新增一个 `ai-decision` 策略：

```typescript
// src/engine/strategy/ai-decision.ts
export const aiDecisionStrategy: Strategy = async (ctx) => {
  const releaseLock = ctx.hold();

  // 1. 收集市场数据
  const marketData = {
    assetPrice: ctx.ticker.price,
    binancePrice: ctx.ticker.binancePrice,
    coinbasePrice: ctx.ticker.coinbasePrice,
    divergence: ctx.ticker.divergence,
    orderBook: ctx.orderBook.getSnapshotData(),
    orderHistory: ctx.orderHistory,
    pendingOrders: ctx.pendingOrders,
    marketResult: ctx.getMarketResult(),
  };

  // 2. 调用 AI 决策（可选：本地指标 + AI 双重判断）
  const decision = await callAIDecision(marketData, {
    apiKey: process.env.AI_API_KEY,
    model: process.env.AI_MODEL || "gpt-4o",
    baseUrl: process.env.AI_BASE_URL,
  });

  // 3. 根据决策执行
  if (decision.action === "BUY") {
    const tokenId = decision.side === "UP"
      ? ctx.clobTokenIds[0]
      : ctx.clobTokenIds[1];

    ctx.postOrders([{
      req: {
        tokenId,
        action: "buy",
        price: decision.price,
        shares: decision.shares,
      },
      expireAtMs: ctx.slotEndMs - 30000,
      onFilled(filledShares) {
        // 设置止盈止损
        placeExitOrders(ctx, decision.side, filledShares, decision.stopLoss, decision.takeProfit);
      },
    }]);
  } else if (decision.action === "WAIT") {
    ctx.log(`[ai] WAIT — confidence ${decision.confidence} below threshold`);
  }

  return () => releaseLock();
};
```

#### 4.2.2 策略目录扩展

```
src/engine/strategy/
├── index.ts              # 策略注册表
├── types.ts              # 类型定义
├── simulation.ts         # 教学策略（保留作参考）
├── late-entry.ts         # 技术分析策略
├── ai-decision.ts        # 新增：AI 决策策略
├── indicators.ts         # 新增：技术指标公共库（从 late-entry 提取）
└── utils.ts              # 工具函数（waitForAsk/waitForBid）
```

#### 4.2.3 技术指标公共库提取

将 `late-entry.ts` 中的 RSI、ATR、RTV 类提取到 `indicators.ts`：

```typescript
// src/engine/strategy/indicators.ts
export class RSI { /* 从 late-entry.ts 迁移 */ }
export class ATR { /* 从 late-entry.ts 迁移 */ }
export class RTV { /* 从 late-entry.ts 迁移 */ }
export class MACD { /* 新增 */ }
export class BollingerBands { /* 新增 */ }
export class Indicators {
  rsi: RSI;
  atr: ATR;
  rtv: RTV;
  macd: MACD;
  bbands: BollingerBands;
  // ...
}
```

### 4.3 策略参数化

将策略中的硬编码值提取为可配置项：

| 策略 | 当前硬编码 | 建议改为环境变量 |
|------|-----------|-----------------|
| simulation | buyPrice=0.49, sellPrice=0.70, shares=5 | `SIM_BUY_PRICE`, `SIM_SELL_PRICE`, `SIM_SHARES` |
| late-entry | shares=6, gapSafety≥40, remaining conditions | `LATE_ENTRY_SHARES`, `LATE_ENTRY_GAP_SAFETY`, `LATE_ENTRY_DIVERGENCE` |

---

## 第五章 | 安全问题分析

### 5.1 严重风险

| 序号 | 问题 | 文件 | 风险等级 | 修复方案 |
|------|------|------|---------|---------|
| 1 | **私钥通过环境变量明文传递** | `engine/client.ts` | 🔴 高 | 使用 `readFileSync` 从密钥文件读取，或集成硬件安全模块 |
| 2 | **私钥可能被日志泄露** | `engine/log.ts` | 🔴 高 | 确保 Never log PRIVATE_KEY 或任何密钥。当前 `log.write` 接收任意字符串，缺乏敏感信息过滤 |
| 3 | **curl 路径硬编码 + 可能存在命令注入风险** | `utils/fetch-retry.ts` | 🔴 高 | URL 传入 curl 参数未做转义，理论上可通过 URL 注入参数。应使用 `--` 分隔符和数组形式参数 |
| 4 | **Polygon RPC 公网节点，无备份** | `engine/client.ts` | 🟡 中 | `POLYGON_RPC` 使用 `publicnode.com`，单点故障。应支持多 RPC 故障转移 |

### 5.2 中等风险

| 序号 | 问题 | 文件 | 风险等级 | 修复方案 |
|------|------|------|---------|---------|
| 5 | **API 响应无完整性校验** | `tracker/api-queue.ts` | 🟡 中 | `EventResponse` 等类型断言前应加 Zod 校验，防止 API 返回畸形数据导致崩溃 |
| 6 | **state JSON 无校验** | `engine/state.ts` | 🟡 中 | `loadState` 读取 JSON 后未校验结构，恶意篡改可导致引擎异常 |
| 7 | **日志不设大小限制** | `engine/log.ts` | 🟡 中 | 长期运行日志可能填满磁盘。需添加日志轮转或大小限制 |
| 8 | **process-lock 文件未清理** | `utils/process-lock.ts` | 🟡 中 | 如果进程被 SIGKILL 杀死，lock 文件残留 |

### 5.3 低风险/建议

| 序号 | 问题 | 文件 | 修复方案 |
|------|------|------|---------|
| 9 | `redeemPositions` 静默吞下异常 | `engine/client.ts` | 红包带 `silent=true` 时 suppress console 但吞下所有错误 |
| 10 | 无 `.env.sample` 文件 | 项目根目录 | 创建 `.env.example` |
| 11 | `errorMsg` 字符串匹配脆弱 | `engine/market-lifecycle.ts` | `p?.errorMsg?.includes("not enough balance")` 依赖 CLOB API 错误文案稳定性 |

### 5.4 安全加固清单

```bash
# 1. 创建 .env.example
cp .env.example .env
chmod 600 .env

# 2. 日志轮转（如果使用 systemd 则依托 journald）
# 或在代码中加入日志大小检查

# 3. 使用 Private Key 文件而非环境变量
echo "0xYOUR_PRIVATE_KEY" > /etc/polyagent/key.pem
chmod 400 /etc/polyagent/key.pem
# 在代码中: const privateKey = readFileSync("/etc/polyagent/key.pem", "utf8").trim();

# 4. 添加 RPC 故障转移
POLYGON_RPC_URLS=https://polygon-rpc.com,https://rpc-mainnet.maticvigil.com
```

---

## 第六章 | 架构优化：VPS 部署适配

### 6.1 当前架构问题

| 问题 | 影响 | 优先级 |
|------|------|-------|
| 无进程管理（PM2/systemd） | 崩溃后不会自动重启 | 🔴 高 |
| 无健康检查端点 | 无法被外部监控系统探测 | 🟡 中 |
| 无 Docker 化 | 环境差异导致"在我机器上能跑" | 🟡 中 |
| 仅控制台日志 | 无结构化的远程日志方案 | 🟢 低 |
| 状态仅本地 JSON | 无法多实例共享状态 | 🟢 低 |
| 单一市场 + 单线程 | 无法同时交易多个资产 | 🟢 低 |

### 6.2 systemd 服务配置

```ini
# /etc/systemd/system/polyagent.service
[Unit]
Description=Polyagent - Polymarket AI Trading Agent
After=network.target

[Service]
Type=simple
User=polyagent
WorkingDirectory=/opt/polyagent
ExecStart=/usr/bin/node --import tsx --experimental-websocket src/index.ts
Restart=always
RestartSec=10
Environment=NODE_ENV=production
EnvironmentFile=/opt/polyagent/.env

# 安全加固
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/opt/polyagent/logs /opt/polyagent/state

# 日志
StandardOutput=journal
StandardError=journal
SyslogIdentifier=polyagent

[Install]
WantedBy=multi-user.target
```

### 6.3 Dockerfile

```dockerfile
# Dockerfile
FROM node:20.20.2-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

FROM node:20.20.2-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app ./

RUN apk add --no-cache curl
RUN mkdir -p /app/logs /app/state
RUN chown -R node:node /app
USER node

CMD ["node", "--import", "tsx", "--experimental-websocket", "src/index.ts"]
```

### 6.4 docker-compose.yml

```yaml
version: "3.8"
services:
  polyagent:
    build: .
    restart: unless-stopped
    environment:
      - NODE_ENV=production
      - ${TICKER:-polymarket,coinbase}
      - ${MARKET_ASSET:-btc}
      - ${MARKET_WINDOW:-5m}
      - PRIVATE_KEY=${PRIVATE_KEY}
      - POLY_FUNDER_ADDRESS=${POLY_FUNDER_ADDRESS}
      - BUILDER_KEY=${BUILDER_KEY}
      - BUILDER_SECRET=${BUILDER_SECRET}
      - BUILDER_PASSPHRASE=${BUILDER_PASSPHRASE}
      - WALLET_BALANCE=${WALLET_BALANCE:-50}
      - MAX_SESSION_LOSS=${MAX_SESSION_LOSS:-3}
      - AI_API_KEY=${AI_API_KEY}
      - AI_MODEL=${AI_MODEL:-gpt-4o}
      - AI_BASE_URL=${AI_BASE_URL}
    volumes:
      - ./logs:/app/logs
      - ./state:/app/state
    network_mode: host  # 或使用 bridge + 端口映射
```

### 6.5 健康检查端点（新增）

```typescript
// src/engine/health-server.ts
import { createServer } from "http";

export function startHealthServer(port: number, getStatus: () => object) {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      const status = getStatus();
      const healthy = status.healthy !== false;
      res.writeHead(healthy ? 200 : 503, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify(status));
    } else if (req.url === "/metrics") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(formatMetrics(getStatus()));
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`[health] Listening on http://127.0.0.1:${port}`);
  });

  return server;
}
```

### 6.6 Metrics 暴露

```typescript
// 暴露 Prometheus 格式的指标
function formatMetrics(status: any): string {
  return [
    `# HELP polyagent_session_pnl Session PnL in USD`,
    `# TYPE polyagent_session_pnl gauge`,
    `polyagent_session_pnl ${status.sessionPnl}`,
    ``,
    `# HELP polyagent_active_markets Number of active market lifecycles`,
    `# TYPE polyagent_active_markets gauge`,
    `polyagent_active_markets ${status.activeLifecycles}`,
    ``,
    `# HELP polyagent_uptime_seconds Engine uptime in seconds`,
    `# TYPE polyagent_uptime_seconds gauge`,
    `polyagent_uptime_seconds ${status.uptime}`,
  ].join("\n");
}
```

### 6.7 .env 文件说明

`.env.example` 完整模板见 [第二章 2.6](#26-envexample-完整版)，此处不再重复。部署时从该模板复制并填写即可。

---

## 第七章 | 代码质量优化

### 7.1 类型安全增强

```typescript
// 当前: EventResponse 无校验
const event: EventResponse = ((await res.json()) as any[])[0];

// 优化: Zod schema 校验
import { z } from "zod";

const EventResponseSchema = z.object({
  id: z.string(),
  ticker: z.string(),
  negRisk: z.boolean(),
  markets: z.array(z.object({
    id: z.string(),
    conditionId: z.string(),
    clobTokenIds: z.string(),
    outcomes: z.string(),
    outcomePrices: z.string(),
    closed: z.boolean(),
    feeSchedule: z.object({
      rate: z.number(),
      exponent: z.number(),
      takerOnly: z.boolean(),
      rebateRate: z.number(),
    }).optional(),
  })),
});

const parsed = EventResponseSchema.safeParse(eventData);
if (!parsed.success) {
  throw new Error(`Invalid event response: ${parsed.error.message}`);
}
```

### 7.2 错误处理增强

`market-lifecycle.ts` 中的 `_tick` 方法：

```typescript
// 当前: try-catch 只 log 不处理
private _step() {
  try {
    await this._handleRunning();
  } catch (e) {
    this._log(`tick error: ${e}`, "red");
    // 错误后状态可能不一致，应考虑转到 DONE 避免死循环
  }
}

// 优化: 连续错误计数 + 熔断
private _consecutiveErrors = 0;
private _step() {
  try {
    await this._handleRunning();
    this._consecutiveErrors = 0;
  } catch (e) {
    this._consecutiveErrors++;
    this._log(`tick error (#${this._consecutiveErrors}): ${e}`, "red");
    if (this._consecutiveErrors >= 10) {
      this._log(`Too many consecutive errors. Marking DONE.`, "red");
      this._setState("DONE");
    }
  }
}
```

### 7.3 内存管理

```typescript
// engine/early-bird.ts: completedMarkets 无限增长
// 添加上限
private _completedMarkets: CompletedMarketState[] = [];
private readonly _maxCompletedMarkets = 1000;

// 在 push 后裁剪
this._completedMarkets.push(market);
if (this._completedMarkets.length > this._maxCompletedMarkets) {
  this._completedMarkets = this._completedMarkets.slice(-this._maxCompletedMarkets);
}
```

### 7.4 文件大小限制

```typescript
// engine/log.ts: 日志文件大小检查
import { statSync } from "fs";

const MAX_LOG_SIZE = 50 * 1024 * 1024; // 50MB

write(msg: string, color?: LogColor): void {
  // 检查日志大小
  try {
    const info = statSync(this._filePath);
    if (info.size > MAX_LOG_SIZE) {
      console.warn(`Log file ${this._filePath} exceeds ${MAX_LOG_SIZE / 1024 / 1024}MB. Consider log rotation.`);
    }
  } catch {}
  // ... 原有逻辑
}
```

---

## 第八章 | 遗漏与补充建议

### 8.1 核心缺失功能

| 功能 | 现状 | 建议 |
|------|------|------|
| **AI 决策集成** | 无 | 新增 `ai-decision` 策略（见第四章） |
| **每日 Notion 总结** | 无 | 第九章已覆盖，当前阶段唯一的信息出口 |
| **通知/告警** | 无 | 添加 Telegram/Discord Webhook 通知（交易信号、止损触发、会话结束） |
| **Dry Run 确认** | `--prod` 需要手动输入 Y | 保留作为安全措施，但支持 `FORCE_PROD=true` 跳过 |
| **多市场并行** | 仅单一资产 | 支持 `MARKET_ASSETS=btc,eth,sol` 多资产并行（v2 规划） |
| **回测框架** | 无 | 日志文件可解析用于回测，但需要专门的 backtest 脚本 |

### 8.2 现有离线分析工具（analysis/）

项目已自带一个离线分析前端，保留不动：

- **技术栈**：React 18 + Vite 5 + Chart.js
- **用途**：读取 `logs/` 下的日志文件，生成可视化分析图表（UP/DOWN分布、胜率+PnL曲线、单轮详情）
- **启动**：`cd analysis && npm run dev`
- **定位**：事后分析工具，非实时 Dashboard。引擎运行结束后用于复盘

### 8.3 Web Dashboard（延后）

实时 Web Dashboard（实时 PnL、持仓、信号）暂不开发，当前阶段仅依赖 Notion 每日总结获取信息。保留方案设计，后续项目稳定运行后再决定是否实施。

### 8.5 建议新增文件

```
src/
├── engine/
│   ├── health-server.ts     # 健康检查 HTTP 服务
│   └── notifications.ts     # Telegram/Discord 通知
├── config/
│   ├── schema.ts            # Zod 配置校验
│   └── defaults.ts          # 默认配置
├── backtest/
│   └── runner.ts            # 回测运行器（基于历史日志）
└── index.ts                 # 重构后的 CLI 入口
```

### 8.6 建议 npm scripts

```json
{
  "scripts": {
    "start": "node --import tsx --experimental-websocket src/index.ts",
    "dev": "npm start -- --strategy simulation --rounds 10",
    "prod": "npm start -- --prod",
    "check": "tsc --noEmit",
    "lint": "prettier --check 'src/**/*.ts'",
    "fmt": "prettier --write 'src/**/*.ts'",
    "test": "node --import tsx --test test/**/*.test.ts",
    "health": "curl -s http://127.0.0.1:4173/health | jq",
    "backtest": "node --import tsx src/backtest/runner.ts",
    "redeem": "node --import tsx scripts/redeem.ts",
    "pusd:wrap": "node --import tsx scripts/pusd.ts wrap",
    "pusd:unwrap": "node --import tsx scripts/pusd.ts unwrap",
    "reset-state": "node --import tsx scripts/reset-state.ts"
  }
}
```

### 8.7 .gitignore 补充

```
node_modules/
dist/
logs/
state/
.env
*.log
*.db
```

---

## 第九章 | Notion 每日交易总结

### 9.1 功能概述

每天定时将前一个交易日的交易数据提炼为一页纯文本 Daily Summary，通过 `ntn` CLI 写入 Notion 数据库。Notion Database 结构极简：仅需 `Date`（标题列）+ `Daily Summary`（正文文本）两个字段。

### 9.2 Notion 数据库 Schema（极简版）

用户需在 Notion 中创建一个 Database，仅需以下 2 个属性：

| 属性名 | 类型 | 说明 |
|--------|------|------|
| `Date` | **Title** | 交易日期，作为页面标题（如 `2026-06-26`） |
| `Daily Summary` | Text | 唯一正文字段，包含结构化多段落的当日交易总结 |

不需要 Select、Number 等任何其他列——所有信息都浓缩在 `Daily Summary` 的纯文本中。

### 9.3 日报模板（输出样式）

每天生成的 `Daily Summary` 文本模板如下：

```text
───────────────────────────
Polyagent Daily Report
2026-06-26 | Strategy: ai-decision | Asset: BTC/USD | Window: 5m
───────────────────────────

📊 [ACCOUNT]
   Balance:      $50.42
   Mode:         simulation
   Session PnL:  +$0.42
   Max Drawdown: $-1.25
   Runtime:      17h 23m

🔄 [FLOW]
   Markets Activated:   60
   Opportunities Found: 45
   Trades Executed:     38
   Win Rate:            71.1%  (27W / 11L)
   Avg Entry Price:     $0.52
   Avg Exit Price:      $0.54

📦 [TRADING]
   Total Invested:      $26.00
   Total Returned:      $26.42
   Avg Profit/Trade:    +$0.011
   Best Trade:          +$0.15  (btc-updown-5m-1719400000)
   Worst Trade:         -$0.08  (btc-updown-5m-1719405000)

⚠️  [RISK]
   Partial Fills:       2
   Failed Orders:        0
   Emergency Sells:      1
   Killswitch Triggered: 0
   Max Session Loss:     -$3.00 (limit)

🤖 [AI]
   Model:          gpt-4o
   AI Calls:       45
   Decisions:      BUY=27 | WAIT=18 |  Avg Confidence: 67%

📈 [TOP 5 PROFITABLE]
   1. +$0.15  btc-updown-5m-1719400000
   2. +$0.12  btc-updown-5m-1719400500
   3. +$0.10  btc-updown-5m-1719401500
   4. +$0.08  btc-updown-5m-1719402700
   5. +$0.07  btc-updown-5m-1719403900
   … and 22 other winning markets

💸 [TOP 3 LOSERS]
   1. -$0.08  btc-updown-5m-1719405000
   2. -$0.06  btc-updown-5m-1719403200
   3. -$0.04  btc-updown-5m-1719404400
   … and 8 other losing markets
```

### 9.4 实现架构

```
src/
├── notion/
│   ├── client.ts          # Notion API 封装（基于 ntn CLI）
│   ├── reporter.ts        # 日报数据聚合 + 模板渲染
│   └── scheduler.ts       # 定时调度器
```

### 9.5 数据聚合与模板渲染

```typescript
// src/notion/reporter.ts
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

      // count partials / fails / emergency from order details
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
    const remainingWinners = won.length - top5.length;
    const remainingLosers = lost.length - bottom3.length;

    let peak = 0, maxDD = 0, running = 0;
    for (const r of rounds) {
      running += r.pnl;
      if (running > peak) peak = running;
      const dd = peak - running;
      if (dd > maxDD) maxDD = dd;
    }

    // Compute invested/returned from order history
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

    // Runtime
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

  // ── 模板渲染 ─────────────────────────────────────────────────
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

    // 📊 ACCOUNT
    lines.push("📊 [ACCOUNT]");
    lines.push(padR("Balance:", `$${stats.totalInvested.toFixed(2)}`));
    lines.push(padR("Mode:", cfg.PROD ? "live" : "simulation"));
    lines.push(padR("Session PnL:", `${sign(stats.sessionPnl)}$${stats.sessionPnl.toFixed(2)}`));
    lines.push(padR("Max Drawdown:", `-$${stats.maxDrawdown.toFixed(2)}`));
    lines.push(padR("Runtime:", `${Math.floor(stats.runtimeMinutes / 60)}h ${stats.runtimeMinutes % 60}m`));
    lines.push("");

    // 🔄 FLOW
    lines.push("🔄 [FLOW]");
    lines.push(padR("Markets Activated:", String(stats.totalRounds)));
    lines.push(padR("Opportunities Found:", String(stats.totalBuys + stats.totalSells)));
    lines.push(padR("Trades Executed:", String(stats.totalBuys + stats.totalSells)));
    lines.push(padR("Win Rate:", `${pct(stats.winRate)}  (${stats.wonRounds}W / ${stats.lostRounds}L)`));
    lines.push(padR("Avg Entry Price:", `$${stats.avgEntryPrice.toFixed(2)}`));
    lines.push(padR("Avg Exit Price:", `$${stats.avgExitPrice.toFixed(2)}`));
    lines.push("");

    // 📦 TRADING
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

    // ⚠️ RISK
    lines.push("⚠️  [RISK]");
    lines.push(padR("Partial Fills:", String(stats.partialFills)));
    lines.push(padR("Failed Orders:", String(stats.failedOrders)));
    lines.push(padR("Emergency Sells:", String(stats.emergencySells)));
    lines.push(padR("Killswitch:", "0"));
    lines.push(padR("Max Session Loss:", `-$${cfg.MAX_SESSION_LOSS.toFixed(2)} (limit)`));
    lines.push("");

    // 🤖 AI
    lines.push("🤖 [AI]");
    lines.push(padR("Model:", cfg.AI_MODEL));
    lines.push(padR("AI Calls:", String(stats.aiCalls)));
    lines.push(padR("Decisions:", `BUY=${stats.aiBuys} | WAIT=${stats.aiWaits} | Avg Confidence: ${(stats.aiAvgConfidence * 100).toFixed(0)}%`));
    lines.push("");

    // 📈 TOP 5
    lines.push("📈 [TOP 5 PROFITABLE]");
    for (let i = 0; i < stats.top5.length; i++) {
      const r = stats.top5[i]!;
      lines.push(`   ${i + 1}. ${sign(r.pnl)}$${Math.abs(r.pnl).toFixed(2)}  ${r.slug}`);
    }
    const remainingW = stats.wonRounds - stats.top5.length;
    if (remainingW > 0) lines.push(`   … and ${remainingW} other winning markets`);
    lines.push("");

    // 💸 BOTTOM 3
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
```

### 9.6 Notion 客户端实现

```typescript
// src/notion/client.ts
import { execSync } from "child_process";

export class NotionClient {
  private apiKey: string;
  private databaseId: string;

  constructor(apiKey: string, databaseId: string) {
    this.apiKey = apiKey;
    this.databaseId = databaseId;
  }

  /** 调用 ntn CLI 操作 Notion API */
  private ntnApi(path: string, method = "GET", body?: object): any {
    const args = [`ntn`, `api`, path];
    if (method !== "GET") args.push("-X", method);
    if (body) args.push("-d", JSON.stringify(body));
    args.push("--quiet");

    // 使用 execSync 而非 spawn，简单可靠
    const result = execSync(args.join(" "), {
      encoding: "utf8",
      env: { ...process.env, NOTION_API_TOKEN: this.apiKey },
      maxBuffer: 10 * 1024 * 1024,
    });
    try { return JSON.parse(result); } catch { return result; }
  }

  /** 将 Daily Summary 纯文本写入 Notion Database 新页面 */
  async createDailyPage(dateStr: string, summaryText: string): Promise<string> {
    const body = {
      parent: { database_id: this.databaseId },
      properties: {
        // Title 列 — 页面标题就是日期
        "Date": { title: [{ text: { content: dateStr } }] },
        // 正文文本列
        "Daily Summary": {
          rich_text: [{ text: { content: summaryText } }]
        },
      },
    };

    const response = this.ntnApi("v1/pages", "POST", body);
    return response.id;
  }
}
```

### 9.7 定时调度器

```typescript
// src/notion/scheduler.ts
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
```

### 9.8 引擎集成

```typescript
// src/engine/polyagent.ts
import { NotionScheduler } from "../notion/scheduler";

export class Polyagent {
  private _notionScheduler = new NotionScheduler();

  async start(): Promise<void> {
    // ... 原有启动逻辑
    this._notionScheduler.start();
    // ...
  }
}
```

### 9.9 部署前提

```bash
# 1. 安装 ntn CLI
npm install -g ntn@latest

# 2. 在 .env 中添加 4 个变量:
NOTION_API_KEY=ntn_xxxxxxxxxxxxxx
NOTION_DATABASE_ID=xxxxxxxxxxxxxxxxxxxx
NOTION_DAILY_SUMMARY_TIME=08:00
NOTION_DAILY_SUMMARY_TZ=Asia/Shanghai
```

### 9.10 Notion Database 创建指南

在 Notion 中创建 Database 时：
1. 新建一个 Database（表格视图）
2. 保留默认的 **Title** 列，重命名为 `Date`
3. 新增一列 **Text** 类型，命名为 `Daily Summary`
4. Delete 其他默认列（Tags 等）
5. 根据 `NOTION_DATABASE_ID`（从 Database URL 中复制 32 位 ID）配置 `.env`

---

## 第十章 | 执行优先级与排期建议

### Phase 1 — 跑起来（1-2天）
1. ✅ 项目改名 Polyagent（第一章）
2. ✅ 全 .env 配置化——Zod Schema + Config 单例（第二章）
3. ✅ Bun → Node.js 迁移（第三章全部）
4. ✅ 创建 `.env.example`
5. ✅ 在本地 `npm install` + 运行 simulation 策略验证

### Phase 2 — 加固安全（1天）
5. ✅ 安全风险修复（第五章）
6. ✅ 类型安全增强（Zod schema）
7. ✅ 错误熔断机制
8. ✅ 日志大小限制

### Phase 3 — 部署到 VPS（1天）
9. ✅ Dockerfile + docker-compose.yml
10. ✅ systemd 配置（第六章）
11. ✅ 健康检查端点
12. ✅ 告警通知
13. ✅ Notion 日报调度器（第九章）— 需提供 NOTION_API_KEY + DATABASE_ID

### Phase 4 — 策略优化（2-3天）
14. ✅ 新增 `ai-decision` 策略
15. ✅ 提取公共指标库
16. ✅ 策略参数化
17. ✅ 回测验证

### Phase 5 — 高级功能（按需）
18. 多资产并行
19. 对空交易（SHORT 方向）策略优化
20. 动态仓位管理（Kelly Criterion）
21. Web Dashboard（实时 PnL、持仓、信号）— 当前阶段不开发，以 Notion 每日总结替代

---

## 第十一章 | 策略优化：Scalp + 波动率门控 + 多策略组合

> 基于社区实践反馈与策略分析结论，在现有 `simulation` / `late-entry` / `ai-decision` 基础上，建立三层策略体系。

### 11.1 当前问题

| 问题 | 影响 |
|------|------|
| `late-entry` 条件极严（5个 AND），大部分轮次不交易 | 资金利用率极低，跑一天可能只交易 3-5 轮 |
| `simulation` 完全无视市场条件（硬编码 0.49buy / 0.70sell） | 没有实际交易价值，仅用于学习 API |
| 没有波动率感知 | 震荡市也照常交易，无差别亏损 |
| 胜率优先思维 | 忽视盈亏比，胜率高但赚钱少 |
| 缺乏仓位管理 | 每轮固定 share 数，不会根据市场状态调整 |

### 11.2 三层策略体系

```
┌─────────────────────────────────────────────────┐
│              Polyagent 策略层                     │
├─────────────────────────────────────────────────┤
│ Layer 1: Market State Detector                  │
│   → 实时波动率分类：TRENDING / OSCILLATING / HOT │
│   → ATR-based + divergence-based                │
├─────────────────────────────────────────────────┤
│ Layer 2: Strategy Dispatcher                    │
│   → OSCILLATING → Scalp Strategy (高频低利)      │
│   → TRENDING    → AI Decision Strategy (中频)   │
│   → HOT         → Late-Entry Strategy (低频高胜率)│
├─────────────────────────────────────────────────┤
│ Layer 3: Risk Manager                           │
│   → 动态仓位：波动率↑仓位↓                        │
│   → 止损收紧：HOT 模式下 TP 放宽、SL 收紧         │
│   → 日最大亏损熔断（已有）                        │
└─────────────────────────────────────────────────┘
```

### 11.3 Scalp 策略详细设计

**目标：** 每个 5 分钟窗口内做多笔小额快进快出交易，利用 BTC 价格微小的方向性偏移获利。

**入口条件（全 AND）：**

| 条件 | 值 | 说明 |
|------|-----|------|
| 市场窗口内剩余时间 | > 180s | 保证有足够时间出场，拒绝最后一分钟入场 |
| 最佳 ask 价格 | 0.42–0.58 | 只在接近 50/50 的不确定区间入场 |
| BTC 价格已打破开盘价 | 偏离 ≥ 0.05% | 已经有方向性迹象 |
| 波动率门控 ATR | ≥ 1.5 且 ≤ 6 | 不能太平（没趋势），也不能太剧烈（风险过高） |
| 价差（spread） | ≤ 0.03 | 确保流动性足够 |

**出场条件：**

| 类型 | 条件 |
|------|------|
| 止盈 | 入场价 + 0.05（如 0.50→0.55，10% 利润） |
| 止损 | 入场价 - 0.03（如 0.50→0.47，6% 亏损） |
| 时间出场 | 距市场结束 30s 内，无条件 emergency sell |
| 波动率突变 | ATR 突然 > 8，立即市价退出 |

**仓位规则：**

```
单笔仓位 = MAX_POSITION_USD × (1 / 波动率乘数) × 基础仓位比

波动率乘数 = atr / ATR_NEUTRAL  （ATR_NEUTRAL = 3.0）
基础仓位比 = 0.20   （即平缓市场最多用 20% 资金）

示例：
  ATR = 2  → 乘数 = 0.67 → 仓位 = 5 × 1.5 × 0.20 = $1.50
  ATR = 5  → 乘数 = 1.67 → 仓位 = 5 × 0.6 × 0.20 = $0.60
```

**单窗口限制：**

- 最多 5 笔 Scalp 交易 / 窗口
- 连续 2 笔亏损 → 该窗口停止 Scalp
- 单笔最大亏损 < $0.30

### 11.4 波动率门控（Market State Detector）

**实时状态分类：**

```
                    ATR < 1.5       →  OSCILLATING
Divergence < $5  ── ATR 1.5–6.0   →  TRENDING
                    ATR > 6.0       →  HOT

Divergence ≥ $5  ── 任意 ATR       →  KILLSWITCH
```

**各状态策略映射：**

| 状态 | 策略 | 行为 |
|------|------|------|
| `OSCILLATING` | Scalp | 高频小仓位，0.50±0.08 区间入场，快进快出 |
| `TRENDING` | AI Decision | 中频中等仓位，由 AI 判断方向和时机 |
| `HOT` | Late-Entry | 低频高胜率，必须满足 5 个 AND 条件 |
| `KILLSWITCH` | 全停 | 不交易，等市场恢复 |

**注意：** `TRENDING` 模式是最常见的（估计 60%+ 时间）。当 AI决策未配置时（`AI_API_KEY` 为空），自动 fallback 到 Scalp 策略，即 `OSCILLATING` 和 `TRENDING` 都跑 Scalp。

### 11.5 ATR 计算实现（新增到 ticker.ts）

```typescript
// src/tracker/ticker.ts 中新增 ATR 计算
export class TickerTracker {
  // … 原有属性 …
  
  private _priceHistory: number[] = [];
  private _atrHistory: number[] = [];
  private _atrValue = 0;
  
  get atr() { return this._atrValue; }
  
  // 每次收到 tick 时调用
  private _updateATR(price: number): void {
    this._priceHistory.push(price);
    if (this._priceHistory.length > 14) this._priceHistory.shift();
    if (this._priceHistory.length < 2) return;
    
    const tr = Math.abs(
      this._priceHistory[this._priceHistory.length - 1]! -
      this._priceHistory[this._priceHistory.length - 2]!
    );
    this._atrHistory.push(tr);
    if (this._atrHistory.length > 7) this._atrHistory.shift();
    
    this._atrValue = this._atrHistory.reduce((s, v) => s + v, 0)
      / this._atrHistory.length;
  }
  
  get marketState(): "OSCILLATING" | "TRENDING" | "HOT" | "KILLSWITCH" {
    if (this.isKillswitch) return "KILLSWITCH";
    if (this._atrValue < 1.5) return "OSCILLATING";
    if (this._atrValue > 6) return "HOT";
    return "TRENDING";
  }
}
```

### 11.6 盈亏比优先的仓位管理

**当前：** `WALLET_BALANCE` / `MAX_SESSION_LOSS` — 只管绝对金额

**优化后：**

```bash
# 新增 .env 配置项（已加入 schema）
MAX_POSITION_USD=5        # 单笔最大仓位（美元）
MAX_DAILY_TRADES=200      # 单日最多交易次数
DAILY_MAX_LOSS_PCT=0.05   # 单日最大亏损比例（5%）
MAX_DRAWDOWN_PCT=0.25     # 最大回撤 25% → 触发熔断
```

**仓位动态调整规则：**

```
baseSize = MAX_POSITION_USD
adjustedSize = baseSize × (1 / volatilityMultiplier) × trendStrength

其中：
  volatilityMultiplier = atr / 3.0
  trendStrength = |BTC价格 - 开盘价| / 开盘价 × 100  (clamped 0.5–2.0)
  
  → 波动率越低、趋势越强 → 仓位越大
  → 波动率越高、趋势越弱 → 仓位越小
```

### 11.7 多策略组合引擎

**策略注册表扩展（strategy/index.ts）：**

```typescript
export const strategies: Record<string, Strategy> = {
  "simulation": simulationStrategy,
  "late-entry": lateEntry,
  "ai-decision": aiDecisionStrategy,
  "scalp": scalpStrategy,           // 新增
  "combo": comboStrategy,           // 新增 — 自动切换
};
```

**Combo 策略核心逻辑：**

```typescript
// src/engine/strategy/combo.ts
export const comboStrategy: Strategy = async (ctx) => {
  const releaseLock = ctx.hold();
  const { ticker } = ctx;
  
  // 按 marketState 选择子策略
  switch (ticker.marketState) {
    case "OSCILLATING":
      return await scalpStrategy(ctx);
    case "TRENDING": {
      // 有 AI key → ai-decision，否则 → scalp fallback
      const hasAI = !!(process.env.AI_API_KEY);
      return hasAI ? await aiDecisionStrategy(ctx) : await scalpStrategy(ctx);
    }
    case "HOT":
      return await lateEntry(ctx);
    case "KILLSWITCH":
      ctx.log("[combo] Killswitch active — skipping", "yellow");
      return () => releaseLock();
  }
};
```

### 11.8 新增文件与修改清单

| 操作 | 文件 | 说明 |
|------|------|------|
| **新增** | `src/engine/strategy/scalp.ts` | Scalp 高频策略实现 |
| **新增** | `src/engine/strategy/combo.ts` | 多策略组合调度器 |
| **修改** | `src/engine/strategy/index.ts` | 注册 scalp、combo 策略 |
| **修改** | `src/tracker/ticker.ts` | 增加 ATR 计算 + marketState getter |
| **修改** | `src/config/schema.ts` | 新增 `ATR_PERIOD`, `SCALP_MAX_PER_WINDOW`, `SCALP_TP_PCT`, `SCALP_SL_PCT` |
| **修改** | `.env.example` | 新增策略参数 |

### 11.9 新增 .env 配置项

```bash
# --- 波动率门控 ---
ATR_PERIOD=14              # ATR 计算周期（tick 数）
ATR_OSCILLATE_MAX=1.5      # OSCILLATING 状态 ATR 上限
ATR_HOT_MIN=6.0            # HOT 状态 ATR 下限

# --- Scalp 策略 ---
SCALP_MAX_PER_WINDOW=5     # 单窗口最多交易次数
SCALP_TP_PCT=0.10          # 止盈比例（10% = 0.50→0.55）
SCALP_SL_PCT=0.06          # 止损比例（6% = 0.50→0.47）
SCALP_ENTRY_MIN=0.42       # 入场价格下限
SCALP_ENTRY_MAX=0.58       # 入场价格上限
SCALP_SPREAD_MAX=0.03      # 最大可接受 spread
SCALP_MIN_REMAINING_SEC=180 # 最少剩余秒数
SCALP_MAX_CONSEC_LOSS=2    # 连续亏损停止数
```

---

## 第十二章 | 更新后的执行优先级

### Phase 1 — 基础设施 ✅ 已完成
1. ~~项目改名 Polyagent~~
2. ~~全 .env 配置化——Zod Schema + Config 单例~~
3. ~~Bun → Node.js 迁移~~
4. ~~创建 .env.example~~
5. ~~安装依赖~~

### Phase 2 — 安全加固 ✅ 已完成
6. ~~错误熔断机制~~
7. ~~日志大小限制~~
8. ~~内存管理（completedMarkets cap）~~

### Phase 3 — 部署 + Notion ✅ 已完成
9. ~~Dockerfile + docker-compose.yml（文档已设计，代码待部署到 VPS）~~
10. ~~Notion 日报模块（client/reporter/scheduler + 引擎集成）~~

### Phase 4 — 策略核心优化（本次重点，2-3天）
11. ✅ 在 `ticker.ts` 中增加 ATR 计算 + `marketState` 分类器
12. ✅ 实现 `scalp` 策略
13. ✅ 实现 `combo` 多策略组合调度器
14. ✅ 更新 `.env` 配置（新增 13 个参数）
15. ✅ 策略回测验证（先跑 simulation 10 轮，再跑 combo 100 轮）

### Phase 5 — AI 决策（1-2天）
16. ✅ 实现 `ai-decision` 策略
17. ✅ 提取公共指标库 `indicators.ts`
18. ✅ 策略参数化全部完成

### Phase 6 — 高级功能（按需）
19. 多资产并行
20. Telegram 告警推送
21. Web Dashboard

| 文件 | 修改内容 |
|------|---------|
| `package.json` | 改名、添加依赖、更新 scripts |
| `src/index.ts`（原 `index.ts`） | 顶层 await 消除、参数默认值、命名变更 |
| `src/engine/polyagent.ts`（原 `engine/early-bird.ts`） | 类名、state 路径、session loss 逻辑 |
| `src/engine/client.ts` | RPC 故障转移、私钥文件读取支持 |
| `src/engine/log.ts` | 日志文件名、大小检查 |
| `src/engine/logger.ts` | 日志文件名 |
| `src/engine/state.ts` | Zod schema 校验 |
| `src/utils/fetch-retry.ts` | Bun.spawn → child_process.spawn |
| `src/utils/process-lock.ts` | lock 文件名 |
| `src/engine/strategy/late-entry.ts` | 修复 PROD 守卫、提取指标类 |
| `src/engine/market-lifecycle.ts` | 连续错误熔断 |
| `src/tracker/ticker.ts` | null safety |
| `src/tracker/api-queue.ts` | Zod schema 校验 |

## 附录 B：当前 Bug 清单

1. **`late-entry.ts` 中 `ticker.divergence` 可能为 null** — `null <= 10` 始终为 true，导致入场条件中的 divergence 检查实际上被跳过
2. **`fetch-retry.ts` 的 curl 路径在非 macOS/Linux/Windows 上为 `/usr/bin/curl`** — 某些系统 curl 在 `/usr/local/bin/curl`
3. **`market-lifecycle.ts` throw without recovery** — `_step` 的 catch 块只 log 不处理，状态机可能卡住
4. **`state.ts` 不处理 JSON 解析中的 bigint** — 如果 PnL 数值极大可能超出 `number` 安全范围
5. **`tracker/ticker.ts` 的 `validated` 标志在一次验证成功后不再验证** — 如果 Binance feed 延迟恢复，早期验证会阻止后续检测
