/**
 * split-msg.test.ts —— splitMsg 核心算法单元测试
 *
 * 覆盖场景：
 * - 无 waitSeparator 模式
 * - 有 waitSeparator 模式
 * - qqbot 特有场景
 */

import { describe, it, expect } from "vitest";
import {
  splitMsg,
  findBestSplitIndex,
  findLastNewline,
  splitMsgByBracket,
  checkMdLink,
  type SplitMsgConfig,
} from "../../src/utils/split-msg.js";

// ============ findLastNewline 测试 ============

describe("findLastNewline", () => {
  it("应返回最后一个换行符后的位置", () => {
    expect(findLastNewline([..."abc\ndef\nghi"])).toBe(8); // 第二个 \n 后
  });

  it("无换行符返回 -1", () => {
    expect(findLastNewline([..."abcdef"])).toBe(-1);
  });

  it("换行在开头", () => {
    expect(findLastNewline([..."\nabc"])).toBe(1);
  });

  it("换行在末尾", () => {
    expect(findLastNewline([..."abc\n"])).toBe(4);
  });
});

// ============ splitMsgByBracket 测试 ============

describe("splitMsgByBracket", () => {
  it("不以 ] 结尾时直接返回", () => {
    const result = splitMsgByBracket("hello world");
    expect(result.sendMsg).toBe("hello world");
    expect(result.waitMsg).toBe("");
  });

  it("以 [xxx] 结尾时切割出来", () => {
    const result = splitMsgByBracket("hello [链接文本]");
    expect(result.sendMsg).toBe("hello ");
    expect(result.waitMsg).toBe("[链接文本]");
  });

  it("只有 [xxx] 时，sendMsg 为空", () => {
    const result = splitMsgByBracket("[链接文本]");
    expect(result.sendMsg).toBe("");
    expect(result.waitMsg).toBe("[链接文本]");
  });

  it("以 ] 结尾但不是 [xxx] 格式", () => {
    const result = splitMsgByBracket("hello]");
    expect(result.sendMsg).toBe("hello]");
    expect(result.waitMsg).toBe("");
  });
});

// ============ checkMdLink 测试 ============

describe("checkMdLink", () => {
  it("括号平衡返回 true", () => {
    expect(checkMdLink("[hello](https://example.com)")).toBe(true);
  });

  it("括号不平衡返回 false", () => {
    expect(checkMdLink("[hello](https://example.com")).toBe(false);
  });

  it("Markdown 引用 > 不影响", () => {
    expect(checkMdLink("> hello")).toBe(true);
    expect(checkMdLink(">> hello")).toBe(true);
  });

  it("空字符串返回 true", () => {
    expect(checkMdLink("")).toBe(true);
  });

  it("嵌套括号", () => {
    expect(checkMdLink("(a[b{c}d]e)")).toBe(true);
    expect(checkMdLink("(a[b{c]d}e)")).toBe(false);
  });
});

// ============ splitMsg 测试 —— 无 waitSeparator 模式（对应 TestSplitMsg） ============

