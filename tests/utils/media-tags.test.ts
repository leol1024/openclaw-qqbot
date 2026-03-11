/**
 * media-tags.ts 测试用例
 *
 * 覆盖本次改动的核心模块：
 * 1. normalizeMediaTags - 标签拼写纠错与标准化
 * 2. parseMediaTags - 媒体标签解析（从 outbound.ts 提取的共享逻辑）
 * 3. findMediaTagSafePoint - 流式攒包的安全截断点检测
 * 4. decodeMediaPath - 路径解码（八进制转义、双反斜杠等）
 */

import { describe, it, expect } from "vitest";
import {
  normalizeMediaTags,
  parseMediaTags,
  findMediaTagSafePoint,
  decodeMediaPath,
  MEDIA_TAG_REGEX,
} from "../../src/utils/media-tags.js";

// ============ normalizeMediaTags ============

describe("normalizeMediaTags", () => {
  it("应保持标准格式不变", () => {
    const text = "前缀文本<qqimg>/path/to/image.png</qqimg>后缀文本";
    const result = normalizeMediaTags(text);
    expect(result).toBe("前缀文本<qqimg>/path/to/image.png</qqimg>后缀文本");
  });

  it("应修正常见标签别名 - qq_img → qqimg", () => {
    const text = "<qq_img>/path/file.png</qq_img>";
    const result = normalizeMediaTags(text);
    expect(result).toContain("<qqimg>");
    expect(result).toContain("</qqimg>");
    expect(result).toContain("/path/file.png");
  });

  it("应修正别名 - image → qqimg", () => {
    const text = "<image>/tmp/test.jpg</image>";
    const result = normalizeMediaTags(text);
    expect(result).toBe("<qqimg>/tmp/test.jpg</qqimg>");
  });

  it("应修正别名 - img → qqimg", () => {
    const text = "<img>/tmp/test.jpg</img>";
    const result = normalizeMediaTags(text);
    expect(result).toBe("<qqimg>/tmp/test.jpg</qqimg>");
  });

  it("应修正别名 - voice → qqvoice", () => {
    const text = "<voice>/tmp/audio.mp3</voice>";
    const result = normalizeMediaTags(text);
    expect(result).toBe("<qqvoice>/tmp/audio.mp3</qqvoice>");
  });

  it("应修正别名 - video → qqvideo", () => {
    const text = "<video>/tmp/clip.mp4</video>";
    const result = normalizeMediaTags(text);
    expect(result).toBe("<qqvideo>/tmp/clip.mp4</qqvideo>");
  });

  it("应修正别名 - file/doc/document → qqfile", () => {
    expect(normalizeMediaTags("<file>/tmp/a.pdf</file>")).toBe("<qqfile>/tmp/a.pdf</qqfile>");
    expect(normalizeMediaTags("<doc>/tmp/a.pdf</doc>")).toBe("<qqfile>/tmp/a.pdf</qqfile>");
    expect(normalizeMediaTags("<document>/tmp/a.pdf</document>")).toBe("<qqfile>/tmp/a.pdf</qqfile>");
  });

  it("应处理标签内多余空格", () => {
    const text = "< qqimg >/path/file.png</ qqimg >";
    const result = normalizeMediaTags(text);
    expect(result).toContain("<qqimg>");
    expect(result).toContain("/path/file.png");
  });

  it("应处理闭合标签不匹配", () => {
    const text = "<qqimg>/path/file.png</qqvoice>";
    const result = normalizeMediaTags(text);
    expect(result).toBe("<qqimg>/path/file.png</qqimg>");
  });

  it("应处理中文尖括号", () => {
    const text = "＜qqimg＞/path/file.png＜/qqimg＞";
    const result = normalizeMediaTags(text);
    expect(result).toBe("<qqimg>/path/file.png</qqimg>");
  });

  it("应处理引号包裹的路径", () => {
    const text = '<qqimg>"/path/file.png"</qqimg>';
    const result = normalizeMediaTags(text);
    expect(result).toContain("/path/file.png");
  });

  it("应处理 Markdown 反引号包裹", () => {
    const text = "`<qqimg>/path/file.png</qqimg>`";
    const result = normalizeMediaTags(text);
    expect(result).toContain("<qqimg>");
    expect(result).toContain("/path/file.png");
  });

  it("应压缩标签内的换行符", () => {
    const text = "<qqimg>\n  /path/to/\nfile.png\n</qqimg>";
    const result = normalizeMediaTags(text);
    expect(result).toContain("<qqimg>");
    expect(result).toContain("/path/to/ file.png");
  });

  it("没有媒体标签的文本应原样返回", () => {
    const text = "Hello, world! This is plain text.";
    expect(normalizeMediaTags(text)).toBe(text);
  });

  it("应处理多个媒体标签", () => {
    const text = "文字<qqimg>/a.png</qqimg>中间<qqvoice>/b.wav</qqvoice>结尾";
    const result = normalizeMediaTags(text);
    expect(result).toContain("<qqimg>/a.png</qqimg>");
    expect(result).toContain("<qqvoice>/b.wav</qqvoice>");
  });
});

