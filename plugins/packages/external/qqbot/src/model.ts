import type { ChannelMessage, MessageReference, OutgoingMedia } from "./channel-api.js";
import { messageDetails } from "./messages.js";
export const CHANNEL = "qqbot.service";
export const MAX_EVENTS = 200;
export type Scene = "c2c" | "group" | "unknown";
export type JsonObject = Record<string, unknown>;

export interface AutoReplyConfig {
  enabled: boolean;
  c2cEnabled: boolean;
  groupEnabled: boolean;
  groupContext: "shared" | "member";
  groupReplyMode: "mentioned" | "all";
  listenGroupMessages: boolean;
  aiTimeoutMs: number;
  chatGroup: string;
  characterSelection: string;
  assistantInstruction: string;
}

/** One QQ application. Each entry owns its own Gateway, queue, reply loop and role. */
export interface BotAccount {
  id: string;
  name: string;
  appId: string;
  appSecret: string;
  useSandbox: boolean;
  listenerEnabled: boolean;
  waifuProfile: string;
  autoReply: AutoReplyConfig;
  bindings: Record<string, string>;
  processed: string[];
  bindingsAccountId?: string;
  memberBindings?: Record<string, string>;
  deliveries?: {key: string; event: InboundEvent; state: "pending" | "processing" | "failed"; delivered: number; error: string}[];
}

/** The persisted root. Channel capture settings are shared; everything else belongs to one bot. */
export interface Config {
  bots: BotAccount[];
  channelCapture: boolean;
  channelOnlyWhenNoAuto: boolean;
  channelConversationIds: string[] | null;
}

export interface InboundEvent {
  scene: Scene;
  eventType: string;
  eventId: string;
  seq: number;
  messageId: string;
  content: string;
  timestamp: string;
  receivedAt: string;
  userOpenId: string;
  groupOpenId: string;
  author?: ChannelMessage["author"];
  messageType?: number;
  attachments?: ChannelMessage["attachments"];
  elements?: ChannelMessage["elements"];
  card?: JsonObject;
  referenceIndex?: string;
  referencedMessageIndex?: string;
  rawPayload?: JsonObject;
  replyHint: { scene: Scene; msg_id: string; event_id: string; openid: string; group_openid: string };
}
export interface SendParams {
  content?: string;
  msg_type?: number;
  msg_id?: string;
  event_id?: string;
  msg_seq?: number;
  payload?: JsonObject;
  markdown?: JsonObject;
  keyboard?: JsonObject;
  card?: JsonObject;
  media?: { file_info: string };
  message_reference?: MessageReference;
}
export interface ConfigureParams { bot_id?: string; app_id?: string; app_secret?: string; use_sandbox?: boolean; listener_enabled?: boolean; test_connection?: boolean; restart_service?: boolean }
export interface ReceiveParams { bot_id?: string; limit?: number; consume?: boolean; scene?: Scene; event_type?: string; include_raw?: boolean; auto_start?: boolean }
export interface AutoReplyParams { bot_id?: string; group_context?: "shared" | "member"; group_reply_mode?: "mentioned" | "all"; listen_group_messages?: boolean; enabled?: boolean; c2c_enabled?: boolean; group_enabled?: boolean; ai_timeout_ms?: number; chat_group?: string; character_selection?: string; assistant_instruction?: string; waifu_profile?: string; start_now?: boolean }
/** Creates a bot; every field except the credentials is optional. */
export interface BotAddParams { name?: string; app_id: string; app_secret: string; use_sandbox?: boolean; listener_enabled?: boolean; waifu_profile?: string; character_selection?: string; chat_group?: string; assistant_instruction?: string; c2c_enabled?: boolean; group_enabled?: boolean; group_context?: "shared" | "member"; group_reply_mode?: "mentioned" | "all"; listen_group_messages?: boolean; ai_timeout_ms?: number; start?: boolean; test_connection?: boolean }
/** Patches one bot; omitted fields keep their current values. */
export interface BotUpdateParams extends Omit<BotAddParams, "app_id" | "app_secret" | "start" | "test_connection"> { bot_id: string; app_id?: string; app_secret?: string; start?: boolean; test_connection?: boolean; enabled?: boolean }
export interface BotTargetParams { bot_id?: string }
export type Request =
  | { action: "configure"; params: ConfigureParams }
  | { action: "status" }
  | { action: "chat_context"; chatId: string; limit?: number; before?: number }
  | { action: "retry_delivery"; key: string; skip?: boolean; bot_id?: string }
  | { action: "reply_roles" }
  | { action: "test"; bot_id?: string }
  | { action: "start"; restart?: boolean; bot_id?: string }
  | { action: "stop"; bot_id?: string }
  | { action: "receive"; params: ReceiveParams }
  | { action: "clear"; bot_id?: string }
  | { action: "send_c2c"; params: SendParams & { openid: string } }
  | { action: "send_group"; params: SendParams & { group_openid: string } }
  | { action: "upload_media"; scene: "c2c" | "group"; target: string; media: OutgoingMedia; bot_id?: string }
  | { action: "send_media"; scene: "c2c" | "group"; target: string; media: OutgoingMedia; params?: SendParams; bot_id?: string }
  | { action: "upload_image"; scene: "c2c" | "group"; target: string; source: string; bot_id?: string }
  | { action: "auto_configure"; params: AutoReplyParams }
  | { action: "auto_start"; bot_id?: string }
  | { action: "auto_stop"; bot_id?: string }
  | { action: "auto_once"; bot_id?: string }
  | { action: "bots_list" }
  | { action: "bot_add"; params: BotAddParams }
  | { action: "bot_update"; params: BotUpdateParams }
  | { action: "bot_remove"; bot_id: string }
  | { action: "bot_start"; bot_id: string; restart?: boolean }
  | { action: "bot_stop"; bot_id: string };
