import WebSocket from "ws";
import path from "node:path";
import * as fs from "node:fs";
import type { ResolvedQQBotAccount, WSPayload, C2CMessageEvent, GuildMessageEvent, GroupMessageEvent } from "./types.js";
import { getAccessToken, getGatewayUrl, sendC2CMessage, sendChannelMessage, sendDmMessage, sendGroupMessage, clearTokenCache, sendC2CImageMessage, sendGroupImageMessage, sendC2CVoiceMessage, sendGroupVoiceMessage, sendC2CVideoMessage, sendGroupVideoMessage, sendC2CFileMessage, sendGroupFileMessage, initApiConfig, startBackgroundTokenRefresh, stopBackgroundTokenRefresh, sendC2CInputNotify } from "./api.js";
import { loadSession, saveSession, clearSession, type SessionState } from "./session-store.js";
import { recordKnownUser, flushKnownUsers } from "./known-users.js";
import { getQQBotRuntime } from "./runtime.js";
import { startImageServer, isImageServerRunning, downloadFile, type ImageServerConfig } from "./image-server.js";
import { getImageSize, formatQQBotMarkdownImage, hasQQBotImageSize, DEFAULT_IMAGE_SIZE } from "./utils/image-size.js";
import { parseQQBotPayload, encodePayloadForCron, isCronReminderPayload, isMediaPayload, type CronReminderPayload, type MediaPayload } from "./utils/payload.js";
import { convertSilkToWav, isVoiceAttachment, formatDuration, resolveTTSConfig, textToSilk, audioFileToSilkBase64, waitForFile, isAudioFile } from "./utils/audio-convert.js";
import { normalizeMediaTags, parseMediaTags, INCOMPLETE_MEDIA_TAG_REGEX, decodeMediaPath, tagNameToQueueType, filterInternalMarkers } from "./utils/media-tags.js";
import { createDefaultChain, type StreamHandlerContext } from "./stream-handlers/index.js";
import { checkFileSize, readFileAsync, fileExistsAsync, isLargeFile, formatFileSize } from "./utils/file-utils.js";
import { getQQBotDataDir, isLocalPath as isLocalFilePath, looksLikeLocalPath, normalizePath, sanitizeFileName, runDiagnostics } from "./utils/platform.js";
import { createStreamSender } from "./outbound.js";
import { MSG_TYPE_C2C, MSG_TYPE_GUILD, MSG_TYPE_DM, MSG_TYPE_GROUP, type MessageType } from "./constants.js";

/**
 * 通用 OpenAI 兼容 STT（语音转文字）
 *
 * 为什么在插件侧做 STT 而不走框架管道？
 * 框架的 applyMediaUnderstanding 同时执行 runCapability("audio") 和 extractFileBlocks。
 * 后者会把 WAV 文件的 PCM 二进制当文本注入 Body（looksLikeUtf8Text 误判），导致 context 爆炸。
 * 在插件侧完成 STT 后不把 WAV 放入 MediaPaths，即可规避此框架 bug。
 *
 * 配置解析策略（与 TTS 统一的两级回退）：
 * 1. 优先 channels.qqbot.stt（插件专属配置）
 * 2. 回退 tools.media.audio.models[0]（框架级配置）
 * 3. 再从 models.providers.[provider] 继承 apiKey/baseUrl
 * 4. 支持任何 OpenAI 兼容的 STT 服务
 */
interface STTConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

function resolveSTTConfig(cfg: Record<string, unknown>): STTConfig | null {
  const c = cfg as any;

  // 优先使用 channels.qqbot.stt（插件专属配置）
  const channelStt = c?.channels?.qqbot?.stt;
  if (channelStt && channelStt.enabled !== false) {
    const providerId: string = channelStt?.provider || "openai";
    const providerCfg = c?.models?.providers?.[providerId];
    const baseUrl: string | undefined = channelStt?.baseUrl || providerCfg?.baseUrl;
    const apiKey: string | undefined = channelStt?.apiKey || providerCfg?.apiKey;
    const model: string = channelStt?.model || "whisper-1";
    if (baseUrl && apiKey) {
      return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
    }
  }

  // 回退到 tools.media.audio.models[0]（框架级配置）
  const audioModelEntry = c?.tools?.media?.audio?.models?.[0];
  if (audioModelEntry) {
    const providerId: string = audioModelEntry?.provider || "openai";
    const providerCfg = c?.models?.providers?.[providerId];
    const baseUrl: string | undefined = audioModelEntry?.baseUrl || providerCfg?.baseUrl;
    const apiKey: string | undefined = audioModelEntry?.apiKey || providerCfg?.apiKey;
    const model: string = audioModelEntry?.model || "whisper-1";
    if (baseUrl && apiKey) {
      return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
    }
  }

  return null;
}

async function transcribeAudio(audioPath: string, cfg: Record<string, unknown>): Promise<string | null> {
  const sttCfg = resolveSTTConfig(cfg);
  if (!sttCfg) return null;

  const fileBuffer = fs.readFileSync(audioPath);
  const fileName = sanitizeFileName(path.basename(audioPath));
  const mime = fileName.endsWith(".wav") ? "audio/wav"
    : fileName.endsWith(".mp3") ? "audio/mpeg"
    : fileName.endsWith(".ogg") ? "audio/ogg"
    : "application/octet-stream";

  const form = new FormData();
  form.append("file", new Blob([fileBuffer], { type: mime }), fileName);
  form.append("model", sttCfg.model);

  const resp = await fetch(`${sttCfg.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${sttCfg.apiKey}` },
    body: form,
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`STT failed (HTTP ${resp.status}): ${detail.slice(0, 300)}`);
  }

  const result = await resp.json() as { text?: string };
  return result.text?.trim() || null;
}

// QQ Bot intents - 按权限级别分组
const INTENTS = {
  // 基础权限（默认有）
  GUILDS: 1 << 0,                    // 频道相关
  GUILD_MEMBERS: 1 << 1,             // 频道成员
  PUBLIC_GUILD_MESSAGES: 1 << 30,    // 频道公开消息（公域）
  // 需要申请的权限
  DIRECT_MESSAGE: 1 << 12,           // 频道私信
  GROUP_AND_C2C: 1 << 25,            // 群聊和 C2C 私聊（需申请）
};

// 权限级别：从高到低依次尝试
const INTENT_LEVELS = [
  // Level 0: 完整权限（群聊 + 私信 + 频道）
  {
    name: "full",
    intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.DIRECT_MESSAGE | INTENTS.GROUP_AND_C2C,
    description: "群聊+私信+频道",
  },
  // Level 1: 群聊 + 频道（无私信）
  {
    name: "group+channel",
    intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.GROUP_AND_C2C,
    description: "群聊+频道",
  },
  // Level 2: 仅频道（基础权限）
  {
    name: "channel-only",
    intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.GUILD_MEMBERS,
    description: "仅频道消息",
  },
];

// 重连配置
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000]; // 递增延迟
const RATE_LIMIT_DELAY = 60000; // 遇到频率限制时等待 60 秒
const MAX_RECONNECT_ATTEMPTS = 100;
const MAX_QUICK_DISCONNECT_COUNT = 3; // 连续快速断开次数阈值
const QUICK_DISCONNECT_THRESHOLD = 5000; // 5秒内断开视为快速断开

// 图床服务器配置（可通过环境变量覆盖）
const IMAGE_SERVER_PORT = parseInt(process.env.QQBOT_IMAGE_SERVER_PORT || "18765", 10);
// 使用绝对路径，确保文件保存和读取使用同一目录
const IMAGE_SERVER_DIR = process.env.QQBOT_IMAGE_SERVER_DIR || getQQBotDataDir("images");

// 流式消息配置（仅 C2C 私聊支持）
const STREAM_KEEPALIVE_INTERVAL = 8000; // 流式心跳间隔（毫秒），需要在 10 秒内发送

// 消息队列配置（异步处理，防止阻塞心跳）
const MESSAGE_QUEUE_SIZE = 1000; // 最大队列长度（全局总量）
const PER_USER_QUEUE_SIZE = 20; // 单用户最大排队数
const MAX_CONCURRENT_USERS = 10; // 最大同时处理的用户数

// ============ 消息回复限流器 ============
// 同一 message_id 1小时内最多回复 4 次，超过1小时需降级为主动消息
const MESSAGE_REPLY_LIMIT = 4;
const MESSAGE_REPLY_TTL = 60 * 60 * 1000; // 1小时

interface MessageReplyRecord {
  count: number;
  firstReplyAt: number;
}

const messageReplyTracker = new Map<string, MessageReplyRecord>();

/**
 * 检查是否可以回复该消息（限流检查）
 * @param messageId 消息ID
 * @returns { allowed: boolean, remaining: number } allowed=是否允许回复，remaining=剩余次数
 */
function checkMessageReplyLimit(messageId: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const record = messageReplyTracker.get(messageId);
  
  // 清理过期记录（定期清理，避免内存泄漏）
  if (messageReplyTracker.size > 10000) {
    for (const [id, rec] of messageReplyTracker) {
      if (now - rec.firstReplyAt > MESSAGE_REPLY_TTL) {
        messageReplyTracker.delete(id);
      }
    }
  }
  
  if (!record) {
    return { allowed: true, remaining: MESSAGE_REPLY_LIMIT };
  }
  
  // 检查是否过期
  if (now - record.firstReplyAt > MESSAGE_REPLY_TTL) {
    messageReplyTracker.delete(messageId);
    return { allowed: true, remaining: MESSAGE_REPLY_LIMIT };
  }
  
  // 检查是否超过限制
  const remaining = MESSAGE_REPLY_LIMIT - record.count;
  return { allowed: remaining > 0, remaining: Math.max(0, remaining) };
}

/**
 * 记录一次消息回复
 * @param messageId 消息ID
 */
function recordMessageReply(messageId: string): void {
  const now = Date.now();
  const record = messageReplyTracker.get(messageId);
  
  if (!record) {
    messageReplyTracker.set(messageId, { count: 1, firstReplyAt: now });
  } else {
    // 检查是否过期，过期则重新计数
    if (now - record.firstReplyAt > MESSAGE_REPLY_TTL) {
      messageReplyTracker.set(messageId, { count: 1, firstReplyAt: now });
    } else {
      record.count++;
    }
  }
}

// ============ QQ 表情标签解析 ============

/**
 * 解析 QQ 表情标签，将 <faceType=1,faceId="13",ext="base64..."> 格式
 * 替换为 【表情: 中文名】 格式
 * ext 字段为 Base64 编码的 JSON，格式如 {"text":"呲牙"}
 */
function parseFaceTags(text: string): string {
  if (!text) return text;

  // 匹配 <faceType=...,faceId="...",ext="..."> 格式的表情标签
  return text.replace(/<faceType=\d+,faceId="[^"]*",ext="([^"]*)">/g, (_match, ext: string) => {
    try {
      const decoded = Buffer.from(ext, "base64").toString("utf-8");
      const parsed = JSON.parse(decoded);
      const faceName = parsed.text || "未知表情";
      return `【表情: ${faceName}】`;
    } catch {
      return _match;
    }
  });
}

// ============ 媒体发送友好错误提示 ============

/**
 * 将媒体上传/发送错误转为对用户友好的提示文案
 */
function formatMediaErrorMessage(mediaType: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("上传超时") || msg.includes("timeout") || msg.includes("Timeout")) {
    return `抱歉，${mediaType}资源加载超时，可能是网络原因或文件太大，请稍后再试～`;
  }
  if (msg.includes("文件不存在") || msg.includes("not found") || msg.includes("Not Found")) {
    return `抱歉，${mediaType}文件不存在或已失效，无法发送～`;
  }
  if (msg.includes("文件大小") || msg.includes("too large") || msg.includes("exceed")) {
    return `抱歉，${mediaType}文件太大了，超出了发送限制～`;
  }
  if (msg.includes("Network error") || msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND")) {
    return `抱歉，网络连接异常，${mediaType}发送失败，请稍后再试～`;
  }
  return `抱歉，${mediaType}发送失败了，请稍后再试～`;
}

export interface GatewayContext {
  account: ResolvedQQBotAccount;
  abortSignal: AbortSignal;
  cfg: unknown;
  onReady?: (data: unknown) => void;
  onError?: (error: Error) => void;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

/**
 * 消息队列项类型（用于异步处理消息，防止阻塞心跳）
 */
interface QueuedMessage {
  type: MessageType;
  senderId: string;
  senderName?: string;
  content: string;
  messageId: string;
  timestamp: string;
  channelId?: string;
  guildId?: string;
  groupOpenid?: string;
  attachments?: Array<{ content_type: string; url: string; filename?: string; voice_wav_url?: string; asr_refer_text?: string }>;
}

/**
 * 启动图床服务器
 */
async function ensureImageServer(log?: GatewayContext["log"], publicBaseUrl?: string): Promise<string | null> {
  if (isImageServerRunning()) {
    return publicBaseUrl || `http://0.0.0.0:${IMAGE_SERVER_PORT}`;
  }

  try {
    const config: Partial<ImageServerConfig> = {
      port: IMAGE_SERVER_PORT,
      storageDir: IMAGE_SERVER_DIR,
      // 使用用户配置的公网地址，而不是 0.0.0.0
      baseUrl: publicBaseUrl || `http://0.0.0.0:${IMAGE_SERVER_PORT}`,
      ttlSeconds: 3600, // 1 小时过期
    };
    await startImageServer(config);
    log?.info(`[qqbot] Image server started on port ${IMAGE_SERVER_PORT}, baseUrl: ${config.baseUrl}`);
    return config.baseUrl!;
  } catch (err) {
    log?.error(`[qqbot] Failed to start image server: ${err}`);
    return null;
  }
}

/**
 * 启动 Gateway WebSocket 连接（带自动重连）
 * 支持流式消息发送
 */
export async function startGateway(ctx: GatewayContext): Promise<void> {
  const { account, abortSignal, cfg, onReady, onError, log } = ctx;

  if (!account.appId || !account.clientSecret) {
    throw new Error("QQBot not configured (missing appId or clientSecret)");
  }

  // 启动环境诊断（首次连接时执行）
  const diag = await runDiagnostics();
  if (diag.warnings.length > 0) {
    for (const w of diag.warnings) {
      log?.info(`[qqbot:${account.accountId}] ${w}`);
    }
  }

  // 初始化 API 配置（markdown 支持）
  initApiConfig({
    markdownSupport: account.markdownSupport,
    log: log ? { info: log.info.bind(log), error: log.error.bind(log) } : undefined,
  });
  log?.info(`[qqbot:${account.accountId}] API config: markdownSupport=${account.markdownSupport === true}, streamSupport=${account.streamSupport === true}, debug=${account.debug === true}`);

  // debug 日志：仅当 account.debug=true 时输出，用于非关键路径的详细信息
  const debugLog = account.debug ? (msg: string) => log?.info(msg) : undefined;

  // TTS 配置验证
  const ttsCfg = resolveTTSConfig(cfg as Record<string, unknown>);
  if (ttsCfg) {
    const maskedKey = ttsCfg.apiKey.length > 8
      ? `${ttsCfg.apiKey.slice(0, 4)}****${ttsCfg.apiKey.slice(-4)}`
      : "****";
    log?.info(`[qqbot:${account.accountId}] TTS configured: model=${ttsCfg.model}, voice=${ttsCfg.voice}, authStyle=${ttsCfg.authStyle ?? "bearer"}, baseUrl=${ttsCfg.baseUrl}`);
    log?.info(`[qqbot:${account.accountId}] TTS apiKey: ${maskedKey}${ttsCfg.queryParams ? `, queryParams=${JSON.stringify(ttsCfg.queryParams)}` : ""}${ttsCfg.speed !== undefined ? `, speed=${ttsCfg.speed}` : ""}`);
  } else {
    log?.info(`[qqbot:${account.accountId}] TTS not configured (voice messages will be unavailable)`);
  }

  // 如果配置了公网 URL，启动图床服务器
  let imageServerBaseUrl: string | null = null;
  if (account.imageServerBaseUrl) {
    // 使用用户配置的公网地址作为 baseUrl
    await ensureImageServer(log, account.imageServerBaseUrl);
    imageServerBaseUrl = account.imageServerBaseUrl;
    log?.info(`[qqbot:${account.accountId}] Image server enabled with URL: ${imageServerBaseUrl}`);
  } else {
    log?.info(`[qqbot:${account.accountId}] Image server disabled (no imageServerBaseUrl configured)`);
  }

  let reconnectAttempts = 0;
  let isAborted = false;
  let currentWs: WebSocket | null = null;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let sessionId: string | null = null;
  let lastSeq: number | null = null;
  let lastConnectTime: number = 0; // 上次连接成功的时间
  let quickDisconnectCount = 0; // 连续快速断开次数
  let isConnecting = false; // 防止并发连接
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null; // 重连定时器
  let shouldRefreshToken = false; // 下次连接是否需要刷新 token
  let intentLevelIndex = 0; // 当前尝试的权限级别索引
  let lastSuccessfulIntentLevel = -1; // 上次成功的权限级别

  // ============ P1-2: 尝试从持久化存储恢复 Session ============
  // 传入当前 appId，如果 appId 已变更（换了机器人），旧 session 自动失效
  const savedSession = loadSession(account.accountId, account.appId);
  if (savedSession) {
    sessionId = savedSession.sessionId;
    lastSeq = savedSession.lastSeq;
    intentLevelIndex = savedSession.intentLevelIndex;
    lastSuccessfulIntentLevel = savedSession.intentLevelIndex;
    log?.info(`[qqbot:${account.accountId}] Restored session from storage: sessionId=${sessionId}, lastSeq=${lastSeq}, intentLevel=${intentLevelIndex}`);
  }

  // ============ 按用户并发的消息队列（同用户串行，跨用户并行） ============
  // 每个用户有独立队列，同一用户的消息串行处理（保持时序），
  // 不同用户的消息并行处理（互不阻塞）。
  const userQueues = new Map<string, QueuedMessage[]>(); // peerId → 消息队列
  const activeUsers = new Set<string>(); // 正在处理中的用户
  let messagesProcessed = 0;
  let handleMessageFnRef: ((msg: QueuedMessage) => Promise<void>) | null = null;
  let totalEnqueued = 0; // 全局已入队总数（用于溢出保护）

  // 获取消息的路由 key（决定并发隔离粒度）
  const getMessagePeerId = (msg: QueuedMessage): string => {
    if (msg.type === MSG_TYPE_GUILD) return `guild:${msg.channelId ?? "unknown"}`;
    if (msg.type === MSG_TYPE_GROUP) return `group:${msg.groupOpenid ?? "unknown"}`;
    return `dm:${msg.senderId}`;
  };

  const enqueueMessage = (msg: QueuedMessage): void => {
    const peerId = getMessagePeerId(msg);
    let queue = userQueues.get(peerId);
    if (!queue) {
      queue = [];
      userQueues.set(peerId, queue);
    }

    // 单用户队列溢出保护
    if (queue.length >= PER_USER_QUEUE_SIZE) {
      const dropped = queue.shift();
      log?.error(`[qqbot:${account.accountId}] Per-user queue full for ${peerId}, dropping oldest message ${dropped?.messageId}`);
    }

    // 全局总量保护
    totalEnqueued++;
    if (totalEnqueued > MESSAGE_QUEUE_SIZE) {
      log?.error(`[qqbot:${account.accountId}] Global queue limit reached (${totalEnqueued}), message from ${peerId} may be delayed`);
    }

    queue.push(msg);
    log?.debug?.(`[qqbot:${account.accountId}] Message enqueued for ${peerId}, user queue: ${queue.length}, active users: ${activeUsers.size}`);

    // 如果该用户没有正在处理的消息，立即启动处理
    drainUserQueue(peerId);
  };

  // 处理指定用户队列中的消息（串行）
  const drainUserQueue = async (peerId: string): Promise<void> => {
    if (activeUsers.has(peerId)) return; // 该用户已有处理中的消息
    if (activeUsers.size >= MAX_CONCURRENT_USERS) {
      log?.info(`[qqbot:${account.accountId}] Max concurrent users (${MAX_CONCURRENT_USERS}) reached, ${peerId} will wait`);
      return; // 达到并发上限，等待其他用户处理完后触发
    }

    const queue = userQueues.get(peerId);
    if (!queue || queue.length === 0) {
      userQueues.delete(peerId);
      return;
    }

    activeUsers.add(peerId);

    try {
      while (queue.length > 0 && !isAborted) {
        const msg = queue.shift()!;
        totalEnqueued = Math.max(0, totalEnqueued - 1);
        try {
          if (handleMessageFnRef) {
            await handleMessageFnRef(msg);
            messagesProcessed++;
          }
        } catch (err) {
          log?.error(`[qqbot:${account.accountId}] Message processor error for ${peerId}: ${err}`);
        }
      }
    } finally {
      activeUsers.delete(peerId);
      userQueues.delete(peerId);
      // 处理完后，检查是否有等待并发槽位的用户
      for (const [waitingPeerId, waitingQueue] of userQueues) {
        if (waitingQueue.length > 0 && !activeUsers.has(waitingPeerId)) {
          drainUserQueue(waitingPeerId);
          break; // 每次只唤醒一个，避免瞬间并发激增
        }
      }
    }
  };

  const startMessageProcessor = (handleMessageFn: (msg: QueuedMessage) => Promise<void>): void => {
    handleMessageFnRef = handleMessageFn;
    log?.info(`[qqbot:${account.accountId}] Message processor started (per-user concurrency, max ${MAX_CONCURRENT_USERS} users)`);
  };

  abortSignal.addEventListener("abort", () => {
    isAborted = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    cleanup();
    // P1-1: 停止后台 Token 刷新
    stopBackgroundTokenRefresh(account.appId);
    // P1-3: 保存已知用户数据
    flushKnownUsers();
  });

  const cleanup = () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    if (currentWs && (currentWs.readyState === WebSocket.OPEN || currentWs.readyState === WebSocket.CONNECTING)) {
      currentWs.close();
    }
    currentWs = null;
  };

