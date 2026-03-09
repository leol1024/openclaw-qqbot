import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveQQBotAccount } from "../config.js";
import { listQQBotAccountIds } from "../config.js";
import { getAccessToken, apiRequest } from "../api.js";

// ========== 常量 ==========

const CHANNEL_TYPE_TEXT = 0;
const CHANNEL_TYPE_VOICE = 2;
const CHANNEL_TYPE_CATEGORY = 4;
const CHANNEL_TYPE_LIVE = 10005;
const CHANNEL_TYPE_APP = 10006;
const CHANNEL_TYPE_FORUM = 10007;

// ========== 类型定义 ==========

interface Channel {
  id: string;
  guild_id: string;
  name: string;
  type: number;
  position: number;
  parent_id: string;
  owner_id: string;
  sub_type: number;
  private_type?: number;
  speak_permission?: number;
  application_id?: string;
}

interface ChannelListParams {
  guild_id: string;
}

interface GetChannelParams {
  channel_id: string;
}

interface CreateChannelParams {
  guild_id: string;
  name: string;
  type: number;
  sub_type?: number;
  position: number;
  parent_id?: string;
  private_type?: number;
  private_user_ids?: string[];
  speak_permission?: number;
  application_id?: string;
}

interface PatchChannelParams {
  channel_id: string;
  name?: string;
  position?: number;
  parent_id?: string;
  private_type?: number;
  speak_permission?: number;
}

interface DeleteChannelParams {
  channel_id: string;
}

// ========== JSON Schema ==========

const ChannelListSchema = {
  type: "object",
  properties: {
    guild_id: {
      type: "string",
      description: "频道 ID，可通过 qqbot_guild_list 工具获取",
    },
  },
  required: ["guild_id"],
} as const;

const GetChannelSchema = {
  type: "object",
  properties: {
    channel_id: {
      type: "string",
      description: "子频道 ID",
    },
  },
  required: ["channel_id"],
} as const;

const CreateChannelSchema = {
  type: "object",
  properties: {
    guild_id: {
      type: "string",
      description: "频道 ID，可通过 qqbot_guild_list 工具获取",
    },
    name: {
      type: "string",
      description: "子频道名称",
    },
    type: {
      type: "number",
      description:
        "子频道类型：0=文字, 2=语音, 4=子频道分组, 10005=直播, 10006=应用, 10007=论坛",
      enum: [
        CHANNEL_TYPE_TEXT,
        CHANNEL_TYPE_VOICE,
        CHANNEL_TYPE_CATEGORY,
        CHANNEL_TYPE_LIVE,
        CHANNEL_TYPE_APP,
        CHANNEL_TYPE_FORUM,
      ],
    },
    sub_type: {
      type: "number",
      description: "子频道子类型：0=闲聊, 1=公告, 2=攻略, 3=开黑",
      enum: [0, 1, 2, 3],
    },
    position: {
      type: "number",
      description: "子频道排序位置（当 type=4 即分组时，数值必须 >= 2）",
    },
    parent_id: {
      type: "string",
      description: "子频道所属分组 ID",
    },
    private_type: {
      type: "number",
      description: "子频道私密类型：0=公开, 1=管理员和指定成员可见, 2=管理员可见",
      enum: [0, 1, 2],
    },
    private_user_ids: {
      type: "array",
      items: { type: "string" },
      description: "子频道私密类型成员 ID 列表（private_type=1 时有效）",
    },
    speak_permission: {
      type: "number",
      description: "子频道发言权限：0=无效（仅创建公告子频道时有效，此时为只读）, 1=所有人, 2=管理员和指定成员",
      enum: [0, 1, 2],
    },
    application_id: {
      type: "string",
      description: "应用类型子频道的应用 AppID（仅 type=10006 时需要）",
    },
  },
  required: ["guild_id", "name", "type", "position"],
} as const;

const PatchChannelSchema = {
  type: "object",
  properties: {
    channel_id: {
      type: "string",
      description: "要修改的子频道 ID",
    },
    name: {
      type: "string",
      description: "子频道名称",
    },
    position: {
      type: "number",
      description: "排序位置",
    },
    parent_id: {
      type: "string",
      description: "分组 ID",
    },
    private_type: {
      type: "number",
      description: "子频道私密类型：0=公开, 1=管理员和指定成员可见, 2=管理员可见",
      enum: [0, 1, 2],
    },
    speak_permission: {
      type: "number",
      description: "子频道发言权限：0=无效, 1=所有人, 2=管理员和指定成员",
      enum: [0, 1, 2],
    },
  },
  required: ["channel_id"],
} as const;

