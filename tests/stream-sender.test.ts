/**
 * StreamSender 测试用例
 *
 * 覆盖本次改动的核心：C2C 流式消息发送器
 * 1. C2C 目标走流式路径（包含 stream 参数）
 * 2. 群聊/频道目标自动降级为普通消息
 * 3. 流式上下文管理（index 递增、streamId 记录、ended 标记）
 * 4. 已结束后拒绝继续发送
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock api.ts 的所有远程调用
vi.mock("../src/api.js", () => ({
  getAccessToken: vi.fn().mockResolvedValue("mock-access-token"),
  sendC2CMessage: vi.fn().mockResolvedValue({ id: "stream-abc", timestamp: 1700000000 }),
  sendGroupMessage: vi.fn().mockResolvedValue({ id: "grp-001", timestamp: "2024-01-01T00:00:00Z" }),
  sendChannelMessage: vi.fn().mockResolvedValue({ id: "ch-001", timestamp: "2024-01-01T00:00:00Z" }),
  getNextMsgSeq: vi.fn().mockReturnValue(12345),
}));

import { StreamSender } from "../src/outbound.js";
import { sendC2CMessage, sendGroupMessage, sendChannelMessage } from "../src/api.js";
import type { ResolvedQQBotAccount } from "../src/types.js";
import { StreamState } from "../src/types.js";

const mockAccount: ResolvedQQBotAccount = {
  accountId: "test-account",
  enabled: true,
  appId: "test-app-id",
  clientSecret: "test-secret",
  secretSource: "config",
  markdownSupport: false,
  streamSupport: true,
  config: {},
};

describe("StreamSender", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============ C2C 流式路径 ============

  describe("C2C 流式消息", () => {
    it("应识别 C2C 目标支持流式", () => {
      const sender = new StreamSender(mockAccount, "c2c:user123", "msg-reply-id");
      expect(sender.isStreamSupported()).toBe(true);
    });

    it("首次 send 应传入 stream.state=STREAMING, index=0, id=''", async () => {
      const sender = new StreamSender(mockAccount, "c2c:user123", "msg-reply-id");
      await sender.send("Hello");

      expect(sendC2CMessage).toHaveBeenCalledWith(
        "mock-access-token",
        "user123",
        "Hello",
        "msg-reply-id",
        expect.objectContaining({
          state: StreamState.STREAMING,
          index: 0,
          id: "",
        })
      );
    });

    it("第二次 send 应递增 index 并携带 streamId", async () => {
      const sender = new StreamSender(mockAccount, "c2c:user123", "msg-reply-id");
      await sender.send("Hello");
      await sender.send("Hello World");

      expect(sendC2CMessage).toHaveBeenCalledTimes(2);
      const secondCall = vi.mocked(sendC2CMessage).mock.calls[1]!;
      const streamConfig = secondCall[4]!;
      expect(streamConfig.index).toBe(1);
      expect(streamConfig.id).toBe("stream-abc");
    });

    it("end() 应传入 stream.state=END", async () => {
      const sender = new StreamSender(mockAccount, "c2c:user123", "msg-reply-id");
      await sender.send("Hello");
      await sender.end("Hello World - END");

      const lastCall = vi.mocked(sendC2CMessage).mock.calls[1]!;
      const streamConfig = lastCall[4]!;
      expect(streamConfig.state).toBe(StreamState.END);
    });

    it("end() 后 isEnded() 应返回 true", async () => {
      const sender = new StreamSender(mockAccount, "c2c:user123");
      expect(sender.isEnded()).toBe(false);
      await sender.end("done");
      expect(sender.isEnded()).toBe(true);
    });

    it("已结束后继续 send 应返回错误", async () => {
      const sender = new StreamSender(mockAccount, "c2c:user123");
      await sender.end("done");
      const result = await sender.send("more");
      expect(result.error).toBe("Stream already ended");
    });

    it("getContext() 应返回当前状态", async () => {
      const sender = new StreamSender(mockAccount, "c2c:user123", "msg-001");
      const ctx0 = sender.getContext();
      expect(ctx0.index).toBe(0);
      expect(ctx0.streamId).toBe("");
      expect(ctx0.ended).toBe(false);

      await sender.send("Hello");
      const ctx1 = sender.getContext();
      expect(ctx1.index).toBe(1);
      expect(ctx1.streamId).toBe("stream-abc");
      expect(ctx1.ended).toBe(false);
    });

    it("返回值应包含 streamId", async () => {
      const sender = new StreamSender(mockAccount, "c2c:user123", "msg-001");
      const result = await sender.send("Hello");
      expect(result.streamId).toBe("stream-abc");
      expect(result.messageId).toBe("stream-abc");
    });
  });

  // ============ 群聊降级 ============

  describe("群聊降级为普通消息", () => {
    it("应识别 group 目标不支持流式", () => {
      const sender = new StreamSender(mockAccount, "group:grp123");
      expect(sender.isStreamSupported()).toBe(false);
    });

    it("群聊 send 应调用 sendGroupMessage（无 stream 参数）", async () => {
      const sender = new StreamSender(mockAccount, "group:grp123", "msg-reply-id");
      await sender.send("Hello Group");

      expect(sendGroupMessage).toHaveBeenCalledWith(
        "mock-access-token",
        "grp123",
        "Hello Group",
        "msg-reply-id"
      );
      expect(sendC2CMessage).not.toHaveBeenCalled();
    });

    it("群聊 end 后 isEnded() 应返回 true", async () => {
      const sender = new StreamSender(mockAccount, "group:grp123");
      await sender.end("bye");
      expect(sender.isEnded()).toBe(true);
    });

    it("群聊返回值不应包含 streamId", async () => {
      const sender = new StreamSender(mockAccount, "group:grp123");
      const result = await sender.send("Hello");
      expect(result.streamId).toBeUndefined();
    });
  });

  // ============ 频道降级 ============

  describe("频道降级为普通消息", () => {
    it("应识别 channel 目标不支持流式", () => {
      const sender = new StreamSender(mockAccount, "channel:ch123");
      expect(sender.isStreamSupported()).toBe(false);
    });

    it("频道 send 应调用 sendChannelMessage（无 stream 参数）", async () => {
      const sender = new StreamSender(mockAccount, "channel:ch123", "msg-reply-id");
      await sender.send("Hello Channel");

      expect(sendChannelMessage).toHaveBeenCalledWith(
        "mock-access-token",
        "ch123",
        "Hello Channel",
        "msg-reply-id"
      );
      expect(sendC2CMessage).not.toHaveBeenCalled();
    });
  });

  // ============ 配置校验 ============

  describe("配置缺失", () => {
    it("缺少 appId 应返回错误", async () => {
      const badAccount = { ...mockAccount, appId: "" };
      const sender = new StreamSender(badAccount, "c2c:user123");
      const result = await sender.send("Hello");
      expect(result.error).toContain("not configured");
    });

    it("缺少 clientSecret 应返回错误", async () => {
      const badAccount = { ...mockAccount, clientSecret: "" };
      const sender = new StreamSender(badAccount, "c2c:user123");
      const result = await sender.send("Hello");
      expect(result.error).toContain("not configured");
    });
  });

  // ============ 默认目标解析 ============

  describe("目标地址解析", () => {
    it("纯 openid 应解析为 C2C", () => {
      const sender = new StreamSender(mockAccount, "ABC123DEF456");
      expect(sender.isStreamSupported()).toBe(true);
    });

    it("qqbot:c2c:xxx 前缀应正确解析", () => {
      const sender = new StreamSender(mockAccount, "qqbot:c2c:user123");
      expect(sender.isStreamSupported()).toBe(true);
    });
  });
});