  const getReconnectDelay = () => {
    const idx = Math.min(reconnectAttempts, RECONNECT_DELAYS.length - 1);
    return RECONNECT_DELAYS[idx];
  };

  const scheduleReconnect = (customDelay?: number) => {
    if (isAborted || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log?.error(`[qqbot:${account.accountId}] Max reconnect attempts reached or aborted`);
      return;
    }

    // 取消已有的重连定时器
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const delay = customDelay ?? getReconnectDelay();
    reconnectAttempts++;
    log?.info(`[qqbot:${account.accountId}] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!isAborted) {
        connect();
      }
    }, delay);
  };

  const connect = async () => {
    // 防止并发连接
    if (isConnecting) {
      log?.debug?.(`[qqbot:${account.accountId}] Already connecting, skip`);
      return;
    }
    isConnecting = true;

    try {
      cleanup();

      // 如果标记了需要刷新 token，则清除缓存
      if (shouldRefreshToken) {
        log?.info(`[qqbot:${account.accountId}] Refreshing token...`);
        clearTokenCache(account.appId);
        shouldRefreshToken = false;
      }
      
      const accessToken = await getAccessToken(account.appId, account.clientSecret);
      log?.info(`[qqbot:${account.accountId}] ✅ Access token obtained successfully`);
      const gatewayUrl = await getGatewayUrl(accessToken);

      log?.info(`[qqbot:${account.accountId}] Connecting to ${gatewayUrl}`);

      const ws = new WebSocket(gatewayUrl);
      currentWs = ws;

      const pluginRuntime = getQQBotRuntime();

      // 处理收到的消息
      const handleMessage = async (event: {
        type: MessageType;
        senderId: string;
        senderName?: string;
        content: string;
        messageId: string;
        timestamp: string;
        channelId?: string;
        guildId?: string;
        groupOpenid?: string;
        attachments?: Array<{ content_type: string; url: string; filename?: string; voice_wav_url?: string; asr_refer_text?: string }>;
      }) => {

        log?.debug?.(`[qqbot:${account.accountId}] Received message: ${JSON.stringify(event)}`);
        log?.info(`[qqbot:${account.accountId}] Processing message from ${event.senderId}: ${event.content}`);
        if (event.attachments?.length) {
          log?.info(`[qqbot:${account.accountId}] Attachments: ${event.attachments.length}`);
        }

        pluginRuntime.channel.activity.record({
          channel: "qqbot",
          accountId: account.accountId,
          direction: "inbound",
        });

        // 发送输入状态提示（仅 C2C 私聊，频道/频道私信/群聊不支持）
        if (event.type !== "guild" && event.type !== "group" && event.type !== "dm") {
          try {
            let token = await getAccessToken(account.appId, account.clientSecret);
            try {
              await sendC2CInputNotify(token, event.senderId, event.messageId, 60);
            } catch (notifyErr) {
              const errMsg = String(notifyErr);
              if (errMsg.includes("token") || errMsg.includes("401") || errMsg.includes("11244")) {
                log?.info(`[qqbot:${account.accountId}] InputNotify token expired, refreshing...`);
                clearTokenCache(account.appId);
                token = await getAccessToken(account.appId, account.clientSecret);
                await sendC2CInputNotify(token, event.senderId, event.messageId, 60);
              } else {
                throw notifyErr;
              }
            }
            log?.info(`[qqbot:${account.accountId}] Sent input notify to ${event.senderId}`);
          } catch (err) {
            log?.error(`[qqbot:${account.accountId}] sendC2CInputNotify error: ${err}`);
          }
        }

        const isGroupChat = event.type === MSG_TYPE_GUILD || event.type === MSG_TYPE_GROUP;
        // peerId 只放纯 ID，类型信息由 peer.kind 表达
        // 频道：用 channelId
        // 频道私信：用 channelId（隔离到频道维度）
        // 群聊：用 groupOpenid（框架根据 kind:"group" 区分）
        // 频道私信：用 channelId（隔离到频道维度）
        // C2C 私聊：用 senderId（框架根据 dmScope 决定隔离粒度）
        const peerId = event.type === MSG_TYPE_GUILD ? (event.channelId ?? "unknown")
                     : event.type === MSG_TYPE_DM ? (event.channelId ?? event.senderId)
                     : event.type === MSG_TYPE_GROUP ? (event.groupOpenid ?? "unknown")
                     : event.senderId;

        const route = pluginRuntime.channel.routing.resolveAgentRoute({
          cfg,
          channel: "qqbot",
          accountId: account.accountId,
          peer: {
            kind: isGroupChat ? "group" : "direct",
            id: peerId,
          },
        });

        const envelopeOptions = pluginRuntime.channel.reply.resolveEnvelopeFormatOptions(cfg);

        // 组装消息体
        // 静态系统提示已移至 skills/qqbot-cron/SKILL.md 和 skills/qqbot-media/SKILL.md
        // BodyForAgent 只保留必要的动态上下文信息
        
        // ============ 用户标识信息 ============
        
        // 收集额外的系统提示（如果配置了账户级别的 systemPrompt）
        const systemPrompts: string[] = [];
        if (account.systemPrompt) {
          systemPrompts.push(account.systemPrompt);
        }
        
        // 处理附件（图片等）- 下载到本地供 openclaw 访问
        let attachmentInfo = "";
        const imageUrls: string[] = [];
        const imageMediaTypes: string[] = [];
        const voiceAttachmentPaths: string[] = [];
        const voiceAttachmentUrls: string[] = [];
        const voiceAsrReferTexts: string[] = [];
        const voiceTranscripts: string[] = [];
        const voiceTranscriptSources: Array<"stt" | "asr" | "fallback"> = [];
        // 存到 .openclaw/qqbot 目录下的 downloads 文件夹
        const downloadDir = getQQBotDataDir("downloads");
        
        if (event.attachments?.length) {
          const otherAttachments: string[] = [];
          
          for (const att of event.attachments) {
            // 修复 QQ 返回的 // 前缀 URL
            const attUrl = att.url?.startsWith("//") ? `https:${att.url}` : att.url;

            // 语音附件：优先下载 WAV（voice_wav_url），减少 SILK→WAV 转换
            const isVoice = isVoiceAttachment(att);
            const asrReferText = typeof att.asr_refer_text === "string" ? att.asr_refer_text.trim() : "";
            const wavUrl = isVoice && att.voice_wav_url
              ? (att.voice_wav_url.startsWith("//") ? `https:${att.voice_wav_url}` : att.voice_wav_url)
              : "";
            const voiceSourceUrl = wavUrl || attUrl;
            if (isVoice) {
              if (voiceSourceUrl) voiceAttachmentUrls.push(voiceSourceUrl);
              if (asrReferText) voiceAsrReferTexts.push(asrReferText);
            }
            let localPath: string | null = null;
            let audioPath: string | null = null; // 用于 STT 的音频路径

            if (isVoice && wavUrl) {
              const wavLocalPath = await downloadFile(wavUrl, downloadDir);
              if (wavLocalPath) {
                localPath = wavLocalPath;
                audioPath = wavLocalPath;
                log?.info(`[qqbot:${account.accountId}] Voice attachment: ${att.filename}, downloaded WAV directly (skip SILK→WAV)`);
              } else {
                log?.error(`[qqbot:${account.accountId}] Failed to download voice_wav_url, falling back to original URL`);
              }
            }

            // WAV 下载失败或不是语音附件：下载原始文件
            if (!localPath) {
              localPath = await downloadFile(attUrl, downloadDir, att.filename);
            }

            if (localPath) {
              if (att.content_type?.startsWith("image/")) {
                imageUrls.push(localPath);
                imageMediaTypes.push(att.content_type);
              } else if (isVoice) {
                voiceAttachmentPaths.push(localPath);
                // 语音消息处理：先检查 STT 是否可用，避免无意义的转换开销
                const sttCfg = resolveSTTConfig(cfg as Record<string, unknown>);
                if (!sttCfg) {
                  if (asrReferText) {
                    log?.info(`[qqbot:${account.accountId}] Voice attachment: ${att.filename} (STT not configured, using asr_refer_text fallback)`);
                    voiceTranscripts.push(asrReferText);
                    voiceTranscriptSources.push("asr");
                  } else {
                    log?.info(`[qqbot:${account.accountId}] Voice attachment: ${att.filename} (STT not configured, skipping transcription)`);
                    voiceTranscripts.push("[语音消息 - 语音识别未配置，无法转录]");
                    voiceTranscriptSources.push("fallback");
                  }
                } else {
                  // 如果还没有 WAV 路径（voice_wav_url 不可用），需要 SILK→WAV 转换
                  if (!audioPath) {
                    const sttFormats = account.config?.audioFormatPolicy?.sttDirectFormats;
                    log?.info(`[qqbot:${account.accountId}] Voice attachment: ${att.filename}, converting SILK→WAV...`);
                    try {
                      const wavResult = await convertSilkToWav(localPath, downloadDir);
                      if (wavResult) {
                        audioPath = wavResult.wavPath;
                        log?.info(`[qqbot:${account.accountId}] Voice converted: ${wavResult.wavPath} (${formatDuration(wavResult.duration)})`);
                      } else {
                        audioPath = localPath; // 转换失败，尝试用原始文件
                      }
                    } catch (convertErr) {
                      log?.error(`[qqbot:${account.accountId}] Voice conversion failed: ${convertErr}`);
                      if (asrReferText) {
                        log?.info(`[qqbot:${account.accountId}] Voice attachment: ${att.filename} (using asr_refer_text fallback after convert failure)`);
                        voiceTranscripts.push(asrReferText);
                        voiceTranscriptSources.push("asr");
                      } else {
                        voiceTranscripts.push("[语音消息 - 格式转换失败]");
                        voiceTranscriptSources.push("fallback");
                      }
                      continue;
                    }
                  }

                  // STT 转录
                  try {
                    const transcript = await transcribeAudio(audioPath!, cfg as Record<string, unknown>);
                    if (transcript) {
                      log?.info(`[qqbot:${account.accountId}] STT transcript: ${transcript.slice(0, 100)}...`);
                      voiceTranscripts.push(transcript);
                      voiceTranscriptSources.push("stt");
                    } else if (asrReferText) {
                      log?.info(`[qqbot:${account.accountId}] STT returned empty result, using asr_refer_text fallback`);
                      voiceTranscripts.push(asrReferText);
                      voiceTranscriptSources.push("asr");
                    } else {
                      log?.info(`[qqbot:${account.accountId}] STT returned empty result`);
                      voiceTranscripts.push("[语音消息 - 转录结果为空]");
                      voiceTranscriptSources.push("fallback");
                    }
                  } catch (sttErr) {
                    log?.error(`[qqbot:${account.accountId}] STT failed: ${sttErr}`);
                    if (asrReferText) {
                      log?.info(`[qqbot:${account.accountId}] Voice attachment: ${att.filename} (using asr_refer_text fallback after STT failure)`);
                      voiceTranscripts.push(asrReferText);
                      voiceTranscriptSources.push("asr");
                    } else {
                      voiceTranscripts.push("[语音消息 - 转录失败]");
                      voiceTranscriptSources.push("fallback");
                    }
                  }
                }
              } else {
                otherAttachments.push(`[附件: ${localPath}]`);
              }
              log?.info(`[qqbot:${account.accountId}] Downloaded attachment to: ${localPath}`);
            } else {
              // 下载失败，fallback 到原始 URL
              log?.error(`[qqbot:${account.accountId}] Failed to download: ${attUrl}`);
              if (att.content_type?.startsWith("image/")) {
                imageUrls.push(attUrl);
                imageMediaTypes.push(att.content_type);
              } else if (isVoice && asrReferText) {
                log?.info(`[qqbot:${account.accountId}] Voice attachment download failed, using asr_refer_text fallback`);
                voiceTranscripts.push(asrReferText);
                voiceTranscriptSources.push("asr");
              } else {
                otherAttachments.push(`[附件: ${att.filename ?? att.content_type}] (下载失败)`);
              }
            }
          }
          
          if (otherAttachments.length > 0) {
            attachmentInfo += "\n" + otherAttachments.join("\n");
          }
        }
        
        // 语音转录文本注入到用户消息中
        let voiceText = "";
        const hasAsrReferFallback = voiceTranscriptSources.includes("asr");
        if (voiceTranscripts.length > 0) {
          voiceText = voiceTranscripts.length === 1
            ? `${voiceTranscriptSources[0] === "asr" ? "[语音消息]" : "[语音消息]"} ${voiceTranscripts[0]}`
            : voiceTranscripts.map((t, i) => {
                const prefix = voiceTranscriptSources[i] === "asr"
                  ? `[语音${i + 1}(ASR兜底，可能不准确)]`
                  : `[语音${i + 1}]`;
                return `${prefix} ${t}`;
              }).join("\n");
        }

        // 解析 QQ 表情标签，将 <faceType=...,ext="base64"> 替换为 【表情: 中文名】
        let parsedContent = parseFaceTags(event.content);
        // 清理 QQ 平台注入的 ASR 兜底说明文本（如 "ASR兜底，可能不准确"）
        parsedContent = parsedContent
          .replace(/[\[【\(（]?\s*ASR\s*兜底[^】\]\)）\n]*[\]】\)）]?\s*/gi, "")
          .replace(/[，,]?\s*可能不准确\s*/g, "")
          .trim();
        const userContent = voiceText
          ? (parsedContent.trim() ? `${parsedContent}\n${voiceText}` : voiceText) + attachmentInfo
          : parsedContent + attachmentInfo;

        // Body: 展示用的用户原文（Web UI 看到的）
        const body = pluginRuntime.channel.reply.formatInboundEnvelope({
          channel: "qqbot",
          from: event.senderName ?? event.senderId,
          timestamp: new Date(event.timestamp).getTime(),
          body: userContent,
          chatType: isGroupChat ? "group" : "direct",
          sender: {
            id: event.senderId,
            name: event.senderName,
          },
          envelope: envelopeOptions,
          ...(imageUrls.length > 0 ? { imageUrls } : {}),
        });
        
        // BodyForAgent: AI 实际看到的完整上下文（动态数据 + 系统提示 + 用户输入）
        const nowMs = Date.now();

        // 构建媒体附件纯数据描述（图片 + 语音统一列出）
        const uniqueVoicePaths = [...new Set(voiceAttachmentPaths)];
        const uniqueVoiceUrls = [...new Set(voiceAttachmentUrls)];
        const uniqueVoiceAsrReferTexts = [...new Set(voiceAsrReferTexts)].filter(Boolean);
        const sttTranscriptCount = voiceTranscriptSources.filter((s) => s === "stt").length;
        const asrFallbackCount = voiceTranscriptSources.filter((s) => s === "asr").length;
        const fallbackCount = voiceTranscriptSources.filter((s) => s === "fallback").length;
        if (voiceAttachmentPaths.length > 0 || voiceAttachmentUrls.length > 0 || uniqueVoiceAsrReferTexts.length > 0) {
          const asrPreview = uniqueVoiceAsrReferTexts.length > 0
            ? uniqueVoiceAsrReferTexts[0].slice(0, 50)
            : "";
          log?.info(
            `[qqbot:${account.accountId}] Voice input summary: local=${uniqueVoicePaths.length}, remote=${uniqueVoiceUrls.length}, `
            + `asrReferTexts=${uniqueVoiceAsrReferTexts.length}, transcripts=${voiceTranscripts.length}, `
            + `source(stt/asr/fallback)=${sttTranscriptCount}/${asrFallbackCount}/${fallbackCount}`
            + (asrPreview ? `, asr_preview="${asrPreview}${uniqueVoiceAsrReferTexts[0].length > 50 ? "..." : ""}"` : "")
          );
        }
        let receivedMediaSection = "";
        if (imageUrls.length > 0 || uniqueVoicePaths.length > 0 || uniqueVoiceUrls.length > 0) {
          const mediaSections: string[] = [];
          if (imageUrls.length > 0) {
            const imageEntries = imageUrls.map((p, i) => `  - ${p} (${imageMediaTypes[i] || "unknown"})`);
            mediaSections.push(`- 图片附件:\n${imageEntries.join("\n")}`);
          }
          if (uniqueVoicePaths.length > 0 || uniqueVoiceUrls.length > 0) {
            const voiceEntries = [
              ...uniqueVoicePaths.map((p) => `  - ${p} (local audio)`),
              ...uniqueVoiceUrls.map((u) => `  - ${u} (remote audio)`),
            ];
            mediaSections.push(`- 语音附件:\n${voiceEntries.join("\n")}`);
          }
          receivedMediaSection = `\n${mediaSections.join("\n")}`;
        }

        // AI 看到的投递地址必须带完整前缀（qqbot:c2c: / qqbot:group: / qqbot:dm:）
        const qualifiedTarget = event.type === MSG_TYPE_GUILD ? `qqbot:channel:${event.channelId}`
                              : event.type === MSG_TYPE_DM ? `qqbot:dm:${event.guildId}`
                              : event.type === MSG_TYPE_GROUP ? `qqbot:group:${event.groupOpenid}`
                              : `qqbot:c2c:${event.senderId}`;

        // 动态检测 TTS/STT 配置状态
        const hasTTS = !!resolveTTSConfig(cfg as Record<string, unknown>);
        const hasSTT = !!resolveSTTConfig(cfg as Record<string, unknown>);

        // 语音能力说明：<qqvoice> 标签本身只负责发送已有的音频文件，不依赖插件 TTS。
        // TTS 只是生成音频文件的一种方式，框架侧的 TTS 工具（如 audio_speech）也能生成。
        // 因此始终暴露 <qqvoice> 能力，但根据 TTS 状态给出不同的使用指引。
        const ttsHint = hasTTS
          ? `6. 🎤 插件 TTS 已启用: 如果你有 TTS 工具（如 audio_speech），可用它生成音频文件后用 <qqvoice> 发送`
          : `6. ⚠️ 插件 TTS 未配置: 如果你有 TTS 工具（如 audio_speech），仍可用它生成音频文件后用 <qqvoice> 发送；若无 TTS 工具，则无法主动生成语音`;
        const sttHint = hasSTT
          ? `\n7. 插件侧 STT 已配置，用户发送的语音消息会尽量自动转录`
          : `\n7. 插件侧 STT 未配置，插件不会自动转录语音消息`;
        const asrFallbackHint = hasAsrReferFallback
          ? `\n8. 本条消息包含平台返回的 asr_refer_text 兜底文本（低置信度）。理解用户意图时可参考，但如关键信息不明确应先追问确认。`
          : "";
        const voiceForwardHint = uniqueVoicePaths.length > 0 || uniqueVoiceUrls.length > 0
          ? `\n9. 本条消息已附带语音文件路径/URL。若你具备 STT 能力（框架能力或 STT skill），优先直接转写音频；若无 STT 能力或转写失败，再使用 asr_refer_text（若存在）作为兜底。`
          : "";
        const voiceSection = `

【发送语音 - 必须遵守】
1. 发语音方法: 在回复文本中写 <qqvoice>本地音频文件路径</qqvoice>，系统自动处理
2. 示例: "来听听吧！ <qqvoice>/tmp/tts/voice.mp3</qqvoice>"
3. 支持格式: .silk, .slk, .slac, .amr, .wav, .mp3, .ogg, .pcm
4. ⚠️ <qqvoice> 只用于语音文件，图片请用 <qqimg>；两者不要混用
5. 发送语音时，不要重复输出语音中已朗读的文字内容；语音前后的文字应是补充信息而非语音的文字版重复
${ttsHint}${sttHint}${asrFallbackHint}${voiceForwardHint}`;

        const voiceAsrSection = uniqueVoiceAsrReferTexts.length > 0
          ? `\n- 语音ASR兜底文本:\n${uniqueVoiceAsrReferTexts.map((t, i) => `  ${i + 1}. ${t}`).join("\n")}`
          : "";

        const contextInfo = `你正在通过 QQ 与用户对话。

【会话上下文】
- 用户: ${event.senderName || "未知"} (${event.senderId})
- 场景: ${event.type === MSG_TYPE_GUILD ? "频道" : event.type === MSG_TYPE_DM ? "频道私信" : isGroupChat ? "群聊" : "私聊"}${event.type === MSG_TYPE_GUILD ? ` (频道: ${event.channelId}, 服务器: ${event.guildId})` : event.type === MSG_TYPE_DM ? ` (频道: ${event.channelId}, 服务器: ${event.guildId})` : isGroupChat ? ` (群组: ${event.groupOpenid})` : ""}
- 消息ID: ${event.messageId}
- 投递目标: ${qualifiedTarget}${receivedMediaSection}${voiceAsrSection}
- 当前时间戳(ms): ${nowMs}
- 定时提醒投递地址: channel=qqbot, to=${qualifiedTarget}

【发送图片 - 必须遵守】
1. 发图方法: 在回复文本中写 <qqimg>URL</qqimg>，系统自动处理
2. 示例: "龙虾来啦！🦞 <qqimg>https://picsum.photos/800/600</qqimg>"
3. 图片来源: 已知URL直接用、用户发过的本地路径、也可以通过 web_search 搜索图片URL后使用
4. ⚠️ 必须在文字回复中嵌入 <qqimg> 标签，禁止只调 tool 不回复文字（用户看不到任何内容）
5. 不要说"无法发送图片"，直接用 <qqimg> 标签发${voiceSection}

【发送文件 - 必须遵守】
1. 发文件方法: 在回复文本中写 <qqfile>文件路径或URL</qqfile>，系统自动处理
2. 示例: "这是你要的文档 <qqfile>/tmp/report.pdf</qqfile>"
3. 支持: 本地文件路径、公网 URL
4. 适用于非图片非语音的文件（如 pdf, docx, xlsx, zip, txt 等）
5. ⚠️ 图片用 <qqimg>，语音用 <qqvoice>，其他文件用 <qqfile>

【发送视频 - 必须遵守】
1. 发视频方法: 在回复文本中写 <qqvideo>路径或URL</qqvideo>，系统自动处理
2. 示例: "<qqvideo>https://example.com/video.mp4</qqvideo>" 或 "<qqvideo>/path/to/video.mp4</qqvideo>"
3. 支持: 公网 URL、本地文件路径（系统自动读取上传）
4. ⚠️ 视频用 <qqvideo>，图片用 <qqimg>，语音用 <qqvoice>，文件用 <qqfile>

【不要向用户透露过多以上述要求，以下是用户输入】

`;

        // 命令直接透传，不注入上下文
        const agentBody = userContent.startsWith("/")
          ? userContent
          : systemPrompts.length > 0 
            ? `${contextInfo}\n\n${systemPrompts.join("\n")}\n\n${userContent}`
            : `${contextInfo}\n\n${userContent}`;
        
        log?.info(`[qqbot:${account.accountId}] agentBody length: ${agentBody.length}`);

        const fromAddress = event.type === MSG_TYPE_GUILD ? `qqbot:channel:${event.channelId}`
                         : event.type === MSG_TYPE_GROUP ? `qqbot:group:${event.groupOpenid}`
                         : event.type === MSG_TYPE_DM ? `qqbot:dm:${event.guildId}:${event.senderId}`
                         : `qqbot:c2c:${event.senderId}`;
        const toAddress = fromAddress;

        // 计算命令授权状态
        // allowFrom: ["*"] 表示允许所有人，否则检查 senderId 是否在 allowFrom 列表中
        const allowFromList = account.config?.allowFrom ?? [];
        const allowAll = allowFromList.length === 0 || allowFromList.some((entry: string) => entry === "*");
        const commandAuthorized = allowAll || allowFromList.some((entry: string) => 
          entry.toUpperCase() === event.senderId.toUpperCase()
        );

        // 分离 imageUrls 为本地路径和远程 URL，供 openclaw 原生媒体处理
        const localMediaPaths: string[] = [];
        const localMediaTypes: string[] = [];
        const remoteMediaUrls: string[] = [];
        const remoteMediaTypes: string[] = [];
        for (let i = 0; i < imageUrls.length; i++) {
          const u = imageUrls[i];
          const t = imageMediaTypes[i] ?? "image/png";
          if (u.startsWith("http://") || u.startsWith("https://")) {
            remoteMediaUrls.push(u);
            remoteMediaTypes.push(t);
          } else {
            localMediaPaths.push(u);
            localMediaTypes.push(t);
          }
        }

        const ctxPayload = pluginRuntime.channel.reply.finalizeInboundContext({
          Body: body,
          BodyForAgent: agentBody,
          RawBody: event.content,
          CommandBody: event.content,
          From: fromAddress,
          To: toAddress,
          SessionKey: route.sessionKey,
          AccountId: route.accountId,
          ChatType: isGroupChat ? "group" : "direct",
          SenderId: event.senderId,
          SenderName: event.senderName,
          Provider: "qqbot",
          Surface: "qqbot",
          MessageSid: event.messageId,
          Timestamp: new Date(event.timestamp).getTime(),
          OriginatingChannel: "qqbot",
          OriginatingTo: toAddress,
          QQChannelId: event.channelId,
          QQGuildId: event.guildId,
          QQGroupOpenid: event.groupOpenid,
          QQVoiceAsrReferAvailable: hasAsrReferFallback,
          QQVoiceTranscriptSources: voiceTranscriptSources,
          QQVoiceAttachmentPaths: uniqueVoicePaths,
          QQVoiceAttachmentUrls: uniqueVoiceUrls,
          QQVoiceAsrReferTexts: uniqueVoiceAsrReferTexts,
          QQVoiceInputStrategy: "prefer_audio_stt_then_asr_fallback",
          CommandAuthorized: commandAuthorized,
          // 传递媒体路径和 URL，使 openclaw 原生媒体处理（视觉等）能正常工作
          ...(localMediaPaths.length > 0 ? {
            MediaPaths: localMediaPaths,
            MediaPath: localMediaPaths[0],
            MediaTypes: localMediaTypes,
            MediaType: localMediaTypes[0],
          } : {}),
          ...(remoteMediaUrls.length > 0 ? {
            MediaUrls: remoteMediaUrls,
            MediaUrl: remoteMediaUrls[0],
          } : {}),
        });

        // 发送消息的辅助函数，带 token 过期重试
        const sendWithTokenRetry = async (sendFn: (token: string) => Promise<unknown>) => {
          try {
            const token = await getAccessToken(account.appId, account.clientSecret);
            await sendFn(token);
          } catch (err) {
            const errMsg = String(err);
            // 如果是 token 相关错误，清除缓存重试一次
            if (errMsg.includes("401") || errMsg.includes("token") || errMsg.includes("access_token")) {
              log?.info(`[qqbot:${account.accountId}] Token may be expired, refreshing...`);
              clearTokenCache(account.appId);
              const newToken = await getAccessToken(account.appId, account.clientSecret);
              await sendFn(newToken);
            } else {
              throw err;
            }
          }
        };

        // 发送错误提示的辅助函数
        const sendErrorMessage = async (errorText: string) => {
          try {
            await sendWithTokenRetry(async (token) => {
              if (event.type === MSG_TYPE_C2C) {
                await sendC2CMessage(token, event.senderId, errorText, event.messageId);
              } else if (event.type === MSG_TYPE_GROUP && event.groupOpenid) {
                await sendGroupMessage(token, event.groupOpenid, errorText, event.messageId);
              } else if (event.type === MSG_TYPE_DM && event.guildId) {
                await sendDmMessage(token, event.guildId, errorText, event.messageId);
              } else if (event.channelId) {
                await sendChannelMessage(token, event.channelId, errorText, event.messageId);
              }
            });
          } catch (sendErr) {
            log?.error(`[qqbot:${account.accountId}] Failed to send error message: ${sendErr}`);
          }
        };

        // ============ 通用消息发送辅助函数（消除三路分派重复） ============
        
        /** 发送文本消息（自动根据 event.type 分派到 c2c/group/dm/channel） */
        const sendTextMessage = async (text: string) => {
          log?.info(`[qqbot:${account.accountId}] [send-text] type=${event.type}, len=${text.length}, text=${JSON.stringify(text)}`);
          await sendWithTokenRetry(async (token) => {
            if (event.type === MSG_TYPE_C2C) {
              await sendC2CMessage(token, event.senderId, text, event.messageId);
            } else if (event.type === MSG_TYPE_GROUP && event.groupOpenid) {
              await sendGroupMessage(token, event.groupOpenid, text, event.messageId);
            } else if (event.type === MSG_TYPE_DM && event.guildId) {
              await sendDmMessage(token, event.guildId, text, event.messageId);
            } else if (event.channelId) {
              await sendChannelMessage(token, event.channelId, text, event.messageId);
            }
          });
        };

        /** 发送图片消息（URL 或 Base64 DataURL，自动四路分派） */
        const sendImageMessage = async (imageUrl: string, altMarkdown?: string) => {
          const isDataUrl = imageUrl.startsWith("data:");
          log?.info(`[qqbot:${account.accountId}] [send-image] type=${event.type}${isDataUrl ? `, dataUrl(len=${imageUrl.length})` : `, url=${imageUrl.slice(0, 120)}`}${altMarkdown ? `, alt=${altMarkdown.slice(0, 60)}` : ""}`);
          await sendWithTokenRetry(async (token) => {
            if (event.type === MSG_TYPE_C2C) {
              await sendC2CImageMessage(token, event.senderId, imageUrl, event.messageId);
            } else if (event.type === MSG_TYPE_GROUP && event.groupOpenid) {
              await sendGroupImageMessage(token, event.groupOpenid, imageUrl, event.messageId);
            } else if (event.type === MSG_TYPE_DM && event.guildId) {
              // 频道私信：公网 URL 使用 Markdown 格式，本地图片暂不支持
              if (altMarkdown) {
                await sendDmMessage(token, event.guildId, altMarkdown, event.messageId);
              } else if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) {
                await sendDmMessage(token, event.guildId, `![](${imageUrl})`, event.messageId);
              } else {
                log?.info(`[qqbot:${account.accountId}] DM does not support rich media for local images`);
              }
            } else if (event.channelId) {
              // 频道不支持富媒体 API，降级到文本/markdown
              if (altMarkdown) {
                await sendChannelMessage(token, event.channelId, altMarkdown, event.messageId);
              } else if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) {
                await sendChannelMessage(token, event.channelId, `![](${imageUrl})`, event.messageId);
              } else {
                log?.info(`[qqbot:${account.accountId}] Channel does not support rich media for local images`);
              }
            }
          });
        };

        /** 发送语音消息（自动四路分派） */
        const sendVoiceMessage = async (silkBase64: string) => {
          log?.info(`[qqbot:${account.accountId}] [send-voice] type=${event.type}, dataLen=${silkBase64.length}`);
          await sendWithTokenRetry(async (token) => {
            if (event.type === MSG_TYPE_C2C) {
              await sendC2CVoiceMessage(token, event.senderId, silkBase64, event.messageId);
            } else if (event.type === MSG_TYPE_GROUP && event.groupOpenid) {
              await sendGroupVoiceMessage(token, event.groupOpenid, silkBase64, event.messageId);
            } else if (event.type === MSG_TYPE_DM && event.guildId) {
              await sendDmMessage(token, event.guildId, `[语音消息暂不支持频道私信发送]`, event.messageId);
            } else if (event.channelId) {
              await sendChannelMessage(token, event.channelId, `[语音消息暂不支持频道发送]`, event.messageId);
            }
          });
        };

        /** 发送视频消息（URL 或 Base64，自动四路分派） */
        const sendVideoMessage = async (url?: string, base64?: string) => {
          log?.info(`[qqbot:${account.accountId}] [send-video] type=${event.type}${url ? `, url=${url.slice(0, 120)}` : ""}${base64 ? `, base64(len=${base64.length})` : ""}`);
          await sendWithTokenRetry(async (token) => {
            if (event.type === MSG_TYPE_C2C) {
              await sendC2CVideoMessage(token, event.senderId, url, base64, event.messageId);
            } else if (event.type === MSG_TYPE_GROUP && event.groupOpenid) {
              await sendGroupVideoMessage(token, event.groupOpenid, url, base64, event.messageId);
            } else if (event.type === MSG_TYPE_DM && event.guildId) {
              await sendDmMessage(token, event.guildId, `[视频消息暂不支持频道私信发送]`, event.messageId);
            } else if (event.channelId) {
              await sendChannelMessage(token, event.channelId, `[视频消息暂不支持频道发送]`, event.messageId);
            }
          });
        };

        /** 发送文件消息（URL 或 Base64，自动四路分派） */
        const sendFileMessage = async (base64?: string, url?: string, fileName?: string) => {
          log?.info(`[qqbot:${account.accountId}] [send-file] type=${event.type}${fileName ? `, name=${fileName}` : ""}${url ? `, url=${url.slice(0, 120)}` : ""}${base64 ? `, base64(len=${base64.length})` : ""}`);
          await sendWithTokenRetry(async (token) => {
            if (event.type === MSG_TYPE_C2C) {
              await sendC2CFileMessage(token, event.senderId, base64, url, event.messageId, fileName);
            } else if (event.type === MSG_TYPE_GROUP && event.groupOpenid) {
              await sendGroupFileMessage(token, event.groupOpenid, base64, url, event.messageId, fileName);
            } else if (event.type === MSG_TYPE_DM && event.guildId) {
              await sendDmMessage(token, event.guildId, `[文件消息暂不支持频道私信发送]`, event.messageId);
            } else if (event.channelId) {
              await sendChannelMessage(token, event.channelId, `[文件消息暂不支持频道发送]`, event.messageId);
            }
          });
        };

        /**
         * 本地图片文件 → Base64 Data URL
         * @returns Data URL 字符串
         * @throws 文件不存在、格式不支持、文件过大等错误
         */
        const localImageToDataUrl = async (imagePath: string): Promise<string> => {
          if (!(await fileExistsAsync(imagePath))) {
            throw new Error(`图片文件不存在: ${imagePath}`);
          }
          const imgSizeCheck = checkFileSize(imagePath);
          if (!imgSizeCheck.ok) {
            throw new Error(imgSizeCheck.error!);
          }
          const fileBuffer = await readFileAsync(imagePath);
          const base64Data = fileBuffer.toString("base64");
          const ext = path.extname(imagePath).toLowerCase();
          const mimeTypes: Record<string, string> = {
            ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".png": "image/png", ".gif": "image/gif",
            ".webp": "image/webp", ".bmp": "image/bmp",
          };
          const mimeType = mimeTypes[ext];
          if (!mimeType) {
            throw new Error(`不支持的图片格式: ${ext}`);
          }
          log?.info(`[qqbot:${account.accountId}] Converted local image to Base64 (size: ${formatFileSize(fileBuffer.length)})`);
          return `data:${mimeType};base64,${base64Data}`;
        };

        /**
         * 完整的语音发送流程：等待文件就绪 → SILK 转换 → 发送
         * @throws 文件不存在、转换失败等错误
         */
        const sendVoiceFromFile = async (voicePath: string) => {
          const fileSize = await waitForFile(voicePath);
          if (fileSize === 0) {
            throw new Error(`语音生成失败，文件未就绪: ${voicePath}`);
          }
          const uploadFormats = account.config?.audioFormatPolicy?.uploadDirectFormats ?? account.config?.voiceDirectUploadFormats;
          const silkBase64 = await audioFileToSilkBase64(voicePath, uploadFormats);
          if (!silkBase64) {
            const ext = path.extname(voicePath).toLowerCase();
            throw new Error(`语音格式转换失败 (${ext}, ${fileSize} bytes)`);
          }
          log?.info(`[qqbot:${account.accountId}] Voice file converted to SILK Base64 (${fileSize} bytes)`);
          await sendVoiceMessage(silkBase64);
        };

        /**
         * 完整的视频发送流程：支持公网 URL 和本地文件
         * @throws 文件不存在、文件过大等错误
         */
        const sendVideoFromPath = async (videoPath: string) => {
          const isHttpUrl = videoPath.startsWith("http://") || videoPath.startsWith("https://");
          if (isHttpUrl) {
            await sendVideoMessage(videoPath, undefined);
          } else {
            if (!(await fileExistsAsync(videoPath))) {
              throw new Error(`视频文件不存在: ${videoPath}`);
            }
            const vidSizeCheck = checkFileSize(videoPath);
            if (!vidSizeCheck.ok) throw new Error(vidSizeCheck.error!);
            const fileBuffer = await readFileAsync(videoPath);
            const videoBase64 = fileBuffer.toString("base64");
            log?.info(`[qqbot:${account.accountId}] Read local video (${formatFileSize(fileBuffer.length)}): ${videoPath}`);
            await sendVideoMessage(undefined, videoBase64);
          }
        };

        /**
         * 完整的文件发送流程：支持公网 URL 和本地文件
         * @throws 文件不存在、文件过大等错误
         */
        const sendFileFromPath = async (filePath: string) => {
          const isHttpUrl = filePath.startsWith("http://") || filePath.startsWith("https://");
          const fileName = sanitizeFileName(path.basename(filePath));
          if (isHttpUrl) {
            await sendFileMessage(undefined, filePath, fileName);
          } else {
            if (!(await fileExistsAsync(filePath))) throw new Error(`文件不存在: ${filePath}`);
            const flSizeCheck = checkFileSize(filePath);
            if (!flSizeCheck.ok) throw new Error(flSizeCheck.error!);
            const fileBuffer = await readFileAsync(filePath);
            const fileBase64 = fileBuffer.toString("base64");
            log?.info(`[qqbot:${account.accountId}] Read local file (${formatFileSize(fileBuffer.length)}): ${filePath}`);
            await sendFileMessage(fileBase64, undefined, fileName);
          }
        };

        // ============ 公共函数：QQBOT_PAYLOAD 结构化载荷执行 ============
        // 统一处理 parseQQBotPayload 的结果，避免 deliver / 流式结束阶段重复代码
        // 支持 cron_reminder 和 media（image/audio/video/file）两种载荷类型
        const executePayload = async (text: string): Promise<void> => {
          const payloadResult = parseQQBotPayload(text);

          if (!payloadResult.isPayload) return;

          if (payloadResult.error) {
            log?.error(`[qqbot:${account.accountId}] Payload parse error: ${payloadResult.error}`);
            await sendErrorMessage(`[QQBot] 载荷解析失败: ${payloadResult.error}`);
            return;
          }

          if (!payloadResult.payload) return;

          const parsedPayload = payloadResult.payload;
          log?.info(`[qqbot:${account.accountId}] Detected structured payload, type: ${parsedPayload.type}`);

          if (isCronReminderPayload(parsedPayload)) {
            // ============ 定时提醒载荷 ============
            const cronMessage = encodePayloadForCron(parsedPayload);
            const confirmText = `⏰ 提醒已设置，将在指定时间发送: "${parsedPayload.content}"`;
            try {
              await sendTextMessage(confirmText);
              log?.info(`[qqbot:${account.accountId}] Cron reminder confirmation sent, cronMessage: ${cronMessage}`);
            } catch (err) {
              log?.error(`[qqbot:${account.accountId}] Failed to send cron confirmation: ${err}`);
            }
          } else if (isMediaPayload(parsedPayload)) {
            // ============ 媒体消息载荷 ============
            log?.info(`[qqbot:${account.accountId}] Processing media payload, mediaType: ${parsedPayload.mediaType}`);
            await sendMediaFromPayload(parsedPayload);
          } else {
            log?.error(`[qqbot:${account.accountId}] Unknown payload type: ${(parsedPayload as any).type}`);
            await sendErrorMessage(`[QQBot] 不支持的载荷类型: ${(parsedPayload as any).type}`);
          }
        };

        // ============ 公共函数：按 MediaPayload 发送富媒体 ============
        // 从 QQBOT_PAYLOAD 的 media 类型载荷中提取并发送图片/语音/视频/文件
        const sendMediaFromPayload = async (payload: MediaPayload): Promise<void> => {
          if (payload.mediaType === "image") {
            let imageUrl = normalizePath(payload.path);
            if (payload.source === "file") {
              try {
                imageUrl = await localImageToDataUrl(imageUrl);
              } catch (readErr) {
                log?.error(`[qqbot:${account.accountId}] Failed to read local image: ${readErr}`);
                await sendErrorMessage(`[QQBot] 读取图片文件失败: ${readErr}`);
                return;
              }
            }
            try {
              await sendImageMessage(imageUrl, `![](${payload.path})`);
              log?.info(`[qqbot:${account.accountId}] Sent image via media payload`);
              if (payload.caption) {
                await sendTextMessage(payload.caption);
              }
            } catch (err) {
              log?.error(`[qqbot:${account.accountId}] Failed to send image: ${err}`);
              await sendErrorMessage(formatMediaErrorMessage("图片", err));
            }
          } else if (payload.mediaType === "audio") {
            try {
              const ttsText = payload.caption || payload.path;
              if (!ttsText?.trim()) {
                await sendErrorMessage(`[QQBot] 语音消息缺少文本内容`);
              } else {
                const ttsCfg = resolveTTSConfig(cfg as Record<string, unknown>);
                if (!ttsCfg) {
                  log?.error(`[qqbot:${account.accountId}] TTS not configured (channels.qqbot.tts in openclaw.json)`);
                  await sendErrorMessage(`[QQBot] TTS 未配置，请在 openclaw.json 的 channels.qqbot.tts 中配置`);
                } else {
                  log?.info(`[qqbot:${account.accountId}] TTS: "${ttsText.slice(0, 50)}..." via ${ttsCfg.model}`);
                  const ttsDir = getQQBotDataDir("tts");
                  const { silkBase64, duration } = await textToSilk(ttsText, ttsCfg, ttsDir);
                  log?.info(`[qqbot:${account.accountId}] TTS done: ${formatDuration(duration)}, uploading voice...`);
                  await sendVoiceMessage(silkBase64);
                  log?.info(`[qqbot:${account.accountId}] Voice message sent`);
                }
              }
            } catch (err) {
              log?.error(`[qqbot:${account.accountId}] TTS/voice send failed: ${err}`);
              await sendErrorMessage(`[QQBot] 语音发送失败: ${err}`);
            }
          } else if (payload.mediaType === "video") {
            try {
              const videoPath = normalizePath(payload.path ?? "");
              if (!videoPath?.trim()) {
                await sendErrorMessage(`[QQBot] 视频消息缺少视频路径`);
              } else {
                log?.info(`[qqbot:${account.accountId}] Video send: "${videoPath.slice(0, 60)}..."`);
                await sendVideoFromPath(videoPath);
                log?.info(`[qqbot:${account.accountId}] Video message sent`);
                if (payload.caption) {
                  await sendTextMessage(payload.caption);
                }
              }
            } catch (err) {
              log?.error(`[qqbot:${account.accountId}] Video send failed: ${err}`);
              await sendErrorMessage(formatMediaErrorMessage("视频", err));
            }
          } else if (payload.mediaType === "file") {
            try {
              const filePath = normalizePath(payload.path ?? "");
              if (!filePath?.trim()) {
                await sendErrorMessage(`[QQBot] 文件消息缺少文件路径`);
              } else {
                log?.info(`[qqbot:${account.accountId}] File send: "${filePath.slice(0, 60)}..."`);
                await sendFileFromPath(filePath);
                log?.info(`[qqbot:${account.accountId}] File message sent`);
              }
            } catch (err) {
              log?.error(`[qqbot:${account.accountId}] File send failed: ${err}`);
              await sendErrorMessage(formatMediaErrorMessage("文件", err));
            }
          } else {
            log?.error(`[qqbot:${account.accountId}] Unknown media type: ${(payload as MediaPayload).mediaType}`);
            await sendErrorMessage(`[QQBot] 不支持的媒体类型: ${(payload as MediaPayload).mediaType}`);
          }
        };

        // ============ 公共函数：按媒体类型发送单个富媒体 ============
        // 统一处理 stream-handlers 和 deliver sendQueue 中的媒体发送逻辑
        // mediaType: "image" | "voice" | "video" | "file"
        // mediaPath: 已 decode 后的路径
        const sendMediaByType = async (mediaType: string, mediaPath: string): Promise<void> => {
          if (mediaType === "image") {
            const imagePath = normalizePath(mediaPath);
            const isHttpUrl = imagePath.startsWith("http://") || imagePath.startsWith("https://");
            const isLocal = isLocalFilePath(imagePath);

            if (isHttpUrl) {
              // 公网 URL → 直接发送图片
              try {
                await sendImageMessage(imagePath);
                log?.info(`[qqbot:${account.accountId}] Sent HTTP image: ${imagePath.slice(0, 60)}...`);
              } catch (err) {
                log?.error(`[qqbot:${account.accountId}] Failed to send HTTP image: ${err}`);
                await sendErrorMessage(formatMediaErrorMessage("图片", err));
              }
            } else if (isLocal) {
              // 本地图片 → 转 DataURL → 富媒体 API
              try {
                const imageUrl = await localImageToDataUrl(imagePath);
                await sendImageMessage(imageUrl);
                log?.info(`[qqbot:${account.accountId}] Sent local image via Rich Media API`);
              } catch (err) {
                log?.error(`[qqbot:${account.accountId}] Failed to send local image: ${err}`);
                await sendErrorMessage(`图片发送失败，图片似乎不存在哦，图片路径：${imagePath}`);
              }
            } else {
              log?.error(`[qqbot:${account.accountId}] Invalid image path (not local or URL): ${imagePath}`);
            }
          } else if (mediaType === "voice") {
            const voicePath = normalizePath(mediaPath);
            try {
              await sendVoiceFromFile(voicePath);
              log?.info(`[qqbot:${account.accountId}] Sent voice: ${voicePath.slice(0, 60)}...`);
            } catch (err) {
              log?.error(`[qqbot:${account.accountId}] Failed to send voice: ${err}`);
              await sendErrorMessage(formatMediaErrorMessage("语音", err));
            }
          } else if (mediaType === "video") {
            const videoPath = normalizePath(mediaPath);
            try {
              await sendVideoFromPath(videoPath);
              log?.info(`[qqbot:${account.accountId}] Sent video: ${videoPath.slice(0, 60)}...`);
            } catch (err) {
              log?.error(`[qqbot:${account.accountId}] Failed to send video: ${err}`);
              await sendErrorMessage(formatMediaErrorMessage("视频", err));
            }
          } else if (mediaType === "file") {
            const filePath = normalizePath(mediaPath);
            try {
              await sendFileFromPath(filePath);
              log?.info(`[qqbot:${account.accountId}] Sent file: ${filePath.slice(0, 60)}...`);
            } catch (err) {
              log?.error(`[qqbot:${account.accountId}] Failed to send file: ${err}`);
              await sendErrorMessage(`文件发送失败: ${err}`);
            }
          }
        };

        // ============ 公共函数：本地路径标签提示 ============
        // 当检测到本地文件路径出现在非结构化消息中时，给出使用 <qqXXX> 标签的提示
        const logLocalPathHint = (url: string): void => {
          const ext = path.extname(url).toLowerCase();
          const VIDEO_EXTS = [".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv"];
          let suggestedTag = "qqimg";
          let mediaDesc = "图片";
          if (isAudioFile(url)) {
            suggestedTag = "qqvoice";
            mediaDesc = "语音";
          } else if (VIDEO_EXTS.includes(ext)) {
            suggestedTag = "qqvideo";
            mediaDesc = "视频";
          } else if (![".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext)) {
            suggestedTag = "qqfile";
            mediaDesc = "文件";
          }
          log?.info(`[qqbot:${account.accountId}] 💡 Local path detected in non-structured message (not sending): ${url}`);
          log?.info(`[qqbot:${account.accountId}] 💡 Hint: Use <${suggestedTag}>${url}</${suggestedTag}> tag to send local ${mediaDesc}`);
        };

        try {
          const messagesConfig = pluginRuntime.channel.reply.resolveEffectiveMessagesConfig(cfg, route.agentId);

          // 追踪是否有响应
          let hasResponse = false;
          let hasBlockResponse = false; // 是否收到了面向用户的 block 回复
          let toolDeliverCount = 0; // tool deliver 计数
          const toolTexts: string[] = []; // 收集所有 tool deliver 文本（用于格式化展示）
          let toolFallbackSent = false; // 兜底消息是否已发送（只发一次）
          const responseTimeout = 120000; // 120秒超时（2分钟，与 TTS/文件生成超时对齐）
          const toolOnlyTimeout = 60000; // tool-only 兜底超时：60秒内没有 block 就兜底
          const maxToolRenewals = 3; // tool 续期上限：最多续期 3 次（总等待 = 60s × 3 = 180s）
          let toolRenewalCount = 0; // 已续期次数
          let timeoutId: ReturnType<typeof setTimeout> | null = null;
          let toolOnlyTimeoutId: ReturnType<typeof setTimeout> | null = null;

          // 格式化 tool 兜底消息：极简，只展示工具原始参数
          const formatToolFallback = (): string => {
            if (toolTexts.length === 0) {
              return "🔧 调用工具中…";
            }
            const recentTools = toolTexts.slice(-3);
            const totalLen = recentTools.reduce((s, t) => s + t.length, 0);
            if (totalLen > 1800) {
              const last = recentTools[recentTools.length - 1]!;
              return `🔧 调用工具中…\n\`\`\`\n${last.slice(0, 1500)}\n\`\`\``;
            }
            const toolBlock = recentTools.join("\n---\n");
            return `🔧 调用工具中…\n\`\`\`\n${toolBlock}\n\`\`\``;
          };

