/**
 * 流式攒包特殊格式处理器 —— 类型定义
 *
 * 策略模式：每个 Handler 实现统一接口，处理一种特殊格式
 * 责任链模式：多个 Handler 按优先级串联，由 StreamHandlerChain 统一调度
 */

// ============ 日志接口 ============

export interface StreamLogger {
  info: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

// ============ 上下文接口 ============

/**
 * 流式处理器上下文 —— 封装流式发送所需的状态和操作
 *
 * Handler 通过 ctx 读取/修改流式状态，调用发送操作，
 * 而不直接依赖 gateway.ts 的闭包变量。
 */
export interface StreamHandlerContext {
  /** 当前攒包缓冲区（handler 可修改） */
  buffer: string;
  /** 账户 ID（日志前缀用） */
  accountId: string;
  /** 是否已开始流式发送 */
  streamStarted: boolean;
  /** 流式是否已结束 */
  streamEnded: boolean;
  /** 流式是否已失败（停止当前消息发送） */
  streamFailed: boolean;
  /** 暂存的 QQBOT_PAYLOAD 结构化载荷全文 */
  pendingPayloadText: string;

  // ---- 操作方法 ----

  /** 发送一个流式分片 */
  sendStreamChunk(text: string, isEnd: boolean): Promise<boolean>;
  /** 中断当前流式会话（刷 buffer → 发结束标记） */
  interruptStream(): Promise<void>;
  /** 重建 StreamSender */
  rebuildStream(): void;
  /** 按类型发送富媒体（image/voice/video/file） */
  sendMediaByType(type: string, path: string): Promise<void>;
  /** 发送图片的 markdown 嵌入（流式内不中断） */
  sendImageAsMarkdown?(imagePath: string): Promise<boolean>;

  /** 日志实例 */
  log?: StreamLogger;
}

// ============ 处理结果 ============

export interface HandleResult {
  /** 是否已处理 */
  handled: boolean;
  /** 处理后的 buffer（handler 应将消费后的剩余内容放在这里） */
  newBuffer: string;
  /** 是否终止后续 handler 处理（如 payload 拦截） */
  abort?: boolean;
}

// ============ Handler 接口 ============

/**
 * 流式特殊格式处理器接口（策略模式）
 *
 * 每个 Handler 负责一种特殊格式的检测和处理：
 * - canHandle + handle：主动处理（如完整媒体标签的中断/发送/重建）
 * - findSafePoint：被动阻断（如不完整标签、未闭合链接，返回安全截断点）
 */
export interface StreamHandler {
  /** Handler 名称（日志和调试用） */
  readonly name: string;

  /**
   * 是否能处理当前 buffer 中的格式（责任链匹配）
   * 返回 true 时 chain 会调用 handle()
   */
  canHandle(buffer: string): boolean;

  /**
   * 执行处理逻辑
   * 调用者已持有 sendingLock，handler 内部不需要感知锁
   */
  handle(ctx: StreamHandlerContext): Promise<HandleResult>;

  /**
   * 返回安全截断点
   * - 等于 buffer.length：无阻断，全部可发送
   * - 0 或 -1：整个 buffer 都不安全，继续攒
   * - 其他值：从该位置截断发送
   */
  findSafePoint(buffer: string): number;
}
