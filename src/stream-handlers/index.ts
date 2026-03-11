/**
 * 流式攒包特殊格式处理器 —— 统一导出
 *
 * gateway.ts 的唯一导入入口：
 *   import { createDefaultChain, StreamHandlerChain, type StreamHandlerContext } from "./stream-handlers/index.js";
 */

export { StreamHandlerChain } from "./chain.js";
export type { StreamHandler, StreamHandlerContext, HandleResult, StreamLogger } from "./types.js";

import { StreamHandlerChain } from "./chain.js";
import { PayloadHandler } from "./payload-handler.js";
import { MediaTagHandler } from "./media-tag-handler.js";
import { BracketSafeHandler } from "./bracket-safe-handler.js";

/**
 * 创建默认的处理器责任链
 *
 * 注册顺序决定优先级（先注册的先检查）：
 * 1. PayloadHandler      — QQBOT_PAYLOAD 拦截（最高优先级，abort 整个链）
 * 2. MediaTagHandler     — 完整富媒体标签处理 + 不完整标签安全点
 * 3. BracketSafeHandler  — 括号匹配 + 换行优先 + MD链接保护 安全截断
 *                          （替换原 MarkdownLinkHandler，是其严格超集）
 */
export function createDefaultChain(): StreamHandlerChain {
  const chain = new StreamHandlerChain();
  chain
    .register(new PayloadHandler())
    .register(new MediaTagHandler())
    .register(new BracketSafeHandler());
  return chain;
}