          const timeoutPromise = new Promise<void>((_, reject) => {
            timeoutId = setTimeout(() => {
              if (!hasResponse) {
                reject(new Error("Response timeout"));
              }
            }, responseTimeout);
          });

          // ============ 消息发送目标 ============
          // 确定发送目标
          const targetTo = event.type === MSG_TYPE_C2C ? event.senderId
                        : event.type === MSG_TYPE_GROUP ? `group:${event.groupOpenid}`
                        : event.type === MSG_TYPE_DM ? `dm:${event.guildId}`
                        : `channel:${event.channelId}`;

          // ============ 流式消息发送器（仅 C2C 私聊 + streamSupport 开启） ============
          //
          // C2C 流式架构：
          //   disableBlockStreaming=true
          //   onPartialReply → token 级实时流式发送（通过攒包缓冲 bufferAndSend）
          //                    同时支持媒体标签检测：完整标签 → 中断流式→发送富媒体→重建
          //   deliver → 流式场景直接跳过（isPayloadBlock=true 时放行处理结构化载荷）
          //   QQ Bot 流式是 "增量追加"，每次发送 delta 文本，客户端拼接显示
          //
          const supportsStream = event.type === MSG_TYPE_C2C && account.streamSupport === true;
          const streamLog = log ? { info: log.info.bind(log), error: log.error.bind(log) } : undefined;
          let streamSender = supportsStream ? createStreamSender(account, targetTo, event.messageId, streamLog) : null;
          let streamStarted = false; // 是否已开始流式发送
          let streamEnded = false; // 流式是否已结束
          let streamFailed = false; // 流式是否失败（停止当前消息发送）
          let sendingLock = false; // 发送锁，防止并发发送
          let pendingPayloadText = ""; // 暂存 QQBOT_PAYLOAD 结构化载荷全文（流式结束后处理）
          let keepaliveTimer: ReturnType<typeof setTimeout> | null = null;
          const MAX_KEEPALIVE_COUNT = 10; // 最大连续空保活次数，超过后只能通过发送实际消息来续

