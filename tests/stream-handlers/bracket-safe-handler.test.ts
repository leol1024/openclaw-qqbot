/**
 * bracket-safe-handler.test.ts —— BracketSafeHandler 集成测试
 *
 * 验证 BracketSafeHandler 的 findSafePoint 在各种场景下返回正确的安全截断点，
 * 以及与 MediaTagHandler/PayloadHandler 在责任链 (StreamHandlerChain) 中的协同工作。
 */

import { describe, it, expect } from "vitest";
import { BracketSafeHandler } from "../../src/stream-handlers/bracket-safe-handler.js";
import { createDefaultChain } from "../../src/stream-handlers/index.js";

// ============ BracketSafeHandler.findSafePoint 单独测试 ============

describe("BracketSafeHandler.findSafePoint", () => {
  const handler = new BracketSafeHandler();

  it("空 buffer 返回 0", () => {
    expect(handler.findSafePoint("")).toBe(0);
  });

  it("短文本无分隔符 —— 继续攒包", () => {
    expect(handler.findSafePoint("你好")).toBe(0);
  });

  it("有分隔符的短文本", () => {
    const safePoint = handler.findSafePoint("你好，世界");
    expect(safePoint).toBe(3); // "你好，" 长度为 3
  });

  it("有换行符 —— 优先从换行处截断", () => {
    const safePoint = handler.findSafePoint("第一行\n第二行");
    expect(safePoint).toBe(4); // "第一行\n"
  });

  it("未闭合括号 —— 返回最后平衡点", () => {
    const safePoint = handler.findSafePoint("已完成的内容，(未闭合的括号");
    // "已完成的内容，" 是安全的（7个字符），括号未闭合
    expect(safePoint).toBe(7);
  });

  it("括号内逗号不触发截断", () => {
    const safePoint = handler.findSafePoint("(括号内，不切)，外面的内容");
    // 应该在外面的逗号处切割："(括号内，不切)，"
    expect(safePoint).toBe(9);
  });

  it("不完整的 MD 链接 —— 继续攒包", () => {
    // [text]( 后面 URL 未闭合 → 整个 buffer 不安全
    const safePoint = handler.findSafePoint("[链接文本](https://example.com/ver");
    expect(safePoint).toBe(0);
  });

  it("完整的 MD 链接 —— 可以安全截断", () => {
    const buffer = "[链接](https://example.com)后续文本，继续";
    const safePoint = handler.findSafePoint(buffer);
    expect(safePoint).toBeGreaterThan(0);
  });

  it("[xxx] 结尾保护", () => {
    // "一些内容[链接文本]" → [链接文本] 会被保留到下次
    const buffer = "一些文本，这是一段话[链接文本]";
    const safePoint = handler.findSafePoint(buffer);
    // sendMsg 应该是 "一些文本，这是一段话"，不包含 [链接文本]
    expect(safePoint).toBeLessThan(buffer.length);
    expect(buffer.slice(0, safePoint)).not.toContain("[链接文本]");
  });

  it("Markdown 引用 > 不影响截断", () => {
    const safePoint = handler.findSafePoint("> 引用内容，一些文本");
    expect(safePoint).toBeGreaterThan(0);
  });

  it("splitFail 超长文本强制发送", () => {
    // 构造超过 maxSliceBytesLen 的未闭合括号文本
    const longContent = "中".repeat(3000); // 每个中文字符 3 字节 = 9000 字节
    const buffer = "(" + longContent;
    const safePoint = handler.findSafePoint(buffer);
    // splitFail 时应返回 buffer.length 强制发送
    expect(safePoint).toBe(buffer.length);
  });

  it("数学公式括号匹配 —— 不匹配括号结构返回 0 继续攒包", () => {
    // "> a ∈ (1/2,1]" 中 ( 和 ] 不匹配，findBestSplitIndex 返回 -1
    // 短文本无法找到安全截断点，继续攒包
    const buffer = "> a ∈ (1/2,1]，一些内容";
    const safePoint = handler.findSafePoint(buffer);
    expect(safePoint).toBe(0);
  });

  it("完整的数学公式括号 —— 可以截断", () => {
    // 括号匹配完整后可以截断
    const buffer = "> a ∈ (1/2,1)，一些内容";
    const safePoint = handler.findSafePoint(buffer);
    expect(safePoint).toBeGreaterThan(0);
  });

  it("canHandle 始终返回 false", () => {
    expect(handler.canHandle("任何内容")).toBe(false);
  });
});

// ============ 责任链集成测试 ============

describe("StreamHandlerChain 集成 (BracketSafeHandler)", () => {
  it("createDefaultChain 包含 BracketSafeHandler", () => {
    const chain = createDefaultChain();
    // 通过 findSafeFlushPoint 间接验证 handler 已注册
    const safePoint = chain.findSafeFlushPoint("你好，世界");
    expect(safePoint).toBe(3); // BracketSafeHandler 的分隔符切割
  });

  it("不完整媒体标签 —— MediaTagHandler 与 BracketSafeHandler 取最小安全点", () => {
    const chain = createDefaultChain();
    // 不完整的 <qqimg> 标签：MediaTagHandler 会在 < 前截断
    const buffer = "已发送的内容，<qqimg";
    const safePoint = chain.findSafeFlushPoint(buffer);
    // MediaTagHandler.findSafePoint 和 BracketSafeHandler.findSafePoint 都会返回值
    // chain 取最小值
    expect(safePoint).toBeGreaterThan(0);
    expect(safePoint).toBeLessThanOrEqual(buffer.length);
    // 不应从 <qqimg 中间截断
    expect(buffer.slice(0, safePoint)).not.toContain("<qqimg");
  });

  it("纯文本带分隔符 —— BracketSafeHandler 提供分隔符切割", () => {
    const chain = createDefaultChain();
    const safePoint = chain.findSafeFlushPoint("第一句话。第二句话");
    // 在 "。" 后切割
    expect(safePoint).toBe(5); // "第一句话。"
  });

  it("有换行的文本 —— 优先换行切割", () => {
    const chain = createDefaultChain();
    const safePoint = chain.findSafeFlushPoint("第一行\n第二行");
    expect(safePoint).toBe(4); // "第一行\n"
  });

  it("空 buffer 返回 0", () => {
    const chain = createDefaultChain();
    expect(chain.findSafeFlushPoint("")).toBe(0);
  });
});