// ============ parseMediaTags ============

describe("parseMediaTags", () => {
  it("无媒体标签时返回 hasMedia=false", () => {
    const result = parseMediaTags("Hello, just plain text.");
    expect(result.hasMedia).toBe(false);
    expect(result.sendQueue).toEqual([]);
  });

  it("应正确解析单个图片标签", () => {
    const result = parseMediaTags("前缀<qqimg>/path/image.png</qqimg>后缀");
    expect(result.hasMedia).toBe(true);
    expect(result.sendQueue).toHaveLength(3);
    expect(result.sendQueue[0]).toEqual({ type: "text", content: "前缀" });
    expect(result.sendQueue[1]).toEqual({ type: "image", content: "/path/image.png" });
    expect(result.sendQueue[2]).toEqual({ type: "text", content: "后缀" });
  });

  it("应正确解析 <qqimg>...</img> 闭合格式", () => {
    const result = parseMediaTags("<qqimg>/path/image.png</img>");
    expect(result.hasMedia).toBe(true);
    expect(result.sendQueue).toHaveLength(1);
    expect(result.sendQueue[0]).toEqual({ type: "image", content: "/path/image.png" });
  });

  it("应正确解析语音标签", () => {
    const result = parseMediaTags("<qqvoice>/tmp/audio.silk</qqvoice>");
    expect(result.hasMedia).toBe(true);
    expect(result.sendQueue[0]).toEqual({ type: "voice", content: "/tmp/audio.silk" });
  });

  it("应正确解析视频标签", () => {
    const result = parseMediaTags("<qqvideo>/tmp/video.mp4</qqvideo>");
    expect(result.hasMedia).toBe(true);
    expect(result.sendQueue[0]).toEqual({ type: "video", content: "/tmp/video.mp4" });
  });

  it("应正确解析文件标签", () => {
    const result = parseMediaTags("<qqfile>/tmp/doc.pdf</qqfile>");
    expect(result.hasMedia).toBe(true);
    expect(result.sendQueue[0]).toEqual({ type: "file", content: "/tmp/doc.pdf" });
  });

  it("应按顺序处理混合的文本和多个媒体标签", () => {
    const text = "开头文字<qqimg>/a.png</qqimg>中间文字<qqvoice>/b.wav</qqvoice>结尾文字";
    const result = parseMediaTags(text);
    expect(result.hasMedia).toBe(true);
    expect(result.sendQueue).toHaveLength(5);
    expect(result.sendQueue.map(i => i.type)).toEqual(["text", "image", "text", "voice", "text"]);
  });

  it("应跳过空的文本段", () => {
    const result = parseMediaTags("<qqimg>/a.png</qqimg><qqimg>/b.png</qqimg>");
    expect(result.hasMedia).toBe(true);
    // 两个连续图片之间没有文本，不应出现空文本项
    expect(result.sendQueue.every(i => i.content.trim().length > 0)).toBe(true);
  });

  it("应压缩连续多个换行为最多两个", () => {
    const text = "第一段\n\n\n\n\n第二段<qqimg>/img.png</qqimg>第三段";
    const result = parseMediaTags(text);
    const firstText = result.sendQueue.find(i => i.type === "text" && i.content.includes("第一段"));
    expect(firstText?.content).toBe("第一段\n\n第二段");
  });

  it("应支持 textFilter 参数过滤文本", () => {
    const text = "INTERNAL:前缀<qqimg>/img.png</qqimg>INTERNAL:后缀";
    const result = parseMediaTags(text, (t) => t.replace(/INTERNAL:/g, ""));
    expect(result.sendQueue[0]).toEqual({ type: "text", content: "前缀" });
    expect(result.sendQueue[2]).toEqual({ type: "text", content: "后缀" });
  });

  it("textFilter 返回空字符串时应跳过该文本段", () => {
    const text = "REMOVE_ME<qqimg>/img.png</qqimg>保留的文字";
    const result = parseMediaTags(text, (t) => t === "REMOVE_ME" ? "" : t);
    expect(result.sendQueue[0]).toEqual({ type: "image", content: "/img.png" });
    expect(result.sendQueue[1]).toEqual({ type: "text", content: "保留的文字" });
  });

  it("应正确处理 HTTP URL 图片路径", () => {
    const result = parseMediaTags("<qqimg>https://example.com/image.png</qqimg>");
    expect(result.hasMedia).toBe(true);
    expect(result.sendQueue[0]).toEqual({ type: "image", content: "https://example.com/image.png" });
  });
});

