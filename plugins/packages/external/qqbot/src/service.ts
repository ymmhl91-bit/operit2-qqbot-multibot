import { ChannelStore, conversationKey } from "./channel-store.js";
import { ChannelInbox, messageKey } from "./channel-inbox.js";
import type { ChannelAccount, ChannelRequest, ChannelResponses, ChannelMessage, ChannelConversation, ConversationHistory } from "./channel-api.js";
import { getSettings as waifuSettings, stream as waifuStream } from "./dependencies/waifu/api.js";
import { chatText, ReplyTextStream } from "./messages.js";
import { attachments, downloadConsoleAttachment } from "./attachments.js";
import { QQGateway } from "./gateway.js";
import { QQOpenApi } from "./openapi.js";
import { CHANNEL, MAX_EVENTS, defaultBot, defaultConfig, defaultAutoReply, errorText, integer, newBotId, nonblank, normalizeConfig, text, type AccountResponse, type AutoReplyParams, type BotAccount, type BotAddParams, type BotUpdateParams, type Config, type ConfigureParams, type InboundEvent, type ReceiveParams, type Request, type Response, type ReplyRole, type Status } from "./model.js";

const MAX_DELIVERIES = 200;
type Delivery = NonNullable<BotAccount["deliveries"]>[number];
interface ReplyTask {
  superseded: boolean;
  stopDelivery?: () => void;
  done?: Promise<void>;
  cancellation?: Promise<unknown>;
}

/** Runs one QQ application: its own Gateway, event queue, reply loop and role. */
class QQBotRuntime {
  private api: QQOpenApi;
  private gateway: QQGateway;
  private readonly events: InboundEvent[] = [];
  private readonly seen = new Set<string>();
  private autoTimer: number | null = null;
  private readonly autoTasks = new Map<string, ReplyTask>();
  private autoGeneration = 0;
  private readonly activeChats = new Map<string, string>();
  private readonly activeContexts = new Map<string, {chatId: string; accountId: string; conversationId: string; authorId: string; scene: "c2c" | "group"}>();
  private autoRunning = false;
  private autoError = "";
  private repliedCount = 0;

  /** Creates one isolated runtime over shared durable stores and one bot's own configuration. */
  constructor(private readonly root: Config, private readonly bot: BotAccount,
    private readonly sessions: ChannelStore, private readonly channelInbox: ChannelInbox) {
    bot.autoReply = {...defaultAutoReply(), ...bot.autoReply};
    bot.memberBindings ??= {};
    bot.deliveries ??= [];
    bot.bindingsAccountId ??= bot.appId;
    bot.deliveries = bot.deliveries.map(delivery => delivery.state === "processing" ? {...delivery, state: "failed" as const, error: "上次回复中断，请确认已发送内容后重试或跳过。"} : delivery);
    this.coalescePending();
    this.api = this.createApi();
    this.gateway = this.createGateway();
  }

  /** Exposes the account identity that tools and the UI address this runtime by. */
  get id(): string { return this.bot.id; }
  get accountId(): string { return this.bot.appId; }

  /** Persists through the shared root so one file holds every account. */
  private flush(): Promise<void> { return PluginConfig.flush(this.root); }

  /** Binds all HTTP calls to the ordinary cross-platform networking SDK. */
  private createApi(bot: BotAccount = this.bot): QQOpenApi {
    return new QQOpenApi({ ...bot }, { request: options => Tools.Net.http(options) }, this.sessions.recordSend("qq"));
  }

  /** Binds socket handles and ordered dispatches to the current main engine. */
  private createGateway(): QQGateway {
    return new QQGateway(this.api, { request: request => Tools.Net.webSocket(request) }, event => this.enqueue(event));
  }

  /** Exposes operational state without returning stored application credentials. */
  status(): Status {
    return { botId: this.bot.id, name: this.bot.name, waifuProfile: this.bot.waifuProfile, configured: this.bot.appId !== "" && this.bot.appSecret !== "", appId: this.bot.appId, useSandbox: this.bot.useSandbox, listenerEnabled: this.bot.listenerEnabled,
      service: { status: this.gateway.status, sessionId: this.gateway.sessionId, lastError: this.gateway.lastError, receivedCount: this.gateway.receivedCount },
      queue: { size: this.events.length, capacity: MAX_EVENTS },
      autoReply: { config: { ...this.bot.autoReply }, running: this.autoRunning, lastError: this.autoError, bindings: { ...this.bot.bindings }, repliedCount: this.repliedCount, deliveries: (this.bot.deliveries ?? []).filter(item => item.state !== "pending").map(({key,state,delivered,error}) => ({key,state,delivered,error})) } };
  }

  /** Restores this account only when the user explicitly left its listener enabled. */
  async restore(): Promise<void> {
    if (!this.bot.listenerEnabled) return;
    if (this.bot.appId === "" || this.bot.appSecret === "") return;
    await this.start(false);
  }

  /** Starts the listener and awaits its authenticated READY event. */
  async start(restart: boolean): Promise<void> {
    nonblank(this.bot.appId, "AppID"); nonblank(this.bot.appSecret, "AppSecret");
    if (restart) await this.stopRuntime();
    if (this.gateway.status === "ready") {
      if (this.bot.autoReply.enabled && !this.autoRunning) this.startAuto();
      return;
    }
    if (this.gateway.status !== "connecting") {
      this.api = this.createApi(); this.gateway = this.createGateway();
      await this.gateway.start();
    }
    await this.gateway.waitReady();
    if (this.bot.autoReply.enabled) this.startAuto();
  }

  /** Stops pending AI work and the socket before releasing the listener runtime. */
  async stopRuntime(): Promise<void> { await this.stopAuto(); await this.gateway.stop(); }

  /** Validates a configuration patch before durably committing it and restarting its affected runtime. */
  async configure(params: ConfigureParams): Promise<void> {
    const next = { appId: this.bot.appId, appSecret: this.bot.appSecret, useSandbox: this.bot.useSandbox, listenerEnabled: this.bot.listenerEnabled };
    if (params.app_id !== undefined) next.appId = text(params.app_id, "app_id").trim();
    if (params.app_secret !== undefined) next.appSecret = text(params.app_secret, "app_secret").trim();
    if (params.use_sandbox !== undefined) { if (typeof params.use_sandbox !== "boolean") throw new Error("use_sandbox must be boolean"); next.useSandbox = params.use_sandbox; }
    if (params.listener_enabled !== undefined) { if (typeof params.listener_enabled !== "boolean") throw new Error("listener_enabled must be boolean"); next.listenerEnabled = params.listener_enabled; }
    if (next.listenerEnabled) { nonblank(next.appId, "AppID"); nonblank(next.appSecret, "AppSecret"); }
    if (params.test_connection === true) await this.createApi({ ...this.bot, ...next }).test();
    const changed = next.appId !== this.bot.appId || next.appSecret !== this.bot.appSecret || next.useSandbox !== this.bot.useSandbox;
    if (changed || !next.listenerEnabled || params.restart_service === true) await this.stopRuntime();
    if (next.appId !== this.bot.appId) {
      this.events.length=0;this.seen.clear();this.bot.bindings={};this.bot.memberBindings={};this.bot.processed=[];this.bot.deliveries=[];
      this.bot.bindingsAccountId=next.appId;
    }
    Object.assign(this.bot, next);
    if (changed) { this.api = this.createApi(); this.gateway = this.createGateway(); }
    await this.flush();
    if (next.listenerEnabled) await this.start(false);
  }

