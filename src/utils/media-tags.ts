/**
 * 富媒体标签预处理、纠错、解析
 *
 * 1. normalizeMediaTags: 小模型常见的标签拼写错误及变体修正
 * 2. parseMediaTags: 将文本解析为发送队列（文本/图片/语音/视频/文件）
 * 3. hasIncompleteMediaTag: 检测文本末尾是否存在不完整的媒体标签
 *
 * 设计原则：sendText（outbound.ts）和 deliver 回调（gateway.ts）
 * 共享同一套解析逻辑，避免重复维护。
 */

import { expandTilde, normalizePath } from "./platform.js";

// 标准标签名
const VALID_TAGS = ["qqimg", "qqvoice", "qqvideo", "qqfile"] as const;

// 开头标签别名映射（key 全部小写）
const TAG_ALIASES: Record<string, typeof VALID_TAGS[number]> = {
  // ---- qqimg 变体 ----
  "qq_img": "qqimg",
  "qqimage": "qqimg",
  "qq_image": "qqimg",
  "qqpic": "qqimg",
  "qq_pic": "qqimg",
  "qqpicture": "qqimg",
  "qq_picture": "qqimg",
  "qqphoto": "qqimg",
  "qq_photo": "qqimg",
  "img": "qqimg",
  "image": "qqimg",
  "pic": "qqimg",
  "picture": "qqimg",
  "photo": "qqimg",
  // ---- qqvoice 变体 ----
  "qq_voice": "qqvoice",
  "qqaudio": "qqvoice",
  "qq_audio": "qqvoice",
  "voice": "qqvoice",
  "audio": "qqvoice",
  // ---- qqvideo 变体 ----
  "qq_video": "qqvideo",
  "video": "qqvideo",
  // ---- qqfile 变体 ----
  "qq_file": "qqfile",
  "qqdoc": "qqfile",
  "qq_doc": "qqfile",
  "file": "qqfile",
  "doc": "qqfile",
  "document": "qqfile",
};

// 构建所有可识别的标签名列表（标准名 + 别名）
const ALL_TAG_NAMES = [...VALID_TAGS, ...Object.keys(TAG_ALIASES)];
// 按长度降序排列，优先匹配更长的名称（避免 "img" 抢先匹配 "qqimg" 的子串）
ALL_TAG_NAMES.sort((a, b) => b.length - a.length);

const TAG_NAME_PATTERN = ALL_TAG_NAMES.join("|");

/**
 * 构建一个宽容的正则，能匹配各种畸形标签写法：
 *
 * 常见错误模式：
 *  1. 标签名拼错：<qq_img>, <qqimage>, <image>, <img>, <pic> ...
 *  2. 标签内多余空格：<qqimg >, < qqimg>, <qqimg >
 *  3. 闭合标签不匹配：<qqimg>url</qqvoice>, <qqimg>url</img>
 *  4. 闭合标签缺失斜杠：<qqimg>url<qqimg> (用开头标签代替闭合标签)
 *  5. 闭合标签缺失尖括号：<qqimg>url/qqimg>
 *  6. 中文尖括号：＜qqimg＞url＜/qqimg＞ 或 <qqimg>url</qqimg>
 *  7. 多余引号包裹路径：<qqimg>"path"</qqimg>
 *  8. Markdown 代码块包裹：`<qqimg>path</qqimg>`
 */
const FUZZY_MEDIA_TAG_REGEX = new RegExp(
  // 可选 Markdown 行内代码反引号
  "`?" +
  // 开头标签：允许中文/英文尖括号，标签名前后可有空格
  "[<＜<]\\s*(" + TAG_NAME_PATTERN + ")\\s*[>＞>]" +
  // 内容：非贪婪匹配，允许引号包裹
  "[\"']?\\s*" +
  "([^<＜<＞>\"'`]+?)" +
  "\\s*[\"']?" +
  // 闭合标签：允许各种不规范写法
  "[<＜<]\\s*/?\\s*(?:" + TAG_NAME_PATTERN + ")\\s*[>＞>]" +
  // 可选结尾反引号
  "`?",
  "gi"
);

/**
 * 将标签名映射为标准名称
 */
function resolveTagName(raw: string): typeof VALID_TAGS[number] {
  const lower = raw.toLowerCase();
  if ((VALID_TAGS as readonly string[]).includes(lower)) {
    return lower as typeof VALID_TAGS[number];
  }
  return TAG_ALIASES[lower] ?? "qqimg";
}

