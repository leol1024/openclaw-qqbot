// ============ 消息类型常量 ============

/** C2C 私聊消息 */
export const MSG_TYPE_C2C = "c2c" as const;
/** 频道公开消息 */
export const MSG_TYPE_GUILD = "guild" as const;
/** 频道私信 */
export const MSG_TYPE_DM = "dm" as const;
/** 群聊消息 */
export const MSG_TYPE_GROUP = "group" as const;

/** 消息类型联合类型 */
export type MessageType = typeof MSG_TYPE_C2C | typeof MSG_TYPE_GUILD | typeof MSG_TYPE_DM | typeof MSG_TYPE_GROUP;
