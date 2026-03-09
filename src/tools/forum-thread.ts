import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveQQBotAccount } from "../config.js";
import { listQQBotAccountIds } from "../config.js";
import { getAccessToken, apiRequest } from "../api.js";

// ========== 常量 ==========

const FORMAT_TEXT = 1;
const FORMAT_HTML = 2;
const FORMAT_MARKDOWN = 3;
const FORMAT_JSON = 4;

// ========== 类型定义 ==========

interface PutThreadResult {
  task_id: string;
  create_time: string;
}

interface PutThreadParams {
  channel_id: string;
  title: string;
  content: string;
  format: number;
}

interface ThreadDetail {
  thread: {
    guild_id: string;
    channel_id: string;
    author_id: string;
    thread_info: {
      thread_id: string;
      title: string;
      content: string;
      date_time: string;
    };
  };
}

interface ThreadListResult {
  threads: Array<{
    guild_id: string;
    channel_id: string;
    author_id: string;
    thread_info: {
      thread_id: string;
      title: string;
      content: string;
      date_time: string;
    };
  }>;
  is_finish: number;
}

interface GetThreadParams {
  channel_id: string;
  thread_id: string;
}

interface DeleteThreadParams {
  channel_id: string;
  thread_id: string;
}

interface ThreadListParams {
  channel_id: string;
}

// ========== JSON Schema ==========

const PutThreadSchema = {
  type: "object",
  properties: {
    channel_id: {
      type: "string",
      description: "子频道 ID（论坛类型的子频道）",
    },
    title: {
      type: "string",
      description: "帖子标题",
    },
    content: {
      type: "string",
      description:
        "帖子内容（默认为 Markdown 格式）。format=1 时为纯文本；format=2 时为 HTML；format=3 时为 Markdown；format=4 时为 RichText JSON 字符串",
    },
    format: {
      type: "number",
      description:
        "帖子文本格式：1=普通文本, 2=HTML, 3=Markdown, 4=JSON（RichText）。不传时默认为 3（Markdown）",
      enum: [FORMAT_TEXT, FORMAT_HTML, FORMAT_MARKDOWN, FORMAT_JSON],
      default: FORMAT_MARKDOWN,
    },
  },
  required: ["channel_id", "title", "content"],
} as const;

const GetThreadSchema = {
  type: "object",
  properties: {
    channel_id: {
      type: "string",
      description: "子频道 ID（论坛类型的子频道），可通过 qqbot_channel_list 工具获取",
    },
    thread_id: {
      type: "string",
      description: "帖子 ID",
    },
  },
  required: ["channel_id", "thread_id"],
} as const;

const DeleteThreadSchema = {
  type: "object",
  properties: {
    channel_id: {
      type: "string",
      description: "子频道 ID（论坛类型的子频道），可通过 qqbot_channel_list 工具获取",
    },
    thread_id: {
      type: "string",
      description: "帖子 ID",
    },
  },
  required: ["channel_id", "thread_id"],
} as const;