  private normalized(event: InboundEvent): ChannelMessage {
    const scene = event.scene;
    if (scene !== "group" && scene !== "c2c") throw Error("Unsupported QQ conversation scene");
    const accountId=nonblank(this.bot.appId,"AppID"), conversationId=scene==="group"?event.groupOpenId:event.userOpenId;
    return {key:messageKey(["qq",accountId,scene,conversationId,event.messageId]),channel:"qq",accountId,
      messageId:event.messageId,conversationId,authorId:event.userOpenId,text:chatText(event),timestamp:event.timestamp,
      autoReplyEnabled:this.shouldReply(event),
      ...(event.author === undefined ? {} : {author:event.author}),
      ...(event.messageType === undefined ? {} : {messageType:event.messageType}),
      ...(event.attachments === undefined ? {} : {attachments:event.attachments}),
      ...(event.elements === undefined ? {} : {elements:event.elements}),
      ...(event.card === undefined ? {} : {card:event.card}),
      ...(event.referenceIndex === undefined ? {} : {referenceIndex:event.referenceIndex}),
      ...(event.referencedMessageIndex === undefined ? {} : {referencedMessageIndex:event.referencedMessageIndex}),
      context:JSON.parse(JSON.stringify({scene,replyHint:event.replyHint,raw:event.rawPayload??null}))};
  }
  /** Reads QQ's mentions array defensively; only an explicit is_you===true counts. */
  private mentionedMe(event: InboundEvent): boolean {
    const payload=event.rawPayload as Record<string, unknown> | undefined;
    const body=payload?.["d"];
    if(typeof body!=="object"||body===null||Array.isArray(body))return false;
    const mentions=(body as Record<string, unknown>)["mentions"];
    if(!Array.isArray(mentions))return false;
    return mentions.some(item=>typeof item==="object"&&item!==null&&!Array.isArray(item)&&(item as Record<string, unknown>)["is_you"]===true);
  }
  private shouldReply(event: InboundEvent): boolean {
    const config=this.bot.autoReply;
    return config.enabled && (event.scene==="c2c"?config.c2cEnabled:event.scene==="group" && config.groupEnabled &&
      (config.groupReplyMode==="all" || event.eventType==="GROUP_AT_MESSAGE_CREATE" ||
        event.eventType==="GROUP_MESSAGE_CREATE" && this.mentionedMe(event)));
  }
  /** Stores readable group history separately from model turns and maintenance deliveries. */
  private async enqueue(event: InboundEvent): Promise<void> {
    const key=event.messageId===""?`${event.eventType}:${event.eventId}:${event.seq}`:JSON.stringify([this.bot.appId,event.scene,event.scene==="group"?event.groupOpenId:event.userOpenId,event.messageId]);
    if(this.seen.has(key))return;
    const valid=event.messageId!=="" && (event.scene==="c2c" || event.scene==="group");
    let channelOnly=false;
    if(valid){
      const message=this.normalized(event), binding=`${event.scene}:${message.conversationId}`;
      if(event.scene!=="group" || this.bot.autoReply.listenGroupMessages || this.shouldReply(event))
        await this.sessions.observe(message,event.scene as "c2c"|"group",`QQ ${event.scene==="group"?"群聊":"私聊"} ${message.conversationId}`,this.bot.bindings[binding]);
      const captured=this.root.channelCapture && (!Array.isArray(this.root.channelConversationIds) || this.root.channelConversationIds.includes(message.conversationId));
      if(captured)await this.channelInbox.record(message);
      channelOnly=captured && this.root.channelOnlyWhenNoAuto && !this.shouldReply(event);
      if(this.shouldReply(event) && !this.bot.processed.includes(key) && !this.bot.processed.includes(`${event.scene}:${event.messageId}`) && !this.bot.deliveries!.some(item=>item.key===key)){
        this.interrupt(this.binding(event));
        this.coalescePending(event);
        const deliveries = this.bot.deliveries!;
        if (deliveries.length >= MAX_DELIVERIES) {
          const oldestFailure = deliveries.findIndex(item => item.state === "failed");
          if (oldestFailure >= 0) {
            const [expired] = deliveries.splice(oldestFailure, 1);
            this.bot.processed = [...this.bot.processed, expired.key].slice(-512);
          }
        }
        if (deliveries.length >= MAX_DELIVERIES) {
          this.autoError = "自动回复积压已达 200 条，新消息仍保存在近期会话中。";
        } else {
          this.bot.deliveries = [...deliveries, { key, event, state: "pending", delivered: 0, error: "" }];
          await this.flush();
        }
      }
    }
    this.seen.add(key);if(this.seen.size>512)this.seen.delete(this.seen.values().next().value!);
    if(!channelOnly){if(this.events.length>=MAX_EVENTS)this.events.shift();this.events.push(event);}
  }

  private async conversations(): Promise<ChannelConversation[]> {
    // Existing Bot-created chats remain the authoritative routing after upgrade.
    for(const [binding,chatId] of Object.entries(this.bot.bindings)){
      const separator=binding.indexOf(":"), scene=binding.slice(0,separator), id=binding.slice(separator+1);
      if((scene!=="c2c"&&scene!=="group")||!id)continue;
      await this.sessions.remember({key:conversationKey("qq",this.bot.appId,scene,id),channel:"qq",accountId:this.bot.appId,scene,
        conversationId:id,title:`QQ ${scene==="group"?"群聊":"私聊"} ${id}`,chatId,lastMessageAt:0});
    }
    return (await this.sessions.conversations("qq",this.bot.appId)).map(session=>({...session,
      contextChatIds:Object.entries(this.bot.memberBindings??{}).filter(([key])=>JSON.parse(key)[0]===session.key).map(([,id])=>id)}));
  }
  private openChat(key:string):Promise<ChannelConversation>{
    const existing=this.opening.get(key);if(existing)return existing;
    const task=(async()=>{
      const session=await this.sessions.get(key);
      if(session.accountId!==this.bot.appId)throw Error("会话不属于当前 QQ 账号");
      if(session.chatId)return session;
      const retained=this.bot.bindings[`${session.scene}:${session.conversationId}`];
      if(retained)return this.sessions.bind(key,retained);
      const config=this.bot.autoReply, input=config.characterSelection===""?null:{"com.operit.character_cards":{version:1,selection:config.characterSelection}};
      const chatId=(await Tools.Chat.createNew({setAsCurrentChat:false,input})).chatId;
      // Publish the identity before presentation updates, so a failed title update cannot create duplicates.
      this.bot.bindings={...this.bot.bindings,[`${session.scene}:${session.conversationId}`]:chatId};
      await this.flush();
      const bound=await this.sessions.bind(key,chatId);
      await Tools.Chat.updateTitle(chatId,session.title);
      if(config.chatGroup!=="")await Tools.Chat.updateGroup([chatId],config.chatGroup);
      return bound;
    })();
    this.opening.set(key,task);void task.finally(()=>this.opening.delete(key)).catch(()=>{});return task;
  }
  private readonly opening = new Map<string, Promise<ChannelConversation>>();

