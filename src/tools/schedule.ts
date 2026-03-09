import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveQQBotAccount } from "../config.js";
import { listQQBotAccountIds } from "../config.js";
import { getAccessToken, apiRequest } from "../api.js";

/**
 * 日程提醒类型
 * 0: 不提醒, 1: 开始时提醒, 2: 开始前5分钟, 3: 开始前15分钟, 4: 开始前30分钟, 5: 开始前60分钟
 */
const REMIND_TYPE_NONE = "0";
const REMIND_TYPE_AT_START = "1";
const REMIND_TYPE_5MIN_BEFORE = "2";
const REMIND_TYPE_15MIN_BEFORE = "3";
const REMIND_TYPE_30MIN_BEFORE = "4";
const REMIND_TYPE_60MIN_BEFORE = "5";

/**
 * Schedule 对象
 */
interface Schedule {
  id?: string;
  name: string;
  start_timestamp: string;
  end_timestamp: string;
  jump_channel_id?: string;
  remind_type?: string;
  creator?: {
    user: { id: string; username: string; bot: boolean };
    nick: string;
    joined_at: string;
  };
}

/**
 * 创建/修改日程的 Schedule 参数（不含 id）
 */
interface ScheduleInput {
  name: string;
  start_timestamp: string;
  end_timestamp: string;
  jump_channel_id?: string;
  remind_type?: string;
}

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

// ---- 创建日程 ----

interface PostScheduleParams {
  channel_id: string;
  name: string;
  start_timestamp: string;
  end_timestamp: string;
  jump_channel_id?: string;
  remind_type?: string;
}

const PostScheduleSchema = {
  type: "object",
  properties: {
    channel_id: {
      type: "string",
      description: "日程子频道 ID，可通过 qqbot_channel_list 工具获取",
    },
    name: {
      type: "string",
      description: "日程名称",
    },
    start_timestamp: {
      type: "string",
      description: "日程开始时间戳（毫秒），如 \"1642076453000\"",
    },
    end_timestamp: {
      type: "string",
      description: "日程结束时间戳（毫秒），如 \"1642083653000\"",
    },
    jump_channel_id: {
      type: "string",
      description: "日程开始时跳转到的子频道 ID，默认 \"0\"（不跳转）",
      default: "0",
    },
    remind_type: {
      type: "string",
      description:
        "提醒类型：0=不提醒, 1=开始时提醒, 2=开始前5分钟, 3=开始前15分钟, 4=开始前30分钟, 5=开始前60分钟。默认 \"0\"",
      enum: [
        REMIND_TYPE_NONE,
        REMIND_TYPE_AT_START,
        REMIND_TYPE_5MIN_BEFORE,
        REMIND_TYPE_15MIN_BEFORE,
        REMIND_TYPE_30MIN_BEFORE,
        REMIND_TYPE_60MIN_BEFORE,
      ],
      default: REMIND_TYPE_NONE,
    },
  },
  required: ["channel_id", "name", "start_timestamp", "end_timestamp"],
} as const;

// ---- 修改日程 ----

interface PatchScheduleParams extends PostScheduleParams {
  schedule_id: string;
}

const PatchScheduleSchema = {
  type: "object",
  properties: {
    ...PostScheduleSchema.properties,
    schedule_id: {
      type: "string",
      description: "要修改的日程 ID",
    },
  },
  required: ["channel_id", "schedule_id", "name", "start_timestamp", "end_timestamp"],
} as const;

// ---- 删除日程 ----

interface DeleteScheduleParams {
  channel_id: string;
  schedule_id: string;
}

const DeleteScheduleSchema = {
  type: "object",
  properties: {
    channel_id: {
      type: "string",
      description: "日程子频道 ID",
    },
    schedule_id: {
      type: "string",
      description: "要删除的日程 ID",
    },
  },
  required: ["channel_id", "schedule_id"],
} as const;

/**
 * 注册日程相关工具（创建、修改、删除）
 */
