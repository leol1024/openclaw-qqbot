/**
 * StreamHandlerChain —— 责任链实现
 *
 * 管理多个 StreamHandler，按注册顺序串联，提供两个核心方法：
 * - processBuffer：遍历 handler 的 canHandle → handle（主动处理）
 * - findSafeFlushPoint：门槛 + 通行检查模型，
 *   第一个 handler（BracketSafeHandler）算出截断上界（门槛），
 *   后续 handler 对 candidate 做全量验证（否决权），任一不通过则不发送
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
   * 被动阻断：计算 buffer 的安全截断点（门槛 + 通行检查）
   *
   * 两阶段模型：
   *
   * 阶段一（门槛）：第一个 handler（BracketSafeHandler）对完整 buffer 计算截断上界
   *   → 括号匹配通过才说明文本"可能"可以截断，返回 0 则整体不发送
   *
   * 阶段二（通行检查）：后续 handler 对门槛范围内的 candidate 做全量检查
   *   → 如果任意一个 handler 认为 candidate 不完全安全（返回值 < candidate.length），
   *     则整体不发送（返回 0），等更多内容进来
   *   → 只有全部后续 handler 都返回 candidate.length（全部通过），才放行
   *
   * 设计理念：后续 handler 不"收紧"截断点，而是拥有"否决权"。
   * 要么 candidate 全发送，要么不发送继续攒包。
   *
   * @returns 安全截断点（0 表示不安全继续攒包，>0 表示可以截断发送）
   */
  findSafeFlushPoint(buffer: string): number {
    if (!buffer) return 0;
    if (this.handlers.length === 0) return buffer.length;

    // 阶段一：门槛 —— 第一个 handler 算出截断上界
    const gatekeeper = this.handlers[0];
    const safePoint = gatekeeper.findSafePoint(buffer);
    if (safePoint <= 0) return 0;

    // 阶段二：通行检查 —— 后续 handler 对 candidate 做全量验证
    const candidate = buffer.slice(0, safePoint);
    for (let i = 1; i < this.handlers.length; i++) {
      const handler = this.handlers[i];
      const point = handler.findSafePoint(candidate);
      // 任意 handler 认为 candidate 不完全安全 → 否决，继续攒包
      if (point < candidate.length) {
        return 0;
      }
    }

    return safePoint;
  }
}
