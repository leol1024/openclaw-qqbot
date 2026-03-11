/**
 * MarkdownLinkHandler —— Markdown 链接安全截断处理器
 *
 * 检测 buffer 末尾是否存在不完整的 markdown 链接 [text](url)，
 * 返回安全截断位置。不主动处理（canHandle 始终返回 false）。
 *
 * 需要保护的不完整状态：
 *   a. [text           — [ 未闭合
 *   b. [text](url      — ]( 后面的 URL 未闭合（缺少 )）
 *   c. [text](         — 刚开始 URL 部分
 *   d. ![alt](url      — markdown 图片的不完整状态
 *
 * 注意：代码块 ```、行内代码 `、加粗 ** 等不需要等待闭合，
 * QQ 客户端能正确处理这些不完整的 markdown 片段。
 */

import type { StreamHandler, StreamHandlerContext, HandleResult } from "./types.js";

export class MarkdownLinkHandler implements StreamHandler {
  readonly name = "MarkdownLinkHandler";

  /**
   * 不主动处理 —— markdown 链接只做被动阻断
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
   * 检测 buffer 末尾是否有不完整的 markdown 链接
   * 返回安全截断点
   *
   * 从 gateway.ts 的 findSafeFlushPoint 中提取的 markdown 链接部分逻辑
   */
  findSafePoint(buffer: string): number {
    const len = buffer.length;
    if (len === 0) return 0;

    // 从后往前搜索，限制回溯范围（URL 最长 2048 + 链接文字最长 256）
    const MAX_LINK_SCAN = Math.min(len, 2400);
    const scanStart = len - MAX_LINK_SCAN;

    // ---- 检查 1: 是否有未闭合的 ]( —— URL 部分正在生成中 ----
    let linkUrlStart = -1;
    for (let i = len - 1; i >= scanStart + 1; i--) {
      if (buffer[i] === '(' && buffer[i - 1] === ']') {
        // 检查这个 ]( 后面是否有匹配的 )
        const afterParen = buffer.slice(i + 1);
        if (!afterParen.includes(')')) {
          linkUrlStart = i - 1; // 指向 ] 的位置
          break;
        }
        // 有 )，这个链接是完整的，不需要保护
        break;
      }
    }

    if (linkUrlStart >= 0) {
      // URL 部分未闭合，往前找对应的 [（跳过嵌套的 []）
      let depth = 0;
      for (let i = linkUrlStart - 1; i >= scanStart; i--) {
        if (buffer[i] === ']') depth++;
        else if (buffer[i] === '[') {
          if (depth > 0) { depth--; }
          else {
            // 找到匹配的 [，检查前面是否有 !（markdown 图片）
            const cutPos = (i > 0 && buffer[i - 1] === '!') ? i - 1 : i;
            return cutPos; // 在 [ 或 ![ 前截断
          }
        }
      }
      return linkUrlStart; // 找不到 [，在 ] 处截断
    }

    // ---- 检查 2: 是否有未闭合的 [ —— 链接文字正在生成中 ----
    let bracketDepth = 0;
    let lastOpenBracket = -1;
    for (let i = len - 1; i >= scanStart; i--) {
      const ch = buffer[i];
      if (ch === ')') {
        // 遇到 )，可能是一个完整链接的结尾，跳过整个链接
        // 往前找匹配的 ](
        let j = i - 1;
        while (j >= scanStart && buffer[j] !== '(') j--;
        if (j >= scanStart + 1 && buffer[j] === '(' && buffer[j - 1] === ']') {
          // 找到 ](，再往前找 [
          let d = 0;
          let k = j - 2;
          while (k >= scanStart) {
            if (buffer[k] === ']') d++;
            else if (buffer[k] === '[') {
              if (d > 0) d--;
              else {
                i = k; // 跳过整个完整链接
                break;
              }
            }
            k--;
          }
        }
        continue;
      }
      if (ch === ']') {
        bracketDepth++;
      } else if (ch === '[') {
        if (bracketDepth > 0) {
          bracketDepth--;
        } else {
          // 未闭合的 '['
          lastOpenBracket = i;
          break;
        }
      }
    }

    if (lastOpenBracket >= 0) {
      // 有未闭合的 [，检查前面是否有 !（markdown 图片 ![）
      const cutPos = (lastOpenBracket > 0 && buffer[lastOpenBracket - 1] === '!')
        ? lastOpenBracket - 1
        : lastOpenBracket;
      return cutPos;
    }

    // 全部安全
    return len;
  }
}
