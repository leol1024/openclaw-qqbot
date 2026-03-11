/**
 * PayloadHandler —— QQBOT_PAYLOAD 结构化载荷处理器
 *
 * 检测 buffer 是否以 "QQBOT_PAYLOAD:" 开头，
 * 将全文暂存到 ctx.pendingPayloadText，在流式结束阶段统一处理。
 * payload 不应当作文本流式发送给用户。
 */

import type { StreamHandler, StreamHandlerContext, HandleResult } from "./types.js";

export class PayloadHandler implements StreamHandler {
  readonly name = "PayloadHandler";

  /**
   * 检测 buffer 是否为 QQBOT_PAYLOAD 结构化载荷
   * 或者上下文中已经标记为 payload（正在逐步生成中）
   */
  canHandle(buffer: string): boolean {
    return buffer.trimStart().startsWith("QQBOT_PAYLOAD:");
  }

  /**
   * 暂存 payload 全文到 ctx.pendingPayloadText，清空 buffer
   * 返回 abort=true 终止后续 handler
   */
  async handle(ctx: StreamHandlerContext): Promise<HandleResult> {
    ctx.log?.info(`[qqbot:${ctx.accountId}] [PayloadHandler] Detected QQBOT_PAYLOAD, storing for post-stream processing`);
    ctx.pendingPayloadText = ctx.buffer;
    return {
      handled: true,
      newBuffer: "",
      abort: true, // 终止链：payload 独占整个 buffer
    };
  }

  /**
   * 如果 buffer 是 payload，返回 0 阻止发送
   * 否则不影响安全点
   */
  findSafePoint(buffer: string): number {
    if (buffer.trimStart().startsWith("QQBOT_PAYLOAD:")) {
      return 0; // 阻止发送
    }
    return buffer.length; // 不影响
  }
}
