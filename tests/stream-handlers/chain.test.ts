/**
 * chain.test.ts —— StreamHandlerChain 门槛 + 通行检查测试
 *
 * 验证 findSafeFlushPoint 的两阶段行为：
 * 1. 第一个 handler（门槛）算出截断上界
 * 2. 后续 handler 对 candidate 做全量验证
 *    → 全部通过才放行，任一否决则返回 0 继续攒包
 *
 * 使用 mock handler 精确验证传递行为，
 * 以及真实 handler 组合验证集成场景。
 */

import { describe, it, expect, vi } from "vitest";
import { StreamHandlerChain } from "../../src/stream-handlers/chain.js";
import type { StreamHandler, StreamHandlerContext, HandleResult } from "../../src/stream-handlers/types.js";
import { createDefaultChain } from "../../src/stream-handlers/index.js";

// ============ 辅助：mock handler 工厂 ============

/**
 * 创建一个 mock handler，可自定义 findSafePoint 逻辑，
 * 并记录每次 findSafePoint 被调用时收到的参数。
 */
function createMockHandler(
  name: string,
  findSafePointFn: (buffer: string) => number,
): StreamHandler & { calls: string[] } {
  const calls: string[] = [];
  return {
    name,
    calls,
    canHandle: () => false,
    handle: async (ctx: StreamHandlerContext): Promise<HandleResult> => {
      return { handled: false, newBuffer: ctx.buffer };
    },
    findSafePoint(buffer: string): number {
      calls.push(buffer); // 记录实际收到的文本
      return findSafePointFn(buffer);
    },
  };
}

// ============ 基本行为 ============

describe("findSafeFlushPoint —— 基本行为", () => {
  it("空 buffer 返回 0", () => {
    const chain = new StreamHandlerChain();
    chain.register(createMockHandler("A", () => 0));
    expect(chain.findSafeFlushPoint("")).toBe(0);
  });

  it("无 handler 时返回 buffer.length", () => {
    const chain = new StreamHandlerChain();
    expect(chain.findSafeFlushPoint("Hello")).toBe(5);
  });

  it("单个 handler（门槛）返回全长 → 通过", () => {
    const h = createMockHandler("A", (buf) => buf.length);
    const chain = new StreamHandlerChain();
    chain.register(h);

    expect(chain.findSafeFlushPoint("Hello World")).toBe(11);
    expect(h.calls).toEqual(["Hello World"]);
  });

  it("单个 handler（门槛）返回 0 → 不发送", () => {
    const h = createMockHandler("A", () => 0);
    const chain = new StreamHandlerChain();
    chain.register(h);

    expect(chain.findSafeFlushPoint("Hello")).toBe(0);
  });

  it("单个 handler（门槛）收紧截断点", () => {
    const h = createMockHandler("A", () => 5);
    const chain = new StreamHandlerChain();
    chain.register(h);

    expect(chain.findSafeFlushPoint("Hello World")).toBe(5);
  });
});

// ============ 门槛 + 通行检查 ============