  /** Resolves the conversation bound to one of this account's Bot chats. */
  async chatContext(chatId:string,limit?:number,before?:number):Promise<ConversationHistory | null>{
    const active=[...this.activeContexts.values()].find(context=>context.chatId===chatId);
    const sessions=await this.conversations();
    let session=sessions.find(item=>item.chatId===chatId);
    let authorId:string|undefined;
    if(!session){
      const member=Object.entries(this.bot.memberBindings??{}).find(([,id])=>id===chatId);
      if(member){const [key,author]=JSON.parse(member[0]) as [string,string];session=sessions.find(item=>item.key===key);authorId=author;}
    }
    if(!session)return null;
    if(this.bot.autoReply.groupContext==="member"&&session.scene==="group")authorId=authorId??active?.authorId;
    if(this.bot.autoReply.groupContext==="member"&&session.scene==="group"&&!authorId)throw Error("成员隔离模式需要明确的当前发送者");
    return this.sessions.history(session.key,limit,before,authorId);
  }
  /** Reports whether one chat belongs to this account without throwing for other accounts. */
  async ownsChat(chatId:string):Promise<boolean>{ try { return (await this.chatContext(chatId,1)) !== null } catch { return false } }

  /** Returns and optionally consumes only events matching explicit filters. */
  private receive(params: ReceiveParams): AccountResponse {
    const limit = params.limit === undefined ? 20 : integer(params.limit, "limit", 1, 100);
    if (params.scene !== undefined && params.scene !== "c2c" && params.scene !== "group" && params.scene !== "unknown") throw new Error("Invalid scene");
    const selected = this.events.filter(event => (params.scene === undefined || params.scene === event.scene) && (params.event_type === undefined || params.event_type === event.eventType)).slice(0, limit);
    if (params.consume !== false) for (const event of selected) this.events.splice(this.events.indexOf(event), 1);
    const events = selected.map(event => {
      if (params.include_raw === true) return { ...event };
      const { rawPayload: _raw, ...summary } = event;
      return summary;
    });
    return { success: true, returnedCount: events.length, remainingCount: this.events.length, events };
  }

  /** Commits automatic reply settings using the v2 conversation creation contract. */
  async configureAuto(params: AutoReplyParams): Promise<void> {
    const next = { ...this.bot.autoReply };
    for (const [field, value] of [["enabled", params.enabled], ["c2cEnabled", params.c2c_enabled], ["groupEnabled", params.group_enabled]] as const) {
      if (value !== undefined) { if (typeof value !== "boolean") throw new Error(`${field} must be boolean`); next[field] = value; }
    }
    if(params.group_context!==undefined){if(params.group_context!=="shared"&&params.group_context!=="member")throw Error("Invalid group context mode");next.groupContext=params.group_context;}
    if(params.group_reply_mode!==undefined){if(params.group_reply_mode!=="mentioned"&&params.group_reply_mode!=="all")throw Error("Invalid group reply mode");next.groupReplyMode=params.group_reply_mode;}
    if(params.listen_group_messages!==undefined){if(typeof params.listen_group_messages!=="boolean")throw Error("Invalid group listening setting");next.listenGroupMessages=params.listen_group_messages;}
    if (params.ai_timeout_ms !== undefined) next.aiTimeoutMs = integer(params.ai_timeout_ms, "ai_timeout_ms", 1000, 600000);
    if (params.chat_group !== undefined) next.chatGroup = text(params.chat_group, "chat_group").trim();
    if (params.character_selection !== undefined) next.characterSelection = text(params.character_selection, "character_selection").trim();
    if (params.assistant_instruction !== undefined) next.assistantInstruction = text(params.assistant_instruction, "assistant_instruction");
    if (next.enabled && params.start_now !== false && !this.bot.listenerEnabled) throw new Error("Enable the QQ listener before starting automatic replies");
    const profile = params.waifu_profile === undefined ? this.bot.waifuProfile : nonblank(params.waifu_profile, "waifu_profile");
    if (next.enabled && profile !== "native") await preferWaifu(profile);
    await this.stopAuto();
    this.bot.waifuProfile = profile;
    this.bot.autoReply = next;
    this.coalescePending();
    await this.flush();
    if (next.enabled && params.start_now !== false) {
      await this.start(false);
    }
  }

  /** Processes unrelated conversations concurrently. */
  private startAuto(): void {
    if (this.autoRunning) return;
    this.autoRunning = true; this.autoError = "";
    this.scheduleAuto(this.autoGeneration);
  }

  private binding(event: InboundEvent): string {
    if (event.scene !== "group") return JSON.stringify([event.scene, event.userOpenId]);
    return JSON.stringify(this.bot.autoReply.groupContext === "member"
      ? [event.scene, event.groupOpenId, event.userOpenId] : [event.scene, event.groupOpenId]);
  }

  /** Keeps the last waiting event per reply context, including after upgrading. */
  private coalescePending(replacement?: InboundEvent): void {
    const seen = new Set(replacement ? [this.binding(replacement)] : []);
    const dropped: string[] = [];
    const deliveries = [...this.bot.deliveries!].reverse().filter(item => {
      if (item.state !== "pending") return true;
      const binding = this.binding(item.event);
      if (seen.has(binding)) { dropped.push(item.key); return false; }
      seen.add(binding);
      return true;
    }).reverse();
    if (dropped.length === 0) return;
    this.bot.deliveries = deliveries;
    this.bot.processed = [...this.bot.processed, ...dropped].slice(-512);
  }

  private interrupt(binding: string): void {
    const task = this.autoTasks.get(binding);
    if (!task || task.superseded) return;
    task.superseded = true;
    void this.cancelReply(binding, task);
  }

  private cancelReply(binding: string, task: ReplyTask): Promise<unknown> | undefined {
    task.stopDelivery?.();
    const chatId = this.activeChats.get(binding);
    if (chatId) task.cancellation ??= Tools.Chat.cancel(chatId).catch(error => console.error("[qqbot.cancel]", error));
    return task.cancellation;
  }

  private takeEvent(): Delivery | undefined {
    const delivery = this.bot.deliveries!.find(item => item.state === "pending" && this.shouldReply(item.event) &&
      !this.autoTasks.has(this.binding(item.event)));
    if (!delivery) return;
    delivery.state = "processing";
    this.bot.deliveries = [...this.bot.deliveries!];
    const index = this.events.indexOf(delivery.event);
    if (index >= 0) this.events.splice(index, 1);
    return delivery;
  }