/**
 * 预清理：将富媒体标签内部的换行/回车/制表符压缩为单个空格。
 *
 * 部分模型会在标签内部插入 \n \r \t 等空白字符，例如：
 *   <qqimg>\n  /path/to/file.png\n</qqimg>
 *   <qqimg>/path/to/\nfile.png</qqimg>
 *
 * 此正则匹配从开标签到闭标签之间的内容（允许跨行），
 * 将内部所有 [\r\n\t] 替换为空格，然后压缩连续空格。
 */
const MULTILINE_TAG_CLEANUP = new RegExp(
  "([<＜<]\\s*(?:" + TAG_NAME_PATTERN + ")\\s*[>＞>])" +
  "([\\s\\S]*?)" +
  "([<＜<]\\s*/?\\s*(?:" + TAG_NAME_PATTERN + ")\\s*[>＞>])",
  "gi"
);

/**
 * 预处理 LLM 输出文本，将各种畸形/错误的富媒体标签修正为标准格式。
 *
 * 标准格式：<qqimg>/path/to/file</qqimg>
 *
 * @param text LLM 原始输出
 * @returns 修正后的文本（如果没有匹配到任何标签则原样返回）
 */
export function normalizeMediaTags(text: string): string {
  // 先将标签内部的换行/回车/制表符压缩为空格
  let cleaned = text.replace(MULTILINE_TAG_CLEANUP, (_m, open: string, body: string, close: string) => {
    const flat = body.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ");
    return open + flat + close;
  });

  return cleaned.replace(FUZZY_MEDIA_TAG_REGEX, (_match, rawTag: string, content: string) => {
    const tag = resolveTagName(rawTag);
    const trimmed = content.trim();
    if (!trimmed) return _match; // 空内容不处理
    // 展开波浪线路径：~/Desktop/file.png → /Users/xxx/Desktop/file.png
    const expanded = expandTilde(trimmed);
    return `<${tag}>${expanded}</${tag}>`;
  });
}

// ============ 共享的媒体标签解析逻辑 ============

/** 媒体标签正则（标准化后的格式） */
export const MEDIA_TAG_REGEX = /<(qqimg|qqvoice|qqvideo|qqfile)>([^<>]+)<\/(?:qqimg|qqvoice|qqvideo|qqfile|img)>/gi;

/**
 * 不完整媒体标签正则（只有开始标签，没有闭合标签）
 * 匹配 <qqvideo>url 或 <qqimg>path 等，内容到文本末尾
 * 用于流式结束阶段，AI 输出了开始标签但没有闭合标签的情况
 */
export const INCOMPLETE_MEDIA_TAG_REGEX = /<(qqimg|qqvoice|qqvideo|qqfile)>([^<>]+)$/gi;

/** 发送队列项类型 */
export type MediaSendQueueItemType = "text" | "image" | "voice" | "video" | "file";

/** 发送队列项 */
export interface MediaSendQueueItem {
  type: MediaSendQueueItemType;
  content: string;
}

/**
 * 解码模型输出中可能存在的转义路径
 *
 * 处理：
 *   1. 双反斜杠 → 单反斜杠（Markdown 转义）
 *   2. 八进制转义序列 + UTF-8 双重编码修复
 *
 * sendText 和 deliver 回调中都需要这段逻辑，提取为共享函数。
 */
export function decodeMediaPath(rawPath: string): string {
  // 剥离 MEDIA: 前缀（框架可能注入），展开 ~ 路径
  let mediaPath = rawPath.trim();
  if (mediaPath.startsWith("MEDIA:")) {
    mediaPath = mediaPath.slice("MEDIA:".length);
  }
  mediaPath = normalizePath(mediaPath);

  // 1. 双反斜杠 -> 单反斜杠（Markdown 转义）
  mediaPath = mediaPath.replace(/\\\\/g, "\\");

  // 2. 八进制转义序列 + UTF-8 双重编码修复
  try {
    const hasOctal = /\\[0-7]{1,3}/.test(mediaPath);
    const hasNonASCII = /[\u0080-\u00FF]/.test(mediaPath);

    if (hasOctal || hasNonASCII) {
      // Step 1: 将八进制转义转换为字节
      let decoded = mediaPath.replace(/\\([0-7]{1,3})/g, (_: string, octal: string) => {
        return String.fromCharCode(parseInt(octal, 8));
      });

      // Step 2: 提取所有字节（包括 Latin-1 字符）
      const bytes: number[] = [];
      for (let i = 0; i < decoded.length; i++) {
        const code = decoded.charCodeAt(i);
        if (code <= 0xFF) {
          bytes.push(code);
        } else {
          const charBytes = Buffer.from(decoded[i]!, 'utf8');
          bytes.push(...charBytes);
        }
      }

      // Step 3: 尝试按 UTF-8 解码
      const buffer = Buffer.from(bytes);
      const utf8Decoded = buffer.toString('utf8');

      if (!utf8Decoded.includes('\uFFFD') || utf8Decoded.length < decoded.length) {
        mediaPath = utf8Decoded;
      }
    }
  } catch {
    // 路径解码失败，使用原始路径
  }

  return mediaPath;
}

