/**
 * split-msg.ts —— 核心攒包拆分算法
 *
 * 移植自 babyQ fmtx.go 的 SplitMsg / findBestSplitIndex / removeFakeMdLinks / splitMsgByBracket 逻辑。
 *
 * 功能概述：
 * 1. 括号匹配安全截断 —— 使用栈算法检测 ()[]{}<> 的平衡状态
 * 2. 换行符优先切割 —— buffer 内有换行时优先从最后一个换行处截断
 * 3. [xxx] 结尾保护 —— 防止 [text](url) 被从中间切断
 * 4. 假 MD 链接清除 —— [text](非http链接) → text
 * 5. XML 自闭合标签跟随 —— 分隔符后紧跟的连续自闭合标签一起发送
 * 6. Markdown 引用 > 特殊处理 —— 栈为空时 > 不当作右尖括号
 */

// ============ 配置 ============

/** 攒包拆分配置 */
export interface SplitMsgConfig {
  /** 最大分片长度（字符/rune 数），默认 1200 */
  maxSliceLength?: number;
  /** 分隔符集合，默认 "。？！，；：、.?!,;:" */
  separators?: string;
  /** 等待分隔符的最大字符数，默认 100 */
  waitSeparatorMaxRunes?: number;
  /** 分片最大字节数（超出则标记 splitFail），默认 4000 */
  maxSliceBytesLen?: number;
  /** 是否启用 waitSeparator 模式（按分隔符切割），默认 true */
  waitSeparator?: boolean;
}

/** 拆分结果 */
export interface SplitResult {
  /** 可以安全发送的部分 */
  sendMsg: string;
  /** 需要继续等待的部分 */
  waitMsg: string;
  /** 是否发生了拆分失败（累积超长仍无法拆分） */
  splitFail?: boolean;
}

// ============ 默认值 ============

const DEFAULT_MAX_SLICE_LENGTH = 1200;
const DEFAULT_SEPARATORS = '。？！，；：、.?!,;:';
const DEFAULT_WAIT_SEPARATOR_MAX_RUNES = 100;
const DEFAULT_MAX_SLICE_BYTES_LEN = 4000;

// ============ 预编译正则 ============

/** 匹配连续自闭合 XML/HTML 标签（例如 <tag ... /><tag ... />） */
const TAG_PATTERN = /^(?:<[^>]+\/>)+/;

/** 匹配 Markdown 链接格式 [text](url) */
const MD_URL_RE = /\[(.*?)\]\((.*?)\)/g;

/** 匹配以中括号 [xxx] 结尾的表达式 */
const BRACKET_REGEX = /(\[[^\]]+\])$/;

const PROTOCOL_HTTP = 'http://';
const PROTOCOL_HTTPS = 'https://';

// ============ 括号映射 ============

const CLOSE_TO_OPEN: Record<string, string> = {
  ')': '(',
  ']': '[',
  '}': '{',
  '>': '<',
};

const OPEN_BRACKETS = new Set(['(', '[', '{', '<']);
const CLOSE_BRACKETS = new Set([')', ']', '}', '>']);

// ============ 内部选项 ============

interface SplitMsgOptions {
  waitSeparator: boolean;
  separators: string;
  waitSeparatorMaxRunes: number;
}

// ============ 核心函数 ============

/**
 * 拆分消息，返回 sendMsg 和 waitMsg
 *
 * 移植自 babyQ fmtx.go SplitMsg
 *
 * 流程：
 * 1. removeFakeMdLinks 删除假 MD 链接
 * 2. 取前 maxSliceLength 字符范围
 * 3. findBestSplitIndex 找最佳分割点
 * 4. splitMsgByBracket [xxx] 结尾保护
 */