describe("splitMsg (waitSeparator=false)", () => {
  const config: SplitMsgConfig = { waitSeparator: false };

  it("测试断句01: Markdown 引用 >>", () => {
    const result = splitMsg(">> 好的，我现在需要回答", config);
    expect(result.sendMsg).toBe(">> 好的，我现在需要回答");
  });

  it("测试断句02: Markdown 引用 >", () => {
    const result = splitMsg("> 好的，我现在需要回答，我想一下", config);
    expect(result.sendMsg).toBe("> 好的，我现在需要回答，我想一下");
  });

  it("测试断句03: 内嵌 >>", () => {
    const result = splitMsg("你好>> 好的，我现在需要回答", config);
    expect(result.sendMsg).toBe("你好>> 好的，我现在需要回答");
  });

  it("测试断句09: 换行 + 不完整链接", () => {
    const result = splitMsg("> 这是一段引用\n[不完整的链接(", config);
    expect(result.sendMsg).toBe("> 这是一段引用\n");
    expect(result.waitMsg).toBe("[不完整的链接(");
  });

  it("测试断句10: 括号内逗号不切分", () => {
    const result = splitMsg("(测试，逗号)，你好", config);
    expect(result.sendMsg).toBe("(测试，逗号)，你好");
  });

  it("测试断句11: 换行 + 不完整括号", () => {
    const result = splitMsg("(测试，逗号)\n你好(", config);
    expect(result.sendMsg).toBe("(测试，逗号)\n");
    expect(result.waitMsg).toBe("你好(");
  });

  it("测试断句12: 数学公式括号匹配", () => {
    const msg =
      "> a ∈ (1/2,1]，那么f(t) - f(0) = f'(ξ)t，ξ∈(0,t)，所以|f(t)-f(0)|=|f'(ξ)|t ≤ t。而t ∈ (1/2,1]，所以t ≤ 1，但这不够，因为要≤1/2。哦，不对，应该利用f(0)=f(1)，所以f(t) - f(1 - t) = [f(t) - f(0)] - [f(1 - t) - f(0)] = f'(ξ)t - f'(η)(1 - t)，其中ξ∈(0,t)，η∈(0,1 - t)。然后绝对值是|f'(ξ)t - f'(η)(1 - t)| ≤ t + (1 - t) = 1？这也不对。\n > \n > 哦，可能我错了，应该先考虑当x₁和x₂在[0,1/2]或[1/2,1]时，或者跨过1/2的情况。正确的做法应该是：";
    const result = splitMsg(msg, config);
    expect(result.sendMsg).toBe(
      "> a ∈ (1/2,1]，那么f(t) - f(0) = f'(ξ)t，ξ∈(0,t)，所以|f(t)-f(0)|=|f'(ξ)|t ≤ t。而t ∈ (1/2,1]，所以t ≤ 1，但这不够，因为要≤1/2。哦，不对，应该利用f(0)=f(1)，所以f(t) - f(1 - t) = [f(t) - f(0)] - [f(1 - t) - f(0)] = f'(ξ)t - f'(η)(1 - t)，其中ξ∈(0,t)，η∈(0,1 - t)。然后绝对值是|f'(ξ)t - f'(η)(1 - t)| ≤ t + (1 - t) = 1？这也不对。\n > \n"
    );
    expect(result.waitMsg).toBe(
      " > 哦，可能我错了，应该先考虑当x₁和x₂在[0,1/2]或[1/2,1]时，或者跨过1/2的情况。正确的做法应该是："
    );
  });
});

// ============ splitMsg 测试 —— 有 waitSeparator 模式（对应 TestSplitMsgWithWaitSeparator） ============

