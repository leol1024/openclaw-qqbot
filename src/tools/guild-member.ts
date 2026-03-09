import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveQQBotAccount } from "../config.js";
import { listQQBotAccountIds } from "../config.js";
import { getAccessToken, apiRequest } from "../api.js";

// ========== 类型定义 ==========

interface User {
  id: string;
  username: string;
  avatar: string;
  bot: boolean;
  union_openid?: string;
  union_user_account?: string;
}

interface Member {
  user: User;
  nick: string;
  roles: string[];
  joined_at: string;
  deaf?: boolean;
  mute?: boolean;
  pending?: boolean;
}

interface RoleMembersResponse {
  data: Member[];
  next: string;
}

interface OnlineNumsResponse {
  online_nums: number;
}

// ========== 参数类型 ==========

interface OnlineNumsParams {
  channel_id: string;
}

interface MemberListParams {
  guild_id: string;
  after?: string;
  limit?: number;
}

interface RoleMemberListParams {
  guild_id: string;
  role_id: string;
  start_index?: string;
  limit?: number;
}

interface GetMemberParams {
  guild_id: string;
  user_id: string;
}

// ========== JSON Schema ==========

const OnlineNumsSchema = {
  type: "object",
  properties: {
    channel_id: {
      type: "string",
      description: "音视频/直播子频道 ID",
    },
  },
  required: ["channel_id"],
} as const;

const MemberListSchema = {
  type: "object",
  properties: {
    guild_id: {
      type: "string",
      description: "频道 ID，可通过 qqbot_guild_list 工具获取",
    },
    after: {
      type: "string",
      description: "上一次回包中最后一个 member 的 user id，首次请求填 0，默认 0",
    },
    limit: {
      type: "number",
      description: "分页大小，1-400，默认 1。成员较多的频道建议使用较大值",
    },
  },
  required: ["guild_id"],
} as const;

const RoleMemberListSchema = {
  type: "object",
  properties: {
    guild_id: {
      type: "string",
      description: "频道 ID，可通过 qqbot_guild_list 工具获取",
    },
    role_id: {
      type: "string",
      description: "身份组 ID",
    },
    start_index: {
      type: "string",
      description: "分页标识，首次请求填 0，后续使用上一次回包的 next 字段，默认 0",
    },
    limit: {
      type: "number",
      description: "分页大小，1-400，默认 1。成员较多的频道建议使用较大值",
    },
  },
  required: ["guild_id", "role_id"],
} as const;

const GetMemberSchema = {
  type: "object",
  properties: {
    guild_id: {
      type: "string",
      description: "频道 ID，可通过 qqbot_guild_list 工具获取",
    },
    user_id: {
      type: "string",
      description: "用户 ID",
    },
  },
  required: ["guild_id", "user_id"],
} as const;

// ========== 工具函数 ==========

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

// ========== 注册入口 ==========

/**
 * 注册所有频道成员相关工具：
 * - qqbot_channel_online_nums: 获取子频道在线成员数
 * - qqbot_guild_member_list: 获取频道成员列表（仅私域机器人）
 * - qqbot_guild_role_member_list: 获取频道身份组成员列表（仅私域机器人）
 * - qqbot_guild_member_get: 获取频道成员详情
 */