          // 清理心跳定时器
          const clearKeepalive = () => {
            if (keepaliveTimer) {
              clearTimeout(keepaliveTimer);
              keepaliveTimer = null;
            }
          };

          // 重置心跳定时器
          // keepalive 必须发送空字符串，这是 QQ 通道的要求
          // ⚠️ 捕获注册时的 sender 实例，防止 rebuildStream 后用已 END 的旧 sender 发送
          // @param count 当前连续空保活次数（外部消息发送后传 0，保活自递归时传 count+1）
          const resetKeepalive = (count = 0) => {
            clearKeepalive();
            if (streamSender && streamStarted && !streamEnded && !streamFailed) {
              const senderAtRegistration = streamSender; // 捕获当前实例
              keepaliveTimer = setTimeout(async () => {
                // 二次检查：确保 sender 没有被 rebuild 替换，且流式未结束
                if (!streamEnded && !streamFailed && !sendingLock && streamSender === senderAtRegistration) {
                  if (count >= MAX_KEEPALIVE_COUNT) {
                    log?.info(`[qqbot:${account.accountId}] 💓 Keepalive suppressed: consecutive count ${count} reached limit ${MAX_KEEPALIVE_COUNT}, waiting for actual message to resume. sender=${senderAtRegistration.instanceId}, streamId=${senderAtRegistration.getContext().streamId}`);
                    return;
                  }
                  // streamId 为空时不发送心跳，直接停止（流式尚未真正建立，无需保活）
                  const currentStreamId = senderAtRegistration.getContext().streamId;
                  if (!currentStreamId) {
                    log?.info(`[qqbot:${account.accountId}] 💓 Keepalive stopped: streamId is empty, sender=${senderAtRegistration.instanceId}`);
                    clearKeepalive();
                    return;
                  }
                  debugLog?.(`[qqbot:${account.accountId}] 💓 Sending stream keepalive (${count + 1}/${MAX_KEEPALIVE_COUNT}): sender=${senderAtRegistration.instanceId}, streamId=${currentStreamId}`);
                  sendingLock = true;
                  try {
                    // 三次检查：拿到锁后再确认一次（锁等待期间状态可能已变）
                    if (streamEnded || streamFailed || streamSender !== senderAtRegistration) {
                      debugLog?.(`[qqbot:${account.accountId}] 💓 Keepalive skipped: stream state changed while acquiring lock, sender=${senderAtRegistration.instanceId}, currentSender=${streamSender?.instanceId}, streamEnded=${streamEnded}`);
                      return;
                    }
                    await streamSender.send("", false);
                    resetKeepalive(count + 1);
                  } catch (err) {
                    // 心跳发送失败：不停止流式（后续实际消息可能仍能发送），仅停止心跳
                    log?.error(`[qqbot:${account.accountId}] 💓 Keepalive send failed, stopping keepalive (stream continues): sender=${senderAtRegistration.instanceId}, streamId=${currentStreamId}, error=${err}`);
                    clearKeepalive();
                  } finally {
                    sendingLock = false;
                  }
                } else if (!streamEnded && streamSender !== senderAtRegistration) {
                  debugLog?.(`[qqbot:${account.accountId}] 💓 Keepalive skipped (sender replaced): registered=${senderAtRegistration.instanceId}, current=${streamSender?.instanceId}`);
                }
              }, STREAM_KEEPALIVE_INTERVAL);
            }
          };