export function registerScheduleTools(api: OpenClawPluginApi): void {
  const cfg = api.config;
  if (!cfg) {
    api.logger.debug?.("qqbot_schedule: No config available, skipping");
    return;
  }

  const accountIds = listQQBotAccountIds(cfg);
  if (accountIds.length === 0) {
    api.logger.debug?.("qqbot_schedule: No QQBot accounts configured, skipping");
    return;
  }

  const firstAccountId = accountIds[0];
  const account = resolveQQBotAccount(cfg, firstAccountId);

  if (!account.appId || !account.clientSecret) {
    api.logger.debug?.("qqbot_schedule: Account not fully configured, skipping");
    return;
  }

  // 创建日程
  api.registerTool(
    {
      name: "qqbot_schedule_create",
      label: "QQBot Schedule Create",
      description:
        "在 QQ 频道的日程子频道中创建日程。" +
        "需要管理频道权限。单个管理员每天限 10 次，单个频道每天限 100 次。" +
        "需要提供日程名称、开始/结束时间戳（毫秒）。",
      parameters: PostScheduleSchema,
      async execute(_toolCallId, params) {
        const p = params as PostScheduleParams;

        if (!p.channel_id || !p.name || !p.start_timestamp || !p.end_timestamp) {
          return json({ error: "channel_id, name, start_timestamp, end_timestamp 为必填参数" });
        }

        const scheduleInput: ScheduleInput = {
          name: p.name,
          start_timestamp: p.start_timestamp,
          end_timestamp: p.end_timestamp,
          jump_channel_id: p.jump_channel_id ?? "0",
          remind_type: p.remind_type ?? REMIND_TYPE_NONE,
        };

        try {
          const accessToken = await getAccessToken(account.appId, account.clientSecret);
          const result = await apiRequest<Schedule>(
            accessToken,
            "POST",
            `/channels/${p.channel_id}/schedules`,
            { schedule: scheduleInput },
          );
          return json(result);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const errStack = err instanceof Error ? err.stack : undefined;
          api.logger.error?.(
            `qqbot_schedule_create: Failed to create schedule in channel ${p.channel_id}: ${errMsg}`,
          );
          if (errStack) {
            api.logger.error?.(`qqbot_schedule_create: Stack trace:\n${errStack}`);
          }
          return json({ error: errMsg });
        }
      },
    },
    { name: "qqbot_schedule_create" },
  );

  api.logger.info?.("qqbot_schedule: Registered qqbot_schedule_create tool");

  // 修改日程
  api.registerTool(
    {
      name: "qqbot_schedule_update",
      label: "QQBot Schedule Update",
      description:
        "修改 QQ 频道日程子频道中的指定日程。" +
        "需要管理频道权限。需要提供日程 ID、名称、开始/结束时间戳。",
      parameters: PatchScheduleSchema,
      async execute(_toolCallId, params) {
        const p = params as PatchScheduleParams;

        if (!p.channel_id || !p.schedule_id || !p.name || !p.start_timestamp || !p.end_timestamp) {
          return json({
            error: "channel_id, schedule_id, name, start_timestamp, end_timestamp 为必填参数",
          });
        }

        const scheduleInput: ScheduleInput = {
          name: p.name,
          start_timestamp: p.start_timestamp,
          end_timestamp: p.end_timestamp,
          jump_channel_id: p.jump_channel_id ?? "0",
          remind_type: p.remind_type ?? REMIND_TYPE_NONE,
        };

        try {
          const accessToken = await getAccessToken(account.appId, account.clientSecret);
          const result = await apiRequest<Schedule>(
            accessToken,
            "PATCH",
            `/channels/${p.channel_id}/schedules/${p.schedule_id}`,
            { schedule: scheduleInput },
          );
          return json(result);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          api.logger.error?.(
            `qqbot_schedule_update: Failed to update schedule ${p.schedule_id} in channel ${p.channel_id}: ${errMsg}`,
          );
          return json({ error: errMsg });
        }
      },
    },
    { name: "qqbot_schedule_update" },
  );

  api.logger.info?.("qqbot_schedule: Registered qqbot_schedule_update tool");

  // 删除日程
  api.registerTool(
    {
      name: "qqbot_schedule_delete",
      label: "QQBot Schedule Delete",
      description:
        "删除 QQ 频道日程子频道中的指定日程。" +
        "需要管理频道权限。需要提供子频道 ID 和日程 ID。",
      parameters: DeleteScheduleSchema,
      async execute(_toolCallId, params) {
        const p = params as DeleteScheduleParams;

        if (!p.channel_id || !p.schedule_id) {
          return json({ error: "channel_id 和 schedule_id 为必填参数" });
        }

        try {
          const accessToken = await getAccessToken(account.appId, account.clientSecret);
          await apiRequest<void>(
            accessToken,
            "DELETE",
            `/channels/${p.channel_id}/schedules/${p.schedule_id}`,
          );
          return json({
            success: true,
            message: `已删除子频道 ${p.channel_id} 中的日程 ${p.schedule_id}`,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const errStack = err instanceof Error ? err.stack : undefined;
          api.logger.error?.(
            `qqbot_schedule_delete: Failed to delete schedule ${p.schedule_id} in channel ${p.channel_id}: ${errMsg}`,
          );
          if (errStack) {
            api.logger.error?.(`qqbot_schedule_delete: Stack trace:\n${errStack}`);
          }
          return json({ error: errMsg });
        }
      },
    },
    { name: "qqbot_schedule_delete" },
  );

  api.logger.info?.("qqbot_schedule: Registered qqbot_schedule_delete tool");
}