  private launchAuto(generation: number, delivery: Delivery): Promise<void> {
    const binding = this.binding(delivery.event);
    const task: ReplyTask = { superseded: false };
    this.autoTasks.set(binding, task);
    const done = this.autoTick(generation, delivery, binding, task).finally(async () => {
      // Cancel by chat ID must settle before another turn reuses that chat.
      await task.cancellation;
      this.autoTasks.delete(binding);
    });
    task.done = done;
    void done.catch(error => console.error("[qqbot.auto.task]", error));
    return done;
  }

  /** Keeps a bounded number of unrelated conversations moving independently. */
  private scheduleAuto(generation: number): void {
    if (!this.autoRunning || generation !== this.autoGeneration) return;
    this.autoTimer = setTimeout(() => {
      this.autoTimer = null;
      if (this.gateway.status === "error" || this.gateway.status === "stopped") {
        this.autoRunning = false; this.autoError = `QQ listener is ${this.gateway.status}: ${this.gateway.lastError}`; return;
      }
      if (this.gateway.status === "ready" && this.autoTasks.size < 3) {
        const item = this.takeEvent();
        if (item) void this.launchAuto(generation, item);
      }
      this.scheduleAuto(generation);
    }, 300);
  }

  /** Cancels every owned generation before allowing stop or reconfiguration to finish. */
  private async stopAuto(): Promise<void> {
    this.autoRunning = false; ++this.autoGeneration;
    if (this.autoTimer !== null) { clearTimeout(this.autoTimer); this.autoTimer = null; }
    const cancellations = await Promise.allSettled([...this.autoTasks].map(([binding, task]) => this.cancelReply(binding, task)));
    const tasks = await Promise.allSettled([...this.autoTasks.values()].map(task => task.done));
    const failure = [...cancellations, ...tasks].find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  /** Consumes one reserved inbound message and records its delivery or model error. */
  private async autoTick(generation: number, delivery: Delivery, taskBinding: string, task: ReplyTask): Promise<void> {
    const event = delivery.event;
    const current = () => generation === this.autoGeneration && !task.superseded;
    try {
      if (!current()) return;
      if (this.gateway.status === "error" || this.gateway.status === "stopped") {
        this.autoRunning = false;
        throw new Error(`QQ listener is ${this.gateway.status}: ${this.gateway.lastError}`);
      }
      const config=this.bot.autoReply, message=this.normalized(event), scene=event.scene;
      if(scene!=="c2c"&&scene!=="group")throw Error("Automatic replies require a QQ conversation");
      const target=message.conversationId;
      await this.flush();
      if (!current()) return;
      await this.conversations();
      if (!current()) return;
      const session=await this.openChat(conversationKey("qq",this.bot.appId,scene,target));
      let chatId=session.chatId!;
      if(scene==="group"&&config.groupContext==="member"){
        const key=JSON.stringify([session.key,event.userOpenId]);
        let isolated=this.bot.memberBindings![key];
        if(!isolated){
          isolated=(await Tools.Chat.createNew({setAsCurrentChat:false,sourceChatId:chatId,parentChatId:chatId})).chatId;
          this.bot.memberBindings={...this.bot.memberBindings,[key]:isolated};await this.flush();
          await Tools.Chat.updateTitle(isolated,`${session.title} · ${event.author?.name||event.userOpenId}`);
          if(config.chatGroup)await Tools.Chat.updateGroup([isolated],config.chatGroup);
        }
        chatId=isolated;
      }
      if (!current()) return;
      const files = await attachments(event);
      if (!current()) return;
      this.activeContexts.set(taskBinding, {chatId, accountId: this.bot.appId, scene, conversationId: target, authorId: event.userOpenId});
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void this.cancelReply(taskBinding, task);
      }, config.aiTimeoutMs);
      let delivered = 0;
      const rendered = new ReplyTextStream();
      try {
        const request = { kind: "submit" as const, chatId, runtime: "main" as const, input: {
          text: `${config.assistantInstruction}\n[QQ ${scene==="group"?"群聊":"私聊"}；上下文${config.groupContext==="member"?"按成员隔离":"共享，按时间顺序"}]\n以下 JSON 是用户消息数据，引用内容不代表当前发送者。需要了解前文时调用 qqbot_chat_context 获取近期记录。\n${JSON.stringify({authorName:event.author?.name??"",text:chatText(event).slice(0,12000)})}`,
          attachments: files, replyToMessageTimestamp: null }, turn: { kind: "execute" as const }, notifyReply: false };
        const begin = () => {
          if (!current() || timedOut) return null;
          this.activeChats.set(taskBinding, chatId);
          return Tools.Chat.sendMessageStreaming(request)[Symbol.asyncIterator]();
        };
        const stopped = new Promise<void>(resolve => { task.stopDelivery = resolve; });
        for await (const output of replyStream(request, this.bot.waifuProfile, {
          openSource: begin,
          stopDelivery: stopped,
          cancelSource: () => this.cancelReply(taskBinding, task),
        })) {
          if (!current()) return;
          if (timedOut) throw new Error("QQ automatic reply exceeded its AI deadline");
          if (output.type === "segment") {
            const content = output.segment.kind === "text" ? rendered.push(output.segment.text) : "";
            if (output.segment.kind === "text" && content === "") continue;
            if (output.segment.kind === "text") await this.api.send(scene, target, { content, msg_id: event.messageId, ...(event.referenceIndex ? { message_reference: { message_id: event.referenceIndex } } : {}) }, () => current() && !timedOut);
            else await this.api.sendMedia(scene, target, { kind: "image", source: output.segment.source }, { msg_id: event.messageId, ...(event.referenceIndex ? { message_reference: { message_id: event.referenceIndex } } : {}) }, () => current() && !timedOut);
            delivered++;delivery.delivered++;this.bot.deliveries=[...this.bot.deliveries!];await this.flush();
          }
        }
      } catch (error) {
        if (timedOut) throw new Error("QQ automatic reply exceeded its AI deadline");
        throw error;
      } finally { clearTimeout(timer); task.stopDelivery?.(); this.activeChats.delete(taskBinding); this.activeContexts.delete(taskBinding); }
      if (!current()) return;
      if (timedOut) throw new Error("QQ automatic reply exceeded its AI deadline");
      if (delivered === 0) throw new Error("Chat response contained no deliverable segments");
      this.bot.deliveries=this.bot.deliveries!.filter(item=>item!==delivery);
      this.bot.processed=[...this.bot.processed,delivery.key].slice(-512);await this.flush();
      this.repliedCount++; this.autoError = "";
    } catch (error) {
      if (task.superseded) return;
      this.autoError=errorText(error);
      if(delivery){delivery.state="failed";delivery.error=this.autoError;this.bot.deliveries=[...this.bot.deliveries!];await this.flush();}
      console.error("[qqbot.auto]",error);
    } finally {
      if (task.superseded && this.bot.deliveries!.includes(delivery)) {
        this.bot.deliveries = this.bot.deliveries!.filter(item => item !== delivery);
        this.bot.processed = [...this.bot.processed, delivery.key].slice(-512);
        await this.flush();
      } else if(delivery.state==="processing" && this.bot.deliveries!.includes(delivery)){delivery.state="failed";delivery.error="回复被停止；请确认发送情况后重试或跳过。";this.bot.deliveries=[...this.bot.deliveries!];await this.flush();}
    }
  }

  /** Independent public channel contract, separate from the automatic-reply queue. */
  async channel(request: ChannelRequest): Promise<ChannelResponses[ChannelRequest["action"]]> {
    if (request === null || typeof request !== "object") throw new Error("Invalid channel request");
    switch (request.action) {
      case "conversations": return {conversations:await this.conversations()};
      case "open_chat": return this.openChat(request.conversationKey);
      case "history": {
        const session=await this.sessions.get(request.conversationKey);
        if(session.accountId!==this.bot.appId)throw Error("会话不属于当前 QQ 账号");
        return this.sessions.history(session.key,request.limit,request.before,undefined,true);
      }
      case "subscribe": return this.sessions.subscribe(request.consumerId,request.routes,"qq",this.bot.appId);
      case "configure": {
        if (typeof request.capture !== "boolean") throw new Error("capture must be boolean");
        if (request.conversationIds !== undefined && request.conversationIds !== null &&
            (!Array.isArray(request.conversationIds) || request.conversationIds.some(id => typeof id !== "string" || id.trim() === "")))
          throw new Error("conversationIds must be null or an array of non-empty strings");
        if (request.channelOnlyWhenNoAuto !== undefined && typeof request.channelOnlyWhenNoAuto !== "boolean") throw new Error("channelOnlyWhenNoAuto must be boolean");
        const previous = this.root.channelCapture, previousIds = this.root.channelConversationIds, previousOnly = this.root.channelOnlyWhenNoAuto;
        this.root.channelCapture = request.capture;
        if (request.channelOnlyWhenNoAuto !== undefined) this.root.channelOnlyWhenNoAuto = request.channelOnlyWhenNoAuto;
        if (request.conversationIds !== undefined) this.root.channelConversationIds = request.conversationIds === null ? null : [...new Set(request.conversationIds)];
        try { await this.flush(); } catch (error) { this.root.channelCapture = previous; this.root.channelConversationIds = previousIds; this.root.channelOnlyWhenNoAuto = previousOnly; throw error; }
        return { capture: this.root.channelCapture, conversationIds: this.root.channelConversationIds ?? null, channelOnlyWhenNoAuto: this.root.channelOnlyWhenNoAuto === true };
      }
      case "status": return { channel: "qq", accountId: this.bot.appId, name: this.bot.name,
        capture: this.root.channelCapture === true, conversationIds: this.root.channelConversationIds ?? null, channelOnlyWhenNoAuto: this.root.channelOnlyWhenNoAuto === true, service: this.gateway.status,
        configured: !!(this.bot.appId && this.bot.appSecret), listenerEnabled: this.bot.listenerEnabled,
        autoReplyEnabled: this.bot.autoReply.enabled, error: this.gateway.lastError || this.autoError,
        replyActivity: {
          received: this.gateway.receivedCount,
          replied: this.repliedCount,
          failed: this.bot.deliveries!.filter(item => item.state === "failed").length,
          running: this.autoRunning && this.gateway.status === "ready",
          directEnabled: this.bot.autoReply.c2cEnabled,
          groupMode: this.bot.autoReply.groupEnabled ? this.bot.autoReply.groupReplyMode : "off",
        } };
      case "manage": {
        const command = request.command;
        if (command === "connect") await this.configure({ app_id: nonblank(request.appId, "App ID"), app_secret: nonblank(request.appSecret, "App Secret"), listener_enabled: true, test_connection: true });
        else {
          if (!["start", "stop", "test"].includes(command)) throw Error("Unknown QQ management command");
          // Turning the listener on implies "run this bot", which includes its AI replies.
          // Without this, a console "start" left the account connected but silent.
          if (command === "start" && request.autoReply !== undefined) await this.configureAuto({ enabled: request.autoReply, start_now: false });
          if (command === "start" && request.autoReply === undefined && !this.bot.autoReply.enabled) await this.configureAuto({ enabled: true, start_now: false });
          await this.request({ action: command });
        }
        return this.channel({ action: "status" });
      }
      case "active_context": {
        const chatId = nonblank(request.chatId, "chatId");
        const matches = [...this.activeContexts.values()].filter(value => value.chatId === chatId);
        return matches.length === 1 ? {channel: "qq", ...matches[0]} : null;
      }
      case "peek": return { messages: (request.consumerId===undefined ? await this.channelInbox.peek(request.limit, request.conversationId) : await this.sessions.peek(request.consumerId,request.limit,request.conversationKey)).filter(message=>message.accountId===this.bot.appId) };
      case "ack": return { acknowledged: request.consumerId===undefined ? await this.channelInbox.ack(request.key) : await this.sessions.ack(request.consumerId,request.key) };
      case "attachment": {
        const api = this.api;
        const session = await this.sessions.get(request.conversationKey);
        if (session.accountId !== this.bot.appId || api !== this.api) throw Error("QQ 会话不属于当前账户");
        const bytes = await downloadConsoleAttachment(await this.sessions.attachment(session.key, request.messageId, request.index));
        if (api !== this.api) throw Error("QQ 账户已切换");
        return bytes;
      }
      case "reply": {
        const message = await this.channelInbox.get(request.key) ?? await this.sessions.replyRoute(request.key);
        if (message === null) throw new Error("Pending message not found");
        if (message.accountId !== this.bot.appId) throw new Error("Message belongs to a different QQ account");
        const scene = message.context.scene;
        if (scene !== "c2c" && scene !== "group") throw new Error("Unsupported QQ reply scene");
        const params = { content: request.text, markdown: request.markdown, keyboard: request.keyboard, card: request.card,
          message_reference: request.message_reference ?? (message.referenceIndex ? { message_id: message.referenceIndex } : undefined), msg_id: message.messageId };
        return { response: request.media === undefined ? await this.api.send(scene, message.conversationId, params)
          : await this.api.sendMedia(scene, message.conversationId, request.media, params) };
      }
      default: throw new Error("Unknown channel request");
    }
  }

  /** Handles every UI and tool operation addressed to this one account. */
  async request(request: Request): Promise<AccountResponse> {
    switch (request.action) {
      case "configure": await this.configure(request.params); break;
      case "status": break;
      case "chat_context": {
              const context = await this.chatContext(request.chatId, request.limit, request.before);
              if (context === null) throw Error("当前聊天不是此 QQ Bot 的会话");
              return {success:true,context};
            }
      case "retry_delivery": {
        const delivery=this.bot.deliveries!.find(item=>item.key===request.key);
        if(!delivery||delivery.state!=="failed")throw Error("只能处理失败的回复");
        if(request.skip){this.bot.deliveries=this.bot.deliveries!.filter(item=>item!==delivery);this.bot.processed=[...this.bot.processed,delivery.key].slice(-512);}
        else {delivery.state="pending";delivery.error="";this.bot.deliveries=[...this.bot.deliveries!];}
        await this.flush();break;
      }
      case "reply_roles": {
        const [cards, groups] = await Promise.all([
          ToolPkg.callDependency<Record<string, never>, { id: string; name: string }[]>("com.operit.character_cards", "character.list", {}),
          ToolPkg.callDependency<Record<string, never>, { id: string; name: string }[]>("com.operit.character_cards", "group.list", {}),
        ]);
        const roles: ReplyRole[] = [
          ...cards.map(card => ({ selection: `card:${card.id}`, name: card.name })),
          ...groups.map(group => ({ selection: `group:${group.id}`, name: `${group.name}（角色组）` })),
        ];
        return { success: true, roles };
      }
      case "test": return { success: true, response: await this.api.test() };
      case "start":
        nonblank(this.bot.appId, "AppID"); nonblank(this.bot.appSecret, "AppSecret");
        this.bot.listenerEnabled = true; await this.flush(); await this.start(request.restart === true); break;
      case "stop": await this.stopRuntime(); this.bot.listenerEnabled = false; await this.flush(); break;
      case "receive": if (request.params.auto_start === true) await this.start(false); return this.receive(request.params);
      case "clear": { const count = this.events.length; this.events.splice(0); return { success: true, clearedCount: count }; }
      case "send_c2c": return { success: true, response: await this.api.send("c2c", request.params.openid, request.params) };
      case "send_group": return { success: true, response: await this.api.send("group", request.params.group_openid, request.params) };
      case "upload_media": return { success: true, response: await this.api.uploadMedia(request.scene, request.target, request.media) };
      case "send_media": return { success: true, response: await this.api.sendMedia(request.scene, request.target, request.media, request.params) };
      case "upload_image": return { success: true, response: await this.api.uploadImage(request.scene, request.target, request.source) };
      case "auto_configure": await this.configureAuto(request.params); break;
      case "auto_start": await this.configureAuto({ enabled: true, start_now: true }); break;
      case "auto_stop": await this.configureAuto({ enabled: false }); break;
      case "auto_once":
        if (this.autoTasks.size !== 0) throw new Error("An automatic reply is already in progress");
        if (this.gateway.status !== "ready") throw new Error("The QQ listener must be ready");
        this.autoError = "";
        const item = this.takeEvent();
        if (item) await this.launchAuto(this.autoGeneration, item);
        if (this.autoError !== "") throw new Error(this.autoError);
        break;
      default: throw new Error("Unknown QQ Bot operation");
    }
    return { success: true, status: this.status() };
  }
}

