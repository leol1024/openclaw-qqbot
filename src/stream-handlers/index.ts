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
 * findSafePoint 门槛 + 通行检查模型：
 * 1. BracketSafeHandler  — 括号匹配 + 换行优先，算出截断上界（门槛）
 * 2. PayloadHandler      — 对 candidate 做通行检查，包含 QQBOT_PAYLOAD 则否决
 * 3. MediaTagHandler     — 对 candidate 做通行检查，包含未闭合/完整媒体标签则否决
 *    → 任一后续 handler 否决 → 返回 0 继续攒包，等更多内容
 *
 * processBuffer 注册顺序（主动处理，先注册的先检查）：
 * 1. BracketSafeHandler  — 不主动处理（canHandle 始终 false），自然跳过
 * 2. PayloadHandler      — QQBOT_PAYLOAD 拦截（最高优先级，abort 整个链）
 * 3. MediaTagHandler     — 完整富媒体标签处理
 */
export function createDefaultChain(): StreamHandlerChain {
  const chain = new StreamHandlerChain();
  chain
    .register(new BracketSafeHandler())
    .register(new PayloadHandler())
    .register(new MediaTagHandler());
  return chain;
}
