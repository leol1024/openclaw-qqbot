/**
 * BracketSafeHandler —— 括号安全截断处理器（门槛）
 *
 * 作为责任链中 findSafeFlushPoint 的门槛角色：
 * - 对完整 buffer 做括号匹配 ()[]{}<> 平衡检测
 * - 换行符优先切割
 * - [xxx] 结尾保护（防止 MD 链接被截断）
 * - 假 MD 链接清除
 * - XML 自闭合标签跟随
 * - Markdown 引用 > 特殊处理
 * - 算出截断上界，后续 handler 对 candidate 做通行检查
 *
 * 门槛模型：
 * - BracketSafeHandler 先算出括号安全的截断点（上界）
 * - 后续 handler 对 candidate 做全量验证，任一否决则整体不发送
 * - 后续 handler 不"收紧"截断点，而是拥有"否决权"
 */

import type { StreamHandler, StreamHandlerContext, HandleResult } from "./types.js";
import { splitMsg, type SplitMsgConfig } from "../utils/split-msg.js";

export class BracketSafeHandler implements StreamHandler {
  readonly name = "BracketSafeHandler";

  private config: SplitMsgConfig;

  constructor(config?: SplitMsgConfig) {
    this.config = config ?? {};
  }

  /**
   * 不主动处理 —— 仅做被动阻断
   */
  canHandle(_buffer: string): boolean {
    return false;
  }

  /**
   * 不会被调用（canHandle 始终返回 false）
   */
  async handle(ctx: StreamHandlerContext): Promise<HandleResult> {
    return { handled: false, newBuffer: ctx.buffer };
  }

  /**
   * 计算 buffer 的括号安全截断点（截断上界）
   *
   * 调用 splitMsg 算法：
   * - 返回 sendMsg.length 作为截断上界
   * - sendMsg 为空时返回 0（继续攒包）
   * - splitFail 时返回 buffer.length（强制发送，避免无限积压）
   *
   * 这只是前置条件。chain 会将此上界传递给后续 handler，
   * 由它们对截断范围内的文本做进一步检查（富媒体标签、payload 等）。
   */
  findSafePoint(buffer: string): number {
    if (buffer.length === 0) return 0;

    const result = splitMsg(buffer, this.config);

    if (result.sendMsg.length > 0) {
      return result.sendMsg.length;
    }

    // sendMsg 为空，无安全截断点，继续攒包
    // splitFail 时返回 buffer.length 强制发送，避免无限积压
    if (result.splitFail) {
      return buffer.length;
    }

    return 0;
  }
}