/** Owns the shared configuration file and routes each request to the right account runtime. */
class QQBotHub {
  private readonly sessions = new ChannelStore();
  private readonly channelInbox = new ChannelInbox();
  private readonly runtimes = new Map<string, QQBotRuntime>();

  constructor(private readonly config: Config) {}

  /** Creates (or reuses) the runtime for one stored account so state survives reconfiguration. */
  private runtime(bot: BotAccount): QQBotRuntime {
    const existing = this.runtimes.get(bot.id);
    if (existing !== undefined) return existing;
    const created = new QQBotRuntime(this.config, bot, this.sessions, this.channelInbox);
    this.runtimes.set(bot.id, created);
    return created;
  }

  /** Resolves an explicit bot, otherwise the most suitable default account. */
  private select(botId?: string): QQBotRuntime {
    if (botId !== undefined) {
      const bot = this.config.bots.find(item => item.id === botId);
      if (!bot) throw Error(`找不到指定的 QQ Bot：${botId}`);
      return this.runtime(bot);
    }
    const preferred = this.config.bots.find(item => item.listenerEnabled) ?? this.config.bots[0];
    if (!preferred) throw Error("请先在 QQ Bot 设置中添加一个机器人。");
    return this.runtime(preferred);
  }

  /** Finds the account that actually owns one Bot-created chat. */
  private async selectByChat(chatId: string): Promise<QQBotRuntime | null> {
    for (const bot of this.config.bots) {
      const runtime = this.runtime(bot);
      if (await runtime.ownsChat(chatId)) return runtime;
    }
    return null;
  }

