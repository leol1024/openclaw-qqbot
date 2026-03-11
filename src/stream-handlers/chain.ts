/**
 * StreamHandlerChain —— 责任链实现
 *
 * 管理多个 StreamHandler，按注册顺序串联，提供两个核心方法：
 * - processBuffer：遍历 handler 的 canHandle → handle（主动处理）
 * - findSafeFlushPoint：遍历 handler 的 findSafePoint，取最小安全点（被动阻断）
 */

import type { StreamHandler, StreamHandlerContext, HandleResult } from "./types.js";

export class StreamHandlerChain {
  private handlers: StreamHandler[] = [];

  /** 注册 handler（按注册顺序决定优先级） */
  register(handler: StreamHandler): this {
    this.handlers.push(handler);
    return this;
  }

  /**
   * 主动处理：遍历 handler，找到第一个能处理的并执行
   *
   * 语义：处理 buffer 中需要 **立即响应** 的特殊格式
   * 例如：QQBOT_PAYLOAD 拦截、完整媒体标签的中断/发送/重建
   *
   * 如果某个 handler 返回 abort=true，则终止后续 handler
   * 如果 handler 消费了部分 buffer（newBuffer 变短），
   * 会用新 buffer 继续检查后续 handler（可能还有其他标签）
   *
   * @returns 最终的 buffer 和是否有 handler 处理过
   */
  async processBuffer(ctx: StreamHandlerContext): Promise<{ buffer: string; handled: boolean }> {
    let handled = false;

    for (const handler of this.handlers) {
      if (handler.canHandle(ctx.buffer)) {
        ctx.log?.info(`[qqbot:${ctx.accountId}] [chain] ${handler.name}.canHandle=true, processing`);
        const result: HandleResult = await handler.handle(ctx);
        ctx.buffer = result.newBuffer;
        if (result.handled) {
          handled = true;
        }
        if (result.abort) {
          ctx.log?.info(`[qqbot:${ctx.accountId}] [chain] ${handler.name} aborted chain`);
          break;
        }
      }
    }

    return { buffer: ctx.buffer, handled };
  }

  /**
   * 被动阻断：计算 buffer 的安全截断点
   *
   * 遍历所有 handler 的 findSafePoint，取最小值
   * 最小值即为最保守的安全截断位置
   *
   * @returns 安全截断点（0 或 -1 表示不安全，buffer.length 表示全部安全）
   */
  findSafeFlushPoint(buffer: string): number {
    if (!buffer) return 0;

    let minSafePoint = buffer.length;

    for (const handler of this.handlers) {
      const safePoint = handler.findSafePoint(buffer);
      if (safePoint < minSafePoint) {
        minSafePoint = safePoint;
      }
    }

    return minSafePoint;
  }
}