          // ============ QQ Bot 攒包缓冲（C2C 流式专用） ============
          //
          // QQ Bot 的特殊限制：
          //   1. markdown 链接 [text](url) 必须完整发送，截断会导致消息发不出去
          //   2. 媒体标签 <qqimg>/<qqvoice>/<qqvideo>/<qqfile> 必须完整发送
          //   3. QQBOT_PAYLOAD 结构化载荷不应流式发送
          //
          // 特殊格式通过 stream-handlers 责任链统一处理
          //
          let streamBuffer = ""; // 攒包缓冲区
          const STREAM_MIN_FLUSH_CHARS = 10; // 缓冲区最小刷新字符数

          // 创建处理器责任链
          const handlerChain = createDefaultChain();

          // 流式发送分片（增量文本）
          const sendStreamChunk = async (text: string, isEnd: boolean): Promise<boolean> => {
            if (!streamSender || streamEnded) {
              log?.error(`[qqbot:${account.accountId}] ⚠️ sendStreamChunk skipped: streamSender=${streamSender ? `[${streamSender.instanceId}]` : "null"}, streamEnded=${streamEnded}, isEnd=${isEnd}, textLen=${text.length}`);
              return false;
            }
            const senderBefore = streamSender.instanceId;
            const result = await streamSender.send(text, isEnd);
            if (result.error) {
              log?.error(`[qqbot:${account.accountId}] ❌ Stream send error: sender=${senderBefore}, streamId=${streamSender.getContext().streamId}, error=${result.error}`);
              return false;
            }
            const ctx = streamSender.getContext();
            debugLog?.(`[qqbot:${account.accountId}] [stream-chunk] sender=${senderBefore}, streamId=${ctx.streamId}, index=${ctx.index - 1}, isEnd=${isEnd}, len=${text.length}, text=${JSON.stringify(text)}`);
            if (isEnd) {
              streamEnded = true;
              clearKeepalive();
            } else {
              resetKeepalive();
            }
            return true;
          };

          // ============ 流式辅助函数 ============

          /**
           * 中断当前流式会话：刷新 buffer → 发送结束标记
           * 用于在流式中需要发送富媒体消息前中断流式
           */
          const interruptStream = async () => {
            while (sendingLock) {
              await new Promise(resolve => setTimeout(resolve, 50));
            }
            sendingLock = true;
            try {
              if (streamStarted && !streamEnded) {
                const ctx = streamSender!.getContext();
                log?.info(`[qqbot:${account.accountId}] ⏸️ Interrupting stream: sender=${streamSender!.instanceId}, streamId=${ctx.streamId}, index=${ctx.index}, bufferLen=${streamBuffer.length}`);
                if (streamBuffer) {
                  await sendStreamChunk(streamBuffer, false);
                  streamBuffer = "";
                }
                await streamSender!.end("");
                streamEnded = true;
                clearKeepalive();
                log?.info(`[qqbot:${account.accountId}] ⏸️ Stream interrupted successfully: sender=${streamSender!.instanceId}, streamId=${ctx.streamId}`);
              }
            } finally {
              sendingLock = false;
            }
          };

          // 标记 handlePartialReply 因 streamEnded/streamFailed 跳过时是否已打过日志（每轮流式重置）
          let partialReplySkipLogged = false;

          /**
           * 重建 StreamSender，用于中断后继续发送后续流式内容
           */
          const rebuildStream = () => {
            const oldInstanceId = streamSender?.instanceId;
            const oldStreamId = streamSender?.getContext().streamId;
            streamSender = createStreamSender(account, targetTo, event.messageId, streamLog);
            streamStarted = false;
            streamEnded = false;
            partialReplySkipLogged = false; // 新一轮流式，重置日志标记
            log?.info(`[qqbot:${account.accountId}] 🔄 StreamSender rebuilt: old=[${oldInstanceId}|streamId=${oldStreamId}] → new=[${streamSender.instanceId}]`);
          };

          /**
           * 流式发送文本
           * - 流式正常：将文本加入 buffer 并按安全点发送
           * - 流式失败：打印错误，停止发送
           * - 非流式：直接普通发送
           */
          const streamSendTextOrFallback = async (text: string) => {
            if (!text.trim()) return;
            
            if (supportsStream && streamSender && !streamFailed) {
              // 流式发送：加入 buffer，按安全点发送
              while (sendingLock) {
                await new Promise(resolve => setTimeout(resolve, 50));
              }
              sendingLock = true;
              try {
                streamBuffer += text;

                // 循环发送安全分片
                while (streamBuffer.length >= STREAM_MIN_FLUSH_CHARS) {
                  const safePoint = handlerChain.findSafeFlushPoint(streamBuffer);
                  if (safePoint <= 0) break;

                  const toSend = streamBuffer.slice(0, safePoint);
                  streamBuffer = streamBuffer.slice(safePoint);

                  if (toSend) {
                    const success = await sendStreamChunk(toSend, false);
                    if (success) {
                      streamStarted = true;
                    } else {
                      // 流式失败，停止当前消息发送
                      streamFailed = true;
                      log?.error(`[qqbot:${account.accountId}] ❌ Stream send failed in streamSendTextOrFallback: sender=${streamSender?.instanceId}, streamId=${streamSender?.getContext().streamId}, stopping current message`);
                      streamBuffer = "";
                      return;
                    }
                  }
                }

                debugLog?.(`[qqbot:${account.accountId}] Stream text buffered, buffer: ${streamBuffer.length} chars`);
              } finally {
                sendingLock = false;
              }
            } else if (supportsStream && streamFailed) {
              // 流式已失败，跳过发送
              log?.info(`[qqbot:${account.accountId}] Stream failed, skipping text send`);
            } else {
              // 非流式：普通发送
              await sendTextMessage(text);
              log?.info(`[qqbot:${account.accountId}] Sent text (${event.type})`);
            }
          };

          // ============ onPartialReply 回调（C2C 流式专用） ============
          //
          // onPartialReply 在 AI 生成过程中被 token 级别实时调用
          // payload.text 是**累积全文**（非增量），需要跟踪已发送长度计算 delta
          // 通过 stream-handlers 责任链处理特殊格式，保留安全分割点检测
          //
          // 流式模式下 deliver 统一跳过，所有内容都由 onPartialReply 处理：
          //   - 纯文本 → 攒包缓冲 → 流式增量发送
          //   - 媒体标签 → 检测到完整标签后：中断流式 → 发送富媒体 → 重建流式
          //   - QQBOT_PAYLOAD → 暂存到 pendingPayloadText → 流式结束阶段统一处理
          //
          let partialReplySentLength = 0; // 已通过 onPartialReply 发送的累积文本长度
          let partialReplyReceived = false; // onPartialReply 是否被调用过（区别于 streamStarted：后者要求实际发送过流式 chunk）

          /**
           * 构建 StreamHandlerContext —— 将 gateway 闭包状态桥接给 handler 链
           *
           * ⚠️ 在 sendingLock 保护下调用，handler 内部不需要感知锁
           */
          const buildHandlerContext = (): StreamHandlerContext => ({
            buffer: streamBuffer,
            accountId: account.accountId,
            get streamStarted() { return streamStarted; },
            set streamStarted(v: boolean) { streamStarted = v; },
            get streamEnded() { return streamEnded; },
            set streamEnded(v: boolean) { streamEnded = v; },
            get streamFailed() { return streamFailed; },
            set streamFailed(v: boolean) { streamFailed = v; },
            get pendingPayloadText() { return pendingPayloadText; },
            set pendingPayloadText(v: string) { pendingPayloadText = v; },
            sendStreamChunk,
            // 内联中断（在 sendingLock 保护下，不能调用外层 interruptStream 避免死锁）
            interruptStream: async () => {
              if (streamStarted && !streamEnded) {
                const ctx = streamSender!.getContext();
                log?.info(`[qqbot:${account.accountId}] ⏸️ [handler] Interrupting stream: sender=${streamSender!.instanceId}, streamId=${ctx.streamId}, index=${ctx.index}`);
                await streamSender!.end("");
                streamEnded = true;
                clearKeepalive();
                log?.info(`[qqbot:${account.accountId}] ⏸️ [handler] Stream interrupted successfully: sender=${streamSender!.instanceId}, streamId=${ctx.streamId}`);
              }
            },
            rebuildStream: () => {
              const oldInstanceId = streamSender?.instanceId;
              const oldStreamId = streamSender?.getContext().streamId;
              streamSender = createStreamSender(account, targetTo, event.messageId, streamLog);
              streamStarted = false;
              streamEnded = false;
              partialReplySkipLogged = false; // 新一轮流式，重置日志标记
              log?.info(`[qqbot:${account.accountId}] 🔄 [handler] StreamSender rebuilt: old=[${oldInstanceId}|streamId=${oldStreamId}] → new=[${streamSender.instanceId}]`);
            },
            sendMediaByType,
            // 公网图片 → markdown 嵌入流式（不中断）
            sendImageAsMarkdown: async (imagePath: string): Promise<boolean> => {
              try {
                const size = await getImageSize(imagePath);
                const mdImage = formatQQBotMarkdownImage(imagePath, size);
                log?.info(`[qqbot:${account.accountId}] [handler] Embedding HTTP image as markdown: ${size ? `${size.width}x${size.height}` : 'default'}`);
                return await sendStreamChunk("\n" + mdImage + "\n", false);
              } catch (err) {
                log?.info(`[qqbot:${account.accountId}] [handler] Failed to get image size, using default: ${err}`);
                const mdImage = formatQQBotMarkdownImage(imagePath, null);
                return await sendStreamChunk("\n" + mdImage + "\n", false);
              }
            },
            log: log ? { info: log.info.bind(log), error: log.error.bind(log) } : undefined,
          });

          /**
           * 安全刷新 streamBuffer（通过责任链处理完整/不完整媒体标签 + 剩余纯文本）
           *
           * 在所有需要强制刷新 streamBuffer 的场景使用（结束、中断、超时等），
           * 避免将未处理的媒体标签作为纯文本发送。
           *
           * @returns 提取出的待发送媒体列表（调用者在流式结束后独立发送）
           */
          const flushStreamBufferSafe = async (): Promise<Array<{ type: string; path: string }>> => {
            const pendingMedia: Array<{ type: string; path: string }> = [];
            debugLog?.(`[qqbot:${account.accountId}] flushStreamBufferSafe: enter, buffer=${JSON.stringify(streamBuffer)}`);
            if (!streamBuffer) return pendingMedia;

            // 1. 通过责任链处理完整的媒体标签
            while (sendingLock) {
              await new Promise(resolve => setTimeout(resolve, 50));
            }
            sendingLock = true;
            try {
              const ctx = buildHandlerContext();
              await handlerChain.processBuffer(ctx);
              streamBuffer = ctx.buffer;
            } finally {
              sendingLock = false;
            }

            debugLog?.(`[qqbot:${account.accountId}] flushStreamBufferSafe: after chain.processBuffer, buffer=${JSON.stringify(streamBuffer)}`);
            if (!streamBuffer) return pendingMedia;

            // 2. 检测不完整的媒体标签（AI 没有输出闭合标签的情况）
            streamBuffer = normalizeMediaTags(streamBuffer);
            const incompleteRegex = new RegExp(INCOMPLETE_MEDIA_TAG_REGEX.source, INCOMPLETE_MEDIA_TAG_REGEX.flags);
            const incompleteMatches = [...streamBuffer.matchAll(incompleteRegex)];

            if (incompleteMatches.length > 0) {
              log?.info(`[qqbot:${account.accountId}] Found ${incompleteMatches.length} incomplete media tag(s) in buffer, processing`);

              let lastIndex = 0;
              for (const match of incompleteMatches) {
                // 发送标签前的纯文本
                const textBefore = streamBuffer.slice(lastIndex, match.index);
                if (textBefore.trim()) {
                  const filteredText = filterInternalMarkers(textBefore);
                  if (filteredText) {
                    await sendStreamChunk(filteredText, false);
                    streamStarted = true;
                  }
                }

                // 提取媒体标签信息，待调用者在流式结束后发送
                const tagName = match[1]!.toLowerCase();
                const rawPath = match[2] ?? "";
                const mediaPath = decodeMediaPath(rawPath.trim());

                if (mediaPath) {
                  const mediaType = tagNameToQueueType(tagName);
                  debugLog?.(`[qqbot:${account.accountId}] Extracted incomplete ${mediaType} tag for post-stream send: ${mediaPath.slice(0, 120)}`);
                  pendingMedia.push({ type: mediaType, path: mediaPath });
                }

                lastIndex = match.index! + match[0].length;
              }

              // 标签后的剩余文本（不完整标签匹配到末尾，通常没有剩余）
              streamBuffer = streamBuffer.slice(lastIndex);
            }

            // 3. 发送剩余的纯文本
            if (streamBuffer) {
              debugLog?.(`[qqbot:${account.accountId}] flushStreamBufferSafe: sending remaining text, buffer=${JSON.stringify(streamBuffer)}`);
              await sendStreamChunk(streamBuffer, false);
              streamBuffer = "";
            }

            return pendingMedia;
          };

