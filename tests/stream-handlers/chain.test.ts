/**
 * chain.test.ts —— StreamHandlerChain 管道模式测试
 *
 * 验证 findSafeFlushPoint 的管道模式行为：
 * 1. 第一个 handler 算出截断上界
 * 2. 后续 handler 收到的 candidate 是上界范围内的文本（而非完整 buffer）
 * 3. 后续 handler 可以进一步收紧截断点
 * 4. 任何一步返回 0 即短路退出
 *
 * 使用 mock handler 精确验证管道传递行为，
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

// ============ 管道模式：基本行为 ============

describe("findSafeFlushPoint 管道模式 —— 基本行为", () => {
  it("空 buffer 返回 0", () => {
    const chain = new StreamHandlerChain();
    chain.register(createMockHandler("A", () => 0));
    expect(chain.findSafeFlushPoint("")).toBe(0);
  });

  it("无 handler 时返回 buffer.length", () => {
    const chain = new StreamHandlerChain();
    expect(chain.findSafeFlushPoint("Hello")).toBe(5);
  });

  it("单个 handler 返回全长 → 不收紧", () => {
    const h = createMockHandler("A", (buf) => buf.length);
    const chain = new StreamHandlerChain();
    chain.register(h);

    expect(chain.findSafeFlushPoint("Hello World")).toBe(11);
    expect(h.calls).toEqual(["Hello World"]);
  });

  it("单个 handler 返回 0 → 短路", () => {
    const h = createMockHandler("A", () => 0);
    const chain = new StreamHandlerChain();
    chain.register(h);

    expect(chain.findSafeFlushPoint("Hello")).toBe(0);
  });

  it("单个 handler 收紧截断点", () => {
    // 只允许前 5 个字符
    const h = createMockHandler("A", () => 5);
    const chain = new StreamHandlerChain();
    chain.register(h);

    expect(chain.findSafeFlushPoint("Hello World")).toBe(5);
  });
});

// ============ 管道模式：串行收紧 ============

describe("findSafeFlushPoint 管道模式 —— 串行收紧", () => {
  it("第一个 handler 收紧后，第二个 handler 收到的是收紧后的文本", () => {
    const buffer = "ABCDEFGHIJ"; // 10 字符

    // handler A：截断上界 = 7 → candidate = "ABCDEFG"
    const hA = createMockHandler("A", () => 7);
    // handler B：记录收到的文本，返回全长（不再收紧）
    const hB = createMockHandler("B", (buf) => buf.length);

    const chain = new StreamHandlerChain();
    chain.register(hA).register(hB);

    const result = chain.findSafeFlushPoint(buffer);

    expect(result).toBe(7);
    // A 收到完整 buffer
    expect(hA.calls).toEqual(["ABCDEFGHIJ"]);
    // B 收到的是收紧后的 candidate
    expect(hB.calls).toEqual(["ABCDEFG"]);
  });

  it("两个 handler 逐步收紧：10 → 7 → 4", () => {
    const buffer = "ABCDEFGHIJ"; // 10 字符

    // A：截断到 7
    const hA = createMockHandler("A", () => 7);
    // B：在收到的文本（7字符）基础上截断到 4
    const hB = createMockHandler("B", () => 4);

    const chain = new StreamHandlerChain();
    chain.register(hA).register(hB);

    const result = chain.findSafeFlushPoint(buffer);

    expect(result).toBe(4);
    expect(hA.calls).toEqual(["ABCDEFGHIJ"]);
    expect(hB.calls).toEqual(["ABCDEFG"]);
  });

  it("三个 handler 逐步收紧：20 → 15 → 10 → 6", () => {
    const buffer = "A".repeat(20);

    const hA = createMockHandler("A", () => 15);
    const hB = createMockHandler("B", () => 10);
    const hC = createMockHandler("C", () => 6);

    const chain = new StreamHandlerChain();
    chain.register(hA).register(hB).register(hC);

    const result = chain.findSafeFlushPoint(buffer);

    expect(result).toBe(6);
    expect(hA.calls[0].length).toBe(20); // A 收到完整 20 字符
    expect(hB.calls[0].length).toBe(15); // B 收到 15 字符
    expect(hC.calls[0].length).toBe(10); // C 收到 10 字符
  });

  it("后续 handler 不扩大截断范围（返回 > candidate.length 无效）", () => {
    const buffer = "ABCDEFGHIJ"; // 10 字符

    // A：截断到 5
    const hA = createMockHandler("A", () => 5);
    // B：试图返回 8（大于收到的 5 字符），但 point < safePoint 不满足，不会扩大
    const hB = createMockHandler("B", () => 8);

    const chain = new StreamHandlerChain();
    chain.register(hA).register(hB);

    const result = chain.findSafeFlushPoint(buffer);

    expect(result).toBe(5); // 不会被扩大到 8
    expect(hB.calls).toEqual(["ABCDE"]); // B 收到 5 字符
  });
});

// ============ 管道模式：短路退出 ============

describe("findSafeFlushPoint 管道模式 —— 短路退出", () => {
  it("第一个 handler 返回 0，后续 handler 不执行", () => {
    const hA = createMockHandler("A", () => 0);
    const hB = createMockHandler("B", () => 5);

    const chain = new StreamHandlerChain();
    chain.register(hA).register(hB);

    const result = chain.findSafeFlushPoint("Hello World");

    expect(result).toBe(0);
    expect(hA.calls.length).toBe(1);
    expect(hB.calls.length).toBe(0); // B 不应被调用
  });

  it("第二个 handler 返回 0，第三个 handler 不执行", () => {
    const hA = createMockHandler("A", () => 7);
    const hB = createMockHandler("B", () => 0);
    const hC = createMockHandler("C", () => 3);

    const chain = new StreamHandlerChain();
    chain.register(hA).register(hB).register(hC);

    const result = chain.findSafeFlushPoint("ABCDEFGHIJ");

    expect(result).toBe(0);
    expect(hA.calls.length).toBe(1);
    expect(hB.calls.length).toBe(1);
    expect(hC.calls.length).toBe(0); // C 不应被调用
  });
});

// ============ 管道模式：不收紧场景 ============

describe("findSafeFlushPoint 管道模式 —— 不收紧", () => {
  it("所有 handler 都返回全长 → 返回 buffer.length", () => {
    const buffer = "Hello World";

    const hA = createMockHandler("A", (buf) => buf.length);
    const hB = createMockHandler("B", (buf) => buf.length);

    const chain = new StreamHandlerChain();
    chain.register(hA).register(hB);

    const result = chain.findSafeFlushPoint(buffer);

    expect(result).toBe(buffer.length);
    // 两个 handler 都收到完整 buffer（因为没有收紧）
    expect(hA.calls).toEqual(["Hello World"]);
    expect(hB.calls).toEqual(["Hello World"]);
  });
});

// ============ 真实 handler 集成 ============

describe("findSafeFlushPoint 管道模式 —— 真实 handler 集成", () => {
  it("BracketSafeHandler 算出上界，MediaTagHandler 在范围内收紧", () => {
    const chain = createDefaultChain();

    // 括号匹配 ok，BracketSafeHandler 会在逗号处给出截断上界
    // MediaTagHandler 发现截断范围内有 <qqimg>，进一步收紧到标签前
    const buffer = "已完成内容，<qqimg>/path/img.png</qqimg>后续";
    const safePoint = chain.findSafeFlushPoint(buffer);

    // 应在 <qqimg> 前截断
    const safe = buffer.slice(0, safePoint);
    expect(safe).not.toContain("<qqimg>");
    expect(safe).not.toContain("</qqimg>");
    expect(safePoint).toBeGreaterThan(0);
  });

  it("BracketSafeHandler 返回 0（括号未闭合）→ 直接短路，后续不执行", () => {
    const chain = createDefaultChain();

    // 短文本且括号未闭合，BracketSafeHandler 返回 0 → 管道短路
    const buffer = "(未闭合";
    const safePoint = chain.findSafeFlushPoint(buffer);

    expect(safePoint).toBe(0);
  });

  it("纯文本无特殊内容 → BracketSafeHandler 给上界，后续不收紧", () => {
    const chain = createDefaultChain();

    const buffer = "第一句话。第二句话";
    const safePoint = chain.findSafeFlushPoint(buffer);

    // BracketSafeHandler 在 "。" 后截断
    expect(safePoint).toBe("第一句话。".length);
  });

  it("QQBOT_PAYLOAD 在截断范围内 → PayloadHandler 收紧到 0", () => {
    const chain = createDefaultChain();

    // BracketSafeHandler 可能在换行处截断，但 payload 以 QQBOT_PAYLOAD: 开头
    const buffer = "QQBOT_PAYLOAD:\n{\"type\":\"keyboard\"}";
    const safePoint = chain.findSafeFlushPoint(buffer);

    expect(safePoint).toBe(0);
  });

  it("文字 + QQBOT_PAYLOAD → 截断在 payload 之前", () => {
    const chain = createDefaultChain();

    const buffer = "正常文本，一些内容\nQQBOT_PAYLOAD:{\"type\":\"keyboard\"}";
    const safePoint = chain.findSafeFlushPoint(buffer);

    // BracketSafeHandler 在 \n 处给出上界
    // 上界范围内是 "正常文本，一些内容\n"，不含 payload
    // PayloadHandler 检查上界范围内无 payload，不收紧
    const safe = buffer.slice(0, safePoint);
    expect(safe).not.toContain("QQBOT_PAYLOAD");
    expect(safePoint).toBeGreaterThan(0);
  });

  it("不完整媒体标签 → BracketSafeHandler 给上界 → MediaTagHandler 收紧", () => {
    const chain = createDefaultChain();

    const buffer = "一些文字，有内容。<qqimg>/path/to";
    const safePoint = chain.findSafeFlushPoint(buffer);

    const safe = buffer.slice(0, safePoint);
    expect(safe).not.toContain("<qqimg>");
    expect(safePoint).toBeGreaterThan(0);
  });

  it("括号平衡但包含完整媒体标签 → MediaTagHandler 收紧到标签前", () => {
    const chain = createDefaultChain();

    // 尖括号平衡（<qqimg>...</qqimg>），BracketSafeHandler 可能认为可以截断
    // 但 MediaTagHandler 会在标签前截断
    const buffer = "文字内容\n<qqimg>https://cdn.com/photo.jpg</qqimg>";
    const safePoint = chain.findSafeFlushPoint(buffer);

    const safe = buffer.slice(0, safePoint);
    expect(safe).not.toContain("<qqimg>");
    expect(safe).not.toContain("</qqimg>");
  });

  it("管道顺序验证：BracketSafeHandler 先于 MediaTagHandler", async () => {
    const { BracketSafeHandler } = await import("../../src/stream-handlers/bracket-safe-handler.js");
    const { MediaTagHandler } = await import("../../src/stream-handlers/media-tag-handler.js");
    const { PayloadHandler } = await import("../../src/stream-handlers/payload-handler.js");

    // 先注册 BracketSafeHandler（管道入口门槛）
    const chain = new StreamHandlerChain();
    chain
      .register(new BracketSafeHandler())
      .register(new PayloadHandler())
      .register(new MediaTagHandler());

    // BracketSafeHandler 先算上界，MediaTagHandler 再收紧
    const buffer = "内容文字，分隔。<qqimg>/tmp/a.png</qqimg>";
    const safePoint = chain.findSafeFlushPoint(buffer);

    const safe = buffer.slice(0, safePoint);
    expect(safe).not.toContain("<qqimg>");
    expect(safePoint).toBeGreaterThan(0);
  });
});