/** 标签名 → 发送队列项类型 */
export function tagNameToQueueType(tagName: string): MediaSendQueueItemType {
  switch (tagName) {
    case "qqvoice": return "voice";
    case "qqvideo": return "video";
    case "qqfile": return "file";
    default: return "image";
  }
}

/**
 * 解析文本中的媒体标签，生成发送队列
 *
 * 支持四种标签:
 *   <qqimg>路径</qqimg>     — 图片
 *   <qqvoice>路径</qqvoice> — 语音
 *   <qqvideo>路径</qqvideo> — 视频
 *   <qqfile>路径</qqfile>   — 文件
 *
 * 按文本中出现的位置构建发送队列，保持顺序。
 *
 * @param text 已经过 normalizeMediaTags 预处理的文本
 * @param textFilter 可选的文本过滤函数（如 filterInternalMarkers），对文本部分进行处理
 * @returns { hasMedia: boolean, sendQueue: MediaSendQueueItem[] }
 *   - hasMedia: 是否包含媒体标签
 *   - sendQueue: 发送队列（如果没有媒体标签，为空数组）
 */
export function parseMediaTags(
  text: string,
  textFilter?: (text: string) => string
): { hasMedia: boolean; sendQueue: MediaSendQueueItem[] } {
  const regex = new RegExp(MEDIA_TAG_REGEX.source, MEDIA_TAG_REGEX.flags);
  const matches = [...text.matchAll(regex)];

  if (matches.length === 0) {
    return { hasMedia: false, sendQueue: [] };
  }

  const sendQueue: MediaSendQueueItem[] = [];
  let lastIndex = 0;

  for (const match of matches) {
    // 添加标签前的文本
    const textBefore = text.slice(lastIndex, match.index).replace(/\n{3,}/g, "\n\n").trim();
    if (textBefore) {
      const filtered = textFilter ? textFilter(textBefore) : textBefore;
      if (filtered) {
        sendQueue.push({ type: "text", content: filtered });
      }
    }

    const tagName = match[1]!.toLowerCase();
    const rawPath = match[2] ?? "";
    const mediaPath = decodeMediaPath(rawPath);

    if (mediaPath) {
      sendQueue.push({ type: tagNameToQueueType(tagName), content: mediaPath });
    }

    lastIndex = match.index! + match[0].length;
  }

  // 添加最后一个标签后的文本
  const textAfter = text.slice(lastIndex).replace(/\n{3,}/g, "\n\n").trim();
  if (textAfter) {
    const filtered = textFilter ? textFilter(textAfter) : textAfter;
    if (filtered) {
      sendQueue.push({ type: "text", content: filtered });
    }
  }

  return { hasMedia: true, sendQueue };
}

// ============ 流式攒包：媒体标签完整性检测 ============

/**
 * 检测文本末尾是否存在不完整的媒体标签
 *
 * 流式场景下，AI 输出的 <qqimg>path</qqimg> 标签可能被截断在：
 *   1. 开始标签中间：  "<qq" / "<qqim" / "<qqimg" / "<qqimg>"
 *   2. 标签内容中间：  "<qqimg>/path/to/fi"
 *   3. 结束标签中间：  "<qqimg>/path</qq" / "<qqimg>/path</"
 *
 * 如果在这些位置截断发送，QQ API 会收到含有不完整标签的文本，
 * 后续拼接时会格式错乱。
 *
 * @param text 待检测的文本
 * @returns 安全截断位置（从该位置截断发送，之后的内容留在缓冲区）
 *          返回 text.length 表示全部安全
 */
