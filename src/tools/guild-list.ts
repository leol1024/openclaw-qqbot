import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveQQBotAccount } from "../config.js";
import { listQQBotAccountIds } from "../config.js";
import { getAccessToken, apiRequest } from "../api.js";

/**
 * Guild 对象（频道信息）
 */
interface Guild {
  id: string;
  name: string;
  icon: string;
  owner_id: string;
  owner: boolean;
  joined_at: string;
  member_count: number;
  max_members: number;
  description: string;
}

/**
 * 获取频道列表参数 JSON Schema
 */
const GuildListSchema = {
  type: "object",
  properties: {
    before: {
      type: "string",
      description: "读此 guild id 之前的数据。设置 before 时，会先反序，再分页",
    },
    after: {
      type: "string",
      description: "读此 guild id 之后的数据。当 after 和 before 同时设置时，after 参数无效",
    },
    limit: {
      type: "number",
      description: "每次拉取多少条数据，默认 100，最大 100",
    },
  },
  required: [],
} as const;

interface GuildListParams {
  before?: string;
  after?: string;
  limit?: number;
}

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

/**
 * 获取机器人加入的频道列表
 * GET /users/@me/guilds
 */
async function getGuildList(
  accessToken: string,
  params?: GuildListParams,
): Promise<Guild[]> {
  const query = new URLSearchParams();
  if (params?.before) query.set("before", params.before);
  if (params?.after) query.set("after", params.after);
  if (params?.limit != null) query.set("limit", String(Math.max(1, Math.min(100, params.limit))));

  const qs = query.toString();
  const path = `/users/@me/guilds${qs ? `?${qs}` : ""}`;

  return apiRequest<Guild[]>(accessToken, "GET", path);
}

// ========== API 权限类型 ==========

interface APIPermission {
  path: string;
  method: string;
  desc: string;
  auth_status: number;
}

interface APIPermissionResponse {
  apis: APIPermission[];
}

interface GuildApiPermissionParams {
  guild_id: string;
}

const GuildApiPermissionSchema = {
  type: "object",
  properties: {
    guild_id: {
      type: "string",
      description: "频道 ID，可通过 qqbot_guild_list 工具获取",
    },
  },
  required: ["guild_id"],
} as const;

// ========== 注册入口 ==========

/**
 * 注册所有频道级工具：
 * - qqbot_guild_list: 获取机器人加入的频道列表
 * - qqbot_guild_api_permission: 获取机器人在频道可用权限列表
 */
export function registerGuildTools(api: OpenClawPluginApi): void {
  const cfg = api.config;
  if (!cfg) {
    api.logger.debug?.("guild: No config available, skipping");
    return;
  }

  const accountIds = listQQBotAccountIds(cfg);
  if (accountIds.length === 0) {
    api.logger.debug?.("guild: No QQBot accounts configured, skipping");
    return;
  }

  const firstAccountId = accountIds[0];
  const account = resolveQQBotAccount(cfg, firstAccountId);

  if (!account.appId || !account.clientSecret) {
    api.logger.debug?.("guild: Account not fully configured, skipping");
    return;
  }

  // ---- 频道列表 ----

  api.registerTool(
    {
      name: "qqbot_guild_list",
      label: "QQBot Guild List",
      description:
        "获取 QQ 机器人加入的频道列表。" +
        "返回频道 id、名称、图标、拥有者、成员数等信息。" +
        "支持分页参数 before / after / limit。",
      parameters: GuildListSchema,
      async execute(_toolCallId, params) {
        const p = params as GuildListParams;
        try {
          const accessToken = await getAccessToken(account.appId, account.clientSecret);
          const guilds = await getGuildList(accessToken, p);
          return json(guilds);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const errStack = err instanceof Error ? err.stack : undefined;
          api.logger.error?.(
            `qqbot_guild_list: Failed to get guilds: ${errMsg}`,
          );
          if (errStack) {
            api.logger.error?.(`qqbot_guild_list: Stack trace:\n${errStack}`);
          }
          return json({ error: errMsg });
        }
      },
    },
    { name: "qqbot_guild_list" },
  );

  // ---- 频道 API 权限列表 ----

  api.registerTool(
    {
      name: "qqbot_guild_api_permission",
      label: "QQBot Guild API Permission",
      description:
        "获取机器人在指定频道内可以使用的权限列表。" +
        "需要提供频道 guild_id。" +
        "返回 apis 数组，每项包含接口路径 path、请求方法 method、接口描述 desc、授权状态 auth_status（0=未授权, 1=已授权）。",
      parameters: GuildApiPermissionSchema,
      async execute(_toolCallId, params) {
        const p = params as GuildApiPermissionParams;

        if (!p.guild_id) {
          return json({ error: "guild_id 为必填参数" });
        }

        try {
          const accessToken = await getAccessToken(account.appId, account.clientSecret);
          const result = await apiRequest<APIPermissionResponse>(
            accessToken,
            "GET",
            `/guilds/${p.guild_id}/api_permission`,
          );
          return json(result);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const errStack = err instanceof Error ? err.stack : undefined;
          api.logger.error?.(
            `qqbot_guild_api_permission: Failed to get api permissions for guild ${p.guild_id}: ${errMsg}`,
          );
          if (errStack) {
            api.logger.error?.(`qqbot_guild_api_permission: Stack trace:\n${errStack}`);
          }
          return json({ error: errMsg });
        }
      },
    },
    { name: "qqbot_guild_api_permission" },
  );

  api.logger.info?.("guild: Registered all guild tools");
}