const ThreadListSchema = {
  type: "object",
  properties: {
    channel_id: {
      type: "string",
      description: "子频道 ID（论坛类型的子频道），可通过 qqbot_channel_list 工具获取",
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

/**
 * 在指定论坛子频道发表帖子
 * PUT /channels/{channel_id}/threads
 */
async function putThread(
  accessToken: string,
  params: PutThreadParams,
): Promise<PutThreadResult> {
  return apiRequest<PutThreadResult>(
    accessToken,
    "PUT",
    `/channels/${params.channel_id}/threads`,
    {
      title: params.title,
      content: params.content,
      format: params.format,
    },
  );
}

/**
 * 获取指定子频道下的帖子详情
 * GET /channels/{channel_id}/threads/{thread_id}
 */
async function getThread(
  accessToken: string,
  channelId: string,
  threadId: string,
): Promise<ThreadDetail> {
  return apiRequest<ThreadDetail>(
    accessToken,
    "GET",
    `/channels/${channelId}/threads/${threadId}`,
  );
}

/**
 * 获取子频道下的帖子列表
 * GET /channels/{channel_id}/threads
 */
async function getThreadList(
  accessToken: string,
  channelId: string,
): Promise<ThreadListResult> {
  return apiRequest<ThreadListResult>(
    accessToken,
    "GET",
    `/channels/${channelId}/threads`,
  );
}

/**
 * 删除指定子频道下的帖子
 * DELETE /channels/{channel_id}/threads/{thread_id}
 */
async function deleteThread(
  accessToken: string,
  channelId: string,
  threadId: string,
): Promise<void> {
  await apiRequest<void>(
    accessToken,
    "DELETE",
    `/channels/${channelId}/threads/${threadId}`,
  );
}

// ========== 注册入口 ==========

/**
 * 注册所有论坛帖子相关工具：
 * - qqbot_forum_thread_list: 获取帖子列表
 * - qqbot_forum_put_thread: 发表帖子
 * - qqbot_forum_get_thread: 获取帖子详情
 * - qqbot_forum_delete_thread: 删除帖子
 *
 * 注意：以上接口仅私域机器人可用
 */
export function registerForumThreadTools(api: OpenClawPluginApi): void {
  const cfg = api.config;
  if (!cfg) {
    api.logger.debug?.("forum-thread: No config available, skipping");
    return;
  }

  const accountIds = listQQBotAccountIds(cfg);
  if (accountIds.length === 0) {
    api.logger.debug?.("forum-thread: No QQBot accounts configured, skipping");
    return;
  }

  const firstAccountId = accountIds[0];
  const account = resolveQQBotAccount(cfg, firstAccountId);

  if (!account.appId || !account.clientSecret) {
    api.logger.debug?.("forum-thread: Account not fully configured, skipping");
    return;
  }

  // ---- 帖子列表 ----

  api.registerTool(
    {
      name: "qqbot_forum_thread_list",
      label: "QQBot Forum Thread List",
      description:
        "获取 QQ 频道论坛子频道中的帖子列表（仅私域机器人可用）。" +
        "需要提供论坛子频道 ID（可通过 qqbot_channel_list 获取）。" +
        "返回帖子 ID、标题、内容、作者、发布时间等信息。",
      parameters: ThreadListSchema,
      async execute(_toolCallId, params) {
        const p = params as ThreadListParams;

        if (!p.channel_id) {
          return json({ error: "channel_id 为必填参数" });
        }

        try {
          const accessToken = await getAccessToken(account.appId, account.clientSecret);
          const result = await getThreadList(accessToken, p.channel_id);
          return json(result);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const errStack = err instanceof Error ? err.stack : undefined;
          api.logger.error?.(
            `qqbot_forum_thread_list: Failed to get thread list for channel ${p.channel_id}: ${errMsg}`,
          );
          if (errStack) {
            api.logger.error?.(`qqbot_forum_thread_list: Stack trace:\n${errStack}`);
          }
          return json({ error: errMsg });
        }
      },
    },
    { name: "qqbot_forum_thread_list" },
  );

  // ---- 发表帖子 ----

  api.registerTool(
    {
      name: "qqbot_forum_put_thread",
      label: "QQBot Forum Put Thread",
      description:
        "在 QQ 频道的论坛子频道中发表帖子（仅私域机器人可用）。" +
        "需要提供子频道 ID、帖子标题和内容。" +
        "支持纯文本、HTML、Markdown 和 RichText JSON 格式。",
      parameters: PutThreadSchema,
      async execute(_toolCallId, params) {
        const p = params as PutThreadParams;

        if (!p.channel_id || !p.title || !p.content) {
          return json({ error: "channel_id, title 和 content 为必填参数" });
        }

        const format = p.format ?? FORMAT_MARKDOWN;
        if (![FORMAT_TEXT, FORMAT_HTML, FORMAT_MARKDOWN, FORMAT_JSON].includes(format)) {
          return json({ error: `无效的 format 值: ${format}，可选值为 1/2/3/4` });
        }

        try {
          const accessToken = await getAccessToken(account.appId, account.clientSecret);
          const result = await putThread(accessToken, {
            channel_id: p.channel_id,
            title: p.title,
            content: p.content,
            format,
          });
          return json({
            success: true,
            task_id: result.task_id,
            create_time: result.create_time,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          api.logger.error?.(
            `qqbot_forum_put_thread: Failed to put thread in channel ${p.channel_id}: ${errMsg}`,
          );
          return json({ error: errMsg });
        }
      },
    },
    { name: "qqbot_forum_put_thread" },
  );

  // ---- 获取帖子详情 ----

  api.registerTool(
    {
      name: "qqbot_forum_get_thread",
      label: "QQBot Forum Get Thread",
      description:
        "获取 QQ 频道论坛子频道中的帖子详情（仅私域机器人可用）。" +
        "需要提供子频道 ID 和帖子 ID。" +
        "返回帖子标题、内容（RichText JSON）、作者、发布时间等信息。",
      parameters: GetThreadSchema,
      async execute(_toolCallId, params) {
        const p = params as GetThreadParams;

        if (!p.channel_id || !p.thread_id) {
          return json({ error: "channel_id 和 thread_id 为必填参数" });
        }

        try {
          const accessToken = await getAccessToken(account.appId, account.clientSecret);
          const detail = await getThread(accessToken, p.channel_id, p.thread_id);
          return json(detail);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          api.logger.error?.(
            `qqbot_forum_get_thread: Failed to get thread ${p.thread_id} in channel ${p.channel_id}: ${errMsg}`,
          );
          return json({ error: errMsg });
        }
      },
    },
    { name: "qqbot_forum_get_thread" },
  );

  // ---- 删除帖子 ----

  api.registerTool(
    {
      name: "qqbot_forum_delete_thread",
      label: "QQBot Forum Delete Thread",
      description:
        "删除 QQ 频道论坛子频道中的帖子（仅私域机器人可用）。" +
        "需要提供子频道 ID 和帖子 ID。",
      parameters: DeleteThreadSchema,
      async execute(_toolCallId, params) {
        const p = params as DeleteThreadParams;

        if (!p.channel_id || !p.thread_id) {
          return json({ error: "channel_id 和 thread_id 为必填参数" });
        }

        try {
          const accessToken = await getAccessToken(account.appId, account.clientSecret);
          await deleteThread(accessToken, p.channel_id, p.thread_id);
          return json({
            success: true,
            message: `帖子 ${p.thread_id} 已从子频道 ${p.channel_id} 中删除`,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const errStack = err instanceof Error ? err.stack : undefined;
          api.logger.error?.(
            `qqbot_forum_delete_thread: Failed to delete thread ${p.thread_id} in channel ${p.channel_id}: ${errMsg}`,
          );
          if (errStack) {
            api.logger.error?.(`qqbot_forum_delete_thread: Stack trace:\n${errStack}`);
          }
          return json({ error: errMsg });
        }
      },
    },
    { name: "qqbot_forum_delete_thread" },
  );

  api.logger.info?.("forum-thread: Registered all forum thread tools");
}