export interface ReplyRole { selection: string; name: string }
export interface Status {
  botId: string;
  name: string;
  waifuProfile: string;
  configured: boolean;
  appId: string;
  useSandbox: boolean;
  listenerEnabled: boolean;
  service: { status: "stopped" | "connecting" | "ready" | "error"; sessionId: string; lastError: string; receivedCount: number };
  queue: { size: number; capacity: number };
  autoReply: { config: AutoReplyConfig; running: boolean; lastError: string; bindings: Record<string, string>; repliedCount: number; deliveries: {key: string; state: string; delivered: number; error: string}[] };
}
/** What one account runtime answers; it knows nothing about the other accounts. */
export type AccountResponse =
  | { success: true; context: import("./channel-api.js").ConversationHistory }
  | { success: true; status: Status }
  | { success: true; roles: ReplyRole[] }
  | { success: true; returnedCount: number; remainingCount: number; events: InboundEvent[] }
  | { success: true; clearedCount: number }
  | { success: true; response: JsonObject };

/** What the hub answers: the same payloads plus the multi-account projection. */
export type Response =
  | { success: true; context: import("./channel-api.js").ConversationHistory }
  // status is absent only while no bot has been added yet.
  | { success: true; status?: Status; bots: Status[] }
  | { success: true; roles: ReplyRole[] }
  | { success: true; returnedCount: number; remainingCount: number; events: InboundEvent[] }
  | { success: true; clearedCount: number }
  | { success: true; removed: string }
  | { success: true; response: JsonObject };

/** Creates the authored initial persisted configuration. */
export function defaultConfig(): Config {
  return { bots: [], channelCapture: false, channelOnlyWhenNoAuto: false, channelConversationIds: null };
}

/** Supplies the per-bot defaults that older single-account configs and new bots share. */
export function defaultAutoReply(): AutoReplyConfig {
  return { enabled: false, c2cEnabled: true, groupEnabled: true, groupContext: "shared", groupReplyMode: "mentioned", listenGroupMessages: true, aiTimeoutMs: 120000, chatGroup: "QQ Bot", characterSelection: "", assistantInstruction: "请直接回复 QQ 用户，不要输出内部思考或工具执行过程。" };
}

