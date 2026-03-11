/**
 * BracketSafeHandler —— 括号安全截断处理器
 *
 * 替换 MarkdownLinkHandler，提供更完善的安全截断逻辑：
 * - 括号匹配 ()[]{}<> 平衡检测
 * - 换行符优先切割
 * - [xxx] 结尾保护（防止 MD 链接被截断）
 * - 假 MD 链接清除
 * - XML 自闭合标签跟随
 * - Markdown 引用 > 特殊处理
 *
 * 只做被动阻断（canHandle 始终返回 false），
 * 通过 findSafePoint 返回安全截断点，
 * 与 MediaTagHandler/PayloadHandler 在责任链中协同工作。
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
   * 计算 buffer 的安全截断点
   *
   * 调用 splitMsg 算法：
   * - 返回 sendMsg.length 作为安全截断点
   * - sendMsg 为空时返回 0（继续攒包）
   *
   * 注意：splitMsg 内部会执行 removeFakeMdLinks，
   * 但 findSafePoint 返回的是基于原始 buffer 的位置。
   * 由于 removeFakeMdLinks 只会缩短文本（将 [text](url) 变成 text），
   * 使用清理后文本的 sendMsg 长度作为截断点是安全的 ——
   * 它指向的位置在原始 buffer 中只会更靠前（更保守），不会超出安全范围。
   *
   * 但为了精确，我们直接使用原始 buffer 进行拆分计算。
   * removeFakeMdLinks 的作用是预处理，对于 findSafePoint 的场景，
   * 我们关注的是括号匹配和换行符位置，假 MD 链接的存在不影响这些判断。
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
