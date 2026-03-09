import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveQQBotAccount } from "../config.js";
import { listQQBotAccountIds } from "../config.js";
import { getAccessToken, apiRequest } from "../api.js";

/**
 * 公告类型
 */
const ANNOUNCES_TYPE_MEMBER = 0;
const ANNOUNCES_TYPE_WELCOME = 1;

/**
 * 推荐子频道
 */
interface RecommendChannel {
  channel_id: string;
  introduce: string;
}

/**
 * 创建频道公告响应
 */
interface AnnouncesResult {
  guild_id: string;
  channel_id: string;
  message_id: string;
  announces_type: number;
  recommend_channels: RecommendChannel[];
}

/**
 * 创建频道公告参数
 */
interface PostAnnouncesParams {
  guild_id: string;
  message_id?: string;
  channel_id?: string;
  announces_type?: number;
  recommend_channels?: RecommendChannel[];
}

/**
 * 创建频道公告参数 JSON Schema
 */
const PostAnnouncesSchema = {
  type: "object",
  properties: {
    guild_id: {
      type: "string",
      description: "频道 ID，可通过 qqbot_guild_list 工具获取",
    },
    message_id: {
      type: "string",
      description:
        "消息 ID。如有值则优先创建消息类型的成员公告，此时 channel_id 为必填",
    },
    channel_id: {
      type: "string",
      description: "子频道 ID。创建消息类型公告时必填",
    },
    announces_type: {
      type: "number",
      description: "公告类型：0=成员公告（默认），1=欢迎公告",
      enum: [ANNOUNCES_TYPE_MEMBER, ANNOUNCES_TYPE_WELCOME],
    },
    recommend_channels: {
      type: "array",
      description:
        "推荐子频道列表（最多 3 条）。设置时会全部替换现有推荐列表。message_id 为空时生效",
      items: {
        type: "object",
        properties: {
          channel_id: {
            type: "string",
            description: "推荐的子频道 ID",
          },
          introduce: {
            type: "string",
            description: "推荐语",
          },
        },
        required: ["channel_id", "introduce"],
      },
    },
  },
  required: ["guild_id"],
} as const;

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

/**
 * 创建频道公告
 * POST /guilds/{guild_id}/announces
 */
async function postGuildAnnounces(
  accessToken: string,
  params: PostAnnouncesParams,
): Promise<AnnouncesResult> {
  const body: Record<string, unknown> = {};
  if (params.message_id) body.message_id = params.message_id;
  if (params.channel_id) body.channel_id = params.channel_id;
  if (params.announces_type != null) body.announces_type = params.announces_type;
  if (params.recommend_channels) body.recommend_channels = params.recommend_channels;

  return apiRequest<AnnouncesResult>(
    accessToken,
    "POST",
    `/guilds/${params.guild_id}/announces`,
    body,
  );
}

/**
 * 注册 qqbot_guild_announces 工具
 */
export function registerGuildAnnouncesTool(api: OpenClawPluginApi): void {
  const cfg = api.config;
  if (!cfg) {
    api.logger.debug?.("qqbot_guild_announces: No config available, skipping");
    return;
  }

  const accountIds = listQQBotAccountIds(cfg);
  if (accountIds.length === 0) {
    api.logger.debug?.("qqbot_guild_announces: No QQBot accounts configured, skipping");
    return;
  }

  const firstAccountId = accountIds[0];
  const account = resolveQQBotAccount(cfg, firstAccountId);

  if (!account.appId || !account.clientSecret) {
    api.logger.debug?.("qqbot_guild_announces: Account not fully configured, skipping");
    return;
  }

  api.registerTool(
    {
      name: "qqbot_guild_announces",
      label: "QQBot Guild Announces",
      description:
        "创建 QQ 频道全局公告。支持两种类型：" +
        "1) 消息类型公告：提供 message_id 和 channel_id，将某条消息设为公告；" +
        "2) 推荐子频道公告：提供 announces_type 和 recommend_channels（最多 3 条），推荐特定子频道。" +
        "两种类型会互相顶替。",
      parameters: PostAnnouncesSchema,
      async execute(_toolCallId, params) {
        const p = params as PostAnnouncesParams;

        if (!p.guild_id) {
          return json({ error: "guild_id 为必填参数" });
        }

        if (p.message_id && !p.channel_id) {
          return json({ error: "创建消息类型公告时 channel_id 为必填" });
        }

        if (p.recommend_channels && p.recommend_channels.length > 3) {
          return json({ error: "推荐子频道最多只能创建 3 条" });
        }

        try {
          const accessToken = await getAccessToken(account.appId, account.clientSecret);
          const result = await postGuildAnnounces(accessToken, p);
          return json(result);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const errStack = err instanceof Error ? err.stack : undefined;
          api.logger.error?.(
            `qqbot_guild_announces: Failed to create announces for guild ${p.guild_id}: ${errMsg}`,
          );
          if (errStack) {
            api.logger.error?.(`qqbot_guild_announces: Stack trace:\n${errStack}`);
          }
          return json({ error: errMsg });
        }
      },
    },
    { name: "qqbot_guild_announces" },
  );

  api.logger.info?.("qqbot_guild_announces: Registered qqbot_guild_announces tool");

  // ---- 删除频道公告 ----

  const DeleteAnnouncesSchema = {
    type: "object",
    properties: {
      guild_id: {
        type: "string",
        description: "频道 ID，可通过 qqbot_guild_list 工具获取",
      },
      message_id: {
        type: "string",
        description:
          '要删除的公告对应的消息 ID。如需删除所有公告，请设为 "all"',
        default: "all",
      },
    },
    required: ["guild_id"],
  } as const;

  interface DeleteAnnouncesParams {
    guild_id: string;
    message_id?: string;
  }

  api.registerTool(
    {
      name: "qqbot_guild_delete_announces",
      label: "QQBot Guild Delete Announces",
      description:
        "删除 QQ 频道全局公告。" +
        "提供 message_id 删除指定公告，或将 message_id 设为 \"all\" 删除所有公告。" +
        "不传 message_id 时默认删除所有公告。",
      parameters: DeleteAnnouncesSchema,
      async execute(_toolCallId, params) {
        const p = params as DeleteAnnouncesParams;

        if (!p.guild_id) {
          return json({ error: "guild_id 为必填参数" });
        }

        const messageId = p.message_id || "all";

        try {
          const accessToken = await getAccessToken(account.appId, account.clientSecret);
          await apiRequest<void>(
            accessToken,
            "DELETE",
            `/guilds/${p.guild_id}/announces/${messageId}`,
          );
          return json({
            success: true,
            message: messageId === "all"
              ? `已删除频道 ${p.guild_id} 的所有公告`
              : `已删除频道 ${p.guild_id} 中消息 ${messageId} 的公告`,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const errStack = err instanceof Error ? err.stack : undefined;
          api.logger.error?.(
            `qqbot_guild_delete_announces: Failed to delete announces for guild ${p.guild_id}: ${errMsg}`,
          );
          if (errStack) {
            api.logger.error?.(`qqbot_guild_delete_announces: Stack trace:\n${errStack}`);
          }
          return json({ error: errMsg });
        }
      },
    },
    { name: "qqbot_guild_delete_announces" },
  );

  api.logger.info?.("qqbot_guild_delete_announces: Registered qqbot_guild_delete_announces tool");
}
