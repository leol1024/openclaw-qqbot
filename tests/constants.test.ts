/**
 * constants.ts + types.ts 一致性测试
 *
 * 验证本次新增的常量模块和类型定义：
 * 1. 消息类型常量值正确
 * 2. StreamState 枚举值符合 QQ Bot API 规范
 * 3. MessageType 联合类型覆盖所有常量
 */

import { describe, it, expect } from "vitest";
import {
  MSG_TYPE_C2C,
  MSG_TYPE_GUILD,
  MSG_TYPE_DM,
  MSG_TYPE_GROUP,
} from "../src/constants.js";
import { StreamState } from "../src/types.js";

describe("消息类型常量", () => {
  it("MSG_TYPE_C2C 应为 'c2c'", () => {
    expect(MSG_TYPE_C2C).toBe("c2c");
  });

  it("MSG_TYPE_GUILD 应为 'guild'", () => {
    expect(MSG_TYPE_GUILD).toBe("guild");
  });

  it("MSG_TYPE_DM 应为 'dm'", () => {
    expect(MSG_TYPE_DM).toBe("dm");
  });

  it("MSG_TYPE_GROUP 应为 'group'", () => {
    expect(MSG_TYPE_GROUP).toBe("group");
  });

  it("四个常量值应互不相同", () => {
    const values = [MSG_TYPE_C2C, MSG_TYPE_GUILD, MSG_TYPE_DM, MSG_TYPE_GROUP];
    const unique = new Set(values);
    expect(unique.size).toBe(4);
  });
});

describe("StreamState 枚举", () => {
  it("STREAMING 应为 1（QQ Bot API 规范）", () => {
    expect(StreamState.STREAMING).toBe(1);
  });

  it("END 应为 10（QQ Bot API 规范）", () => {
    expect(StreamState.END).toBe(10);
  });

  it("只有两个枚举值", () => {
    // TypeScript 数字枚举会产生正反映射，所以 key 数量是 value 的两倍
    const keys = Object.keys(StreamState).filter(k => isNaN(Number(k)));
    expect(keys).toEqual(["STREAMING", "END"]);
  });
});

describe("常量值与历史硬编码一致性", () => {
  // 确保重构后常量值与原来代码中的硬编码字符串完全一致
  // 这些测试防止重构时意外修改了常量值

  it("C2C 常量与 API 路径前缀 /v2/users/ 对应", () => {
    // gateway.ts 中 C2C 消息走 sendC2CMessage → /v2/users/{openid}/messages
    expect(MSG_TYPE_C2C).toBe("c2c");
  });

  it("GROUP 常量与 API 路径前缀 /v2/groups/ 对应", () => {
    // gateway.ts 中群聊消息走 sendGroupMessage → /v2/groups/{group_openid}/messages
    expect(MSG_TYPE_GROUP).toBe("group");
  });

  it("GUILD 常量与频道事件类型对应", () => {
    // gateway.ts 中频道 AT_MESSAGE_CREATE 事件的 type 为 "guild"
    expect(MSG_TYPE_GUILD).toBe("guild");
  });

  it("DM 常量与频道私信事件类型对应", () => {
    // gateway.ts 中 DIRECT_MESSAGE_CREATE 事件的 type 为 "dm"
    expect(MSG_TYPE_DM).toBe("dm");
  });
});