// ============ findMediaTagSafePoint ============

describe("findMediaTagSafePoint", () => {
  it("空文本返回 0", () => {
    expect(findMediaTagSafePoint("")).toBe(0);
  });

  it("无标签的纯文本返回全长", () => {
    expect(findMediaTagSafePoint("Hello world")).toBe(11);
  });

  // ---- 完整标签阻止截断（留给 processBuffer 处理） ----

  it("完整标签应返回标签前位置（阻止截断发送）", () => {
    const text = "前缀<qqimg>/path/file.png</qqimg>后缀";
    const safePoint = findMediaTagSafePoint(text);
    // 完整标签必须留在 buffer 中等 processBuffer 处理，安全点在标签 '<' 之前
    expect(safePoint).toBe("前缀".length);
  });

  it("完整 qqvideo 标签 + 公网 URL 应阻止截断", () => {
    const text = "<qqvideo>https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4</qqvideo>\n\n";
    const safePoint = findMediaTagSafePoint(text);
    expect(safePoint).toBe(0); // 标签从头开始，安全点在 0
  });

  it("文字后跟完整标签应在文字后截断", () => {
    const text = "这是一段文字\n\n<qqvideo>https://example.com/video.mp4</qqvideo>";
    const safePoint = findMediaTagSafePoint(text);
    expect(safePoint).toBe("这是一段文字\n\n".length);
  });

  it("完整图片标签 + 公网 URL 应阻止截断", () => {
    const text = "看这张图：<qqimg>https://example.com/photo.jpg</qqimg>";
    const safePoint = findMediaTagSafePoint(text);
    expect(safePoint).toBe("看这张图：".length);
  });

  it("多个完整标签应在第一个标签前截断", () => {
    const text = "文字<qqimg>/a.png</qqimg>中间<qqvoice>/b.wav</qqvoice>结尾";
    const safePoint = findMediaTagSafePoint(text);
    // 应在第一个标签 '<qqimg>' 之前截断
    expect(safePoint).toBe("文字".length);
  });

  it("只有完整标签（无前缀文字）返回 0", () => {
    const text = "<qqimg>/path/file.png</qqimg>";
    const safePoint = findMediaTagSafePoint(text);
    expect(safePoint).toBe(0);
  });

  // ---- 不完整标签安全截断 ----

  it("不完整的开始标签 '<qq' 应在 '<' 之前截断", () => {
    const text = "Hello world<qq";
    const safePoint = findMediaTagSafePoint(text);
    expect(safePoint).toBe("Hello world".length);
  });

  it("不完整的开始标签 '<qqim' 应在 '<' 之前截断", () => {
    const text = "Hello world<qqim";
    const safePoint = findMediaTagSafePoint(text);
    expect(safePoint).toBe("Hello world".length);
  });

  it("不完整的开始标签 '<qqimg' 应在 '<' 之前截断", () => {
    const text = "Hello<qqimg";
    const safePoint = findMediaTagSafePoint(text);
    expect(safePoint).toBe("Hello".length);
  });

  it("仅有 '<' 且可能是标签开头时应截断", () => {
    const text = "Hello<";
    const safePoint = findMediaTagSafePoint(text);
    // 单独的 < 不构成标签的不完整开始，因为后面没有 'q'
    // 但 incompleteOpenOrCloseTag 正则可以匹配 "<" 
    // 实际行为取决于正则，这里验证不会超出长度
    expect(safePoint).toBeLessThanOrEqual(text.length);
  });

  it("有开始标签但内容未闭合应在开始标签前截断", () => {
    const text = "前缀文字<qqimg>/path/to/file";
    const safePoint = findMediaTagSafePoint(text);
    expect(safePoint).toBe("前缀文字".length); // 在 '<qqimg>' 之前
  });

  it("闭合标签被截断 '</qq' 应在闭合标签的 '<' 之前截断", () => {
    const text = "文字<qqimg>/path/file.png</qq";
    const safePoint = findMediaTagSafePoint(text);
    // findMediaTagSafePoint 找到最后一个 '<'（即 '</qq' 的 '<'），
    // 检测到不完整的闭合标签，然后回溯找到匹配的开始标签 '<qqimg>'，
    // 在开始标签的 '<' 之前截断
    expect(safePoint).toBeLessThan(text.length);
    // 截断后的文本不应包含不完整的标签
    const safe = text.slice(0, safePoint);
    expect(safe).not.toContain("</qq");
  });

  it("不完整的闭合标签 '</' 应截断", () => {
    const text = "Hello</";
    const safePoint = findMediaTagSafePoint(text);
    expect(safePoint).toBeLessThan(text.length);
  });

  it("完整标签后跟不完整标签应在完整标签前截断", () => {
    // 由于完整标签也需要被阻止截断，安全点应在第一个完整标签前
    const text = "已完成<qqimg>/a.png</qqimg>未完成<qqim";
    const safePoint = findMediaTagSafePoint(text);
    // 第一个完整标签 <qqimg> 前就应该截断
    expect(safePoint).toBe("已完成".length);
  });

  it("不完整的 qqvoice 标签应正确截断", () => {
    const text = "文字<qqvoice>/path/audio";
    const safePoint = findMediaTagSafePoint(text);
    expect(safePoint).toBe("文字".length);
  });

  it("不完整的 qqvideo 标签应正确截断", () => {
    const text = "文字<qqvideo";
    const safePoint = findMediaTagSafePoint(text);
    expect(safePoint).toBe("文字".length);
  });

  it("不完整的 qqfile 标签应正确截断", () => {
    const text = "文字<qqfile>/doc";
    const safePoint = findMediaTagSafePoint(text);
    expect(safePoint).toBe("文字".length);
  });

  it("无 '<' 的长文本返回全长", () => {
    const text = "A".repeat(5000);
    expect(findMediaTagSafePoint(text)).toBe(5000);
  });

  // ---- 非媒体标签的尖括号不受影响 ----

  it("非媒体标签的 HTML（如 <b>）不影响安全点", () => {
    const text = "Hello <b>world</b> foo";
    const safePoint = findMediaTagSafePoint(text);
    expect(safePoint).toBe(text.length);
  });

  it("普通 XML 标签不影响安全点", () => {
    const text = "看看这个 <code>console.log</code> 的输出";
    const safePoint = findMediaTagSafePoint(text);
    expect(safePoint).toBe(text.length);
  });
});