describe("splitMsg (waitSeparator=true, 默认模式)", () => {
  // 默认 waitSeparator=true
  const config: SplitMsgConfig = {};

  it("测试断句01: Markdown 引用 >> 按逗号切", () => {
    const result = splitMsg(">> 好的，我现在需要回答", config);
    expect(result.sendMsg).toBe(">> 好的，");
    expect(result.waitMsg).toBe("我现在需要回答");
  });

  it("测试断句02: Markdown 引用 > 按逗号切", () => {
    const result = splitMsg("> 好的，我现在需要回答，我想一下", config);
    expect(result.sendMsg).toBe("> 好的，我现在需要回答，");
    expect(result.waitMsg).toBe("我想一下");
  });

  it("测试断句03: 内嵌 >> 按逗号切", () => {
    const result = splitMsg("你好>> 好的，我现在需要回答", config);
    expect(result.sendMsg).toBe("你好>> 好的，");
    expect(result.waitMsg).toBe("我现在需要回答");
  });

  it("测试断句04: 分隔符后跟 XML 自闭合标签", () => {
    const msg = `，<qqbot-markdown-node nodeType="refFootnotes" nodeID="quoteArea" index="1"/>提到资本主义体制、政府`;
    const result = splitMsg(msg, config);
    expect(result.sendMsg).toBe(
      `，<qqbot-markdown-node nodeType="refFootnotes" nodeID="quoteArea" index="1"/>提到资本主义体制、`
    );
    expect(result.waitMsg).toBe(`政府`);
  });

  it("测试断句08: 单个 XML 自闭合标签", () => {
    const msg = `<qqbot-markdown-node nodeType="refFootnotes" title = "这是一个有逗号，的标题11111" nodeID="quoteArea" index="3"/>`;
    const result = splitMsg(msg, config);
    expect(result.sendMsg).toBe(msg);
    expect(result.waitMsg).toBe("");
  });

  it("测试断句09: 换行 + 不完整链接", () => {
    const result = splitMsg("> 这是一段引用\n[不完整的链接(", config);
    expect(result.sendMsg).toBe("> 这是一段引用\n");
    expect(result.waitMsg).toBe("[不完整的链接(");
  });

  it("测试断句10: 括号内逗号不切 + 外逗号切", () => {
    const result = splitMsg("(测试，逗号)，你好", config);
    expect(result.sendMsg).toBe("(测试，逗号)，");
    expect(result.waitMsg).toBe("你好");
  });

  it("测试断句11: 换行 + 不完整括号", () => {
    const result = splitMsg("(测试，逗号)，\n你好(", config);
    expect(result.sendMsg).toBe("(测试，逗号)，\n");
    expect(result.waitMsg).toBe("你好(");
  });

  it("测试断句12: 数学公式括号匹配", () => {
    const msg =
      "> a ∈ (1/2,1]，那么f(t) - f(0) = f'(ξ)t，ξ∈(0,t)，所以|f(t)-f(0)|=|f'(ξ)|t ≤ t。而t ∈ (1/2,1]，所以t ≤ 1，但这不够，因为要≤1/2。哦，不对，应该利用f(0)=f(1)，所以f(t) - f(1 - t) = [f(t) - f(0)] - [f(1 - t) - f(0)] = f'(ξ)t - f'(η)(1 - t)，其中ξ∈(0,t)，η∈(0,1 - t)。然后绝对值是|f'(ξ)t - f'(η)(1 - t)| ≤ t + (1 - t) = 1？这也不对。\n > \n > 哦，可能我错了，应该先考虑当x₁和x₂在[0,1/2]或[1/2,1]时，或者跨过1/2的情况。正确的做法应该是：";
    const result = splitMsg(msg, config);
    expect(result.sendMsg).toBe(
      "> a ∈ (1/2,1]，那么f(t) - f(0) = f'(ξ)t，ξ∈(0,t)，所以|f(t)-f(0)|=|f'(ξ)|t ≤ t。而t ∈ (1/2,1]，所以t ≤ 1，但这不够，因为要≤1/2。哦，不对，应该利用f(0)=f(1)，所以f(t) - f(1 - t) = [f(t) - f(0)] - [f(1 - t) - f(0)] = f'(ξ)t - f'(η)(1 - t)，其中ξ∈(0,t)，η∈(0,1 - t)。然后绝对值是|f'(ξ)t - f'(η)(1 - t)| ≤ t + (1 - t) = 1？这也不对。\n > \n"
    );
    expect(result.waitMsg).toBe(
      " > 哦，可能我错了，应该先考虑当x₁和x₂在[0,1/2]或[1/2,1]时，或者跨过1/2的情况。正确的做法应该是："
    );
  });

  it("不完整的 markdown 链接 —— 完整的 [text]( 但 URL 未闭合", () => {
    const msg =
      "[高清地球图](https://qqbot.ugcimg.cn/xq/9bf6cbd07b27797dfa948cbca4bc638e37cd13b2/3566a6288d91b9c89db20f779546";
    const result = splitMsg(msg, config);
    expect(result.sendMsg).toBe("");
    expect(result.waitMsg).toBe(msg);
  });
});

// ============ 超长文本的分割测试 ============

describe("splitMsg 超长文本 (waitSeparator=true)", () => {
  // 构造超长文本用于测试的辅助函数
  const makeLongText = () => {
    const segment =
      "假如我们有一个问题: 给出一段文本，使用一些关键词对它进行描述! 为了方便统一正确答案，这道题可能预先已经给大家写出了一些关键词作为提示.其中这些给出的提示就可以看作是key， 而整个的文本信息就相当于是query，value的含义则更抽象，可以比作是你看到这段文本信息后，脑子里浮现的答案信息， 这里我们又假设大家最开始都不是很聪明，第一次看到这段文本后脑子里基本上浮现的信息就只有提示这些信息， 因此key与value基本是相同的，但是随着我们对这个问题的深入理解，通过我们的思考脑子里想起来的东西原来越多， 并且能够开始对我们query也就是这段文本，提取关键信息进行表示. 这就是注意力作用的过程， 通过这个过程， 我们最终脑子里的value发生了变化。";
    return segment.repeat(3);
  };

  it("测试断句05: 超长文本 + 3 个连续 XML 标签", () => {
    const longText = makeLongText();
    const tags = [
      `<qqbot-markdown-node nodeType="refFootnotes" nodeID="quoteArea" index="1"/>`,
      `<qqbot-markdown-node nodeType="refFootnotes" nodeID="quoteArea" index="2"/>`,
      `<qqbot-markdown-node nodeType="refFootnotes" nodeID="quoteArea" index="3"/>`,
    ];
    const msg = longText + tags.join("");

    const result = splitMsg(msg);
    // 最后一个标签应被分割到 waitMsg
    expect(result.waitMsg).toBe(tags[2]);
    // sendMsg 应包含长文本 + 前两个标签
    expect(result.sendMsg).toBe(longText + tags[0] + tags[1]);
  });

  it("测试断句06: 超长文本 + 2 个标签 + 中间内容 + 1 个标签", () => {
    const longText = makeLongText();
    const tag1 = `<qqbot-markdown-node nodeType="refFootnotes" nodeID="quoteArea" index="1"/>`;
    const tag2 = `<qqbot-markdown-node nodeType="refFootnotes" nodeID="quoteArea" index="2"/>`;
    const tag3 = `<qqbot-markdown-node nodeType="refFootnotes" nodeID="quoteArea" index="3"/>`;
    const msg = longText + tag1 + tag2 + "中间的内容" + tag3;

    const result = splitMsg(msg);
    expect(result.sendMsg).toBe(longText + tag1 + tag2);
    expect(result.waitMsg).toBe("中间的内容" + tag3);
  });

  it("测试断句07: 超长文本 + 2 个标签 + 中间内容 + 逗号 + 1 个标签", () => {
    const longText = makeLongText();
    const tag1 = `<qqbot-markdown-node nodeType="refFootnotes" nodeID="quoteArea" index="1"/>`;
    const tag2 = `<qqbot-markdown-node nodeType="refFootnotes" nodeID="quoteArea" index="2"/>`;
    const tag3 = `<qqbot-markdown-node nodeType="refFootnotes" nodeID="quoteArea" index="3"/>`;
    const msg = longText + tag1 + tag2 + "中间的内容，" + tag3;

    const result = splitMsg(msg);
    expect(result.sendMsg).toBe(longText + tag1 + tag2 + "中间的内容，");
    expect(result.waitMsg).toBe(tag3);
  });
});