          // ============ onPartialReply 回调（C2C 流式专用） ============
          //
          // 四步流水线：
          //   1. 攒包：计算 delta，追加到 streamBuffer
          //   2. 责任链主动处理：QQBOT_PAYLOAD 拦截、完整媒体标签中断/发送/重建
          //   3. 判断能否发送：达到字符阈值 + 无特殊格式阻断（链安全点）
          //   4. 循环发送安全分片
          //

          const handlePartialReply = supportsStream ? async (payload: { text?: string }) => {
            const _prFullText = payload.text ?? "";
            const _prDelta = _prFullText.slice(partialReplySentLength);
            debugLog?.(`[qqbot:${account.accountId}] handlePartialReply received: fullLen=${_prFullText.length}, sentLen=${partialReplySentLength}, delta=${JSON.stringify(_prDelta)}`);
            if (!streamSender || streamEnded || streamFailed) {
              if ((streamEnded || streamFailed) && !partialReplySkipLogged) {
                partialReplySkipLogged = true;
                debugLog?.(`[qqbot:${account.accountId}] handlePartialReply skipped (first occurrence, suppressing further): sender=${streamSender?.instanceId ?? "null"}, streamEnded=${streamEnded}, streamFailed=${streamFailed}`);
              }
              return;
            }

            const fullText = payload.text ?? "";
            if (!fullText || fullText.length <= partialReplySentLength) return;

            hasResponse = true;
            partialReplyReceived = true;

            // 如果之前已经标记为 payload（正在逐步生成中），持续暂存
            if (pendingPayloadText) {
              pendingPayloadText = fullText;
              partialReplySentLength = fullText.length;
              return;
            }

            // ---- 步骤 1: 攒包 ----
            const delta = fullText.slice(partialReplySentLength);
            debugLog?.(`[qqbot:${account.accountId}] handlePartialReply processing: delta=${JSON.stringify(delta)}, buffer=${JSON.stringify(streamBuffer)}`);
            partialReplySentLength = fullText.length;
            streamBuffer += delta;

            // 获取发送锁
            while (sendingLock) {
              await new Promise(resolve => setTimeout(resolve, 50));
            }
            sendingLock = true;
            try {
                // ---- 步骤 2: 责任链主动处理 ----
                // 处理需要立即响应的特殊格式（QQBOT_PAYLOAD、完整媒体标签）
                const ctx = buildHandlerContext();
                const { handled } = await handlerChain.processBuffer(ctx);
                streamBuffer = ctx.buffer;

                // 如果 payload 被拦截（abort），直接返回
                if (handled && pendingPayloadText) {
                  return;
                }

                // 如果流式已失败，停止发送
                if (streamFailed) {
                  streamBuffer = "";
                  return;
                }

                // ---- 步骤 3 + 4: 判断能否发送 + 循环发送安全分片 ----
                while (streamBuffer.length >= STREAM_MIN_FLUSH_CHARS) {
                  const safePoint = handlerChain.findSafeFlushPoint(streamBuffer);
                  if (safePoint <= 0) break; // 无安全点，继续攒

                  const toSend = streamBuffer.slice(0, safePoint);
                  streamBuffer = streamBuffer.slice(safePoint);

                  if (toSend) {
                    const success = await sendStreamChunk(toSend, false);
                    if (success) {
                      streamStarted = true;
                    } else {
                      // 流式发送失败，停止当前消息发送
                      streamFailed = true;
                      clearKeepalive(); // 立即停止保活，防止继续发送空分片
                      log?.error(`[qqbot:${account.accountId}] ❌ Stream send failed in onPartialReply: sender=${streamSender?.instanceId}, streamId=${streamSender?.getContext().streamId}, stopping current message`);
                      streamBuffer = "";
                      return;
                    }
                  }
                }
            } finally {
              sendingLock = false;
            }
          } : undefined;