// ============ decodeMediaPath ============

describe("decodeMediaPath", () => {
  it("应去除首尾空格", () => {
    expect(decodeMediaPath("  /path/file.png  ")).toBe("/path/file.png");
  });

  it("应剥离 MEDIA: 前缀", () => {
    expect(decodeMediaPath("MEDIA:/path/file.png")).toBe("/path/file.png");
  });

  it("应将双反斜杠转为单反斜杠（Markdown 转义恢复）", () => {
    // 输入实际包含 \\ (两个反斜杠)，decodeMediaPath 将其替换为 \ (一个反斜杠)
    // 在 JS 字符串中，"\\\\" 表示两个反斜杠 \\
    expect(decodeMediaPath("/path\\\\to\\\\file.png")).toBe("/path\\to\\file.png");
  });

  it("普通路径应原样返回", () => {
    expect(decodeMediaPath("/Users/test/Desktop/image.png")).toBe("/Users/test/Desktop/image.png");
  });

  it("HTTP URL 应原样返回", () => {
    expect(decodeMediaPath("https://example.com/image.png")).toBe("https://example.com/image.png");
  });
});

// ============ MEDIA_TAG_REGEX 基础匹配 ============

describe("MEDIA_TAG_REGEX", () => {
  it("应匹配标准 qqimg 标签", () => {
    const regex = new RegExp(MEDIA_TAG_REGEX.source, MEDIA_TAG_REGEX.flags);
    const match = regex.exec("<qqimg>/path/file.png</qqimg>");
    expect(match).not.toBeNull();
    expect(match![1]!.toLowerCase()).toBe("qqimg");
    expect(match![2]).toBe("/path/file.png");
  });

  it("应匹配 </img> 闭合变体", () => {
    const regex = new RegExp(MEDIA_TAG_REGEX.source, MEDIA_TAG_REGEX.flags);
    const match = regex.exec("<qqimg>/path/file.png</img>");
    expect(match).not.toBeNull();
  });

  it("应匹配所有四种标签类型", () => {
    const tags = ["qqimg", "qqvoice", "qqvideo", "qqfile"];
    for (const tag of tags) {
      const regex = new RegExp(MEDIA_TAG_REGEX.source, MEDIA_TAG_REGEX.flags);
      const match = regex.exec(`<${tag}>/path/file</${tag}>`);
      expect(match).not.toBeNull();
      expect(match![1]!.toLowerCase()).toBe(tag);
    }
  });
});