  /** Resolves the account addressed by a channel conversation key. */
  private selectByKey(key: string): QQBotRuntime {
    const parts = JSON.parse(key) as unknown[];
    const accountId = typeof parts[1] === "string" ? parts[1] : "";
    const bot = this.config.bots.find(item => item.appId === accountId);
    if (!bot) throw Error("会话不属于任何已配置的 QQ Bot");
    return this.runtime(bot);
  }

  /** Aggregated status plus the per-account projections the UI needs. */
  private statuses(): { status?: Status; bots: Status[] } {
    const bots = this.config.bots.map(bot => this.runtime(bot).status());
    const primary = bots.find(item => item.listenerEnabled) ?? bots[0];
    // An empty list is a valid first-run state, not an error.
    return primary === undefined ? { bots } : { status: primary, bots };
  }

  /** Restores every account the user left enabled, independently. */
  async restore(): Promise<void> {
    for (const bot of this.config.bots) {
      if (!bot.listenerEnabled) continue;
      if (bot.appId === "" || bot.appSecret === "") continue;
      try { await this.runtime(bot).restore(); }
      catch (error) { console.error("[qqbot.restore]", bot.name, error); }
    }
  }

  /** Releases every account's model and networking resources. */
  async terminate(): Promise<void> {
    for (const runtime of this.runtimes.values()) { try { await runtime.stopRuntime(); } catch (error) { console.error("[qqbot.terminate]", error); } }
  }

  /** Creates one additional account after rejecting duplicates and invalid credentials. */
  async add(params: BotAddParams): Promise<Status> {
    const appId = nonblank(params.app_id, "app_id");
    const appSecret = nonblank(params.app_secret, "app_secret");
    if (this.config.bots.some(bot => bot.appId === appId)) throw Error(`AppID ${appId} 已经添加过了，同一个机器人不能重复添加。`);
    const name = (params.name ?? "").trim() || `QQ Bot ${this.config.bots.length + 1}`;
    const bot = defaultBot(appId, appSecret, name);
    if (params.use_sandbox !== undefined) bot.useSandbox = params.use_sandbox === true;
    if (params.listener_enabled !== undefined) bot.listenerEnabled = params.listener_enabled;
    if (params.waifu_profile !== undefined) bot.waifuProfile = nonblank(params.waifu_profile, "waifu_profile");
    bot.autoReply = { ...defaultAutoReply(),
      ...(params.character_selection === undefined ? {} : { characterSelection: params.character_selection }),
      ...(params.chat_group === undefined ? {} : { chatGroup: params.chat_group }),
      ...(params.assistant_instruction === undefined ? {} : { assistantInstruction: params.assistant_instruction }),
      ...(params.c2c_enabled === undefined ? {} : { c2cEnabled: params.c2c_enabled }),
      ...(params.group_enabled === undefined ? {} : { groupEnabled: params.group_enabled }),
      ...(params.group_context === undefined ? {} : { groupContext: params.group_context }),
      ...(params.group_reply_mode === undefined ? {} : { groupReplyMode: params.group_reply_mode }),
      ...(params.listen_group_messages === undefined ? {} : { listenGroupMessages: params.listen_group_messages }),
      ...(params.ai_timeout_ms === undefined ? {} : { aiTimeoutMs: integer(params.ai_timeout_ms, "ai_timeout_ms", 1000, 600000) }) };
    if (params.test_connection === true) {
      const candidate = new QQOpenApi({ ...bot } as never, { request: options => Tools.Net.http(options) }).test();
      await candidate;
    }
    this.config.bots = [...this.config.bots, bot];
    await PluginConfig.flush(this.config);
    const runtime = this.runtime(bot);
    if (params.start === true) { bot.listenerEnabled = true; bot.autoReply.enabled = true; await PluginConfig.flush(this.config); await runtime.start(false); }
    return runtime.status();
  }