          const dispatchPromise = pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              responsePrefix: messagesConfig.responsePrefix,
              deliver: async (payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string }, info: { kind: string }) => {
                hasResponse = true;

                log?.info(`[qqbot:${account.accountId}] deliver called, kind: ${info.kind}, payload keys: ${Object.keys(payload).join(", ")}`);
                debugLog?.(`[qqbot:${account.accountId}] deliver content: kind=${info.kind}, text=${JSON.stringify((payload.text ?? "").slice(0, 500))}${(payload.text ?? "").length > 500 ? `...(total ${payload.text!.length} chars)` : ""}, mediaUrls=${JSON.stringify(payload.mediaUrls ?? [])}, mediaUrl=${payload.mediaUrl ?? "none"}`);

                // ============ 跳过工具调用的中间结果（带兜底保护） ============
                if (info.kind === "tool") {
                  toolDeliverCount++;
                  const toolText = (payload.text ?? "").trim();
                  if (toolText) {
                    toolTexts.push(toolText);
                  }
                  log?.info(`[qqbot:${account.accountId}] Skipping tool result deliver #${toolDeliverCount} (intermediate, not user-facing), text length: ${toolText.length}`);

                  // 兜底已发送，不再续期
                  if (toolFallbackSent) {
                    return;
                  }

                  // tool-only 超时保护：收到 tool 但迟迟没有 block 时，启动兜底定时器
                  // 续期有上限（maxToolRenewals 次），防止无限工具调用永远不触发兜底
                  if (toolOnlyTimeoutId) {
                    if (toolRenewalCount < maxToolRenewals) {
                      clearTimeout(toolOnlyTimeoutId);
                      toolRenewalCount++;
                      log?.info(`[qqbot:${account.accountId}] Tool-only timer renewed (${toolRenewalCount}/${maxToolRenewals})`);
                    } else {
                      // 已达续期上限，不再重置，等定时器自然触发兜底
                      log?.info(`[qqbot:${account.accountId}] Tool-only timer renewal limit reached (${maxToolRenewals}), waiting for timeout`);
                      return;
                    }
                  }
                  toolOnlyTimeoutId = setTimeout(async () => {
                    if (!hasBlockResponse && !toolFallbackSent) {
                      toolFallbackSent = true;
                      log?.error(`[qqbot:${account.accountId}] Tool-only timeout: ${toolDeliverCount} tool deliver(s) but no block within ${toolOnlyTimeout / 1000}s, sending fallback`);
                      const fallback = formatToolFallback();
                      try {
                        await sendTextMessage(fallback);
                      } catch (sendErr) {
                        log?.error(`[qqbot:${account.accountId}] Failed to send tool-only fallback: ${sendErr}`);
                      }
                    }
                  }, toolOnlyTimeout);
                  return;
                }

                // 收到 block 回复，清除所有超时定时器
                hasBlockResponse = true;
                if (timeoutId) {
                  clearTimeout(timeoutId);
                  timeoutId = null;
                }
                if (toolOnlyTimeoutId) {
                  clearTimeout(toolOnlyTimeoutId);
                  toolOnlyTimeoutId = null;
                }
                if (toolDeliverCount > 0) {
                  log?.info(`[qqbot:${account.accountId}] Block deliver after ${toolDeliverCount} tool deliver(s)`);
                }

                let replyText = payload.text ?? "";

                // ============ 流式模式：deliver 跳过（仅限 onPartialReply 已处理的内容） ============
                // 流式模式下，AI 生成的内容都通过 onPartialReply 实时处理：
                //   - 纯文本 → 攒包缓冲 → 流式增量发送
                //   - 媒体标签 → 检测到完整标签后中断流式 → 发送富媒体 → 重建
                //   - QQBOT_PAYLOAD → 暂存到 pendingPayloadText → 流式结束阶段统一处理
                //
                // 但有些内容只走 deliver 不走 onPartialReply（如 OpenClaw 的 /commands 等内置指令），
                // 这些响应在 partialReplyReceived=false 时到达 deliver，必须放行走非流式路径正常发送。
                if (supportsStream && streamSender && !streamFailed) {
                  if (partialReplyReceived || pendingPayloadText) {
                    // onPartialReply 已被调用过或有暂存 payload，说明内容已由流式处理，跳过 deliver
                    // 重置 partialReplySentLength，为下一个 block（如多消息场景）做准备
                    partialReplySentLength = 0;

                    debugLog?.(`[qqbot:${account.accountId}] deliver (stream): skipping, all content handled by onPartialReply (${replyText.length} chars${pendingPayloadText ? ", has pending payload" : ""})`);
                    pluginRuntime.channel.activity.record({
                      channel: "qqbot",
                      accountId: account.accountId,
                      direction: "outbound",
                    });
                    return;
                  }
                  // onPartialReply 未被调用过且无暂存 payload：说明这是不经过 onPartialReply 的独立指令（如 /commands）
                  // 放行到下方非流式路径正常发送
                  debugLog?.(`[qqbot:${account.accountId}] deliver (stream, no partial): treating as non-stream, kind=${info.kind}, text=${replyText.slice(0, 100)}`);
                }
                
                // ============ 媒体标签解析（使用共享的 parseMediaTags） ============
                // 支持四种标签:
                //   <qqimg>路径</qqimg> 或 <qqimg>路径</img>  — 图片
                //   <qqvoice>路径</qqvoice>                   — 语音
                //   <qqvideo>路径或URL</qqvideo>                — 视频
                //   <qqfile>路径</qqfile>                     — 文件
                // 按文本中出现的位置统一构建发送队列，保持顺序
                
                // 预处理：纠正小模型常见的标签拼写错误和格式问题
                replyText = normalizeMediaTags(replyText);
                
                const { hasMedia, sendQueue } = parseMediaTags(replyText, filterInternalMarkers);
                
                if (hasMedia) {
                  const imgCount = sendQueue.filter(i => i.type === "image").length;
                  const voiceCount = sendQueue.filter(i => i.type === "voice").length;
                  const videoCount = sendQueue.filter(i => i.type === "video").length;
                  const fileCount = sendQueue.filter(i => i.type === "file").length;
                  log?.info(`[qqbot:${account.accountId}] Detected media tags: ${imgCount} <qqimg>, ${voiceCount} <qqvoice>, ${videoCount} <qqvideo>, ${fileCount} <qqfile>`);
                  log?.info(`[qqbot:${account.accountId}] Send queue: ${sendQueue.map(item => item.type).join(" -> ")}`);
                  
                  const isStreaming = supportsStream && streamSender && !streamFailed;
                  debugLog?.(`[qqbot:${account.accountId}] Processing media tags (streaming: ${!!isStreaming})`);
                  
                  // ============ 统一的富媒体发送队列处理 ============
                  // 流式模式：文本→流式发送，公网图片→markdown嵌入流式，本地图片/语音/视频/文件→中断流式→发送→重建
                  // 非流式模式：文本→直接发送，图片/语音/视频/文件→直接发送
                  for (const item of sendQueue) {
                    // 流式已失败，停止后续所有发送
                    if (isStreaming && streamFailed) {
                      log?.info(`[qqbot:${account.accountId}] Stream failed, skipping remaining ${sendQueue.indexOf(item) + 1}/${sendQueue.length} items`);
                      break;
                    }

                    if (item.type === "text") {
                      if (isStreaming) {
                        await streamSendTextOrFallback(item.content);
                      } else {
                        try {
                          await sendTextMessage(item.content);
                          log?.info(`[qqbot:${account.accountId}] Sent text: ${item.content.slice(0, 50)}...`);
                        } catch (err) {
                          log?.error(`[qqbot:${account.accountId}] Failed to send text: ${err}`);
                        }
                      }
                    } else if (item.type === "image") {
                      const imagePath = normalizePath(item.content);
                      const isHttpUrl = imagePath.startsWith("http://") || imagePath.startsWith("https://");
                      const isLocalPath = isLocalFilePath(imagePath);
                      
                      if (isStreaming && isHttpUrl) {
                        // 流式 + 公网 URL → markdown 图片格式嵌入流式（不中断）
                        try {
                          const size = await getImageSize(imagePath);
                          const mdImage = formatQQBotMarkdownImage(imagePath, size);
                          debugLog?.(`[qqbot:${account.accountId}] Embedding HTTP image as markdown in stream: ${size ? `${size.width}x${size.height}` : 'default'}`);
                          await streamSendTextOrFallback("\n" + mdImage + "\n");
                        } catch (err) {
                          log?.info(`[qqbot:${account.accountId}] Failed to get image size, using default: ${err}`);
                          const mdImage = formatQQBotMarkdownImage(imagePath, null);
                          await streamSendTextOrFallback("\n" + mdImage + "\n");
                        }
                      } else if (isStreaming && isLocalPath) {
                        // 流式 + 本地图片 → 中断流式 → 富媒体 API → 重建
                        await interruptStream();
                        await sendMediaByType("image", item.content);
                        rebuildStream();
                      } else if (!isStreaming) {
                        // 非流式模式：直接发送图片
                        if (isLocalPath) {
                          // 大文件进度提示
                          const imgSizeCheck = checkFileSize(imagePath);
                          if (imgSizeCheck.ok && isLargeFile(imgSizeCheck.size)) {
                            try {
                              await sendTextMessage(`⏳ 正在上传图片 (${formatFileSize(imgSizeCheck.size)})...`);
                            } catch {}
                          }
                        } else if (!isHttpUrl) {
                          log?.error(`[qqbot:${account.accountId}] Invalid image path (not local or URL): ${imagePath}`);
                          continue;
                        }
                        await sendMediaByType("image", item.content);
                      } else {
                        log?.error(`[qqbot:${account.accountId}] Invalid image path (not local or URL): ${imagePath}`);
                      }
                    } else if (item.type === "voice" || item.type === "video" || item.type === "file") {
                      // 语音/视频/文件：流式模式下需中断→发送→重建
                      if (isStreaming) {
                        await interruptStream();
                      }
                      // 非流式模式下，本地大文件进度提示
                      if (!isStreaming) {
                        const mediaPath = normalizePath(item.content);
                        const isMediaHttp = mediaPath.startsWith("http://") || mediaPath.startsWith("https://");
                        if (!isMediaHttp) {
                          const sizeCheck = checkFileSize(mediaPath);
                          if (sizeCheck.ok && isLargeFile(sizeCheck.size)) {
                            const label = item.type === "video" ? "视频" : item.type === "file" ? `文件 ${sanitizeFileName(path.basename(mediaPath))}` : "语音";
                            try {
                              await sendTextMessage(`⏳ 正在上传${label} (${formatFileSize(sizeCheck.size)})...`);
                            } catch {}
                          }
                        }
                      }
                      await sendMediaByType(item.type, item.content);
                      if (isStreaming) {
                        rebuildStream();
                      }
                    }
                  }
                  
                  // 记录活动并返回
                  pluginRuntime.channel.activity.record({
                    channel: "qqbot",
                    accountId: account.accountId,
                    direction: "outbound",
                  });
                  return;
                }
                
                // ============ 结构化载荷检测与分发 ============
                // 优先检测 QQBOT_PAYLOAD: 前缀，如果是结构化载荷则分发到对应处理器
                if (parseQQBotPayload(replyText).isPayload) {
                  await executePayload(replyText);
                  pluginRuntime.channel.activity.record({
                    channel: "qqbot",
                    accountId: account.accountId,
                    direction: "outbound",
                  });
                  return;
                }
                
                // ============ 非结构化消息：简化处理 ============
                // 📝 设计原则：JSON payload (QQBOT_PAYLOAD) 是发送本地图片的唯一方式
                // 非结构化消息只处理：公网 URL (http/https) 和 Base64 Data URL
                const imageUrls: string[] = [];
                
                /**
                 * 检查并收集图片 URL（仅支持公网 URL 和 Base64 Data URL）
                 * ⚠️ 本地文件路径必须使用 QQBOT_PAYLOAD JSON 格式发送
                 */
                const collectImageUrl = (url: string | undefined | null): boolean => {
                  if (!url) return false;
                  
                  const isHttpUrl = url.startsWith("http://") || url.startsWith("https://");
                  const isDataUrl = url.startsWith("data:image/");
                  
                  if (isHttpUrl || isDataUrl) {
                    if (!imageUrls.includes(url)) {
                      imageUrls.push(url);
                      if (isDataUrl) {
                        log?.info(`[qqbot:${account.accountId}] Collected Base64 image (length: ${url.length})`);
                      } else {
                        log?.info(`[qqbot:${account.accountId}] Collected media URL: ${url.slice(0, 80)}...`);
                      }
                    }
                    return true;
                  }
                  
                  // ⚠️ 本地文件路径不再在此处处理，应使用对应的 <qqXXX> 标签
                  if (isLocalFilePath(url)) {
                    logLocalPathHint(url);
                  }
                  return false;
                };
                
                // 处理 mediaUrls 和 mediaUrl 字段
                if (payload.mediaUrls?.length) {
                  for (const url of payload.mediaUrls) {
                    collectImageUrl(url);
                  }
                }
                if (payload.mediaUrl) {
                  collectImageUrl(payload.mediaUrl);
                }
                
                // 提取文本中的图片格式（仅处理公网 URL）
                // 📝 设计：本地路径必须使用 QQBOT_PAYLOAD JSON 格式发送
                const mdImageRegex = /!\[([^\]]*)\]\(([^)]+)\)/gi;
                const mdMatches = [...replyText.matchAll(mdImageRegex)];
                for (const match of mdMatches) {
                  const url = match[2]?.trim();
                  if (url && !imageUrls.includes(url)) {
                    if (url.startsWith('http://') || url.startsWith('https://')) {
                      // 公网 URL：收集并处理
                      imageUrls.push(url);
                      log?.info(`[qqbot:${account.accountId}] Extracted HTTP image from markdown: ${url.slice(0, 80)}...`);
                    } else if (looksLikeLocalPath(url)) {
                      // 本地路径：根据文件类型给出正确的标签提示
                      logLocalPathHint(url);
                    }
                  }
                }
                
                // 提取裸 URL 图片（公网 URL）
                const bareUrlRegex = /(?<![(\["'])(https?:\/\/[^\s)"'<>]+\.(?:png|jpg|jpeg|gif|webp)(?:\?[^\s"'<>]*)?)/gi;
                const bareUrlMatches = [...replyText.matchAll(bareUrlRegex)];
                for (const match of bareUrlMatches) {
                  const url = match[1];
                  if (url && !imageUrls.includes(url)) {
                    imageUrls.push(url);
                    log?.info(`[qqbot:${account.accountId}] Extracted bare image URL: ${url.slice(0, 80)}...`);
                  }
                }
                
                // 判断是否使用 markdown 模式
                // 流式模式下强制启用 markdown，因为图片可以通过 markdown 格式嵌入流式消息
                const useMarkdown = account.markdownSupport === true || supportsStream;
                log?.info(`[qqbot:${account.accountId}] Markdown mode: ${useMarkdown}, images: ${imageUrls.length}`);
                
                let textWithoutImages = replyText;
                
                // 🎯 过滤内部标记（如 [[reply_to: xxx]]）
                // 这些标记可能被 AI 错误地学习并输出
                textWithoutImages = filterInternalMarkers(textWithoutImages);
                
                // 根据模式处理图片
                if (useMarkdown) {
                  // ============ Markdown 模式 ============
                  // 🎯 关键改动：区分公网 URL 和本地文件/Base64
                  // - 公网 URL (http/https) → 使用 Markdown 图片格式 ![#宽px #高px](url)
                  // - 本地文件/Base64 (data:image/...) → 使用富媒体 API 发送
                  
                  // 分离图片：公网 URL vs Base64/本地文件
                  const httpImageUrls: string[] = [];      // 公网 URL，用于 Markdown 嵌入
                  const base64ImageUrls: string[] = [];    // Base64，用于富媒体 API
                  
                  for (const url of imageUrls) {
                    if (url.startsWith("data:image/")) {
                      base64ImageUrls.push(url);
                    } else if (url.startsWith("http://") || url.startsWith("https://")) {
                      httpImageUrls.push(url);
                    }
                  }
                  
                  log?.info(`[qqbot:${account.accountId}] Image classification: httpUrls=${httpImageUrls.length}, base64=${base64ImageUrls.length}`);
                  
                  // 🔹 第一步：通过富媒体 API 发送 Base64 图片（本地文件已转换为 Base64）
                  if (base64ImageUrls.length > 0) {
                    log?.info(`[qqbot:${account.accountId}] Sending ${base64ImageUrls.length} image(s) via Rich Media API...`);
                    for (const imageUrl of base64ImageUrls) {
                      try {
                        await sendImageMessage(imageUrl);
                        log?.info(`[qqbot:${account.accountId}] Sent Base64 image via Rich Media API (size: ${imageUrl.length} chars)`);
                      } catch (imgErr) {
                        log?.error(`[qqbot:${account.accountId}] Failed to send Base64 image via Rich Media API: ${imgErr}`);
                      }
                    }
                  }
                  
                  // 🔹 第二步：处理文本和公网 URL 图片
                  // 记录已存在于文本中的 markdown 图片 URL
                  const existingMdUrls = new Set(mdMatches.map(m => m[2]));
                  
                  // 需要追加的公网图片（从 mediaUrl/mediaUrls 来的，且不在文本中）
                  const imagesToAppend: string[] = [];
                  
                  // 处理需要追加的公网 URL 图片：获取尺寸并格式化
                  for (const url of httpImageUrls) {
                    if (!existingMdUrls.has(url)) {
                      // 这个 URL 不在文本的 markdown 格式中，需要追加
                      try {
                        const size = await getImageSize(url);
                        const mdImage = formatQQBotMarkdownImage(url, size);
                        imagesToAppend.push(mdImage);
                        log?.info(`[qqbot:${account.accountId}] Formatted HTTP image: ${size ? `${size.width}x${size.height}` : 'default size'} - ${url.slice(0, 60)}...`);
                      } catch (err) {
                        log?.info(`[qqbot:${account.accountId}] Failed to get image size, using default: ${err}`);
                        const mdImage = formatQQBotMarkdownImage(url, null);
                        imagesToAppend.push(mdImage);
                      }
                    }
                  }
                  
                  // 处理文本中已有的 markdown 图片：补充公网 URL 的尺寸信息
                  // 📝 本地路径不再特殊处理（保留在文本中），因为不通过非结构化消息发送
                  for (const match of mdMatches) {
                    const fullMatch = match[0];  // ![alt](url)
                    const imgUrl = match[2];      // url 部分
                    
                    // 只处理公网 URL，补充尺寸信息
                    const isHttpUrl = imgUrl.startsWith('http://') || imgUrl.startsWith('https://');
                    if (isHttpUrl && !hasQQBotImageSize(fullMatch)) {
                      try {
                        const size = await getImageSize(imgUrl);
                        const newMdImage = formatQQBotMarkdownImage(imgUrl, size);
                        textWithoutImages = textWithoutImages.replace(fullMatch, newMdImage);
                        log?.info(`[qqbot:${account.accountId}] Updated image with size: ${size ? `${size.width}x${size.height}` : 'default'} - ${imgUrl.slice(0, 60)}...`);
                      } catch (err) {
                        log?.info(`[qqbot:${account.accountId}] Failed to get image size for existing md, using default: ${err}`);
                        const newMdImage = formatQQBotMarkdownImage(imgUrl, null);
                        textWithoutImages = textWithoutImages.replace(fullMatch, newMdImage);
                      }
                    }
                  }
                  
                  // 从文本中移除裸 URL 图片（已转换为 markdown 格式）
                  for (const match of bareUrlMatches) {
                    textWithoutImages = textWithoutImages.replace(match[0], "").trim();
                  }
                  
                  // 追加需要添加的公网图片到文本末尾
                  if (imagesToAppend.length > 0) {
                    textWithoutImages = textWithoutImages.trim();
                    if (textWithoutImages) {
                      textWithoutImages += "\n\n" + imagesToAppend.join("\n");
                    } else {
                      textWithoutImages = imagesToAppend.join("\n");
                    }
                  }
                  
                  // 🔹 第三步：发送带公网图片的 markdown 消息
                  if (textWithoutImages.trim()) {
                    try {
                      await streamSendTextOrFallback(textWithoutImages);
                    } catch (err) {
                      log?.error(`[qqbot:${account.accountId}] Failed to send markdown message: ${err}`);
                    }
                  }
                } else {
                  // ============ 普通文本模式：使用富媒体 API 发送图片 ============
                  // 从文本中移除所有图片相关内容
                  for (const match of mdMatches) {
                    textWithoutImages = textWithoutImages.replace(match[0], "").trim();
                  }
                  for (const match of bareUrlMatches) {
                    textWithoutImages = textWithoutImages.replace(match[0], "").trim();
                  }
                  
                  // 处理文本中的 URL 点号（防止被 QQ 解析为链接），仅群聊时过滤，C2C 不过滤
                  if (textWithoutImages && event.type !== "c2c") {
                    textWithoutImages = textWithoutImages.replace(/([a-zA-Z0-9])\.([a-zA-Z0-9])/g, "$1_$2");
                  }
                  
                  try {
                    // 发送图片（通过富媒体 API）
                    for (const imageUrl of imageUrls) {
                      try {
                        await sendImageMessage(imageUrl, imageUrl);
                        log?.info(`[qqbot:${account.accountId}] Sent image via media API: ${imageUrl.slice(0, 80)}...`);
                      } catch (imgErr) {
                        log?.error(`[qqbot:${account.accountId}] Failed to send image: ${imgErr}`);
                      }
                    }

                    // 发送文本消息
                    if (textWithoutImages.trim()) {
                      try {
                        await streamSendTextOrFallback(textWithoutImages);
                      } catch (err) {
                        log?.error(`[qqbot:${account.accountId}] Failed to send text: ${err}`);
                      }
                    }
                  } catch (err) {
                    log?.error(`[qqbot:${account.accountId}] Send failed: ${err}`);
                  }
                }

                pluginRuntime.channel.activity.record({
                  channel: "qqbot",
                  accountId: account.accountId,
                  direction: "outbound",
                });
              },
              onError: async (err: unknown) => {
                log?.error(`[qqbot:${account.accountId}] Dispatch error: ${err}`);
                hasResponse = true;
                if (timeoutId) {
                  clearTimeout(timeoutId);
                  timeoutId = null;
                }
                
                // 清理心跳定时器
                clearKeepalive();
                
                // 如果在流式模式中出错，发送结束标记
                if (streamSender && !streamEnded && streamStarted) {
                  try {
                    // 安全刷新缓冲区（处理完整/不完整媒体标签）
                    const pendingMedia = await flushStreamBufferSafe();
                    await streamSender.end("\n\n[生成中断]");
                    streamEnded = true;
                    // 发送提取出的媒体（在流式结束后）
                    for (const media of pendingMedia) {
                      await sendMediaByType(media.type, media.path);
                    }
                    log?.info(`[qqbot:${account.accountId}] Stream ended due to error`);
                  } catch (endErr) {
                    log?.error(`[qqbot:${account.accountId}] Failed to end stream: ${endErr}`);
                  }
                }
                
                // 发送错误提示给用户，显示完整错误信息
                const errMsg = String(err);
                if (errMsg.includes("401") || errMsg.includes("key") || errMsg.includes("auth")) {
                  await sendErrorMessage("⚠️ AI 服务认证失败，API Key 可能无效，请联系管理员检查配置。");
                } else {
                  await sendErrorMessage(`⚠️ AI 处理出错: ${errMsg.slice(0, 500)}`);
                }
              },
            },
            replyOptions: {
              // ============ 流式配置 ============
              //
              // C2C（streamSupport=true）：
              //   disableBlockStreaming=true
              //   onPartialReply=handlePartialReply → token 级实时流式发送 + 富媒体标签处理
              //   deliver 流式已启动时跳过（payload 在流式结束阶段处理），未启动时放行（如 /commands 指令）
              // 非 C2C（群聊/频道）或 C2C（streamSupport=false）：
              //   走框架 block streaming pipeline，由 coalesce 配置控制合并
              //
              disableBlockStreaming: supportsStream,
              // 流式模式使用 onPartialReply 实现 token 级实时发送
              onPartialReply: handlePartialReply,
              // 多消息边界回调：当新的 assistant 消息开始时，结束上一个流式会话并开始新的
              // ⚠️ 必须获取 sendingLock，防止与 handlePartialReply/keepalive 竞态
              onAssistantMessageStart: supportsStream ? async () => {
                if (streamStarted && !streamEnded && streamSender) {
                  const ctx = streamSender.getContext();
                  log?.info(`[qqbot:${account.accountId}] 🔀 onAssistantMessageStart: ending current stream for new message, sender=${streamSender.instanceId}, streamId=${ctx.streamId}, index=${ctx.index}`);
                  while (sendingLock) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                  }
                  sendingLock = true;
                  try {
                    // 二次检查：拿到锁后状态可能已被其他异步流改变
                    if (streamEnded) {
                      log?.info(`[qqbot:${account.accountId}] 🔀 onAssistantMessageStart: stream already ended by another async flow, sender=${streamSender.instanceId}`);
                      rebuildStream();
                      partialReplySentLength = 0;
                      pendingPayloadText = "";
                      return;
                    }
                    // 安全刷新缓冲区（处理完整/不完整媒体标签）
                    const pendingMedia = await flushStreamBufferSafe();
                    await streamSender.end("");
                    streamEnded = true;
                    clearKeepalive();
                    // 发送提取出的媒体（在流式结束后）
                    for (const media of pendingMedia) {
                      await sendMediaByType(media.type, media.path);
                    }
                    // 重置 partialReplySentLength，新消息的 onPartialReply 累积文本从零开始
                    partialReplySentLength = 0;
                    pendingPayloadText = ""; // 重置 payload 暂存
                    log?.info(`[qqbot:${account.accountId}] 🔀 onAssistantMessageStart: previous stream ended, sender=${streamSender.instanceId}, streamId=${streamSender.getContext().streamId}, rebuilding`);
                    // 重建 stream sender，让后续 handlePartialReply 能继续工作
                    // 如果不重建，streamEnded=true 会导致新消息的 handlePartialReply 直接跳过
                    // 同时 deliver 也会因为 supportsStream && streamSender && !streamFailed 为 true 而跳过
                    rebuildStream();
                  } catch (err) {
                    log?.error(`[qqbot:${account.accountId}] Failed to end stream on message boundary: ${err}`);
                  } finally {
                    sendingLock = false;
                  }
                }
              } : undefined,
              onReasoningEnd: supportsStream ? async () => {
                // Reasoning 结束后，开始正式回复，在 thinking 完成后标记边界
                log?.debug?.(`[qqbot:${account.accountId}] onReasoningEnd: reasoning phase complete`);
              } : undefined,
            },
          });

          // 等待分发完成或超时
          try {
            await Promise.race([dispatchPromise, timeoutPromise]);
            
            // 清理心跳定时器
            clearKeepalive();

            // ============ 等待后台 handlePartialReply 完成 ============
            // onPartialReply 是 fire-and-forget（void 调用），dispatch 完成时可能还有
            // handlePartialReply 在后台执行（如富媒体发送等耗时操作）。
            // 等待 sendingLock 释放以确保后台操作完成
            if (sendingLock) {
              log?.info(`[qqbot:${account.accountId}] Waiting for sendingLock to release...`);
              const waitStart = Date.now();
              const LOCK_WAIT_TIMEOUT = 30000; // 最多等 30 秒
              while (sendingLock && Date.now() - waitStart < LOCK_WAIT_TIMEOUT) {
                await new Promise(resolve => setTimeout(resolve, 100));
              }
              if (sendingLock) {
                log?.error(`[qqbot:${account.accountId}] ⚠️ Timed out waiting for sendingLock, proceeding with stream end`);
              } else {
                log?.info(`[qqbot:${account.accountId}] sendingLock released (${Date.now() - waitStart}ms)`);
              }
            }
            
            // ============ 流式结束：处理暂存的 QQBOT_PAYLOAD ============
            // 如果 onPartialReply 检测到 QQBOT_PAYLOAD 前缀并暂存了全文，在此统一处理
            // payload block 不会写入 streamBuffer 也不会启动流式，所以需要独立处理
            if (pendingPayloadText && supportsStream && streamSender) {
              log?.info(`[qqbot:${account.accountId}] Processing pending payload (${pendingPayloadText.length} chars)`);
              
              // 先结束当前流式（如果已启动或 buffer 有剩余内容）
              if ((streamStarted || streamBuffer) && !streamEnded) {
                const ctx = streamSender.getContext();
                log?.info(`[qqbot:${account.accountId}] 🏁 Ending stream for pending payload: sender=${streamSender.instanceId}, streamId=${ctx.streamId}, index=${ctx.index}`);
                // 安全刷新缓冲区（处理完整/不完整媒体标签）
                const pendingMedia = await flushStreamBufferSafe();
                await streamSender.end("");
                streamEnded = true;
                log?.info(`[qqbot:${account.accountId}] 🏁 Stream ended for payload: sender=${streamSender.instanceId}, streamId=${ctx.streamId}`);
                // 发送提取出的媒体
                for (const media of pendingMedia) {
                  await sendMediaByType(media.type, media.path);
                }
              }
              
              // 处理暂存的 payload（调用公共函数）
              await executePayload(pendingPayloadText);
              pendingPayloadText = ""; // 清空暂存
              
              pluginRuntime.channel.activity.record({
                channel: "qqbot",
                accountId: account.accountId,
                direction: "outbound",
              });
            }
            
            // 分发完成后，如果使用了流式且有内容，发送结束标记
            // 注意：streamStarted 仅在实际发送过 chunk 后才为 true
            // 但 buffer 中可能有未达到 STREAM_MIN_FLUSH_CHARS 阈值的内容尚未发送
            // 此时 streamStarted=false 但 buffer 非空，也需要 flush + 发送停止分片
            if (streamSender && !streamEnded && (streamStarted || streamBuffer)) {
              const ctx = streamSender.getContext();
              log?.info(`[qqbot:${account.accountId}] 🏁 Ending stream (dispatch complete): sender=${streamSender.instanceId}, streamId=${ctx.streamId}, index=${ctx.index}, bufferLen=${streamBuffer.length}, streamStarted=${streamStarted}`);
              // 安全刷新缓冲区（处理完整/不完整媒体标签）
              const pendingMedia = await flushStreamBufferSafe();
              const endResult = await streamSender.end("");
              if (endResult.error) {
                log?.error(`[qqbot:${account.accountId}] ❌ Stream end failed: sender=${streamSender.instanceId}, streamId=${ctx.streamId}, error=${endResult.error}`);
              }
              streamEnded = true;
              // 发送提取出的媒体（在流式结束后）
              for (const media of pendingMedia) {
                await sendMediaByType(media.type, media.path);
              }
              log?.info(`[qqbot:${account.accountId}] ✅ Stream completed: sender=${streamSender.instanceId}, streamId=${ctx.streamId}, totalChunks=${streamSender.getContext().index}`);
            } else if (streamSender && !streamEnded) {
              log?.info(`[qqbot:${account.accountId}] Stream not ended: sender=${streamSender.instanceId}, streamStarted=${streamStarted}, streamFailed=${streamFailed}, buffer=${JSON.stringify(streamBuffer)}`);
            }
          } catch (err) {
            clearKeepalive();
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
            // 等待后台 handlePartialReply 完成（超时场景同样需要）
            if (sendingLock) {
              log?.info(`[qqbot:${account.accountId}] [timeout] Waiting for sendingLock to release...`);
              const waitStart = Date.now();
              while (sendingLock && Date.now() - waitStart < 10000) { // 超时场景等待更短（10s）
                await new Promise(resolve => setTimeout(resolve, 100));
              }
              if (sendingLock) {
                log?.error(`[qqbot:${account.accountId}] ⚠️ [timeout] Gave up waiting for sendingLock`);
              }
            }
            // 流式结束处理（超时场景）
            // 同正常完成场景：streamStarted=false 但 buffer 非空时也需要处理
            if (streamSender && !streamEnded && (streamStarted || streamBuffer)) {
              try {
                const ctx = streamSender.getContext();
                log?.error(`[qqbot:${account.accountId}] ⏰ Ending stream due to timeout: sender=${streamSender.instanceId}, streamId=${ctx.streamId}, index=${ctx.index}, bufferLen=${streamBuffer.length}, streamStarted=${streamStarted}`);
                // 安全刷新缓冲区（处理完整/不完整媒体标签）
                const pendingMedia = await flushStreamBufferSafe();
                await streamSender.end("\n\n[超时]");
                streamEnded = true;
                log?.info(`[qqbot:${account.accountId}] ⏰ Stream ended due to timeout: sender=${streamSender.instanceId}, streamId=${ctx.streamId}`);
                // 发送提取出的媒体（在流式结束后）
                for (const media of pendingMedia) {
                  await sendMediaByType(media.type, media.path);
                }
              } catch (endErr) {
                log?.error(`[qqbot:${account.accountId}] ❌ Failed to end stream on timeout: sender=${streamSender.instanceId}, error=${endErr}`);
              }
            }
            if (!hasResponse) {
              log?.error(`[qqbot:${account.accountId}] No response within timeout`);
              await sendErrorMessage("⏳ 已收到，正在处理中…");
            }
          } finally {
            // 清理 tool-only 兜底定时器
            if (toolOnlyTimeoutId) {
              clearTimeout(toolOnlyTimeoutId);
              toolOnlyTimeoutId = null;
            }
            // dispatch 完成后，如果只有 tool 没有 block，且尚未发过兜底，立即兜底
            if (toolDeliverCount > 0 && !hasBlockResponse && !toolFallbackSent) {
              toolFallbackSent = true;
              log?.error(`[qqbot:${account.accountId}] Dispatch completed with ${toolDeliverCount} tool deliver(s) but no block deliver, sending fallback`);
              const fallback = formatToolFallback();
              await sendErrorMessage(fallback);
            }
          }
        } catch (err) {
          log?.error(`[qqbot:${account.accountId}] Message processing failed: ${err}`);
          await sendErrorMessage(`⚠️ 消息处理失败: ${String(err).slice(0, 500)}`);
        }
      };

      ws.on("open", () => {
        log?.info(`[qqbot:${account.accountId}] WebSocket connected`);
        isConnecting = false; // 连接完成，释放锁
        reconnectAttempts = 0; // 连接成功，重置重试计数
        lastConnectTime = Date.now(); // 记录连接时间
        // 启动消息处理器（异步处理，防止阻塞心跳）
        startMessageProcessor(handleMessage);
        // P1-1: 启动后台 Token 刷新
        startBackgroundTokenRefresh(account.appId, account.clientSecret, {
          log: log as { info: (msg: string) => void; error: (msg: string) => void; debug?: (msg: string) => void },
        });
      });

      ws.on("message", async (data) => {
        try {
          const rawData = data.toString();
          const payload = JSON.parse(rawData) as WSPayload;
          const { op, d, s, t } = payload;

          // 打印收到的所有 WebSocket 消息（JSON 格式化）
          log?.info(`[qqbot:${account.accountId}] <<< WS received: ${JSON.stringify(payload, null, 2)}`);

          if (s) {
            lastSeq = s;
            // P1-2: 更新持久化存储中的 lastSeq（节流保存）
            if (sessionId) {
              saveSession({
                sessionId,
                lastSeq,
                lastConnectedAt: lastConnectTime,
                intentLevelIndex: lastSuccessfulIntentLevel >= 0 ? lastSuccessfulIntentLevel : intentLevelIndex,
                accountId: account.accountId,
                savedAt: Date.now(),
                appId: account.appId,
              });
            }
          }

          log?.debug?.(`[qqbot:${account.accountId}] Received op=${op} t=${t}`);

          switch (op) {
            case 10: // Hello
              log?.info(`[qqbot:${account.accountId}] Hello received`);
              
              // 如果有 session_id，尝试 Resume
              if (sessionId && lastSeq !== null) {
                log?.info(`[qqbot:${account.accountId}] Attempting to resume session ${sessionId}`);
                ws.send(JSON.stringify({
                  op: 6, // Resume
                  d: {
                    token: `QQBot ${accessToken}`,
                    session_id: sessionId,
                    seq: lastSeq,
                  },
                }));
              } else {
                // 新连接，发送 Identify
                // 如果有上次成功的级别，直接使用；否则从当前级别开始尝试
                const levelToUse = lastSuccessfulIntentLevel >= 0 ? lastSuccessfulIntentLevel : intentLevelIndex;
                const intentLevel = INTENT_LEVELS[Math.min(levelToUse, INTENT_LEVELS.length - 1)];
                log?.info(`[qqbot:${account.accountId}] Sending identify with intents: ${intentLevel.intents} (${intentLevel.description})`);
                ws.send(JSON.stringify({
                  op: 2,
                  d: {
                    token: `QQBot ${accessToken}`,
                    intents: intentLevel.intents,
                    shard: [0, 1],
                  },
                }));
              }

              // 启动心跳
              const interval = (d as { heartbeat_interval: number }).heartbeat_interval;
              if (heartbeatInterval) clearInterval(heartbeatInterval);
              heartbeatInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ op: 1, d: lastSeq }));
                  log?.debug?.(`[qqbot:${account.accountId}] Heartbeat sent`);
                }
              }, interval);
              break;

            case 0: // Dispatch
              if (t === "READY") {
                const readyData = d as { session_id: string };
                sessionId = readyData.session_id;
                // 记录成功的权限级别
                lastSuccessfulIntentLevel = intentLevelIndex;
                const successLevel = INTENT_LEVELS[intentLevelIndex];
                log?.info(`[qqbot:${account.accountId}] Ready with ${successLevel.description}, session: ${sessionId}`);
                // P1-2: 保存新的 Session 状态
                saveSession({
                  sessionId,
                  lastSeq,
                  lastConnectedAt: Date.now(),
                  intentLevelIndex,
                  accountId: account.accountId,
                  savedAt: Date.now(),
                  appId: account.appId,
                });
                onReady?.(d);
              } else if (t === "RESUMED") {
                log?.info(`[qqbot:${account.accountId}] Session resumed`);
                // P1-2: 更新 Session 连接时间
                if (sessionId) {
                  saveSession({
                    sessionId,
                    lastSeq,
                    lastConnectedAt: Date.now(),
                    intentLevelIndex: lastSuccessfulIntentLevel >= 0 ? lastSuccessfulIntentLevel : intentLevelIndex,
                    accountId: account.accountId,
                    savedAt: Date.now(),
                    appId: account.appId,
                  });
                }
              } else if (t === "C2C_MESSAGE_CREATE") {
                const event = d as C2CMessageEvent;
                // P1-3: 记录已知用户
                recordKnownUser({
                  openid: event.author.user_openid,
                  type: MSG_TYPE_C2C,
                  accountId: account.accountId,
                });
                // 使用消息队列异步处理，防止阻塞心跳
                enqueueMessage({
                  type: MSG_TYPE_C2C,
                  senderId: event.author.user_openid,
                  content: event.content,
                  messageId: event.id,
                  timestamp: event.timestamp,
                  attachments: event.attachments,
                });
              } else if (t === "AT_MESSAGE_CREATE") {
                const event = d as GuildMessageEvent;
                // P1-3: 记录已知用户（频道用户）
                recordKnownUser({
                  openid: event.author.id,
                  type: MSG_TYPE_C2C, // 频道用户按 c2c 类型存储
                  nickname: event.author.username,
                  accountId: account.accountId,
                });
                enqueueMessage({
                  type: MSG_TYPE_GUILD,
                  senderId: event.author.id,
                  senderName: event.author.username,
                  content: event.content,
                  messageId: event.id,
                  timestamp: event.timestamp,
                  channelId: event.channel_id,
                  guildId: event.guild_id,
                  attachments: event.attachments,
                });
              } else if (t === "DIRECT_MESSAGE_CREATE") {
                const event = d as GuildMessageEvent;
                // P1-3: 记录已知用户（频道私信用户）
                recordKnownUser({
                  openid: event.author.id,
                  type: MSG_TYPE_C2C,
                  nickname: event.author.username,
                  accountId: account.accountId,
                });
                enqueueMessage({
                  type: MSG_TYPE_DM,
                  senderId: event.author.id,
                  senderName: event.author.username,
                  content: event.content,
                  messageId: event.id,
                  timestamp: event.timestamp,
                  channelId: event.channel_id,
                  guildId: event.guild_id,
                  attachments: event.attachments,
                });
              } else if (t === "GROUP_AT_MESSAGE_CREATE") {
                const event = d as GroupMessageEvent;
                // P1-3: 记录已知用户（群组用户）
                recordKnownUser({
                  openid: event.author.member_openid,
                  type: MSG_TYPE_GROUP,
                  groupOpenid: event.group_openid,
                  accountId: account.accountId,
                });
                enqueueMessage({
                  type: MSG_TYPE_GROUP,
                  senderId: event.author.member_openid,
                  content: event.content,
                  messageId: event.id,
                  timestamp: event.timestamp,
                  groupOpenid: event.group_openid,
                  attachments: event.attachments,
                });
              }
              break;

            case 11: // Heartbeat ACK
              log?.debug?.(`[qqbot:${account.accountId}] Heartbeat ACK`);
              break;

            case 7: // Reconnect
              log?.info(`[qqbot:${account.accountId}] Server requested reconnect`);
              cleanup();
              scheduleReconnect();
              break;

            case 9: // Invalid Session
              const canResume = d as boolean;
              const currentLevel = INTENT_LEVELS[intentLevelIndex];
              log?.error(`[qqbot:${account.accountId}] Invalid session (${currentLevel.description}), can resume: ${canResume}, raw: ${rawData}`);
              
              if (!canResume) {
                sessionId = null;
                lastSeq = null;
                // P1-2: 清除持久化的 Session
                clearSession(account.accountId);
                
                // 尝试降级到下一个权限级别
                if (intentLevelIndex < INTENT_LEVELS.length - 1) {
                  intentLevelIndex++;
                  const nextLevel = INTENT_LEVELS[intentLevelIndex];
                  log?.info(`[qqbot:${account.accountId}] Downgrading intents to: ${nextLevel.description}`);
                } else {
                  // 已经是最低权限级别了
                  log?.error(`[qqbot:${account.accountId}] All intent levels failed. Please check AppID/Secret.`);
                  shouldRefreshToken = true;
                }
              }
              cleanup();
              // Invalid Session 后等待一段时间再重连
              scheduleReconnect(3000);
              break;
          }
        } catch (err) {
          log?.error(`[qqbot:${account.accountId}] Message parse error: ${err}`);
        }
      });

      ws.on("close", (code, reason) => {
        log?.info(`[qqbot:${account.accountId}] WebSocket closed: ${code} ${reason.toString()}`);
        isConnecting = false; // 释放锁
        
        // 根据错误码处理（参考 QQ 官方文档）
        // 4004: CODE_INVALID_TOKEN - Token 无效，需刷新 token 重新连接
        // 4006: CODE_SESSION_NO_LONGER_VALID - 会话失效，需重新 identify
        // 4007: CODE_INVALID_SEQ - Resume 时 seq 无效，需重新 identify
        // 4008: CODE_RATE_LIMITED - 限流断开，等待后重连
        // 4009: CODE_SESSION_TIMED_OUT - 会话超时，需重新 identify
        // 4900-4913: 内部错误，需要重新 identify
        // 4914: 机器人已下架
        // 4915: 机器人已封禁
        if (code === 4914 || code === 4915) {
          log?.error(`[qqbot:${account.accountId}] Bot is ${code === 4914 ? "offline/sandbox-only" : "banned"}. Please contact QQ platform.`);
          cleanup();
          // 不重连，直接退出
          return;
        }
        
        // 4004: Token 无效，强制刷新 token 后重连
        if (code === 4004) {
          log?.info(`[qqbot:${account.accountId}] Invalid token (4004), will refresh token and reconnect`);
          shouldRefreshToken = true;
          cleanup();
          if (!isAborted) {
            scheduleReconnect();
          }
          return;
        }
        
        // 4008: 限流断开，等待后重连（不需要重新 identify）
        if (code === 4008) {
          log?.info(`[qqbot:${account.accountId}] Rate limited (4008), waiting ${RATE_LIMIT_DELAY}ms before reconnect`);
          cleanup();
          if (!isAborted) {
            scheduleReconnect(RATE_LIMIT_DELAY);
          }
          return;
        }
        
        // 4006/4007/4009: 会话失效或超时，需要清除 session 重新 identify
        if (code === 4006 || code === 4007 || code === 4009) {
          const codeDesc: Record<number, string> = {
            4006: "session no longer valid",
            4007: "invalid seq on resume",
            4009: "session timed out",
          };
          log?.info(`[qqbot:${account.accountId}] Error ${code} (${codeDesc[code]}), will re-identify`);
          sessionId = null;
          lastSeq = null;
          // 清除持久化的 Session
          clearSession(account.accountId);
          shouldRefreshToken = true;
        } else if (code >= 4900 && code <= 4913) {
          // 4900-4913 内部错误，清除 session 重新 identify
          log?.info(`[qqbot:${account.accountId}] Internal error (${code}), will re-identify`);
          sessionId = null;
          lastSeq = null;
          // 清除持久化的 Session
          clearSession(account.accountId);
          shouldRefreshToken = true;
        }
        
        // 检测是否是快速断开（连接后很快就断了）
        const connectionDuration = Date.now() - lastConnectTime;
        if (connectionDuration < QUICK_DISCONNECT_THRESHOLD && lastConnectTime > 0) {
          quickDisconnectCount++;
          log?.info(`[qqbot:${account.accountId}] Quick disconnect detected (${connectionDuration}ms), count: ${quickDisconnectCount}`);
          
          // 如果连续快速断开超过阈值，等待更长时间
          if (quickDisconnectCount >= MAX_QUICK_DISCONNECT_COUNT) {
            log?.error(`[qqbot:${account.accountId}] Too many quick disconnects. This may indicate a permission issue.`);
            log?.error(`[qqbot:${account.accountId}] Please check: 1) AppID/Secret correct 2) Bot permissions on QQ Open Platform`);
            quickDisconnectCount = 0;
            cleanup();
            // 快速断开太多次，等待更长时间再重连
            if (!isAborted && code !== 1000) {
              scheduleReconnect(RATE_LIMIT_DELAY);
            }
            return;
          }
        } else {
          // 连接持续时间够长，重置计数
          quickDisconnectCount = 0;
        }
        
        cleanup();
        
        // 非正常关闭则重连
        if (!isAborted && code !== 1000) {
          scheduleReconnect();
        }
      });

      ws.on("error", (err) => {
        log?.error(`[qqbot:${account.accountId}] WebSocket error: ${err.message}`);
        onError?.(err);
      });

    } catch (err) {
      isConnecting = false; // 释放锁
      const errMsg = String(err);
      log?.error(`[qqbot:${account.accountId}] Connection failed: ${err}`);
      
      // 如果是频率限制错误，等待更长时间
      if (errMsg.includes("Too many requests") || errMsg.includes("100001")) {
        log?.info(`[qqbot:${account.accountId}] Rate limited, waiting ${RATE_LIMIT_DELAY}ms before retry`);
        scheduleReconnect(RATE_LIMIT_DELAY);
      } else {
        scheduleReconnect();
      }
    }
  };

  // 开始连接
  await connect();

  // 等待 abort 信号
  return new Promise((resolve) => {
    abortSignal.addEventListener("abort", () => resolve());
  });
}
