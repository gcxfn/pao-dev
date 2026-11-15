// 独立离线缺陷探针，不属于产品测试集合。只读源码；模拟供应商永不结算。
import { expect, test, vi } from "../../PAO/node_modules/vitest/dist/index.js";
import { SessionManager } from "../../PAO/packages/coding-agent/src/core/session-manager.ts";
import { registerPrecompaction, installPrecompactionAdapter, abortPrecompaction } from "../../PAO/packages/coding-agent/src/pao/context/precompaction.ts";
test("已知缺陷探针：reload使旧ctx失效后再次abort抛stale", async () => {
  vi.useFakeTimers();
  try {
    const handlers = new Map<string, Function>(); const status = vi.fn();
    registerPrecompaction({ on: (name: string, fn: Function) => handlers.set(name, fn) } as any);
    const manager = SessionManager.inMemory();
    manager.appendMessage({ role: "user", content: "旧约束".repeat(1000), timestamp: 0 });
    manager.appendCustomMessageEntry("pao-firstrun", "其他项目内部信息", true);
    manager.appendMessage({ role: "user", content: "保留最新约束".repeat(100), timestamp: 1 });
    const model = { provider: "fake", id: "test", contextWindow: 1000 };
    const generate = vi.fn(() => new Promise<never>(() => {}));
    installPrecompactionAdapter(manager, { enabled: true, settings: () => ({ enabled: true, reserveTokens: 100, keepRecentTokens: 100 }), physicalModel: () => model as any, generate, recordStatus: status });
    let stale = false;
    const ctx = { model, thinkingLevel: "off", signal: new AbortController().signal, get sessionManager() { if(stale) throw new Error("ctx stale after reload"); return manager; } };
    handlers.get("turn_end")!({message:{role:"assistant",provider:"fake",model:"test",stopReason:"stop",usage:{totalTokens:800}}},ctx);
    await Promise.resolve(); expect(generate).toHaveBeenCalledOnce();
    const shutdown = handlers.get("session_shutdown")!({},ctx);
    await vi.advanceTimersByTimeAsync(5000); await shutdown;
    expect(status).toHaveBeenCalledWith(manager.getSessionId(), "取消等待超时，费用未知");
    stale = true;
    const rejected = expect(abortPrecompaction(manager)).rejects.toThrow("ctx stale");
    await vi.advanceTimersByTimeAsync(5000); await rejected;
  } finally { vi.useRealTimers(); }
});