// ============ 超长文本测试 (waitSeparator=false) ============

describe("splitMsg 超长文本 (waitSeparator=false)", () => {
  const config: SplitMsgConfig = { waitSeparator: false };

  const makeLongText = () => {
    const segment =
      "假如我们有一个问题: 给出一段文本，使用一些关键词对它进行描述! 为了方便统一正确答案，这道题可能预先已经给大家写出了一些关键词作为提示.其中这些给出的提示就可以看作是key， 而整个的文本信息就相当于是query，value的含义则更抽象，可以比作是你看到这段文本信息后，脑子里浮现的答案信息， 这里我们又假设大家最开始都不是很聪明，第一次看到这段文本后脑子里基本上浮现的信息就只有提示这些信息， 因此key与value基本是相同的，但是随着我们对这个问题的深入理解，通过我们的思考脑子里想起来的东西原来越多， 并且能够开始对我们query也就是这段文本，提取关键信息进行表示. 这就是注意力作用的过程， 通过这个过程， 我们最终脑子里的value发生了变化。";
    return segment.repeat(3);
  };

  it("测试断句04: 短文本带 XML 标签整体返回", () => {
    const msg = `，<qqbot-markdown-node nodeType="refFootnotes" nodeID="quoteArea" index="1"/>提到资本主义体制、政府`;
    const result = splitMsg(msg, config);
    expect(result.sendMsg).toBe(msg);
  });

  it("测试断句05: 超长文本 + 3 个 XML 标签 —— 在 maxSliceLength 范围内找到最后平衡点", () => {
    const longText = makeLongText();
    const tags = [
      `<qqbot-markdown-node nodeType="refFootnotes" nodeID="quoteArea" index="1"/>`,
      `<qqbot-markdown-node nodeType="refFootnotes" nodeID="quoteArea" index="2"/>`,
      `<qqbot-markdown-node nodeType="refFootnotes" nodeID="quoteArea" index="3"/>`,
    ];
    const msg = longText + tags.join("");
    const result = splitMsg(msg, config);
    // 在 waitSeparator=false 模式下，取前 1200 字符范围，在该范围内找最佳分割点
    // 只要 sendMsg + waitMsg = msg 且 sendMsg 非空即可
    expect(result.sendMsg.length).toBeGreaterThan(0);
    expect(result.sendMsg + result.waitMsg).toBe(msg);
  });

  it("测试断句06: 超长 + 中间内容无分隔符", () => {
    const longText = makeLongText();
    const tag1 = `<qqbot-markdown-node nodeType="refFootnotes" nodeID="quoteArea" index="1"/>`;
    const tag2 = `<qqbot-markdown-node nodeType="refFootnotes" nodeID="quoteArea" index="2"/>`;
    const tag3 = `<qqbot-markdown-node nodeType="refFootnotes" nodeID="quoteArea" index="3"/>`;
    const msg = longText + tag1 + tag2 + "中间的内容" + tag3;
    const result = splitMsg(msg, config);
    // 在 waitSeparator=false 模式下，取前 1200 字符找分割点
    expect(result.sendMsg.length).toBeGreaterThan(0);
    expect(result.sendMsg + result.waitMsg).toBe(msg);
  });

  it("测试断句08: 单个 XML 标签整体返回", () => {
    const msg = `<qqbot-markdown-node nodeType="refFootnotes" title = "这是一个有逗号，的标题11111" nodeID="quoteArea" index="3"/>`;
    const result = splitMsg(msg, config);
    expect(result.sendMsg).toBe(msg);
    expect(result.waitMsg).toBe("");
  });
});