export function registerGuildMemberTools(api: OpenClawPluginApi): void {
  const cfg = api.config;
  if (!cfg) {
    api.logger.debug?.("guild-member: No config available, skipping");
    return;
  }

  const accountIds = listQQBotAccountIds(cfg);
  if (accountIds.length === 0) {
    api.logger.debug?.("guild-member: No QQBot accounts configured, skipping");
    return;
  }

  const firstAccountId = accountIds[0];
  const account = resolveQQBotAccount(cfg, firstAccountId);

  if (!account.appId || !account.clientSecret) {
    api.logger.debug?.("guild-member: Account not fully configured, skipping");
    return;
  }

  // ---- 子频道在线成员数 ----

  api.registerTool(
    {
      name: "qqbot_channel_online_nums",
      label: "QQBot Channel Online Nums",
      description:
        "获取音视频/直播子频道的在线成员数。" +
        "需要提供子频道 channel_id。" +
        "返回在线成员数量。",
      parameters: OnlineNumsSchema,
      async execute(_toolCallId, params) {
        const p = params as OnlineNumsParams;

        if (!p.channel_id) {
          return json({ error: "channel_id 为必填参数" });
        }

        try {
          const accessToken = await getAccessToken(account.appId, account.clientSecret);
          const result = await apiRequest<OnlineNumsResponse>(
            accessToken,
            "GET",
            `/channels/${p.channel_id}/online_nums`,
          );
          return json(result);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const errStack = err instanceof Error ? err.stack : undefined;
          api.logger.error?.(
            `qqbot_channel_online_nums: Failed to get online nums for channel ${p.channel_id}: ${errMsg}`,
          );
          if (errStack) {
            api.logger.error?.(`qqbot_channel_online_nums: Stack trace:\n${errStack}`);
          }
          return json({ error: errMsg });
        }
      },
    },
    { name: "qqbot_channel_online_nums" },
  );

  // ---- 频道成员列表 ----

  api.registerTool(
    {
      name: "qqbot_guild_member_list",
      label: "QQBot Guild Member List",
      description:
        "获取频道成员列表（仅私域机器人可用）。" +
        "需要提供频道 guild_id，支持 after/limit 分页参数。" +
        "返回成员数组，包含用户信息、昵称、身份组、加入时间等。" +
        "翻页时使用最后一个成员的 user.id 作为下一次请求的 after 参数，直到回包为空。" +
        "注意：翻页过程中可能返回重复成员，需按 user.id 去重。",
      parameters: MemberListSchema,
      async execute(_toolCallId, params) {
        const p = params as MemberListParams;

        if (!p.guild_id) {
          return json({ error: "guild_id 为必填参数" });
        }

        const query = new URLSearchParams();
        if (p.after) query.set("after", p.after);
        if (p.limit != null) query.set("limit", String(Math.max(1, Math.min(400, p.limit))));

        const qs = query.toString();
        const path = `/guilds/${p.guild_id}/members${qs ? `?${qs}` : ""}`;

        try {
          const accessToken = await getAccessToken(account.appId, account.clientSecret);
          const members = await apiRequest<Member[]>(
            accessToken,
            "GET",
            path,
          );
          return json(members);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const errStack = err instanceof Error ? err.stack : undefined;
          api.logger.error?.(
            `qqbot_guild_member_list: Failed to get members for guild ${p.guild_id}: ${errMsg}`,
          );
          if (errStack) {
            api.logger.error?.(`qqbot_guild_member_list: Stack trace:\n${errStack}`);
          }
          return json({ error: errMsg });
        }
      },
    },
    { name: "qqbot_guild_member_list" },
  );

  // ---- 频道身份组成员列表 ----

  api.registerTool(
    {
      name: "qqbot_guild_role_member_list",
      label: "QQBot Guild Role Member List",
      description:
        "获取频道指定身份组的成员列表（仅私域机器人可用）。" +
        "需要提供频道 guild_id 和身份组 role_id，支持 start_index/limit 分页参数。" +
        "返回 data（成员数组）和 next（下次分页标识）。" +
        "翻页时使用上次返回的 next 作为下次请求的 start_index，直到 data 为空。",
      parameters: RoleMemberListSchema,
      async execute(_toolCallId, params) {
        const p = params as RoleMemberListParams;

        if (!p.guild_id || !p.role_id) {
          return json({ error: "guild_id 和 role_id 为必填参数" });
        }

        const query = new URLSearchParams();
        if (p.start_index) query.set("start_index", p.start_index);
        if (p.limit != null) query.set("limit", String(Math.max(1, Math.min(400, p.limit))));

        const qs = query.toString();
        const path = `/guilds/${p.guild_id}/roles/${p.role_id}/members${qs ? `?${qs}` : ""}`;

        try {
          const accessToken = await getAccessToken(account.appId, account.clientSecret);
          const result = await apiRequest<RoleMembersResponse>(
            accessToken,
            "GET",
            path,
          );
          return json(result);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const errStack = err instanceof Error ? err.stack : undefined;
          api.logger.error?.(
            `qqbot_guild_role_member_list: Failed to get role members for guild ${p.guild_id} role ${p.role_id}: ${errMsg}`,
          );
          if (errStack) {
            api.logger.error?.(`qqbot_guild_role_member_list: Stack trace:\n${errStack}`);
          }
          return json({ error: errMsg });
        }
      },
    },
    { name: "qqbot_guild_role_member_list" },
  );

  // ---- 频道成员详情 ----

  api.registerTool(
    {
      name: "qqbot_guild_member_get",
      label: "QQBot Guild Member Get",
      description:
        "获取频道中指定成员的详细信息。" +
        "需要提供频道 guild_id 和用户 user_id。" +
        "返回成员信息，包含用户基本信息、昵称、身份组列表、加入时间等。",
      parameters: GetMemberSchema,
      async execute(_toolCallId, params) {
        const p = params as GetMemberParams;

        if (!p.guild_id || !p.user_id) {
          return json({ error: "guild_id 和 user_id 为必填参数" });
        }

        try {
          const accessToken = await getAccessToken(account.appId, account.clientSecret);
          const member = await apiRequest<Member>(
            accessToken,
            "GET",
            `/guilds/${p.guild_id}/members/${p.user_id}`,
          );
          return json(member);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const errStack = err instanceof Error ? err.stack : undefined;
          api.logger.error?.(
            `qqbot_guild_member_get: Failed to get member ${p.user_id} in guild ${p.guild_id}: ${errMsg}`,
          );
          if (errStack) {
            api.logger.error?.(`qqbot_guild_member_get: Stack trace:\n${errStack}`);
          }
          return json({ error: errMsg });
        }
      },
    },
    { name: "qqbot_guild_member_get" },
  );

  api.logger.info?.("guild-member: Registered all guild member tools");
}