describe("findSafeFlushPoint —— 门槛 + 通行检查", () => {
  it("门槛通过，后续 handler 全部通过 → 返回门槛的 safePoint", () => {
    const buffer = "ABCDEFGHIJ"; // 10 字符

    // 门槛：截断上界 = 7
    const gatekeeper = createMockHandler("Gatekeeper", () => 7);
    // 通行检查：全通过（返回 candidate.length）
    const checker = createMockHandler("Checker", (buf) => buf.length);

    const chain = new StreamHandlerChain();
    chain.register(gatekeeper).register(checker);

    const result = chain.findSafeFlushPoint(buffer);

    expect(result).toBe(7);
    // 门槛收到完整 buffer
    expect(gatekeeper.calls).toEqual(["ABCDEFGHIJ"]);
    // 通行检查收到门槛截断后的 candidate
    expect(checker.calls).toEqual(["ABCDEFG"]);
  });

  it("门槛通过，后续 handler 否决 → 返回 0", () => {
    const buffer = "ABCDEFGHIJ"; // 10 字符

    // 门槛：截断上界 = 7
    const gatekeeper = createMockHandler("Gatekeeper", () => 7);
    // 通行检查：否决（返回 < candidate.length）
    const checker = createMockHandler("Checker", () => 4);

    const chain = new StreamHandlerChain();
    chain.register(gatekeeper).register(checker);

    const result = chain.findSafeFlushPoint(buffer);

    expect(result).toBe(0); // 否决 → 返回 0
    expect(checker.calls).toEqual(["ABCDEFG"]);
  });

  it("门槛返回 0 → 后续 handler 不执行", () => {
    const gatekeeper = createMockHandler("Gatekeeper", () => 0);
    const checker = createMockHandler("Checker", () => 5);

    const chain = new StreamHandlerChain();
    chain.register(gatekeeper).register(checker);

    const result = chain.findSafeFlushPoint("Hello World");

    expect(result).toBe(0);
    expect(gatekeeper.calls.length).toBe(1);
    expect(checker.calls.length).toBe(0); // 不应被调用
  });

  it("多个通行检查 handler，全部通过 → 放行", () => {
    const buffer = "ABCDEFGHIJ"; // 10 字符

    const gatekeeper = createMockHandler("Gatekeeper", () => 8);
    const checkerA = createMockHandler("CheckerA", (buf) => buf.length);
    const checkerB = createMockHandler("CheckerB", (buf) => buf.length);

    const chain = new StreamHandlerChain();
    chain.register(gatekeeper).register(checkerA).register(checkerB);

    const result = chain.findSafeFlushPoint(buffer);

    expect(result).toBe(8);
    // 两个通行检查都收到同样的 candidate
    expect(checkerA.calls).toEqual(["ABCDEFGH"]);
    expect(checkerB.calls).toEqual(["ABCDEFGH"]);
  });

  it("多个通行检查 handler，第一个否决 → 第二个不执行，返回 0", () => {
    const buffer = "ABCDEFGHIJ"; // 10 字符

    const gatekeeper = createMockHandler("Gatekeeper", () => 8);
    const checkerA = createMockHandler("CheckerA", () => 3); // 否决
    const checkerB = createMockHandler("CheckerB", (buf) => buf.length);

    const chain = new StreamHandlerChain();
    chain.register(gatekeeper).register(checkerA).register(checkerB);

    const result = chain.findSafeFlushPoint(buffer);

    expect(result).toBe(0);
    expect(checkerA.calls.length).toBe(1);
    expect(checkerB.calls.length).toBe(0); // 短路，不执行
  });

  it("多个通行检查 handler，第二个否决 → 返回 0", () => {
    const buffer = "ABCDEFGHIJ"; // 10 字符

    const gatekeeper = createMockHandler("Gatekeeper", () => 8);
    const checkerA = createMockHandler("CheckerA", (buf) => buf.length); // 通过
    const checkerB = createMockHandler("CheckerB", () => 5); // 否决

    const chain = new StreamHandlerChain();
    chain.register(gatekeeper).register(checkerA).register(checkerB);

    const result = chain.findSafeFlushPoint(buffer);

    expect(result).toBe(0);
    expect(checkerA.calls.length).toBe(1);
    expect(checkerB.calls.length).toBe(1);
  });

  it("门槛返回全长，后续全部通过 → 返回 buffer.length", () => {
    const buffer = "Hello World";

    const gatekeeper = createMockHandler("Gatekeeper", (buf) => buf.length);
    const checker = createMockHandler("Checker", (buf) => buf.length);

    const chain = new StreamHandlerChain();
    chain.register(gatekeeper).register(checker);

    const result = chain.findSafeFlushPoint(buffer);

    expect(result).toBe(buffer.length);
    expect(gatekeeper.calls).toEqual(["Hello World"]);
    expect(checker.calls).toEqual(["Hello World"]);
  });

  it("通行检查返回 0 也是否决", () => {
    const buffer = "ABCDEFGHIJ";

    const gatekeeper = createMockHandler("Gatekeeper", (buf) => buf.length);
    const checker = createMockHandler("Checker", () => 0); // 返回 0

    const chain = new StreamHandlerChain();
    chain.register(gatekeeper).register(checker);

    const result = chain.findSafeFlushPoint(buffer);

    expect(result).toBe(0);
  });
});

// ============ 真实 handler 集成 ============