  /** Patches one account in place and restarts it only when asked to. */
  async update(params: BotUpdateParams): Promise<Status> {
    const bot = this.config.bots.find(item => item.id === params.bot_id);
    if (!bot) throw Error(`找不到指定的 QQ Bot：${params.bot_id}`);
    const runtime = this.runtime(bot);
    const patch: ConfigureParams = { bot_id: bot.id };
    if (params.app_id !== undefined) patch.app_id = params.app_id;
    if (params.app_secret !== undefined) patch.app_secret = params.app_secret;
    if (params.use_sandbox !== undefined) patch.use_sandbox = params.use_sandbox;
    if (params.name !== undefined) { const name = text(params.name, "name").trim(); if (name !== "") bot.name = name; }
    if (params.listener_enabled !== undefined) patch.listener_enabled = params.listener_enabled;
    if (params.test_connection === true) patch.test_connection = true;
    if (params.app_id !== undefined) {
      const nextId = text(params.app_id, "app_id").trim();
      if (nextId !== bot.appId && this.config.bots.some(item => item.id !== bot.id && item.appId === nextId)) throw Error(`AppID ${nextId} 已经添加过了。`);
    }
    const reply: AutoReplyParams = { bot_id: bot.id };
    let replyChanged = false;
    if (params.enabled !== undefined) { reply.enabled = params.enabled; replyChanged = true; }
    if (params.waifu_profile !== undefined) { reply.waifu_profile = params.waifu_profile; replyChanged = true; }
    if (params.character_selection !== undefined) { reply.character_selection = params.character_selection; replyChanged = true; }
    if (params.chat_group !== undefined) { reply.chat_group = params.chat_group; replyChanged = true; }
    if (params.assistant_instruction !== undefined) { reply.assistant_instruction = params.assistant_instruction; replyChanged = true; }
    if (params.c2c_enabled !== undefined) { reply.c2c_enabled = params.c2c_enabled; replyChanged = true; }
    if (params.group_enabled !== undefined) { reply.group_enabled = params.group_enabled; replyChanged = true; }
    if (params.group_context !== undefined) { reply.group_context = params.group_context; replyChanged = true; }
    if (params.group_reply_mode !== undefined) { reply.group_reply_mode = params.group_reply_mode; replyChanged = true; }
    if (params.listen_group_messages !== undefined) { reply.listen_group_messages = params.listen_group_messages; replyChanged = true; }
    if (params.ai_timeout_ms !== undefined) { reply.ai_timeout_ms = params.ai_timeout_ms; replyChanged = true; }
    if (Object.keys(patch).length > 1) await runtime.configure(patch);
    if (replyChanged) await runtime.configureAuto({ ...reply, start_now: false });
    if (params.start === true) await runtime.request({ action: "start" });
    return runtime.status();
  }

  /** Stops one account and forgets its configuration. */
  async remove(botId: string): Promise<string> {
    const bot = this.config.bots.find(item => item.id === botId);
    if (!bot) throw Error(`找不到指定的 QQ Bot：${botId}`);
    const runtime = this.runtimes.get(bot.id);
    if (runtime) { await runtime.stopRuntime(); this.runtimes.delete(bot.id); }
    this.config.bots = this.config.bots.filter(item => item.id !== bot.id);
    await PluginConfig.flush(this.config);
    return bot.name;
  }

  /** Routes a channel request to the account it actually belongs to. */
  async channel(request: ChannelRequest): Promise<ChannelResponses[ChannelRequest["action"]]> {
    if (request === null || typeof request !== "object") throw new Error("Invalid channel request");
    if ("conversationKey" in request && typeof request.conversationKey === "string") return this.selectByKey(request.conversationKey).channel(request) as Promise<ChannelResponses[ChannelRequest["action"]]>;
    // An acknowledge/peek key belongs to exactly one account; never fall through to the default one.
    if ("key" in request && typeof request.key === "string") {
      const owner = await this.selectByChatMessageKey(request);
      if (owner === null) throw Error("消息不属于任何已配置的 QQ Bot");
      return owner.channel(request) as Promise<ChannelResponses[ChannelRequest["action"]]>;
    }
    if ("chatId" in request && typeof request.chatId === "string") {
      const owner = await this.selectByChat(request.chatId);
      if (owner === null) throw Error("当前聊天不是 QQ Bot 的会话");
      return owner.channel(request) as Promise<ChannelResponses[ChannelRequest["action"]]>;
    }
    if (request.action === "manage" && request.command === "connect") {
      const bot = this.config.bots.find(item => item.appId === request.appId.trim());
      if (bot) return this.runtime(bot).channel(request) as Promise<ChannelResponses[ChannelRequest["action"]]>;
      const created = await this.add({ app_id: request.appId, app_secret: request.appSecret, listener_enabled: true });
      return this.select(created.botId).channel(request) as Promise<ChannelResponses[ChannelRequest["action"]]>;
    }
    if (request.action === "accounts") {
      const accounts: ChannelAccount[] = this.config.bots.map(bot => {
        const status = this.runtime(bot).status();
        const directEnabled = status.autoReply.config.c2cEnabled;
        const groupMode = status.autoReply.config.groupEnabled ? status.autoReply.config.groupReplyMode : "off" as const;
        return { accountId: bot.appId, name: bot.name, configured: status.configured,
          listenerEnabled: bot.listenerEnabled, autoReplyEnabled: bot.autoReply.enabled,
          service: status.service.status, directEnabled, groupMode,
          ...(status.service.lastError === "" ? {} : { error: status.service.lastError }),
          replyActivity: { received: status.service.receivedCount, replied: status.autoReply.repliedCount,
            failed: status.autoReply.deliveries.filter(item => item.state === "failed").length,
            running: status.autoReply.running && status.service.status === "ready", directEnabled, groupMode } };
      });
      return { accounts } as ChannelResponses[ChannelRequest["action"]];
    }
    // An explicit accountId lets a console address a non-default bot.
    const accountId = "accountId" in request && typeof request.accountId === "string" ? request.accountId : undefined;
    if (accountId !== undefined) {
      const bot = this.config.bots.find(item => item.appId === accountId);
      if (!bot) throw Error(`找不到指定的 QQ 账号：${accountId}`);
      return this.runtime(bot).channel(request) as Promise<ChannelResponses[ChannelRequest["action"]]>;
    }
    // Every remaining request is account-scoped administrative work.
    return this.select().channel(request) as Promise<ChannelResponses[ChannelRequest["action"]]>;
  }