const DeleteChannelSchema = {
  type: "object",
  properties: {
    channel_id: {
      type: "string",
      description: "要删除的子频道 ID",
    },
  },
  required: ["channel_id"],
} as const;

// ========== 工具函数 ==========

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

function channelTypeName(type: number): string {
  switch (type) {
    case CHANNEL_TYPE_TEXT:
      return "文字子频道";
    case CHANNEL_TYPE_VOICE:
      return "语音子频道";
    case CHANNEL_TYPE_CATEGORY:
      return "分组";
    case CHANNEL_TYPE_LIVE:
      return "直播子频道";
    case CHANNEL_TYPE_APP:
      return "应用子频道";
    case CHANNEL_TYPE_FORUM:
      return "论坛子频道";
    default:
      return `未知(${type})`;
  }
}

// ========== 注册入口 ==========

/**
 * 注册所有子频道相关工具：
 * - qqbot_channel_list: 获取子频道列表
 * - qqbot_channel_get: 获取子频道详情
 * - qqbot_channel_create: 创建子频道（仅私域机器人）
 * - qqbot_channel_update: 修改子频道（仅私域机器人）
 * - qqbot_channel_delete: 删除子频道（仅私域机器人）
 */
export function registerChannelTools(api: OpenClawPluginApi): void {
  const cfg = api.config;
  if (!cfg) {
    api.logger.debug?.("channel: No config available, skipping");
    return;
  }

  const accountIds = listQQBotAccountIds(cfg);
  if (accountIds.length === 0) {
    api.logger.debug?.("channel: No QQBot accounts configured, skipping");
    return;
  }

  const firstAccountId = accountIds[0];
  const account = resolveQQBotAccount(cfg, firstAccountId);

  if (!account.appId || !account.clientSecret) {
    api.logger.debug?.("channel: Account not fully configured, skipping");
    return;
  }

  // ---- 子频道列表 ----

  api.registerTool(
    {
      name: "qqbot_channel_list",
      label: "QQBot Channel List",
      description:
        "获取 QQ 频道下的子频道列表。" +
        "需要提供频道 guild_id（可通过 qqbot_guild_list 工具获取）。" +
        "返回子频道 id、名称、类型（文字/语音/分组/直播/应用/论坛）、排序位置等信息。",
      parameters: ChannelListSchema,
      async execute(_toolCallId, params) {
        const p = params as ChannelListParams;

        if (!p.guild_id) {
          return json({ error: "guild_id 为必填参数" });
        }

        try {
          const accessToken = await getAccessToken(account.appId, account.clientSecret);
          const channels = await apiRequest<Channel[]>(
            accessToken,
            "GET",
            `/guilds/${p.guild_id}/channels`,
          );
          const enriched = channels.map((ch) => ({
            ...ch,
            type_name: channelTypeName(ch.type),
          }));
          return json(enriched);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const errStack = err instanceof Error ? err.stack : undefined;
          api.logger.error?.(
            `qqbot_channel_list: Failed to get channels for guild ${p.guild_id}: ${errMsg}`,
          );
          if (errStack) {
            api.logger.error?.(`qqbot_channel_list: Stack trace:\n${errStack}`);
          }
          return json({ error: errMsg });
        }
      },
    },
    { name: "qqbot_channel_list" },
  );

  // ---- 子频道详情 ----

  api.registerTool(
    {
      name: "qqbot_channel_get",
      label: "QQBot Channel Get",
      description:
        "获取 QQ 频道中指定子频道的详情。" +
        "返回子频道 id、名称、类型、排序、所属分组、私密类型、发言权限等信息。",
      parameters: GetChannelSchema,
      async execute(_toolCallId, params) {
        const p = params as GetChannelParams;

        if (!p.channel_id) {
          return json({ error: "channel_id 为必填参数" });
        }

        try {
          const accessToken = await getAccessToken(account.appId, account.clientSecret);
          const channel = await apiRequest<Channel>(
            accessToken,
            "GET",
            `/channels/${p.channel_id}`,
          );
          return json({ ...channel, type_name: channelTypeName(channel.type) });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const errStack = err instanceof Error ? err.stack : undefined;
          api.logger.error?.(
            `qqbot_channel_get: Failed to get channel ${p.channel_id}: ${errMsg}`,
          );
          if (errStack) {
            api.logger.error?.(`qqbot_channel_get: Stack trace:\n${errStack}`);
          }
          return json({ error: errMsg });
        }
      },
    },
    { name: "qqbot_channel_get" },
  );

  // ---- 创建子频道 ----

  api.registerTool(
    {
      name: "qqbot_channel_create",
      label: "QQBot Channel Create",
      description:
        "在 QQ 频道下创建子频道（仅私域机器人可用，需管理频道权限）。" +
        "需要提供频道 guild_id、子频道名称、类型和排序位置。" +
        "创建成功后触发子频道创建事件。",
      parameters: CreateChannelSchema,
      async execute(_toolCallId, params) {
        const p = params as CreateChannelParams;

        if (!p.guild_id || !p.name || p.type == null || p.position == null) {
          return json({ error: "guild_id, name, type, position 为必填参数" });
        }

        if (p.type === CHANNEL_TYPE_CATEGORY && p.position < 2) {
          return json({ error: "子频道分组（type=4）的 position 必须 >= 2" });
        }

        const body: Record<string, unknown> = {
          name: p.name,
          type: p.type,
          position: p.position,
        };
        if (p.sub_type != null) body.sub_type = p.sub_type;
        if (p.parent_id) body.parent_id = p.parent_id;
        if (p.private_type != null) body.private_type = p.private_type;
        if (p.private_user_ids) body.private_user_ids = p.private_user_ids;
        if (p.speak_permission != null) body.speak_permission = p.speak_permission;
        if (p.application_id) body.application_id = p.application_id;

        try {
          const accessToken = await getAccessToken(account.appId, account.clientSecret);
          const channel = await apiRequest<Channel>(
            accessToken,
            "POST",
            `/guilds/${p.guild_id}/channels`,
            body,
          );
          return json({ ...channel, type_name: channelTypeName(channel.type) });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          api.logger.error?.(
            `qqbot_channel_create: Failed to create channel in guild ${p.guild_id}: ${errMsg}`,
          );
          return json({ error: errMsg });
        }
      },
    },
    { name: "qqbot_channel_create" },
  );

  // ---- 修改子频道 ----

  api.registerTool(
    {
      name: "qqbot_channel_update",
      label: "QQBot Channel Update",
      description:
        "修改 QQ 频道中指定子频道的信息（仅私域机器人可用，需管理子频道权限）。" +
        "支持修改名称、排序、分组、私密类型、发言权限。" +
        "修改成功后触发子频道更新事件。",
      parameters: PatchChannelSchema,
      async execute(_toolCallId, params) {
        const p = params as PatchChannelParams;

        if (!p.channel_id) {
          return json({ error: "channel_id 为必填参数" });
        }

        const body: Record<string, unknown> = {};
        if (p.name != null) body.name = p.name;
        if (p.position != null) body.position = p.position;
        if (p.parent_id != null) body.parent_id = p.parent_id;
        if (p.private_type != null) body.private_type = p.private_type;
        if (p.speak_permission != null) body.speak_permission = p.speak_permission;

        if (Object.keys(body).length === 0) {
          return json({ error: "请至少提供一个要修改的字段（name/position/parent_id/private_type/speak_permission）" });
        }

        try {
          const accessToken = await getAccessToken(account.appId, account.clientSecret);
          const channel = await apiRequest<Channel>(
            accessToken,
            "PATCH",
            `/channels/${p.channel_id}`,
            body,
          );
          return json({ ...channel, type_name: channelTypeName(channel.type) });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          api.logger.error?.(
            `qqbot_channel_update: Failed to update channel ${p.channel_id}: ${errMsg}`,
          );
          return json({ error: errMsg });
        }
      },
    },
    { name: "qqbot_channel_update" },
  );

  // ---- 删除子频道 ----

  api.registerTool(
    {
      name: "qqbot_channel_delete",
      label: "QQBot Channel Delete",
      description:
        "删除 QQ 频道中指定的子频道（仅私域机器人可用，需管理子频道权限）。" +
        "⚠️ 此操作不可逆，删除后数据无法恢复，请谨慎操作。" +
        "删除成功后触发子频道删除事件。",
      parameters: DeleteChannelSchema,
      async execute(_toolCallId, params) {
        const p = params as DeleteChannelParams;

        if (!p.channel_id) {
          return json({ error: "channel_id 为必填参数" });
        }

        try {
          const accessToken = await getAccessToken(account.appId, account.clientSecret);
          await apiRequest<void>(
            accessToken,
            "DELETE",
            `/channels/${p.channel_id}`,
          );
          return json({
            success: true,
            message: `子频道 ${p.channel_id} 已删除`,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          api.logger.error?.(
            `qqbot_channel_delete: Failed to delete channel ${p.channel_id}: ${errMsg}`,
          );
          return json({ error: errMsg });
        }
      },
    },
    { name: "qqbot_channel_delete" },
  );

  api.logger.info?.("channel: Registered all channel tools");
}
