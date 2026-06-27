import { mock } from "bun:test";

class MockLog {
  write() {}
  flush() {}
}
mock.module("../src/engine/log", () => ({
  log: new MockLog(),
}));

mock.module("../src/engine/logger", () => ({
  Logger: class {
    setSnapshotProvider() {}
    setMarketResultProvider() {}
    setTickerProvider() {}

    startSlot() {}
    endSlot() {}
    destroy() {}
    log() {}
    snapshot() {}
  },
}));
