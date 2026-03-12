/**
 * MediaTagHandler —— 富媒体标签处理器
 *
 * 职责：
 * 1. canHandle + handle：检测 buffer 中完整的 <qqXXX>...</qqXXX> 标签，
 *    按序处理：标签前文本流式发送 → 中断流式 → 发送富媒体 → 重建流式 → 剩余留 buffer
 * 2. findSafePoint：检测不完整的媒体标签，返回安全截断点
 *
 * 图片在流式场景有特殊处理：
 * - 公网 URL → 通过 ctx.sendImageAsMarkdown 嵌入流式（不中断）
 * - 本地文件 → 中断流式 → 富媒体 API → 重建
 */

import type { StreamHandler, StreamHandlerContext, HandleResult } from "./types.js";
import {
  normalizeMediaTags,
  MEDIA_TAG_REGEX,
  findMediaTagSafePoint,
  decodeMediaPath,
  tagNameToQueueType,
  filterInternalMarkers,
} from "../utils/media-tags.js";
import { normalizePath, isLocalPath as isLocalFilePath } from "../utils/platform.js";

export class MediaTagHandler implements StreamHandler {
  readonly name = "MediaTagHandler";

  /**
   * 检测 buffer 中是否有完整的媒体标签
   */
  canHandle(buffer: string): boolean {
    // 先 normalize 后检测
    const normalized = normalizeMediaTags(buffer);
    const regex = new RegExp(MEDIA_TAG_REGEX.source, MEDIA_TAG_REGEX.flags);
    return regex.test(normalized);
  }

  /**
   * 处理 buffer 中所有完整的媒体标签
   *
   * 处理流程：
   * 1. normalize buffer（修正小模型拼写错误）
   * 2. 遍历所有完整标签：
   *    a. 标签前文本 → 通过 sendStreamChunk 流式发送
   *    b. 图片（公网 URL）→ sendImageAsMarkdown 嵌入流式
   *    c. 图片（本地文件）/ 语音 / 视频 / 文件 → interruptStream → sendMediaByType → rebuildStream
   * 3. 标签后剩余文本留在 buffer
   */
  async handle(ctx: StreamHandlerContext): Promise<HandleResult> {
    if (ctx.streamFailed || ctx.streamEnded) {
      return { handled: false, newBuffer: ctx.buffer };
    }

    // normalize buffer
    ctx.buffer = normalizeMediaTags(ctx.buffer);

    const regex = new RegExp(MEDIA_TAG_REGEX.source, MEDIA_TAG_REGEX.flags);
    const matches = [...ctx.buffer.matchAll(regex)];
    ctx.log?.info(`[qqbot:${ctx.accountId}] [MediaTagHandler] matches=${matches.length}, buffer=${JSON.stringify(ctx.buffer)}`);

    if (matches.length === 0) {
      return { handled: false, newBuffer: ctx.buffer };
    }

    let lastIndex = 0;

    for (const match of matches) {
      // 1. 发送标签前的纯文本（通过流式）
      const textBefore = ctx.buffer.slice(lastIndex, match.index);
      if (textBefore.trim()) {
        const filteredText = filterInternalMarkers(textBefore);
        if (filteredText) {
          const success = await ctx.sendStreamChunk(filteredText, false);
          if (!success) {
            ctx.streamFailed = true;
            return { handled: true, newBuffer: ctx.buffer.slice(lastIndex), abort: true };
          }
          ctx.streamStarted = true;
        }
      }

      // 2. 处理富媒体标签
      const tagName = match[1]!.toLowerCase();
      const rawPath = match[2] ?? "";
      const mediaPath = decodeMediaPath(rawPath);

      if (mediaPath) {
        const mediaType = tagNameToQueueType(tagName);

        if (mediaType === "image") {
          // 图片特殊处理
          const imagePath = normalizePath(mediaPath);
          const isHttpUrl = imagePath.startsWith("http://") || imagePath.startsWith("https://");
          const isLocalPath = isLocalFilePath(imagePath);

          if (isHttpUrl && ctx.sendImageAsMarkdown) {
            // 公网 URL → markdown 图片嵌入流式（不中断）
            const success = await ctx.sendImageAsMarkdown(imagePath);
            if (!success) {
              ctx.streamFailed = true;
              return { handled: true, newBuffer: ctx.buffer.slice(lastIndex), abort: true };
            }
            ctx.streamStarted = true;
          } else if (isLocalPath) {
            // 本地图片 → 中断流式 → 富媒体 API → 重建
            await ctx.interruptStream();
            try {
              await ctx.sendMediaByType("image", mediaPath);
            } catch (err) {
              ctx.log?.error(`[qqbot:${ctx.accountId}] [MediaTagHandler] image send failed (caught in handler): ${err}`);
            }
            ctx.rebuildStream();
          } else {
            ctx.log?.error(`[qqbot:${ctx.accountId}] [MediaTagHandler] Invalid image path: ${imagePath}`);
          }
        } else {
          // 语音/视频/文件 → 中断流式 → 发送 → 重建
          ctx.log?.info(`[qqbot:${ctx.accountId}] [MediaTagHandler] ${mediaType} tag, interrupting stream`);
          await ctx.interruptStream();
          try {
            await ctx.sendMediaByType(mediaType, mediaPath);
          } catch (err) {
            ctx.log?.error(`[qqbot:${ctx.accountId}] [MediaTagHandler] ${mediaType} send failed (caught in handler): ${err}`);
          }
          ctx.rebuildStream();
        }
      }

      lastIndex = match.index! + match[0].length;
    }

    // 3. 标签后的剩余文本留在 buffer
    const remaining = ctx.buffer.slice(lastIndex);
    ctx.log?.info(`[qqbot:${ctx.accountId}] [MediaTagHandler] done, remaining buffer=${JSON.stringify(remaining)}`);

    return { handled: true, newBuffer: remaining };
  }

  /**
   * 检测不完整媒体标签的安全截断点
   * 复用 media-tags.ts 中的 findMediaTagSafePoint
   */
  findSafePoint(buffer: string): number {
    return findMediaTagSafePoint(buffer);
  }
}
