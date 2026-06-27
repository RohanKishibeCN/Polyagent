import type { Strategy } from "./types.ts";
import { simulationStrategy } from "./simulation.ts";
import { lateEntry } from "./late-entry.ts";
import { scalpStrategy } from "./scalp.ts";
import { comboStrategy } from "./combo.ts";

export const strategies: Record<string, Strategy> = {
  "simulation": simulationStrategy,
  "late-entry": lateEntry,
  "scalp": scalpStrategy,
  "combo": comboStrategy,
};

export const DEFAULT_STRATEGY = "combo";

export type { Strategy, StrategyContext } from "./types.ts";