export function findMediaTagSafePoint(text: string): number {
  const len = text.length;
  if (len === 0) return 0;

  // 策略：从文本末尾向前搜索，找到最后一个 '<' 字符，
  // 判断它是否是一个不完整的媒体标签的开始

  // 最大回溯范围（媒体标签最长不会超过这个长度）
  // <qqvideo>很长的路径最多2048字符</qqvideo> ≈ 2080
  const MAX_SCAN = Math.min(len, 2100);
  const searchStart = len - MAX_SCAN;

  // 从后向前找最后一个 '<'
  let lastAngleBracket = -1;
  for (let i = len - 1; i >= searchStart; i--) {
    if (text[i] === '<') {
      lastAngleBracket = i;
      break;
    }
  }

  if (lastAngleBracket < 0) {
    // 没有 '<'，全部安全
    return len;
  }

  // 从 lastAngleBracket 开始到末尾的文本
  const tail = text.slice(lastAngleBracket);

  // 检查 1: 完整的标签对（已闭合）
  // 如果末尾有完整的 <qqXXX>...</qqXXX>，那就是安全的
  const completeTagRegex = /^<(qqimg|qqvoice|qqvideo|qqfile)>[^<>]+<\/(?:qqimg|qqvoice|qqvideo|qqfile|img)>$/i;
  if (completeTagRegex.test(tail)) {
    return len; // 完整标签，全部安全
  }

  // 检查 2: 是否是不完整的开始标签
  // 匹配 "<", "<q", "<qq", "<qqi", "<qqim", "<qqimg", "<qqimg>",
  // "<qqv", "<qqvo", "<qqvoi", "<qqvoic", "<qqvoice", "<qqvoice>",
  // 等等，以及 "</", "</q", "</qq"...
  const incompleteOpenOrCloseTag = /^<\/?(?:q(?:q(?:i(?:m(?:g)?)?|v(?:o(?:i(?:c(?:e)?)?)?|i(?:d(?:e(?:o)?)?)?)?|f(?:i(?:l(?:e)?)?)?)?)?)?$/i;
  if (incompleteOpenOrCloseTag.test(tail)) {
    // 不完整的标签名，在 '<' 之前截断
    return lastAngleBracket;
  }

  // 检查 3: 有完整的开始标签 <qqXXX> 但没有闭合
  // e.g. "<qqimg>/path/to/file" 或 "<qqimg>/path</qq"
  const hasOpenTag = /^<(qqimg|qqvoice|qqvideo|qqfile)>/i.test(tail);
  if (hasOpenTag) {
    // 有开始标签但尾部没有完整的闭合标签 → 不完整
    const closeTagRegex = /<\/(?:qqimg|qqvoice|qqvideo|qqfile|img)>/i;
    if (!closeTagRegex.test(tail)) {
      // 整个标签未闭合，在 '<' 前截断
      return lastAngleBracket;
    }
  }

  // 检查 4: 闭合标签中间被截断
  // e.g. "some text</qq" 或 "text</" 
  const incompleteCloseInText = /<\/(?:q(?:q(?:i(?:m(?:g)?)?|v(?:o(?:i(?:c(?:e)?)?)?|i(?:d(?:e(?:o)?)?)?)?|f(?:i(?:l(?:e)?)?)?)?)?)?$/i;
  if (incompleteCloseInText.test(tail)) {
    // 向前找匹配的开始标签
    const openTagPos = text.lastIndexOf('<', lastAngleBracket - 1);
    if (openTagPos >= 0) {
      const segment = text.slice(openTagPos);
      const hasMatchingOpen = /^<(qqimg|qqvoice|qqvideo|qqfile)>/i.test(segment);
      if (hasMatchingOpen) {
        // 整个标签对未闭合，在开始标签的 '<' 前截断
        return openTagPos;
      }
    }
    // 仅闭合标签不完整，在 '<' 前截断
    return lastAngleBracket;
  }

  // 全部安全
  return len;
}

// ============ 内部标记过滤 ============

/**
 * 过滤内部标记（如 [[reply_to: xxx]]）
 * 这些标记可能被 AI 错误地学习并输出，需要在发送前移除。
 *
 * sendText（outbound.ts）和 deliver / processMediaInBuffer（gateway.ts）
 * 共享此过滤逻辑。
 */
export function filterInternalMarkers(text: string): string {
  if (!text) return text;

  // 过滤 [[xxx: yyy]] 格式的内部标记
  // 例如: [[reply_to: ROBOT1.0_kbc...]]
  let result = text.replace(/\[\[[a-z_]+:\s*[^\]]*\]\]/gi, "");

  // 清理可能产生的多余空行
  result = result.replace(/\n{3,}/g, "\n\n").trim();

  return result;
}
