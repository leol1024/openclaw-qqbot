/**
 * BracketSafeHandler —— 括号安全截断处理器（必过校验）
 *
 * 作为责任链中 findSafePoint 的第一道关卡：
 * - 括号匹配 ()[]{}<> 平衡检测
 * - 换行符优先切割
 * - [xxx] 结尾保护（防止 MD 链接被截断）
 * - 假 MD 链接清除
 * - XML 自闭合标签跟随
 * - Markdown 引用 > 特殊处理
 *
 * 只做括号层面的安全截断，算出截断上界。
 * 后续 handler（MediaTag、Payload 等）在此上界范围内进一步收紧。
 *
 * 移植自 babyQ fmtx.go 的 SplitMsg 算法。
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