export function splitMsg(msg: string, config?: SplitMsgConfig): SplitResult {
  // 删除假的 md 链接
  msg = removeFakeMdLinks(msg);

  if (msg.length === 0) {
    return { sendMsg: '', waitMsg: '' };
  }

  const maxSliceLength = config?.maxSliceLength ?? DEFAULT_MAX_SLICE_LENGTH;
  const separators = config?.separators ?? DEFAULT_SEPARATORS;
  const waitSeparatorMaxRunes = config?.waitSeparatorMaxRunes ?? DEFAULT_WAIT_SEPARATOR_MAX_RUNES;
  const maxSliceBytesLen = config?.maxSliceBytesLen ?? DEFAULT_MAX_SLICE_BYTES_LEN;
  const waitSeparator = config?.waitSeparator ?? true;

  const opts: SplitMsgOptions = {
    waitSeparator,
    separators,
    waitSeparatorMaxRunes,
  };

  // 按 Unicode 码点转为字符数组（等同于 Go 的 []rune）
  const runes = [...msg];
  const maxLength = Math.min(maxSliceLength, runes.length);

  // 寻找切分点
  const cut = findBestSplitIndex(runes.slice(0, maxLength), opts);

  if (cut > 0) {
    // 检测是否以 "[xxx]" 结尾
    const { sendMsg: s1, waitMsg: s2 } = splitMsgByBracket(runes.slice(0, cut).join(''));
    return {
      sendMsg: s1,
      waitMsg: s2 + runes.slice(cut).join(''),
    };
  }

  // 如果找不到分割点且当前累积的分片长度已经超过最大分片长度，提前返回 splitFail
  const byteLen = new TextEncoder().encode(msg).length;
  if (byteLen > maxSliceBytesLen) {
    return { sendMsg: '', waitMsg: msg, splitFail: true };
  }

  // 其他情况：没有找到分割点，且长度还不满足最大长度限制，继续等待
  return { sendMsg: '', waitMsg: msg };
}

/**
 * 找最佳分割点
 *
 * 移植自 babyQ fmtx.go findBestSplitIndex
 *
 * 算法流程：
 * 1. 优先找最后一个换行符
 * 2. 用栈做 ()[]{}<> 括号匹配
 * 3. waitSeparator 模式下按分隔符分割 + XML 自闭合标签跟随
 * 4. 返回 maxBalanced（最后一个括号平衡点）或 -1
 */
export function findBestSplitIndex(runes: string[], opts: SplitMsgOptions): number {
  // 先找最后一个换行，有的话就按最后一个换行拆分
  const nlIdx = findLastNewline(runes);
  if (nlIdx > 0) {
    return nlIdx;
  }

  const stack: string[] = []; // 记录括号匹配情况的栈

  // lastSplit 记录 waitSeparator 情况下返回的分割点位置
  // maxBalanced 记录 stack 为空时最长的字符串位置
  let lastSplit = -1;
  let maxBalanced = -1;

  for (let i = 0; i < runes.length; i++) {
    const r = runes[i];

    if (OPEN_BRACKETS.has(r)) {
      stack.push(r);
    } else if (CLOSE_BRACKETS.has(r)) {
      // 跳过特殊情况：Markdown 引用语法 '>'
      if (r === '>' && stack.length === 0) {
        continue;
      }
      // 非法括号结构：栈为空，或者栈顶元素不是对应的左括号
      if (stack.length === 0 || stack[stack.length - 1] !== CLOSE_TO_OPEN[r]) {
        return -1;
      }
      // 括号匹配，栈顶左括号出栈
      stack.pop();
    } else {
      // waitSeparator 模式下才处理分隔符逻辑，且要求此时 stack 为空
      if (opts.waitSeparator && stack.length === 0 && (opts.separators.includes(r) || r === '\n')) {
        lastSplit = i + 1;
      }
    }

    if (stack.length === 0) {
      maxBalanced = i + 1;
    }
  }

  // waitSeparator 模式下，优先按分隔符的位置返回
  if (opts.waitSeparator) {
    // 优先按分隔符切
    if (lastSplit !== -1) {
      // 匹配连续自闭合的 XML 标签
      const remaining = runes.slice(lastSplit).join('');
      const tagMatch = TAG_PATTERN.exec(remaining);
      if (tagMatch) {
        lastSplit += [...tagMatch[0]].length;
      }
      return lastSplit;
    }

    // 无论 stack 是否为空，如果没找到分隔符且整个字符串长度小于最大等待长度，则返回 -1
    if (runes.length < opts.waitSeparatorMaxRunes) {
      return -1;
    }
  }

  // stack 为空说明可以整段返回
  if (stack.length === 0) {
    return runes.length;
  }

  // 如果最后一个括号平衡点的位置大于 0，则返回
  if (maxBalanced > 0) {
    return maxBalanced;
  }

  // 没找到拆分点
  return -1;
}

