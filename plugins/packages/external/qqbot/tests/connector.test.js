/* Verifies the external connector contract against several accounts. */
const path = require("path");
const assert = require("assert");

const root = path.join(__dirname, "..", "dist");

/** Records the host calls the service makes. */
function host(initial) {
  const sockets = new Map();
  let nextSocket = 0;
  const state = { config: JSON.parse(JSON.stringify(initial)), socketOpens: [], errors: [], flushes: 0 };
  const Tools = {
    Net: {
      async http(options) {
        const url = String(options.url);
        if (url.includes("getAppAccessToken")) return { statusCode: 200, content: JSON.stringify({ access_token: "t", expires_in: "7200" }) };
        if (url.includes("/gateway/bot")) return { statusCode: 200, content: JSON.stringify({ url: "wss://gw.example" }) };
        if (url.includes("/users/@me")) return { statusCode: 200, content: JSON.stringify({ id: "1", username: "bot" }) };
        return { statusCode: 200, content: JSON.stringify({ id: "m" }) };
      },
      async webSocket(request) {
        if (request.op === "open") { const handle = `s-${++nextSocket}`; sockets.set(handle, []); state.socketOpens.push(request.url); return { op: "open", handle }; }
        if (request.op === "send") return { op: "sent" };
        if (request.op === "close") { sockets.delete(request.handle); return { op: "closed" }; }
        if (request.op === "read") { const queue = sockets.get(request.handle) ?? []; return { op: "read", events: queue.splice(0, queue.length) }; }
        throw new Error(`unexpected socket op ${request.op}`);
      },
    },
    Chat: { async createNew() { return { chatId: "c1" }; }, async updateTitle() {}, async updateGroup() {}, async cancel() {}, async sendMessageStreaming() { throw new Error("unused"); } },
    Storage: { objects: { open() { throw new Error("storage unused"); } } },
  };
  const PluginConfig = { async use() { return state.config; }, async flush(config) { state.flushes++; state.config = config; } };
  return { Tools, PluginConfig, state };
}

/** Loads the compiled service against the simulated host. */
function loadService(sim) {
  globalThis.Tools = sim.Tools;
  globalThis.PluginConfig = sim.PluginConfig;
  globalThis.ToolPkg = { ipc: { on() {} }, getLocalDataDir: () => "/tmp", callDependency: async () => [] };
  globalThis.console = { log() {}, error(...args) { sim.state.errors.push(args.join(" ")); } };
  for (const key of Object.keys(require.cache)) delete require.cache[key];
  return require(path.join(root, "service.js"));
}

const say = message => process.stdout.write(`${message}\n`);

/** Two accounts, the second with replies deliberately switched off. */
const config = {
  channelCapture: false, channelOnlyWhenNoAuto: false, channelConversationIds: null,
  bots: [
    { id: "a", name: "肥鱼", appId: "111", appSecret: "x", useSandbox: false, listenerEnabled: true, waifuProfile: "default",
      autoReply: { enabled: true, c2cEnabled: true, groupEnabled: true, groupContext: "shared", groupReplyMode: "mentioned",
        listenGroupMessages: true, aiTimeoutMs: 120000, chatGroup: "QQ Bot", characterSelection: "card:feiyu", assistantInstruction: "i" },
      bindings: {}, processed: [] },
    { id: "b", name: "claude大小姐", appId: "222", appSecret: "y", useSandbox: false, listenerEnabled: true, waifuProfile: "default",
      autoReply: { enabled: false, c2cEnabled: true, groupEnabled: false, groupContext: "shared", groupReplyMode: "mentioned",
        listenGroupMessages: true, aiTimeoutMs: 120000, chatGroup: "QQ Bot", characterSelection: "card:claude", assistantInstruction: "i" },
      bindings: {}, processed: [] },
  ],
};