/** Creates stable, collision-resistant local identity for one added bot. */
export function newBotId(): string { return `bot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }

/** Shapes a new account while preserving the authored reply defaults. */
export function defaultBot(appId: string, appSecret: string, name: string): BotAccount {
  return { id: newBotId(), name, appId, appSecret, useSandbox: false, listenerEnabled: false, waifuProfile: "default",
    autoReply: defaultAutoReply(), bindings: {}, processed: [] };
}

type Legacy = Partial<Pick<BotAccount, "appId" | "appSecret" | "useSandbox" | "listenerEnabled" | "waifuProfile" | "autoReply" | "bindings" | "processed" | "bindingsAccountId" | "memberBindings" | "deliveries">> & {bots?: unknown};

/**
 * Upgrades a persisted single-account config in place and drops the superseded
 * keys. Returns whether anything actually changed, so the caller can persist the
 * upgraded shape and keep generated bot identities stable across restarts.
 */
export function normalizeConfig(root: Config): { config: Config; migrated: boolean } {
  const legacy = root as Config & Legacy;
  root.channelCapture = root.channelCapture === true;
  root.channelOnlyWhenNoAuto = root.channelOnlyWhenNoAuto === true;
  root.channelConversationIds ??= null;
  const before = JSON.stringify(root);
  if (!Array.isArray(root.bots)) root.bots = [];
  const stored = legacy.appId;
  if (root.bots.length === 0 && typeof stored === "string" && stored.trim() !== "") {
    root.bots.push({ id: newBotId(), name: "QQ Bot 1", appId: stored, appSecret: String(legacy.appSecret ?? ""),
      useSandbox: legacy.useSandbox === true, listenerEnabled: legacy.listenerEnabled === true,
      waifuProfile: typeof legacy.waifuProfile === "string" && legacy.waifuProfile !== "" ? legacy.waifuProfile : "default",
      autoReply: { ...defaultAutoReply(), ...(legacy.autoReply ?? {}) },
      bindings: legacy.bindings ?? {}, processed: legacy.processed ?? [],
      bindingsAccountId: legacy.bindingsAccountId ?? stored,
      ...(legacy.memberBindings === undefined ? {} : { memberBindings: legacy.memberBindings }),
      ...(legacy.deliveries === undefined ? {} : { deliveries: legacy.deliveries }) });
  }
  for (const bot of root.bots) {
    bot.id = bot.id || newBotId();
    bot.name = typeof bot.name === "string" && bot.name.trim() !== "" ? bot.name : bot.appId || "QQ Bot";
    bot.waifuProfile = typeof bot.waifuProfile === "string" && bot.waifuProfile !== "" ? bot.waifuProfile : "default";
    bot.autoReply = { ...defaultAutoReply(), ...(bot.autoReply ?? {}) };
    bot.bindings ??= {};
    bot.processed ??= [];
    bot.bindingsAccountId ??= bot.appId;
  }
  for (const key of ["appId", "appSecret", "useSandbox", "listenerEnabled", "waifuProfile", "autoReply", "bindings", "processed", "bindingsAccountId", "memberBindings", "deliveries"] as const) delete legacy[key];
  return { config: root, migrated: JSON.stringify(root) !== before };
}

/** Requires an object received at a JSON protocol boundary. */
export function object(value: unknown, field: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as JsonObject;
}

/** Requires a string without converting invalid protocol data. */
export function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

/** Requires a nonblank credential, identifier or submitted message. */
export function nonblank(value: unknown, field: string): string {
  const result = text(value, field).trim();
  if (result === "") throw new Error(`${field} must not be blank`);
  return result;
}

/** Checks bounded integers before they reach timers, queues or remote APIs. */
export function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  return value;
}

/** Formats actual thrown values for persisted runtime diagnostics. */
export function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Resolves the exact QQ event schema rather than guessing identifier aliases. */
export function inbound(payload: JsonObject): InboundEvent {
  const eventType = nonblank(payload.t, "dispatch.t");
  const body = object(payload.d, "dispatch.d");
  const seq = integer(payload.s, "dispatch.s", 0, Number.MAX_SAFE_INTEGER);
  let scene: Scene = "unknown", userOpenId = "", groupOpenId = "", messageId = "", content = "", timestamp = "";
  if (eventType === "C2C_MESSAGE_CREATE" || eventType === "GROUP_AT_MESSAGE_CREATE" || eventType === "GROUP_MESSAGE_CREATE") {
    scene = eventType === "C2C_MESSAGE_CREATE" ? "c2c" : "group";
    const author = object(body.author, "message.author");
    userOpenId = nonblank(scene === "c2c" ? author.user_openid : author.member_openid, "message.author openid");
    if (scene === "group") groupOpenId = nonblank(body.group_openid, "message.group_openid");
    messageId = nonblank(body.id, "message.id");
    if (body.content !== undefined) content = text(body.content, "message.content");
    timestamp = text(body.timestamp, "message.timestamp");
  }
  const eventId = payload.id === undefined ? "" : text(payload.id, "dispatch.id");
  return { scene, eventType, eventId, seq, messageId, content, timestamp, receivedAt: new Date().toISOString(), userOpenId, groupOpenId, rawPayload: payload, ...(scene === "unknown" ? {} : messageDetails(body, userOpenId)),
    replyHint: { scene, msg_id: messageId, event_id: eventId, openid: userOpenId, group_openid: groupOpenId } };
}