  /** Resolves the account that produced one durable inbound message key. */
  private async selectByChatMessageKey(request: ChannelRequest): Promise<QQBotRuntime | null> {
    if (!("key" in request) || typeof request.key !== "string") return null;
    for (const bot of this.config.bots) {
      const runtime = this.runtime(bot);
      const conversation = await this.sessions.replyRoute(request.key);
      if (conversation !== null && conversation.accountId === bot.appId) return runtime;
    }
    return null;
  }

  /** Handles every tool and UI operation with one consistent account selection policy. */
  async request(request: Request): Promise<Response> {
    switch (request.action) {
      case "bots_list": { const {status, bots} = this.statuses(); return { success: true, status, bots }; }
      case "bot_add": { const status = await this.add(request.params); return { success: true, status, bots: this.statuses().bots }; }
      case "bot_update": { const status = await this.update(request.params); return { success: true, status, bots: this.statuses().bots }; }
      case "bot_remove": { await this.remove(request.bot_id); return { success: true, removed: request.bot_id, bots: this.statuses().bots, ...(this.statuses().status === undefined ? {} : { status: this.statuses().status }) }; }
      case "bot_start": return this.project(await this.select(request.bot_id).request({ action: "start", restart: request.restart === true }));
      case "bot_stop": return this.project(await this.select(request.bot_id).request({ action: "stop" }));
      case "status": { const {status, bots} = this.statuses(); return { success: true, status, bots }; }
      case "chat_context": {
        const owner = await this.selectByChat(request.chatId);
        if (owner === null) throw Error("当前聊天不是此 QQ Bot 的会话");
        return this.project(await owner.request(request));
      }
      default:
        return this.project(await this.select(targetOf(request, request.action === "receive" ? request.params.bot_id : request.action === "auto_configure" ? request.params.bot_id : botTarget(request))).request(request));
    }
  }

  /** Adds the multi-account projection to any single-account answer. */
  private projection(): { status?: Status; bots: Status[] } { return this.statuses(); }

  /** Forwards one account answer while keeping the caller's payload shape intact. */
  private project(result: AccountResponse): Response {
    const {status, bots} = this.projection();
    const chosen = "status" in result ? result.status : status;
    return { ...result, ...(chosen === undefined ? {} : { status: chosen }), bots } as Response;
  }
}

/** Reads the optional bot selector carried by most request variants. */
function botTarget(request: Request): string | undefined {
  return "bot_id" in request && typeof request.bot_id === "string" ? request.bot_id : undefined;
}

/** Resolves the account a request addresses, preferring an explicit selector. */
function targetOf(request: Request, nested?: string): string | undefined {
  return botTarget(request) ?? (typeof nested === "string" && nested !== "" ? nested : undefined);
}

async function preferWaifu(profile: string): Promise<boolean> {
  if (profile === "native") return false;
  try { await waifuSettings(profile); return true; }
  catch (error) {
    if (/(?:ToolPkg (?:container not found|(?:package|extension owner|public API owner) is disabled)|Dependency version mismatch): com\.operit\.waifu\b/i.test(errorText(error))) return false;
    throw error;
  }
}

async function* replyStream(request: Parameters<typeof waifuStream>[0], profile: string, controls: Required<NonNullable<Parameters<typeof waifuStream>[2]>>): ReturnType<typeof waifuStream> {
  // Select the backend before submitting the turn; never replay a failed or partial Waifu turn.
  if (await preferWaifu(profile)) { yield* waifuStream(request, profile, controls); return; }
  const source = controls.openSource();
  if (!source) return;
  for await (const event of { [Symbol.asyncIterator]: () => source }) {
    if (event.type !== "completed") continue;
    const { outcome, aiResponse } = event.result;
    if (outcome.type !== "committed" || outcome.status !== "completed") throw Error(`Chat did not complete: ${JSON.stringify(outcome)}`);
    if (aiResponse) yield { type: "segment", index: 0, segment: { kind: "text", text: aiResponse } };
    return;
  }
  throw Error("Chat stream ended without a completed receipt");
}

let pendingHub: Promise<QQBotHub> | null = null;
/** Serializes work per account so one slow bot cannot block another. */
const tails = new Map<string, Promise<void>>();
const structuralTail: { current: Promise<void> } = { current: Promise.resolve() };

/** Initializes exactly one hub and retains its asynchronous configuration load. */
async function hub(): Promise<QQBotHub> {
  if (pendingHub === null) pendingHub = (async () => {
    const stored = await PluginConfig.use("qqbot", defaultConfig());
    const { config, migrated } = normalizeConfig(stored);
    // Persist the upgraded shape immediately so generated bot identities survive
    // a restart even when the user only looks at the status page.
    if (migrated) await PluginConfig.flush(config);
    return new QQBotHub(config);
  })();
  return pendingHub;
}

/** Runs one operation after that account's previous operation, never concurrently. */
function sequential<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const tail = tails.get(key) ?? Promise.resolve();
  const result = tail.then(operation);
  tails.set(key, result.then(() => {}, error => { console.error("[qqbot.request]", error); }));
  return result;
}

/** Runs a structural change (add/remove) without racing any account's own queue. */
function structural<T>(operation: () => Promise<T>): Promise<T> {
  const result = structuralTail.current.then(operation);
  structuralTail.current = result.then(() => {}, error => { console.error("[qqbot.structural]", error); });
  return result;
}

/**
 * Picks the queue an operation belongs to. Requests that name a bot wait only
 * for that bot; requests that do not name one are serialized on their own key
 * so they can never overtake a different account's work.
 */
function queueKey(request: Request): string {
  switch (request.action) {
    case "status": case "bots_list": case "reply_roles": return "status";
    case "bot_add": case "bot_remove": return "structural";
    case "receive": return request.params.bot_id ?? "request:receive";
    case "auto_configure": return request.params.bot_id ?? "request:auto_configure";
    case "chat_context": return `chat:${request.chatId}`;
    default:
      // send_*, upload_*, auto_start/stop/once and the legacy start/stop paths
      // all address a bot through bot_id when the caller names one.
      return botTarget(request) ?? `request:${request.action}`;
  }
}

/** Routes tools and UI commands through per-account administrative queues. */
export function receive(request: Request): Promise<Response> {
  const key = queueKey(request);
  if (key === "structural") return structural(async () => (await hub()).request(request));
  return sequential(key, async () => (await hub()).request(request));
}

export function channel(request: ChannelRequest): Promise<ChannelResponses[ChannelRequest["action"]]> {
  return sequential("channel", async () => (await hub()).channel(request));
}

/** Registers the authoritative main-runtime IPC channel. */
export function registerService(): void { ToolPkg.ipc.on<Request, Response>(CHANNEL, receive); }

/** Restores user-enabled networking when the application starts or returns to the foreground. */
export function restore(): Promise<void> { return structural(async () => (await hub()).restore()); }

/** Releases model and networking resources during application termination. */
export function terminate(): Promise<void> { return structural(async () => (await hub()).terminate()); }