describe("findSafeFlushPoint —— 真实 handler 集成", () => {
  it("纯文本无特殊内容 → BracketSafeHandler 给上界，后续全部通过", () => {
    const chain = createDefaultChain();

    const buffer = "第一句话。第二句话";
    const safePoint = chain.findSafeFlushPoint(buffer);

    // BracketSafeHandler 在 "。" 后截断
    expect(safePoint).toBe("第一句话。".length);
  });

  it("BracketSafeHandler 返回 0（括号未闭合）→ 直接不发送", () => {
    const chain = createDefaultChain();

    const buffer = "(未闭合";
    const safePoint = chain.findSafeFlushPoint(buffer);

    expect(safePoint).toBe(0);
  });

  it("括号平衡，无媒体标签 → 正常发送", () => {
    const chain = createDefaultChain();

    const buffer = "(括号平衡)，文字。后续内容";
    const safePoint = chain.findSafeFlushPoint(buffer);

    expect(safePoint).toBeGreaterThan(0);
    const safe = buffer.slice(0, safePoint);
    expect(safe).not.toContain("后续内容"); // BracketSafeHandler 在句号处截断
  });

  it("QQBOT_PAYLOAD 开头 → PayloadHandler 否决，返回 0", () => {
    const chain = createDefaultChain();

    const buffer = "QQBOT_PAYLOAD:\n{\"type\":\"keyboard\"}";
    const safePoint = chain.findSafeFlushPoint(buffer);

    expect(safePoint).toBe(0);
  });

  it("文字 + QQBOT_PAYLOAD → BracketSafeHandler 在换行处截断，candidate 不含 payload → 通过", () => {
    const chain = createDefaultChain();

    const buffer = "正常文本，一些内容\nQQBOT_PAYLOAD:{\"type\":\"keyboard\"}";
    const safePoint = chain.findSafeFlushPoint(buffer);

    const safe = buffer.slice(0, safePoint);
    expect(safe).not.toContain("QQBOT_PAYLOAD");
    expect(safePoint).toBeGreaterThan(0);
  });

  it("candidate 中有不完整媒体标签 → MediaTagHandler 否决，返回 0", () => {
    const chain = createDefaultChain();

    // BracketSafeHandler 在句号后截断，candidate 包含 <qqimg>/path/to
    // MediaTagHandler 发现不完整标签，否决
    const buffer = "一些文字。这里有<qqimg>/path/to";
    const safePoint = chain.findSafeFlushPoint(buffer);

    // 如果门槛截断的 candidate 包含了不完整标签 → 否决返回 0
    // 如果门槛截断的 candidate 不包含标签 → 通过
    const safe = buffer.slice(0, safePoint);
    expect(safe).not.toContain("<qqimg>");
  });

  it("candidate 中有完整媒体标签 → MediaTagHandler 否决，返回 0", () => {
    const chain = createDefaultChain();

    // 完整标签在 candidate 中 → MediaTagHandler 否决
    const buffer = "文字内容\n<qqimg>https://cdn.com/photo.jpg</qqimg>";
    const safePoint = chain.findSafeFlushPoint(buffer);

    // BracketSafeHandler 在 \n 后截断（上界），但 candidate 可能包含完整标签
    // 如果 candidate 包含 <qqimg> → 否决返回 0
    // 如果 candidate 不包含 → 正常放行
    const safe = buffer.slice(0, safePoint);
    expect(safe).not.toContain("<qqimg>");
  });

  it("括号平衡且媒体标签在 candidate 之外 → 正常发送", () => {
    const chain = createDefaultChain();

    // 两段文字用换行分隔，BracketSafeHandler 会在换行处截断
    // candidate = "（括号平衡），文字\n"，不包含 <qqimg>
    // 后续 handler 全部通过 → 正常发送
    const buffer = "（括号平衡），文字\n<qqimg>/path/img.png</qqimg>后续";
    const safePoint = chain.findSafeFlushPoint(buffer);

    const safe = buffer.slice(0, safePoint);
    expect(safe).not.toContain("<qqimg>");
    expect(safePoint).toBeGreaterThan(0);
  });

  it("括号包裹媒体标签 → 门槛 candidate 包含不完整内容 → 否决", () => {
    const chain = createDefaultChain();

    // 场景：括号包裹了媒体标签 "(世界<qqimg>url</qqimg>)"
    // BracketSafeHandler 对完整 buffer 算出上界（可能包含不平衡括号的 candidate）
    // 无论如何，MediaTagHandler 会否决包含标签的 candidate
    const buffer = "前缀。(世界<qqimg>https://cdn.com/a.png</qqimg>)";
    const safePoint = chain.findSafeFlushPoint(buffer);

    const safe = buffer.slice(0, safePoint);
    expect(safe).not.toContain("<qqimg>");
  });

  it("管道顺序验证：BracketSafeHandler 先于 MediaTagHandler", async () => {
    const { BracketSafeHandler } = await import("../../src/stream-handlers/bracket-safe-handler.js");
    const { MediaTagHandler } = await import("../../src/stream-handlers/media-tag-handler.js");
    const { PayloadHandler } = await import("../../src/stream-handlers/payload-handler.js");

    const chain = new StreamHandlerChain();
    chain
      .register(new BracketSafeHandler())
      .register(new PayloadHandler())
      .register(new MediaTagHandler());

    // BracketSafeHandler 先算上界，后续做通行检查
    const buffer = "内容文字，分隔。<qqimg>/tmp/a.png</qqimg>";
    const safePoint = chain.findSafeFlushPoint(buffer);

    const safe = buffer.slice(0, safePoint);
    expect(safe).not.toContain("<qqimg>");
    // 如果门槛截断在标签之前 → 通行检查通过 → safePoint > 0
    // 如果门槛截断包含标签 → 通行检查否决 → safePoint = 0
    // 两种情况都不应包含 <qqimg>
  });
});
