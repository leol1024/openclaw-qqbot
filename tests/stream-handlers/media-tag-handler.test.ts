/**
 * MediaTagHandler 测试用例
 *
 * 覆盖：
 * 1. canHandle — 完整媒体标签检测
 * 2. handle — 富媒体标签处理流程（含图片公网URL/本地文件、语音/视频/文件）
 * 3. findSafePoint — 不完整标签的安全截断点（委托 findMediaTagSafePoint）
 * 4. 图片特殊处理：公网URL → sendImageAsMarkdown 嵌入（不中断流式）
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MediaTagHandler } from "../../src/stream-handlers/media-tag-handler.js";
import type { StreamHandlerContext, HandleResult } from "../../src/stream-handlers/types.js";
import { formatQQBotMarkdownImage, DEFAULT_IMAGE_SIZE } from "../../src/utils/image-size.js";

// ============ 辅助函数 ============

/** 创建一个 mock StreamHandlerContext */
function createMockContext(buffer: string, overrides?: Partial<StreamHandlerContext>): StreamHandlerContext {
  return {
    buffer,
    accountId: "test-account",
    streamStarted: false,
    streamEnded: false,
    streamFailed: false,
    pendingPayloadText: "",
    sendStreamChunk: vi.fn().mockResolvedValue(true),
    interruptStream: vi.fn().mockResolvedValue(undefined),
    rebuildStream: vi.fn(),
    sendMediaByType: vi.fn().mockResolvedValue(undefined),
    sendImageAsMarkdown: vi.fn().mockResolvedValue(true),
    log: { info: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

// ============ canHandle ============

describe("MediaTagHandler.canHandle", () => {
  const handler = new MediaTagHandler();

  it("纯文本返回 false", () => {
    expect(handler.canHandle("Hello world, 你好世界")).toBe(false);
  });

  it("完整的 qqimg 标签返回 true", () => {
    expect(handler.canHandle("前缀<qqimg>/path/image.png</qqimg>后缀")).toBe(true);
  });

  it("完整的 qqvoice 标签返回 true", () => {
    expect(handler.canHandle("<qqvoice>/path/audio.silk</qqvoice>")).toBe(true);
  });

  it("完整的 qqvideo 标签返回 true", () => {
    expect(handler.canHandle("<qqvideo>/path/video.mp4</qqvideo>")).toBe(true);
  });

  it("完整的 qqfile 标签返回 true", () => {
    expect(handler.canHandle("<qqfile>/path/doc.pdf</qqfile>")).toBe(true);
  });

  it("不完整的标签返回 false", () => {
    expect(handler.canHandle("Hello<qqimg>/path/image")).toBe(false);
    expect(handler.canHandle("Hello<qqim")).toBe(false);
  });

  it("别名标签经 normalize 后能识别", () => {
    // <image>...</image> normalize 成 <qqimg>...</qqimg>
    expect(handler.canHandle("<image>/path/test.jpg</image>")).toBe(true);
  });

  it("标签内有多余空格经 normalize 后能识别", () => {
    expect(handler.canHandle("< qqimg >/path/file.png</ qqimg >")).toBe(true);
  });

  it("中文尖括号经 normalize 后能识别", () => {
    expect(handler.canHandle("＜qqimg＞/path/file.png＜/qqimg＞")).toBe(true);
  });
});

// ============ handle: 图片特殊处理 ============

describe("MediaTagHandler.handle — 图片", () => {
  const handler = new MediaTagHandler();

  it("公网 HTTP URL → sendImageAsMarkdown 嵌入流式（不中断）", async () => {
    const ctx = createMockContext("<qqimg>https://example.com/photo.png</qqimg>");
    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    expect(result.newBuffer).toBe("");
    // 应该调用 sendImageAsMarkdown，而非 interruptStream
    expect(ctx.sendImageAsMarkdown).toHaveBeenCalledWith("https://example.com/photo.png");
    expect(ctx.interruptStream).not.toHaveBeenCalled();
    expect(ctx.sendMediaByType).not.toHaveBeenCalled();
    expect(ctx.streamStarted).toBe(true);
  });

  it("公网 HTTPS URL → sendImageAsMarkdown 嵌入流式（不中断）", async () => {
    const ctx = createMockContext("<qqimg>https://cdn.example.com/images/abc.jpg</qqimg>");
    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    expect(ctx.sendImageAsMarkdown).toHaveBeenCalledWith("https://cdn.example.com/images/abc.jpg");
    expect(ctx.interruptStream).not.toHaveBeenCalled();
  });

  it("本地路径图片 → 中断流式 → 富媒体 API → 重建", async () => {
    const ctx = createMockContext("<qqimg>/Users/test/Desktop/photo.png</qqimg>");
    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    expect(result.newBuffer).toBe("");
    // 应该走中断流式路径
    expect(ctx.interruptStream).toHaveBeenCalled();
    expect(ctx.sendMediaByType).toHaveBeenCalledWith("image", "/Users/test/Desktop/photo.png");
    expect(ctx.rebuildStream).toHaveBeenCalled();
    // 不应该调用 sendImageAsMarkdown
    expect(ctx.sendImageAsMarkdown).not.toHaveBeenCalled();
  });

  it("sendImageAsMarkdown 失败时跳过该图片，不 abort 后续处理", async () => {
    const ctx = createMockContext("<qqimg>https://example.com/fail.png</qqimg>", {
      sendImageAsMarkdown: vi.fn().mockResolvedValue(false),
    });
    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    // 不再 abort，允许后续图片继续处理
    expect(result.abort).toBeUndefined();
    expect(ctx.streamFailed).toBe(false);
  });

  it("sendImageAsMarkdown 抛异常时跳过该图片，不 abort 后续处理", async () => {
    const ctx = createMockContext("<qqimg>https://example.com/error.png</qqimg>", {
      sendImageAsMarkdown: vi.fn().mockRejectedValue(new Error("API 限频")),
    });
    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    expect(result.abort).toBeUndefined();
    expect(ctx.streamFailed).toBe(false);
    // 记录了错误日志
    expect(ctx.log!.error).toHaveBeenCalled();
  });

  it("5 张图片中间某张失败 → 跳过失败的，其余继续发送", async () => {
    const urls = [
      "https://picsum.photos/800/600?random=100",
      "https://picsum.photos/800/600?random=101",  // 这张会失败
      "https://picsum.photos/800/600?random=102",
      "https://picsum.photos/800/600?random=103",  // 这张也会失败
      "https://picsum.photos/800/600?random=104",
    ];
    const buffer = urls.map(url => `<qqimg>${url}</qqimg>`).join("\n\n");

    let callCount = 0;
    const ctx = createMockContext(buffer, {
      sendImageAsMarkdown: vi.fn(async (_path: string): Promise<boolean> => {
        callCount++;
        // 第 2 和第 4 张失败
        if (callCount === 2 || callCount === 4) return false;
        return true;
      }),
    });

    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    expect(result.abort).toBeUndefined();
    expect(ctx.streamFailed).toBe(false);
    // 5 张都尝试了
    expect(ctx.sendImageAsMarkdown).toHaveBeenCalledTimes(5);
    for (const url of urls) {
      expect(ctx.sendImageAsMarkdown).toHaveBeenCalledWith(url);
    }
    // 失败的 2 张记录了错误日志
    expect(ctx.log!.error).toHaveBeenCalledTimes(2);
    expect(result.newBuffer).toBe("");
  });

  it("sendImageAsMarkdown 不存在时，公网图片不会调用（跳过处理）", async () => {
    const ctx = createMockContext("<qqimg>https://example.com/photo.png</qqimg>", {
      sendImageAsMarkdown: undefined,
    });
    const result = await handler.handle(ctx);

    // 公网 URL + 无 sendImageAsMarkdown → isHttpUrl=true 但跳过 if 分支
    // isLocalPath=false → 也跳过本地分支
    // 最终仅 log error
    expect(result.handled).toBe(true);
    expect(ctx.interruptStream).not.toHaveBeenCalled();
  });

  it("无效的图片路径（既非公网也非本地）→ 仅记录错误日志", async () => {
    // "relative/path" 既不是 http:// 也不是绝对路径
    const ctx = createMockContext("<qqimg>relative/path/image.png</qqimg>");
    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    expect(ctx.interruptStream).not.toHaveBeenCalled();
    expect(ctx.sendImageAsMarkdown).not.toHaveBeenCalled();
    expect(ctx.sendMediaByType).not.toHaveBeenCalled();
    expect(ctx.log!.error).toHaveBeenCalled();
  });
});

// ============ handle: 语音/视频/文件 ============

describe("MediaTagHandler.handle — 语音/视频/文件", () => {
  const handler = new MediaTagHandler();

  it("语音标签 → 中断流式 → sendMediaByType(voice) → 重建", async () => {
    const ctx = createMockContext("<qqvoice>/tmp/audio.silk</qqvoice>");
    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    expect(ctx.interruptStream).toHaveBeenCalled();
    expect(ctx.sendMediaByType).toHaveBeenCalledWith("voice", "/tmp/audio.silk");
    expect(ctx.rebuildStream).toHaveBeenCalled();
  });

  it("视频标签 → 中断流式 → sendMediaByType(video) → 重建", async () => {
    const ctx = createMockContext("<qqvideo>/tmp/clip.mp4</qqvideo>");
    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    expect(ctx.interruptStream).toHaveBeenCalled();
    expect(ctx.sendMediaByType).toHaveBeenCalledWith("video", "/tmp/clip.mp4");
    expect(ctx.rebuildStream).toHaveBeenCalled();
  });

  it("文件标签 → 中断流式 → sendMediaByType(file) → 重建", async () => {
    const ctx = createMockContext("<qqfile>/tmp/report.pdf</qqfile>");
    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    expect(ctx.interruptStream).toHaveBeenCalled();
    expect(ctx.sendMediaByType).toHaveBeenCalledWith("file", "/tmp/report.pdf");
    expect(ctx.rebuildStream).toHaveBeenCalled();
  });
});

// ============ handle: 混合场景 ============

describe("MediaTagHandler.handle — 混合场景", () => {
  const handler = new MediaTagHandler();

  it("标签前的文本应通过 sendStreamChunk 流式发送", async () => {
    const ctx = createMockContext("这是前缀文本<qqimg>/tmp/test.png</qqimg>");
    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    // 标签前的文本应该被发送
    expect(ctx.sendStreamChunk).toHaveBeenCalledWith("这是前缀文本", false);
    // 标签本身走本地图片路径
    expect(ctx.interruptStream).toHaveBeenCalled();
    expect(ctx.sendMediaByType).toHaveBeenCalledWith("image", "/tmp/test.png");
  });

  it("标签后的文本应保留在 buffer 中", async () => {
    const ctx = createMockContext("<qqimg>/tmp/test.png</qqimg>剩余文本");
    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    expect(result.newBuffer).toBe("剩余文本");
  });

  it("多个标签依次处理", async () => {
    const ctx = createMockContext(
      "文字A<qqimg>https://cdn.com/a.jpg</qqimg>文字B<qqvoice>/tmp/b.silk</qqvoice>结尾"
    );
    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    // 文字A → sendStreamChunk
    expect(ctx.sendStreamChunk).toHaveBeenCalledWith("文字A", false);
    // 图片 → sendImageAsMarkdown（公网 URL）
    expect(ctx.sendImageAsMarkdown).toHaveBeenCalledWith("https://cdn.com/a.jpg");
    // 文字B → sendStreamChunk
    expect(ctx.sendStreamChunk).toHaveBeenCalledWith("文字B", false);
    // 语音 → interruptStream + sendMediaByType + rebuildStream
    expect(ctx.sendMediaByType).toHaveBeenCalledWith("voice", "/tmp/b.silk");
    // 结尾文本留在 buffer
    expect(result.newBuffer).toBe("结尾");
  });

  it("公网图片 + 本地图片混合处理", async () => {
    const ctx = createMockContext(
      "<qqimg>https://example.com/online.jpg</qqimg><qqimg>/tmp/local.png</qqimg>"
    );
    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    // 公网 → sendImageAsMarkdown
    expect(ctx.sendImageAsMarkdown).toHaveBeenCalledWith("https://example.com/online.jpg");
    // 本地 → 中断流式
    expect(ctx.interruptStream).toHaveBeenCalled();
    expect(ctx.sendMediaByType).toHaveBeenCalledWith("image", "/tmp/local.png");
    expect(ctx.rebuildStream).toHaveBeenCalled();
  });

  it("sendStreamChunk 失败时标记 streamFailed 并 abort", async () => {
    const ctx = createMockContext("前缀文字<qqimg>/tmp/test.png</qqimg>", {
      sendStreamChunk: vi.fn().mockResolvedValue(false),
    });
    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    expect(result.abort).toBe(true);
    expect(ctx.streamFailed).toBe(true);
  });

  it("streamFailed 状态下不处理", async () => {
    const ctx = createMockContext("<qqimg>/tmp/test.png</qqimg>", {
      streamFailed: true,
    });
    const result = await handler.handle(ctx);

    expect(result.handled).toBe(false);
  });

  it("streamEnded 状态下不处理", async () => {
    const ctx = createMockContext("<qqimg>/tmp/test.png</qqimg>", {
      streamEnded: true,
    });
    const result = await handler.handle(ctx);

    expect(result.handled).toBe(false);
  });

  it("标签前纯空白文本应跳过（不发送空消息）", async () => {
    const ctx = createMockContext("   \n  <qqimg>/tmp/test.png</qqimg>");
    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    // 纯空白文本 trim() 后为空，不调用 sendStreamChunk
    expect(ctx.sendStreamChunk).not.toHaveBeenCalled();
  });
});

// ============ handle: normalize 纠错 ============

describe("MediaTagHandler.handle — 标签 normalize 纠错", () => {
  const handler = new MediaTagHandler();

  it("别名标签 <image>...<image> 被纠正为 qqimg", async () => {
    const ctx = createMockContext("<image>/tmp/test.jpg</image>");
    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    expect(ctx.interruptStream).toHaveBeenCalled();
    expect(ctx.sendMediaByType).toHaveBeenCalledWith("image", "/tmp/test.jpg");
  });

  it("中文尖括号被纠正", async () => {
    const ctx = createMockContext("＜qqimg＞/tmp/test.jpg＜/qqimg＞");
    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    expect(ctx.interruptStream).toHaveBeenCalled();
    expect(ctx.sendMediaByType).toHaveBeenCalledWith("image", "/tmp/test.jpg");
  });

  it("闭合标签不匹配被纠正", async () => {
    const ctx = createMockContext("<qqimg>/tmp/test.jpg</qqvoice>");
    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    expect(ctx.interruptStream).toHaveBeenCalled();
    expect(ctx.sendMediaByType).toHaveBeenCalledWith("image", "/tmp/test.jpg");
  });

  it("标签内多余空格被纠正", async () => {
    const ctx = createMockContext("< qqimg >/tmp/test.jpg</ qqimg >");
    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    expect(ctx.interruptStream).toHaveBeenCalled();
    expect(ctx.sendMediaByType).toHaveBeenCalledWith("image", "/tmp/test.jpg");
  });

  it("引号包裹路径被清理", async () => {
    const ctx = createMockContext('<qqimg>"/tmp/test.jpg"</qqimg>');
    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    expect(ctx.interruptStream).toHaveBeenCalled();
    expect(ctx.sendMediaByType).toHaveBeenCalledWith("image", "/tmp/test.jpg");
  });

  it("标签内换行被压缩", async () => {
    const ctx = createMockContext("<qqimg>\n  /tmp/\ntest.jpg\n</qqimg>");
    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    expect(ctx.interruptStream).toHaveBeenCalled();
    // normalize 后路径中的换行变成空格
    expect(ctx.sendMediaByType).toHaveBeenCalledWith("image", "/tmp/ test.jpg");
  });

  it("无媒体标签时不处理", async () => {
    const ctx = createMockContext("普通文本，没有任何标签");
    const result = await handler.handle(ctx);

    expect(result.handled).toBe(false);
    expect(result.newBuffer).toBe("普通文本，没有任何标签");
  });
});

// ============ handle: filterInternalMarkers ============

describe("MediaTagHandler.handle — 内部标记过滤", () => {
  const handler = new MediaTagHandler();

  it("标签前的 [[xxx: yyy]] 内部标记被过滤", async () => {
    const ctx = createMockContext("[[reply_to: ROBOT1.0_abc]]实际内容<qqimg>/tmp/test.png</qqimg>");
    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    // filterInternalMarkers 应移除 [[reply_to: ...]]
    expect(ctx.sendStreamChunk).toHaveBeenCalledWith("实际内容", false);
  });

  it("标签前仅有内部标记时跳过发送", async () => {
    const ctx = createMockContext("[[reply_to: ROBOT1.0_abc]]<qqimg>/tmp/test.png</qqimg>");
    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    // 过滤后为空，不发送
    expect(ctx.sendStreamChunk).not.toHaveBeenCalled();
  });
});

// ============ findSafePoint ============

describe("MediaTagHandler.findSafePoint", () => {
  const handler = new MediaTagHandler();

  it("纯文本返回全长", () => {
    expect(handler.findSafePoint("Hello world")).toBe(11);
  });

  it("完整标签返回标签前位置（阻止截断，留给 processBuffer 处理）", () => {
    const text = "前缀<qqimg>/path/file.png</qqimg>后缀";
    expect(handler.findSafePoint(text)).toBe("前缀".length);
  });

  it("只有完整标签（无前缀）返回 0", () => {
    const text = "<qqimg>/path/file.png</qqimg>";
    expect(handler.findSafePoint(text)).toBe(0);
  });

  it("不完整开始标签 '<qqimg' 在 '<' 前截断", () => {
    const text = "Hello world<qqimg";
    expect(handler.findSafePoint(text)).toBe("Hello world".length);
  });

  it("不完整开始标签 '<qq' 在 '<' 前截断", () => {
    const text = "Hello<qq";
    expect(handler.findSafePoint(text)).toBe("Hello".length);
  });

  it("有开始标签但内容未闭合 → 在开始标签前截断", () => {
    const text = "前缀<qqimg>/path/to/file";
    expect(handler.findSafePoint(text)).toBe("前缀".length);
  });

  it("闭合标签被截断 '</qq' → 向前回溯到开始标签前截断", () => {
    const text = "文字<qqimg>/path/file.png</qq";
    const safePoint = handler.findSafePoint(text);
    expect(safePoint).toBeLessThan(text.length);
    const safe = text.slice(0, safePoint);
    expect(safe).not.toContain("<qqimg>");
  });

  it("不完整的 qqvideo 标签 → 截断", () => {
    const text = "文字<qqvideo";
    expect(handler.findSafePoint(text)).toBe("文字".length);
  });

  it("不完整的 qqvoice 标签 → 截断", () => {
    const text = "文字<qqvoice>/path/audio";
    expect(handler.findSafePoint(text)).toBe("文字".length);
  });

  it("不完整的 qqfile 标签 → 截断", () => {
    const text = "文字<qqfile>/doc";
    expect(handler.findSafePoint(text)).toBe("文字".length);
  });

  it("空字符串返回 0", () => {
    expect(handler.findSafePoint("")).toBe(0);
  });

  it("完整标签后跟不完整标签 → 在完整标签前截断", () => {
    const text = "已完成<qqimg>/a.png</qqimg>未完成<qqim";
    const safePoint = handler.findSafePoint(text);
    // 完整标签也需要保护（留给 processBuffer），安全点在第一个标签前
    expect(safePoint).toBe("已完成".length);
  });
});

// ============ 与 StreamHandlerChain 集成 ============

describe("MediaTagHandler — 与责任链集成", () => {
  it("MediaTagHandler.findSafePoint 限制 chain 的 safeFlushPoint", async () => {
    // 直接导入 chain 和相关 handler
    const { StreamHandlerChain } = await import("../../src/stream-handlers/chain.js");
    const { BracketSafeHandler } = await import("../../src/stream-handlers/bracket-safe-handler.js");

    const chain = new StreamHandlerChain();
    const mediaHandler = new MediaTagHandler();
    const bracketHandler = new BracketSafeHandler();
    chain.register(mediaHandler).register(bracketHandler);

    // 不完整媒体标签 → MediaTagHandler 返回较小的 safePoint
    // chain 取最小值
    const buffer = "一些正常文本，有分隔符。<qqimg>/path/to/image";
    const safePoint = chain.findSafeFlushPoint(buffer);

    // MediaTagHandler 应该在 <qqimg> 前截断
    const safe = buffer.slice(0, safePoint);
    expect(safe).not.toContain("<qqimg>");
  });

  it("完整媒体标签 → findSafeFlushPoint 返回标签前位置（阻止截断，留给 processBuffer）", async () => {
    const { StreamHandlerChain } = await import("../../src/stream-handlers/chain.js");

    const chain = new StreamHandlerChain();
    const mediaHandler = new MediaTagHandler();
    chain.register(mediaHandler);

    // 完整标签，safeFlushPoint 应该在标签前截断
    const buffer = "文字<qqimg>/tmp/test.png</qqimg>结尾";
    const safePoint = chain.findSafeFlushPoint(buffer);
    expect(safePoint).toBe("文字".length);
  });

  it("processBuffer 处理完整标签后更新 buffer", async () => {
    const { StreamHandlerChain } = await import("../../src/stream-handlers/chain.js");

    const chain = new StreamHandlerChain();
    const mediaHandler = new MediaTagHandler();
    chain.register(mediaHandler);

    const ctx = createMockContext("前缀<qqimg>/tmp/test.png</qqimg>后缀");
    const processResult = await chain.processBuffer(ctx);

    expect(processResult.handled).toBe(true);
    // 标签前的文本被发送，标签后的文本留在 buffer
    expect(processResult.buffer).toBe("后缀");
  });
});

// ============ 端到端：公网图片 URL → markdown 图片语法 ============

describe("MediaTagHandler — 公网图片 URL → markdown 图片输出", () => {
  const handler = new MediaTagHandler();

  /**
   * 模拟 gateway.ts 中 sendImageAsMarkdown 的真实实现：
   *   1. 获取图片尺寸（这里 mock 返回固定尺寸或 null）
   *   2. 调用 formatQQBotMarkdownImage 生成 ![#宽px #高px](url)
   *   3. 通过 sendStreamChunk 发送
   */
  function createContextWithRealMarkdown(
    buffer: string,
    imageSize: { width: number; height: number } | null = null,
  ): StreamHandlerContext {
    const sendStreamChunk = vi.fn().mockResolvedValue(true);

    return {
      buffer,
      accountId: "test-account",
      streamStarted: false,
      streamEnded: false,
      streamFailed: false,
      pendingPayloadText: "",
      sendStreamChunk,
      interruptStream: vi.fn().mockResolvedValue(undefined),
      rebuildStream: vi.fn(),
      sendMediaByType: vi.fn().mockResolvedValue(undefined),
      // 模拟 gateway 中的真实 sendImageAsMarkdown
      sendImageAsMarkdown: vi.fn(async (imagePath: string): Promise<boolean> => {
        const mdImage = formatQQBotMarkdownImage(imagePath, imageSize);
        return await sendStreamChunk("\n" + mdImage + "\n", false);
      }),
      log: { info: vi.fn(), error: vi.fn() },
    };
  }

  it("公网 URL 应输出 ![#宽px #高px](url) 格式（有尺寸）", async () => {
    const url = "https://example.com/photo.png";
    const ctx = createContextWithRealMarkdown(
      `<qqimg>${url}</qqimg>`,
      { width: 800, height: 600 },
    );

    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    expect(ctx.sendImageAsMarkdown).toHaveBeenCalledWith(url);
    // 验证 sendStreamChunk 收到的是 markdown 图片语法
    expect(ctx.sendStreamChunk).toHaveBeenCalledTimes(1);
    const sentText = (ctx.sendStreamChunk as any).mock.calls[0][0] as string;
    expect(sentText).toContain(`![#800px #600px](${url})`);
    // 验证前后有换行包裹
    expect(sentText).toBe(`\n![#800px #600px](${url})\n`);
  });

  it("公网 URL 应输出 ![#宽px #高px](url) 格式（无尺寸，使用默认 512x512）", async () => {
    const url = "https://cdn.example.com/images/abc.jpg";
    const ctx = createContextWithRealMarkdown(
      `<qqimg>${url}</qqimg>`,
      null, // 无法获取尺寸
    );

    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    expect(ctx.sendStreamChunk).toHaveBeenCalledTimes(1);
    const sentText = (ctx.sendStreamChunk as any).mock.calls[0][0] as string;
    // 默认尺寸 512x512
    expect(sentText).toBe(`\n![#512px #512px](${url})\n`);
  });

  it("前缀文字 + 公网图片 → 先发文字，再发 markdown 图片", async () => {
    const url = "https://example.com/sunset.jpg";
    const ctx = createContextWithRealMarkdown(
      `看看这张照片<qqimg>${url}</qqimg>`,
      { width: 1920, height: 1080 },
    );

    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    // 第一次调用：发送标签前文字
    expect(ctx.sendStreamChunk).toHaveBeenCalledWith("看看这张照片", false);
    // 第二次调用：发送 markdown 图片（由 sendImageAsMarkdown 内部调用）
    expect(ctx.sendStreamChunk).toHaveBeenCalledTimes(2);
    const mdCall = (ctx.sendStreamChunk as any).mock.calls[1][0] as string;
    expect(mdCall).toBe(`\n![#1920px #1080px](${url})\n`);
  });

  it("多个公网图片 → 每个都生成独立的 markdown 图片", async () => {
    const url1 = "https://example.com/a.png";
    const url2 = "https://example.com/b.jpg";
    const ctx = createContextWithRealMarkdown(
      `图1<qqimg>${url1}</qqimg>图2<qqimg>${url2}</qqimg>`,
      { width: 256, height: 256 },
    );

    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    // sendImageAsMarkdown 应被调用两次
    expect(ctx.sendImageAsMarkdown).toHaveBeenCalledTimes(2);
    expect(ctx.sendImageAsMarkdown).toHaveBeenCalledWith(url1);
    expect(ctx.sendImageAsMarkdown).toHaveBeenCalledWith(url2);

    // sendStreamChunk 调用：文字1 + 图片1 + 文字2 + 图片2 = 4 次
    expect(ctx.sendStreamChunk).toHaveBeenCalledTimes(4);

    // 验证每个图片的 markdown 格式
    const calls = (ctx.sendStreamChunk as any).mock.calls;
    expect(calls[0][0]).toBe("图1");
    expect(calls[1][0]).toBe(`\n![#256px #256px](${url1})\n`);
    expect(calls[2][0]).toBe("图2");
    expect(calls[3][0]).toBe(`\n![#256px #256px](${url2})\n`);
  });

  it("别名标签 <image> 公网 URL → 同样输出 markdown 图片", async () => {
    const url = "https://example.com/photo.png";
    const ctx = createContextWithRealMarkdown(
      `<image>${url}</image>`,
      { width: 640, height: 480 },
    );

    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    expect(ctx.sendStreamChunk).toHaveBeenCalledTimes(1);
    const sentText = (ctx.sendStreamChunk as any).mock.calls[0][0] as string;
    expect(sentText).toBe(`\n![#640px #480px](${url})\n`);
  });

  it("5 个公网图片用换行分隔 → 全部处理，每个都发送 markdown 图片", async () => {
    const urls = [
      "https://picsum.photos/800/600?random=100",
      "https://picsum.photos/800/600?random=101",
      "https://picsum.photos/800/600?random=102",
      "https://picsum.photos/800/600?random=103",
      "https://picsum.photos/800/600?random=104",
    ];
    // 模拟 AI 生成的消息：每个图片标签之间用 \n\n 分隔
    const buffer = urls
      .map(url => `<qqimg>${url}</qqimg>`)
      .join("\n\n");
    const ctx = createContextWithRealMarkdown(buffer, { width: 800, height: 600 });

    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    // 5 个公网图片 → sendImageAsMarkdown 调用 5 次
    expect(ctx.sendImageAsMarkdown).toHaveBeenCalledTimes(5);
    for (const url of urls) {
      expect(ctx.sendImageAsMarkdown).toHaveBeenCalledWith(url);
    }
    // 不中断流式（公网图片走 markdown 嵌入）
    expect(ctx.interruptStream).not.toHaveBeenCalled();
    expect(ctx.sendMediaByType).not.toHaveBeenCalled();

    // sendStreamChunk 调用次数：
    // 图片1（无前缀文字） + 图片间的换行文字4次 + 图片5次 = 最多 9 次
    // 但 "\n\n" trim() 后为空，所以换行文字会被跳过
    // 实际只有 5 次（每个图片的 markdown）
    expect(ctx.sendStreamChunk).toHaveBeenCalledTimes(5);

    // 验证每个图片的 markdown 格式
    const calls = (ctx.sendStreamChunk as any).mock.calls;
    for (let i = 0; i < 5; i++) {
      expect(calls[i][0]).toBe(`\n![#800px #600px](${urls[i]})\n`);
    }

    // 最后一个标签后没有剩余文本
    expect(result.newBuffer).toBe("");
  });

  it("5 个公网图片用换行分隔 + 简单 mock → 全部发送 sendImageAsMarkdown", async () => {
    const urls = [
      "https://picsum.photos/800/600?random=100",
      "https://picsum.photos/800/600?random=101",
      "https://picsum.photos/800/600?random=102",
      "https://picsum.photos/800/600?random=103",
      "https://picsum.photos/800/600?random=104",
    ];
    const buffer = urls
      .map(url => `<qqimg>${url}</qqimg>`)
      .join("\n\n");
    const ctx = createMockContext(buffer);

    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    expect(ctx.sendImageAsMarkdown).toHaveBeenCalledTimes(5);
    for (const url of urls) {
      expect(ctx.sendImageAsMarkdown).toHaveBeenCalledWith(url);
    }
    // 换行间隔 trim() 后为空 → 不发送文本块
    expect(ctx.sendStreamChunk).not.toHaveBeenCalled();
    // 不走中断流式路径
    expect(ctx.interruptStream).not.toHaveBeenCalled();
    expect(result.newBuffer).toBe("");
  });

  it("5 个公网图片 + 图片间有文字描述 → 文字和图片交替发送", async () => {
    const buffer =
      "第一张：<qqimg>https://picsum.photos/800/600?random=100</qqimg>\n\n" +
      "第二张：<qqimg>https://picsum.photos/800/600?random=101</qqimg>\n\n" +
      "第三张：<qqimg>https://picsum.photos/800/600?random=102</qqimg>";
    const ctx = createMockContext(buffer);

    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    // 3 张图片
    expect(ctx.sendImageAsMarkdown).toHaveBeenCalledTimes(3);
    // 3 段文字（"第一张："、"\n\n第二张："、"\n\n第三张："）
    expect(ctx.sendStreamChunk).toHaveBeenCalledTimes(3);
    expect(ctx.sendStreamChunk).toHaveBeenCalledWith("第一张：", false);
    // 不中断流式
    expect(ctx.interruptStream).not.toHaveBeenCalled();
    expect(result.newBuffer).toBe("");
  });

  it("图片 URL 后有剩余文字 → markdown 图片发出后，剩余文字留在 buffer", async () => {
    const url = "https://example.com/cat.gif";
    const ctx = createContextWithRealMarkdown(
      `<qqimg>${url}</qqimg>好可爱！`,
      { width: 320, height: 240 },
    );

    const result = await handler.handle(ctx);

    expect(result.handled).toBe(true);
    expect(result.newBuffer).toBe("好可爱！");

    expect(ctx.sendStreamChunk).toHaveBeenCalledTimes(1);
    const sentText = (ctx.sendStreamChunk as any).mock.calls[0][0] as string;
    expect(sentText).toBe(`\n![#320px #240px](${url})\n`);
  });
});