/**
 * 找最后一个换行符的位置（返回换行符后一个位置）
 *
 * 移植自 babyQ fmtx.go findLastNewline
 */
export function findLastNewline(runes: string[]): number {
  for (let i = runes.length - 1; i >= 0; i--) {
    if (runes[i] === '\n') {
      return i + 1;
    }
  }
  return -1;
}

/**
 * 根据中括号切割消息
 *
 * 如果消息以 "[xxx]" 结尾，则把 "[xxx]" 切割到 waitMsg，
 * 防止 md 链接语法 [text](url) 被分割开导致检测不到假的 md 链接
 *
 * 移植自 babyQ fmtx.go splitMsgByBracket
 */
export function splitMsgByBracket(msg: string): { sendMsg: string; waitMsg: string } {
  // 不是以 "]" 结尾，直接返回
  if (!msg.endsWith(']')) {
    return { sendMsg: msg, waitMsg: '' };
  }

  // 检测是不是以 "[xxx]" 结尾
  const matches = BRACKET_REGEX.exec(msg);

  // 如果匹配成功
  if (matches && matches.length > 1) {
    const fullMatch = matches[0];
    const waitMsg = fullMatch; // waitMsg 是完整的 "[xxx]"
    const sendMsg = msg.slice(0, msg.length - fullMatch.length);
    return { sendMsg, waitMsg };
  }

  return { sendMsg: msg, waitMsg: '' };
}

/**
 * 校验 MD 格式 —— 检查括号是否平衡
 *
 * 移植自 babyQ fmtx.go CheckMdLink
 */
export function checkMdLink(mdTxt: string): boolean {
  const stack: string[] = [];
  for (const char of mdTxt) {
    if (char === '(' || char === '[' || char === '{' || char === '<') {
      stack.push(char);
    } else if (char === ')' || char === ']' || char === '}' || char === '>') {
      if (stack.length === 0 && char === '>') {
        continue;
      }
      if (stack.length === 0) {
        return false;
      }

      const top = stack[stack.length - 1];
      stack.pop();

      if (
        (char === ')' && top !== '(') ||
        (char === ']' && top !== '[') ||
        (char === '}' && top !== '{') ||
        (char === '>' && top !== '<')
      ) {
        return false;
      }
    }
  }
  return stack.length === 0;
}

/**
 * 删除假的 md 链接
 *
 * [text](非http链接) → 只保留 text
 *
 * 移植自 babyQ fmtx.go removeFakeMdLinks
 */
export function removeFakeMdLinks(text: string): string {
  // 需要每次重置 lastIndex（使用全局正则）
  const re = new RegExp(MD_URL_RE.source, 'g');
  if (!re.test(text)) {
    return text;
  }

  // 重置后再做替换
  const replaceRe = new RegExp(MD_URL_RE.source, 'g');
  return text.replace(replaceRe, (match, linkText: string, url: string) => {
    if (url.startsWith(PROTOCOL_HTTP) || url.startsWith(PROTOCOL_HTTPS)) {
      return match; // 保留原链接
    }
    return linkText; // 只保留文字
  });
}