(async () => {
  const sim = host(config);
  const service = loadService(sim);

  // --- the console must be able to enumerate accounts instead of assuming one
  const listed = await service.channel({ action: "accounts" });
  assert.strictEqual(listed.accounts.length, 2, "both accounts must be visible to the console");
  assert.deepStrictEqual(listed.accounts.map(a => a.name), ["肥鱼", "claude大小姐"], "names identify each account");
  assert.strictEqual(listed.accounts[0].autoReplyEnabled, true, "account A reports its own reply switch");
  assert.strictEqual(listed.accounts[1].autoReplyEnabled, false, "account B reports its own reply switch");
  assert.strictEqual(listed.accounts[1].groupMode, "off", "account B's group replies are off");
  assert.strictEqual(listed.accounts[0].groupMode, "mentioned", "account A's group mode is independent");
  say("ok: console can list every account with its own switches");

  // --- status defaults to the first enabled account, and can be addressed explicitly
  const dflt = await service.channel({ action: "status" });
  assert.strictEqual(dflt.accountId, "111", "the legacy default stays the first enabled account");
  const second = await service.channel({ action: "status", accountId: "222" });
  assert.strictEqual(second.accountId, "222", "an explicit accountId reads that account");
  assert.strictEqual(second.name, "claude大小姐", "the status names the account it describes");
  assert.strictEqual(second.autoReplyEnabled, false, "account B's reply switch is reported honestly");
  say("ok: status can be read per account");

  // --- the console switch must be able to target account B.
  // The listener start itself needs a real authenticated gateway, which this
  // simulated host cannot provide; assert the routing and the reply switch.
  const pendingStart = service.channel({ action: "manage", command: "start", autoReply: true, accountId: "222" });
  void pendingStart.catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 120));
  const afterSwitch = await service.channel({ action: "status", accountId: "222" });
  assert.strictEqual(afterSwitch.accountId, "222", "the switch addressed account B");
  assert.strictEqual(afterSwitch.autoReplyEnabled, true, "turning replies on for B must stick");
  assert.strictEqual(afterSwitch.listenerEnabled, true, "starting B keeps its listener on");
  const stillA = await service.channel({ action: "status", accountId: "111" });
  assert.strictEqual(stillA.autoReplyEnabled, true, "A is untouched by a change to B");
  say("ok: replies can be switched on for a specific account only");

  // --- a bare start must imply running replies, not a connected-but-silent bot
  const silent = host({ channelCapture: false, channelOnlyWhenNoAuto: false, channelConversationIds: null,
    bots: [{ ...JSON.parse(JSON.stringify(config.bots[1])), autoReply: { ...config.bots[1].autoReply, enabled: false } }] });
  const silentService = loadService(silent);
  void silentService.channel({ action: "manage", command: "start" }).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.strictEqual(silent.state.config.bots[0].autoReply.enabled, true,
    "a bare start must persist replies as enabled, not leave the bot silent");
  say("ok: bare start enables replies instead of leaving the bot connected but silent");
  await new Promise(resolve => setTimeout(resolve, 50));

  // --- an ack for one account must never be answered by another
  const ackError = await service.channel({ action: "ack", key: "not-a-real-key" }).then(() => null, error => error.message);
  assert.ok(typeof ackError === "string", "an unknown key must be rejected instead of hitting the wrong account");
  say(`ok: unknown ack key rejected (${ackError.slice(0, 30)}…)`);

  // --- switching replies off for B must not stop A
  void service.channel({ action: "manage", command: "start", autoReply: false, accountId: "222" }).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 150));
  const bBot = sim.state.config.bots.find(bot => bot.appId === "222");
  const aBot = sim.state.config.bots.find(bot => bot.appId === "111");
  assert.strictEqual(bBot.autoReply.enabled, false, "account B's replies can be switched off");
  assert.strictEqual(aBot.autoReply.enabled, true, "account A keeps replying");
  say("ok: per-account reply switches are independent");

  say("\nexternal connector multi-account checks passed");
  process.exit(0);
})().catch(error => { say(`FAILED: ${error.message}`); say(error.stack); process.exit(1); });