// ============ 边界情况测试 ============

describe("splitMsg 边界情况", () => {
  it("空字符串", () => {
    const result = splitMsg("");
    expect(result.sendMsg).toBe("");
    expect(result.waitMsg).toBe("");
  });

  it("单个字符 (waitSeparator=false)", () => {
    const result = splitMsg("a", { waitSeparator: false });
    expect(result.sendMsg).toBe("a");
    expect(result.waitMsg).toBe("");
  });

  it("单个字符 (waitSeparator=true) —— 短文本继续等待", () => {
    const result = splitMsg("a");
    expect(result.sendMsg).toBe("");
    expect(result.waitMsg).toBe("a");
  });

  it("只有换行符", () => {
    const result = splitMsg("\n");
    expect(result.sendMsg).toBe("\n");
    expect(result.waitMsg).toBe("");
  });

  it("只有未闭合的左括号", () => {
    const result = splitMsg("(");
    expect(result.sendMsg).toBe("");
    expect(result.waitMsg).toBe("(");
  });

  it("MD 锚点链接保留原样 (waitSeparator=false)", () => {
    const result = splitMsg("[引用1](@ref)一些文本", { waitSeparator: false });
    // 不再清除假 MD 链接，[引用1](@ref) 括号平衡，整段可发送
    expect(result.sendMsg).toBe("[引用1](@ref)一些文本");
  });

  it("MD 锚点链接保留原样 (waitSeparator=true) —— 短文本继续等待", () => {
    const result = splitMsg("[引用1](@ref)一些文本");
    // 不再清除假 MD 链接，但 12 字符小于 waitSeparatorMaxRunes(100)，继续等待
    expect(result.sendMsg).toBe("");
    expect(result.waitMsg).toBe("[引用1](@ref)一些文本");
  });

  it("splitFail 超长文本无分割点", () => {
    // 构造一个很长的未闭合括号文本，超过 maxSliceBytesLen
    const longContent = "a".repeat(5000);
    const msg = "(" + longContent;
    const result = splitMsg(msg, { maxSliceBytesLen: 4000 });
    expect(result.splitFail).toBe(true);
    expect(result.sendMsg).toBe("");
  });
});

// ============ findBestSplitIndex 直接测试 ============

describe("findBestSplitIndex", () => {
  const defaultOpts = {
    waitSeparator: false,
    separators: "。？！，；：、.?!,;:",
    waitSeparatorMaxRunes: 100,
  };

  const wsOpts = {
    waitSeparator: true,
    separators: "。？！，；：、.?!,;:",
    waitSeparatorMaxRunes: 100,
  };

  it("简单文本返回整段长度", () => {
    const runes = [..."hello"];
    expect(findBestSplitIndex(runes, defaultOpts)).toBe(5);
  });

  it("有换行时返回换行后位置", () => {
    const runes = [..."hello\nworld"];
    expect(findBestSplitIndex(runes, defaultOpts)).toBe(6);
  });

  it("未闭合括号返回 maxBalanced 或 -1", () => {
    const runes = [..."abc(def"];
    expect(findBestSplitIndex(runes, defaultOpts)).toBe(3);
  });

  it("括号内的分隔符不切割 (waitSeparator) —— 短文本继续等待", () => {
    const runes = [..."(测试，逗号)"];
    // 7 个字符 < waitSeparatorMaxRunes(100)，没有分隔符在括号外，继续等待
    expect(findBestSplitIndex(runes, wsOpts)).toBe(-1);
  });

  it("括号内的分隔符不切割，外部有分隔符 (waitSeparator)", () => {
    const runes = [..."(测试，逗号)，你好"];
    // 外部有逗号分隔符，在位置 8（逗号后）切割
    expect(findBestSplitIndex(runes, wsOpts)).toBe(8);
  });

  it("waitSeparator: 短文本等待", () => {
    const runes = [..."你好"];
    expect(findBestSplitIndex(runes, wsOpts)).toBe(-1); // 太短继续等待
  });

  it("Markdown > 引用不影响", () => {
    const runes = [...">> hello"];
    expect(findBestSplitIndex(runes, defaultOpts)).toBe(8);
  });
});
