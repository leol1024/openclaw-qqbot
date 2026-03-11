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
 * findSafePoint 注册顺序（管道模式，逐步收紧截断点）：
 * 1. BracketSafeHandler  — 括号匹配 + 换行优先，算出截断上界（必过校验）
 * 2. MediaTagHandler     — 在上界范围内检查富媒体标签，进一步收紧
 * 3. PayloadHandler      — 在上界范围内检查 QQBOT_PAYLOAD，进一步收紧
 *
 * processBuffer 注册顺序（主动处理，先注册的先检查）：
 * 1. PayloadHandler      — QQBOT_PAYLOAD 拦截（最高优先级，abort 整个链）
 * 2. MediaTagHandler     — 完整富媒体标签处理
 * 3. BracketSafeHandler  — 不主动处理（canHandle 始终 false）
 *
 * 注意：processBuffer 按注册顺序遍历，但 BracketSafeHandler.canHandle=false，
 * 所以它在 processBuffer 中不会被执行。PayloadHandler 和 MediaTagHandler
 * 的 processBuffer 顺序由它们在数组中的位置决定。
 * 为了兼顾两个流程，这里用注册顺序让 findSafePoint 管道正确工作，
 * processBuffer 中 BracketSafeHandler 自然跳过。
 */
export function createDefaultChain(): StreamHandlerChain {
  const chain = new StreamHandlerChain();
  chain
    .register(new BracketSafeHandler())
    .register(new PayloadHandler())
    .register(new MediaTagHandler());
  return chain;
}
