import type { ComposeDslContext, ComposeNode } from "../../../../../types/compose-dsl";
import { call } from "../rpc.js";
import type { AutoReplyParams, BotAddParams, BotUpdateParams, InboundEvent, ReplyRole, Status } from "../model.js";
import { errorText } from "../model.js";

type Section = "status" | "connection" | "reply" | "diagnostics" | "bots";

/** Guides setup for several QQ bots, each with its own credentials and character. */
export default function settings(ctx: ComposeDslContext): ComposeNode {
  const [width, setWidth] = ctx.useState("layoutWidth", 0);
  const measure = ctx.Modifier.onSizeChanged(size => {
    if (size.width !== width) setWidth(size.width);
  });
  const initialized = ctx.useRef("initialized", false);
  const working = ctx.useRef("working", false);
  const [busy, setBusy] = ctx.useState("busy", "");
  const [status, setStatus] = ctx.useState<Status | null>("status", null);
  const [bots, setBots] = ctx.useState<Status[]>("bots", []);
  const [selected, setSelected] = ctx.useState("selected", "");
  const [errors, setErrors] = ctx.useState<Record<string, string>>("errors", {});
  const [messages, setMessages] = ctx.useState<Record<string, string>>("messages", {});
  const [roles, setRoles] = ctx.useState<ReplyRole[]>("roles", []);
  const [roleError, setRoleError] = ctx.useState("roleError", "");
  const [events, setEvents] = ctx.useState<InboundEvent[] | null>("events", null);
  const [editConnection, setEditConnection] = ctx.useState("editConnection", false);
  const [advanced, setAdvanced] = ctx.useState("advanced", false);
  const [diagnostics, setDiagnostics] = ctx.useState("diagnostics", false);
  const [adding, setAdding] = ctx.useState("adding", false);
  const [newName, setNewName] = ctx.useState("newName", "");
  const [newAppId, setNewAppId] = ctx.useState("newAppId", "");
  const [newSecret, setNewSecret] = ctx.useState("newSecret", "");
  const [newSelection, setNewSelection] = ctx.useState("newSelection", "");
  const [appId, setAppId] = ctx.useState("appId", "");
  const [secret, setSecret] = ctx.useState("secret", "");
  const [sandbox, setSandbox] = ctx.useState("sandbox", false);
  const [c2c, setC2c] = ctx.useState("c2c", true);
  const [group, setGroup] = ctx.useState("group", true);
  const [groupContext, setGroupContext] = ctx.useState<"shared" | "member">("groupContext", "shared");
  const [groupReplyMode, setGroupReplyMode] = ctx.useState<"mentioned" | "all">("groupReplyMode", "mentioned");
  const [listenGroupMessages, setListenGroupMessages] = ctx.useState("listenGroupMessages", true);
  const [selection, setSelection] = ctx.useState("selection", "");
  const [instruction, setInstruction] = ctx.useState("instruction", "");
  const [chatGroup, setChatGroup] = ctx.useState("chatGroup", "QQ Bot");
  const [waifuProfile, setWaifuProfile] = ctx.useState("waifuProfile", "default");
  const [deadline, setDeadline] = ctx.useState("deadline", "120");
  const colors = ctx.MaterialTheme.colorScheme;

  /** Copies one account's values into the editable drafts. */
  function populate(value: Status): void {
    setAppId(value.appId); setSandbox(value.useSandbox);
    setC2c(value.autoReply.config.c2cEnabled); setGroup(value.autoReply.config.groupEnabled);
    setGroupContext(value.autoReply.config.groupContext); setGroupReplyMode(value.autoReply.config.groupReplyMode);
    setListenGroupMessages(value.autoReply.config.listenGroupMessages);
    setSelection(value.autoReply.config.characterSelection); setInstruction(value.autoReply.config.assistantInstruction);
    setChatGroup(value.autoReply.config.chatGroup); setDeadline(String(value.autoReply.config.aiTimeoutMs / 1000));
    setWaifuProfile(value.waifuProfile);
    setSecret(""); setEditConnection(false); setEvents(null);
  }

  /** Applies a fresh multi-account snapshot without discarding the current selection. */
  function adopt(list: Status[], primary?: Status): void {
    setBots(list);
    const keep = list.find(item => item.botId === selected) ?? list.find(item => item.botId === primary?.botId) ?? list[0] ?? null;
    setSelected(keep?.botId ?? ""); setStatus(keep);
    if (keep !== null && !initialized.current) { populate(keep); initialized.current = true; }
  }

  /** Reads every account's runtime state independently from the editable fields. */
  async function refresh(): Promise<void> {
    const result = await call({ action: "bots_list" });
    if ("bots" in result) adopt(result.bots, result.status);
  }

  /** Keeps outcomes beside their controls and rejects duplicate actions before a re-render. */
  async function operate(section: Section, label: string, operation: () => Promise<string>): Promise<void> {
    if (working.current) return;
    working.current = true; setBusy(label);
    setErrors({ ...errors, [section]: "" });
    setMessages({ ...messages, [section]: "" });
    let failureMessage = "";
    try {
      const message = await operation();
      setMessages({ ...messages, [section]: message });
    } catch (failure) {
      console.error("[qqbot.ui]", failure);
      failureMessage = errorText(failure);
      setErrors({ ...errors, [section]: failureMessage });
    } finally {
      try { await refresh(); }
      catch (failure) { setErrors({ ...errors, [section]: failureMessage || `状态读取失败：${errorText(failure)}` }); }
      working.current = false; setBusy("");
    }
  }

  /** Switches the edited account and reloads its drafts. */
  function choose(target: Status): void {
    if (busy !== "" || target.botId === selected) return;
    setSelected(target.botId); setStatus(target); populate(target);
    setErrors({ ...errors, connection: "", reply: "" }); setMessages({ ...messages, connection: "", reply: "" });
  }

  /** Requires usable credentials without ever returning the saved secret to the UI. */
  function credentials(): BotUpdateParams {
    if (status === null) throw new Error("请先添加一个 QQ 机器人。");
    if (appId.trim() === "") throw new Error("请先填写这个机器人的 AppID。");
    if (secret.trim() === "" && (!status.configured || appId.trim() !== status.appId)) throw new Error("请填写这个机器人的 AppSecret。");
    return { bot_id: status.botId, app_id: appId.trim(), use_sandbox: sandbox, ...(secret.trim() === "" ? {} : { app_secret: secret.trim() }) };
  }

  /** Converts user-facing seconds once and validates all reply settings before saving. */
  function replies(): BotUpdateParams {
    if (status === null) throw new Error("请先添加一个 QQ 机器人。");
    if (!c2c && !group) throw new Error("请至少选择一种回复范围：私聊或群消息。");
    const seconds = Number(deadline);
    if (deadline.trim() === "" || !Number.isFinite(seconds) || !/^\d+(?:\.\d{1,3})?$/.test(deadline.trim()) || seconds < 1 || seconds > 600) throw new Error("回复等待时间请填写 1～600 秒。");
    if (waifuProfile.trim() === "") throw new Error("请填写回复效果配置，默认使用 default。");
    return { bot_id: status.botId, c2c_enabled: c2c, group_enabled: group, group_context: groupContext, group_reply_mode: groupReplyMode, listen_group_messages: listenGroupMessages, character_selection: selection, assistant_instruction: instruction,
      chat_group: chatGroup.trim(), waifu_profile: waifuProfile.trim(), ai_timeout_ms: Math.round(seconds * 1000) };
  }

  /** Adds one more bot; the first bot uses the same form as every later one. */
  async function add(): Promise<void> {
    await operate("bots", "正在添加机器人…", async () => {
      if (newAppId.trim() === "") throw new Error("请填写新机器人的 AppID。");
      if (newSecret.trim() === "") throw new Error("请填写新机器人的 AppSecret。");
      const params: BotAddParams = { app_id: newAppId.trim(), app_secret: newSecret.trim(),
        ...(newName.trim() === "" ? {} : { name: newName.trim() }),
        ...(newSelection.trim() === "" ? {} : { character_selection: newSelection.trim() }) };
      const result = await call({ action: "bot_add", params });
      setNewName(""); setNewAppId(""); setNewSecret(""); setNewSelection(""); setAdding(false);
      if ("status" in result && result.status !== undefined) { setSelected(result.status.botId); setStatus(result.status); populate(result.status); initialized.current = true; }
      return "机器人已添加。填写回复设置后可以单独启动它。";
    });
  }

  /** Saves and verifies the values currently visible in the connection form. */
  async function connect(): Promise<void> {
    await operate("connection", "正在验证连接…", async () => {
      await call({ action: "bot_update", params: { ...credentials(), test_connection: true } });
      setSecret(""); setEditConnection(false);
      return "接入信息已保存，连接验证通过。";
    });
  }

  /** Saves reply edits without enabling a stopped bot. */
  async function saveReplies(): Promise<void> {
    await operate("reply", "正在保存回复设置…", async () => {
      await call({ action: "bot_update", params: replies() });
      return "回复设置已保存。";
    });
  }

  /** Starts the selected bot only, leaving the other accounts untouched. */
  async function start(): Promise<void> {
    if (status === null) return;
    await operate("reply", "正在启动机器人…", async () => {
      const target = status.botId;
      // Starting a bot means it should answer, exactly like the official plugin.
      await call({ action: "bot_update", params: { ...replies(), enabled: true } });
      const update: BotUpdateParams = { ...credentials(), test_connection: true, listener_enabled: true, start: true, enabled: true };
      await call({ action: "bot_update", params: { ...update, bot_id: target } });
      setSecret(""); setEditConnection(false);
      return "机器人已启动，可以在 QQ 中发消息试试。下次打开应用时会自动恢复运行。";
    });
  }

  /** Stops only the selected bot. */
  async function stop(): Promise<void> {
    if (status === null) return;
    const target = status.botId;
    await operate("reply", "正在停止机器人…", async () => {
      await call({ action: "bot_stop", bot_id: target });
      return "机器人已停止，下次打开应用时也会保持停止。";
    });
  }

  /** Forgets one bot configuration after an explicit confirmation. */
  async function remove(): Promise<void> {
    if (status === null) return;
    const target = status.botId, name = status.name;
    await operate("bots", "正在删除机器人…", async () => {
      await call({ action: "bot_remove", bot_id: target });
      initialized.current = false;
      const remaining = bots.filter(item => item.botId !== target);
      const next = remaining[0] ?? null;
      setSelected(next?.botId ?? ""); setStatus(next);
      if (next !== null) { populate(next); initialized.current = true; }
      return `已删除「${name}」。`;
    });
  }

  /** Loads human-readable role choices through the declared character dependency. */
  async function loadRoles(): Promise<void> {
    setRoleError("");
    try {
      const result = await call({ action: "reply_roles" });
      if ("roles" in result) setRoles(result.roles);
    } catch (failure) { setRoleError(`角色列表读取失败：${errorText(failure)}`); }
  }

  function description(text: string): ComposeNode {
    return ctx.UI.Text({ text, style: "bodySmall", color: colors.onSurfaceVariant });
  }

  function field(key: string, label: string, value: string, update: (value: string) => void, options: { sensitive?: boolean; multiline?: boolean } = {}): ComposeNode {
    return ctx.UI.OutlinedTextField({ key, label, value, onValueChange: update, enabled: busy === "",
      singleLine: !options.multiline, minLines: options.multiline ? 3 : 1, maxLines: options.multiline ? 6 : 1,
      isPassword: options.sensitive === true, fillMaxWidth: true });
  }

  function toggle(key: string, label: string, checked: boolean, update: (value: boolean) => void): ComposeNode {
    return ctx.UI.Row({ fillMaxWidth: true, verticalAlignment: "center", spacing: 12 }, [
      ctx.UI.Text({ text: label, weight: 1 }), ctx.UI.Switch({ key, checked, onCheckedChange: update, enabled: busy === "" }),
    ]);
  }

  function button(key: string, label: string, onClick: () => void | Promise<void>, primary = false): ComposeNode {
    return ctx.UI[primary ? "Button" : "TextButton"]({ key, text: label, onClick, enabled: busy === "", ...(primary ? { fillMaxWidth: true } : {}) });
  }

  function feedback(section: Section): ComposeNode[] {
    return [
      ...(errors[section] ? [ctx.UI.Text({ text: errors[section], color: colors.error, style: "bodyMedium" })] : []),
      ...(messages[section] ? [description(messages[section])] : []),
    ];
  }

  function card(key: string, title: string, children: ComposeNode[], highlight = false): ComposeNode {
    return ctx.UI.Card({ key, fillMaxWidth: true, containerColor: highlight ? colors.secondaryContainer : colors.surfaceContainerLow, shape: { cornerRadius: 16 } },
      ctx.UI.Column({ fillMaxWidth: true, padding: 16, spacing: 12 }, [ctx.UI.Text({ text: title, style: "titleMedium" }), ...children]));
  }

  const connectionChanged = status !== null && (appId.trim() !== status.appId || secret !== "" || sandbox !== status.useSandbox);
  const saved = status?.autoReply.config;
  const replyChanged = saved !== undefined && (c2c !== saved.c2cEnabled || group !== saved.groupEnabled || groupContext !== saved.groupContext || groupReplyMode !== saved.groupReplyMode || listenGroupMessages !== saved.listenGroupMessages || selection !== saved.characterSelection || instruction !== saved.assistantInstruction
    || chatGroup.trim() !== saved.chatGroup || waifuProfile.trim() !== status?.waifuProfile || Number(deadline) * 1000 !== saved.aiTimeoutMs);
  const active = status !== null && (status.service.status === "ready" || status.service.status === "connecting" || status.autoReply.running);
  const replyOff = status !== null && status.service.status === "ready" && !status.autoReply.running;
  const state = status === null ? "尚未添加机器人" : !status.configured ? `${status.name}：尚未接入 QQ` : {
    stopped: `${status.name}：已停止`, connecting: `${status.name}：正在连接 QQ…`, ready: status.autoReply.running ? `${status.name}：运行中` : `${status.name}：已连接，自动回复未运行`, error: `${status.name}：连接失败`,
  }[status.service.status];
  const choices: ReplyRole[] = [{ selection: "", name: "跟随当前角色" }, { selection: "model:chat", name: "模型对话" }, ...roles];
  if (!choices.some(role => role.selection === selection)) choices.push({ selection, name: "已保存的角色（不在当前列表中）" });
  const newChoices: ReplyRole[] = [{ selection: "", name: "跟随当前角色" }, ...roles];

  const botCards: ComposeNode[] = bots.map(item => ctx.UI.Card({ key: `bot:${item.botId}`, fillMaxWidth: true,
    containerColor: item.botId === selected ? colors.secondaryContainer : colors.surfaceContainerLow, shape: { cornerRadius: 12 } },
    ctx.UI.Row({ fillMaxWidth: true, padding: 12, spacing: 12, verticalAlignment: "center", onClick: () => choose(item) }, [
      ctx.UI.Column({ weight: 1, spacing: 4 }, [
        ctx.UI.Text({ text: `${item.name}${item.botId === selected ? " · 正在编辑" : ""}`, style: "titleSmall" }),
        ctx.UI.Text({ text: `AppID ${item.appId || "未填写"} · ${item.useSandbox ? "沙箱" : "正式"} · ${item.service.status === "ready" ? (item.autoReply.running ? "运行中" : "已连接") : item.service.status === "error" ? "连接失败" : item.service.status === "connecting" ? "连接中" : "已停止"}`,
          style: "bodySmall", color: colors.onSurfaceVariant }),
        ctx.UI.Text({ text: item.autoReply.config.characterSelection === "" ? "角色：跟随当前角色" : `角色：${roles.find(role => role.selection === item.autoReply.config.characterSelection)?.name ?? item.autoReply.config.characterSelection}`,
          style: "bodySmall", color: colors.onSurfaceVariant }),
      ]),
      ctx.UI.TextButton({ key: `use:${item.botId}`, text: "编辑", enabled: busy === "", onClick: () => choose(item) }),
    ])));

  const addFields: ComposeNode[] = [
    description("每个机器人有独立的 AppID、AppSecret、角色卡和回复队列，可以同时运行。"),
    field("newName", "名称（可选）", newName, setNewName),
    field("newAppId", "AppID", newAppId, setNewAppId),
    field("newSecret", "AppSecret", newSecret, setNewSecret, { sensitive: true }),
    ctx.UI.DropdownMenu({ key: "newRole", label: "回复角色", text: newChoices.find(role => role.selection === newSelection)!.name,
      enabled: busy === "", fillMaxWidth: true, onClick: index => setNewSelection(newChoices[index].selection) },
      newChoices.map(role => ctx.UI.Text({ text: role.name, paddingVertical: 8 }))),
    button("confirmAdd", "添加机器人", add, true),
    button("cancelAdd", "取消", () => { setAdding(false); setNewName(""); setNewAppId(""); setNewSecret(""); setNewSelection(""); }),
  ];
  const addCard = card("addCard", "添加机器人", [...addFields, ...feedback("bots")]);
  const botsCard = card("botsCard", "我的机器人", [
    description(`已添加 ${bots.length} 个机器人。点击卡片切换正在编辑的机器人。`),
    ...(bots.length === 0 ? [description("还没有机器人，先添加一个。")] : botCards),
    ...(adding ? [] : [button("addBot", bots.length === 0 ? "添加第一个机器人" : "再添加一个机器人", () => setAdding(true), true)]),
  ], bots.length === 0);

  const connectionFields: ComposeNode[] = status !== null && (editConnection || !status.configured) ? [
    description("从 QQ 开放平台的机器人管理页面获取这个机器人的 AppID 和 AppSecret。"),
    field("appId", "AppID", appId, setAppId),
    field("secret", status.configured && appId.trim() === status.appId ? "AppSecret（已保存，留空保留）" : "AppSecret", secret, setSecret, { sensitive: true }),
    toggle("sandbox", "使用沙箱环境（测试机器人）", sandbox, setSandbox),
    button("connect", "保存并验证", connect, true),
  ] : [
    description(status === null ? "请先添加一个机器人。" : `AppID：${status.appId} · ${status.useSandbox ? "沙箱环境" : "正式环境"} · 密钥已保存`),
    ...(connectionChanged ? [description("接入信息有未保存的修改，启动时会一起保存并验证。")] : []),
    button("editConnection", "修改接入信息", () => setEditConnection(true)),
  ];

  const replyFields: ComposeNode[] = [
    // Surface the exact state the console shows, so "connected but silent" is never a mystery.
    ...(replyOff ? [ctx.UI.Text({ text: "这个机器人已连接，但自动回复没有运行。点下方按钮可开启。", color: colors.error })] : []),
    ctx.UI.DropdownMenu({ key: "role", label: "回复角色", text: choices.find(role => role.selection === selection)!.name,
      enabled: busy === "", fillMaxWidth: true, onClick: index => setSelection(choices[index].selection) },
      choices.map(role => ctx.UI.Text({ text: role.name, paddingVertical: 8 }))),
    description("这个机器人单独使用的角色。每个私聊和群聊都有独立会话；更换角色用于新会话，已有会话保留原来的角色。"),
    ...(roleError ? [ctx.UI.Text({ text: roleError, color: colors.error }), button("reloadRoles", "重新读取角色", loadRoles)] : []),
    toggle("c2c", "回复私聊消息", c2c, setC2c),
    toggle("group", "回复群消息", group, setGroup),
    toggle("listenGroupMessages", "记录群友普通消息", listenGroupMessages, setListenGroupMessages),
    description("记录实际收到的最近 80 条群消息，供 AI 按需读取；普通消息不会默认触发回复。能否收到未 @ 消息取决于 QQ 开放平台授予的事件权限。"),
    toggle("isolateMembers", "按成员隔离群上下文", groupContext === "member", enabled => setGroupContext(enabled ? "member" : "shared")),
    description(groupContext === "shared" ? "同群共享一个会话。触发自动回复的新消息会打断正在生成的回复。不同群和私聊互相独立。" : "每位成员使用独立 AI 会话。触发自动回复的新消息只会打断同一成员的回复，读取前文也只返回该成员的消息。"),
    ctx.UI.DropdownMenu({ key: "groupReplyMode", label: "群消息回复条件", text: groupReplyMode === "mentioned" ? "仅被 @ 时回复" : "回复所有收到的群消息",
      enabled: busy === "", fillMaxWidth: true, onClick: index => setGroupReplyMode(index === 0 ? "mentioned" : "all") },
      [ctx.UI.Text({ text: "仅被 @ 时回复", paddingVertical: 8 }), ctx.UI.Text({ text: "回复所有收到的群消息", paddingVertical: 8 })]),
    button("advanced", advanced ? "收起高级设置" : "高级设置", () => setAdvanced(!advanced)),
  ];
  if (advanced) replyFields.push(
    field("deadline", "回复等待时间（秒，1～600）", deadline, setDeadline),
    field("instruction", "回复要求", instruction, setInstruction, { multiline: true }),
    field("chatGroup", "聊天记录分组", chatGroup, setChatGroup),
    field("waifuProfile", "回复效果配置", waifuProfile, setWaifuProfile),
    description("默认使用 default。分句、表情等效果在 Waifu 插件中配置。"),
  );
  if (replyChanged) replyFields.push(button("saveReplies", "保存回复设置", saveReplies), description(active ? "修改尚未保存。保存后会用于后续回复。" : "修改尚未保存。启动机器人时也会一起保存。"));
  if (status?.autoReply.running || status?.service.status === "connecting") replyFields.push(button("stop", "停止这个机器人", stop, true));
  else {
    replyFields.push(button("start", connectionChanged || replyChanged ? "保存并启动这个机器人" : "启动这个机器人", start, true));
    if (active) replyFields.push(button("stop", "停止这个机器人", stop));
  }
  replyFields.push(button("remove", "删除这个机器人", remove), ...feedback("reply"));

  const statusCard = card("statusCard", state, [
      description(status === null ? "先添加一个机器人。" : `已回复 ${status.autoReply.repliedCount} 条消息 · 待处理 ${status.queue.size}/${status.queue.capacity} 条`),
      ...(busy ? [description(busy)] : []),
      ...(status?.service.lastError ? [ctx.UI.Text({ text: `连接错误：${status.service.lastError}`, color: colors.error })] : []),
      ...(status?.autoReply.lastError ? [ctx.UI.Text({ text: `回复错误：${status.autoReply.lastError}`, color: colors.error })] : []),
      ctx.UI.TextButton({ key: "refresh", text: "刷新状态", enabled: busy === "", onClick: async () => {
        if (status === null) { initialized.current = false; await load(); }
        else await operate("status", "正在刷新状态…", async () => { await refresh(); return ""; });
      } }),
      ...feedback("status"),
    ], status?.autoReply.running === true);
  const connectionCard = card("connectionCard", "2. 接入 QQ", [...connectionFields, ...feedback("connection")]);
  const replyCard = card("replyCard", "3. 设置回复", replyFields);
  const panes: ComposeNode[] = status === null ? [
    ...(adding ? [addCard, botsCard] : [botsCard]),
  ] : [
    statusCard,
    botsCard,
    ...(adding ? [addCard] : []),
    connectionCard,
    replyCard,
  ];
  const children: ComposeNode[] = [
    ctx.UI.Text({ text: "QQ 机器人", style: "headlineMedium" }),
    description(`可以同时接入多个 QQ 机器人，每个机器人使用自己的角色卡自动回复。`),
    width >= 900
      ? ctx.UI.Row({ key: "qqbot-panes", fillMaxWidth: true, spacing: 20, verticalAlignment: "start" }, [
        ctx.UI.Column({ weight: 1, spacing: 16 }, panes.slice(0, 3)),
        ctx.UI.Column({ weight: 1, spacing: 16 }, panes.slice(3)),
      ])
      : ctx.UI.Column({ key: "qqbot-panes", fillMaxWidth: true, spacing: 16 }, panes),
    button("diagnostics", diagnostics ? "收起诊断信息" : "诊断信息", () => setDiagnostics(!diagnostics)),
  ];
  if (diagnostics) children.push(card("diagnosticsCard", "诊断信息", [
    description(`收到事件：${status?.service.receivedCount ?? 0} · 待处理：${status?.queue.size ?? 0}/${status?.queue.capacity ?? 200}`),
    button("recentEvents", "查看待处理消息", () => operate("diagnostics", "正在读取消息…", async () => {
      const result = await call({ action: "receive", params: { limit: 10, consume: false, ...(status === null ? {} : { bot_id: status.botId }) } });
      if ("events" in result) setEvents(result.events);
      return "";
    })),
    ...(events === null ? [] : events.length === 0 ? [description("暂无待处理消息。自动回复已处理的消息可在聊天记录中查看。")] : events.map(event =>
      description(`${event.scene === "c2c" ? "私聊" : event.scene === "group" ? "群消息" : event.eventType} · ${event.timestamp || event.receivedAt}\n${event.content || "[非文本消息]"}`))),
    ...(status?.autoReply.deliveries ?? []).filter(item => item.state === "failed").flatMap(item => [
      description(`回复未完成 · 已发送 ${item.delivered} 段\n${item.error}\n重试可能重复发送，请先核对 QQ 中的回复。`),
      button(`retry:${item.key}`, "确认后重试", () => operate("diagnostics", "正在恢复回复…", async () => { await call({ action: "retry_delivery", key: item.key, ...(status === null ? {} : { bot_id: status.botId }) }); return "已加入回复队列。"; })),
      button(`skip:${item.key}`, "跳过这条回复", () => operate("diagnostics", "正在跳过…", async () => { await call({ action: "retry_delivery", key: item.key, skip: true, ...(status === null ? {} : { bot_id: status.botId }) }); return "已跳过这条回复。"; })),
    ]),
    ...feedback("diagnostics"),
    button("clearEvents", "清空待处理事件", () => operate("diagnostics", "正在清空事件…", async () => {
      const result = await call({ action: "clear", ...(status === null ? {} : { bot_id: status.botId }) }); setEvents([]);
      return "clearedCount" in result ? `已清空 ${result.clearedCount} 条待处理事件。` : "";
    })),
  ]));

  /** Loads drafts once, leaving a failed initial load available for an explicit retry. */
  async function load(): Promise<void> {
    if (initialized.current || working.current) return;
    working.current = true; setBusy("正在读取配置…");
    try {
      const result = await call({ action: "bots_list" });
      if ("bots" in result) adopt(result.bots, result.status);
      setErrors({ ...errors, status: "" });
    } catch (failure) { setErrors({ ...errors, status: `配置读取失败：${errorText(failure)}` }); }
    finally { working.current = false; setBusy(""); }
    await loadRoles();
  }

  return ctx.UI.LazyColumn({ fillMaxSize: true, modifier: measure, padding: 16, spacing: 16, onLoad: load }, children);
}