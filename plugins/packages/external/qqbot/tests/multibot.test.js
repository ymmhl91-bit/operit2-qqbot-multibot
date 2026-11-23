/* Verifies the multi-account service against a simulated host. */
const path = require("path");
const assert = require("assert");

const root = path.join(__dirname, "..", "dist");

/** Records every simulated host call the service makes. */
function host(initial) {
  const sockets = new Map();
  let nextSocket = 0;
  const sent = [];
  const state = {
    config: JSON.parse(JSON.stringify(initial)),
    flushes: 0,
    httpCalls: [],
    titles: [],
    socketOpens: [],
    errors: [],
  };
  const Tools = {
    Net: {
      async http(options) {
        state.httpCalls.push(options);
        if (String(options.url).includes("getAppAccessToken")) {
          return { statusCode: 200, content: JSON.stringify({ access_token: "token", expires_in: "7200" }) };
        }
        if (String(options.url).includes("/gateway/bot")) {
          return { statusCode: 200, content: JSON.stringify({ url: "wss://gateway.example" }) };
        }
        if (String(options.url).includes("/users/@me")) {
          return { statusCode: 200, content: JSON.stringify({ id: "1", username: "bot" }) };
        }
        return { statusCode: 200, content: JSON.stringify({ id: "msg" }) };
      },
      async webSocket(request) {
        if (request.op === "open") {
          const handle = `socket-${++nextSocket}`;
          sockets.set(handle, []);
          state.socketOpens.push(request.url);
          return { op: "open", handle };
        }
        if (request.op === "send") { sent.push({ handle: request.handle, text: request.text }); return { op: "sent" }; }
        if (request.op === "close") { sockets.delete(request.handle); return { op: "closed" }; }
        if (request.op === "read") {
          const queue = sockets.get(request.handle) ?? [];
          return { op: "read", events: queue.splice(0, queue.length) };
        }
        throw new Error(`unexpected socket op ${request.op}`);
      },
    },
    Chat: {
      async createNew() { return { chatId: `chat-${Math.random().toString(36).slice(2, 7)}` }; },
      async updateTitle() {},
      async updateGroup() {},
      async cancel() {},
      async sendMessageStreaming() { throw new Error("not used in this test"); },
    },
    Storage: { objects: { open() { throw new Error("storage is not part of this test"); } } },
  };
  const PluginConfig = {
    async use() { return state.config; },
    async flush(config) { state.flushes++; state.config = config; },
  };
  return { Tools, PluginConfig, state, sent };
}

/** Loads the compiled service with the simulated host installed as globals. */
function loadService(sim) {
  globalThis.Tools = sim.Tools;
  globalThis.PluginConfig = sim.PluginConfig;
  globalThis.ToolPkg = { ipc: { on() {} }, getLocalDataDir: () => "/tmp", callDependency: async () => [] };
  const pluginConsole = { log() {}, error(...args) { sim.state.errors.push(args.join(" ")); } };
  globalThis.console = pluginConsole;
  for (const key of Object.keys(require.cache)) delete require.cache[key];
  return require(path.join(root, "service.js"));
}

/** Keeps the test's own progress visible after the plugin console is replaced. */
const say = (...args) => process.stdout.write(`${args.join(" ")}
`);

/** Builds one legacy single-account configuration to prove the migration path. */
const legacy = {
  appId: "111", appSecret: "aaa", useSandbox: false, listenerEnabled: true, waifuProfile: "default",
  autoReply: { enabled: true, c2cEnabled: true, groupEnabled: true, groupContext: "shared", groupReplyMode: "mentioned",
    listenGroupMessages: true, aiTimeoutMs: 120000, chatGroup: "QQ Bot", characterSelection: "card:x", assistantInstruction: "hi" },
  bindings: {}, processed: [],
  channelCapture: false, channelOnlyWhenNoAuto: false, channelConversationIds: null,
};

(async () => {
  const sim = host(legacy);
  const service = loadService(sim);

  // --- migration: one legacy account becomes bots[0]
  const listed = await service.receive({ action: "bots_list" });
  assert.strictEqual(listed.bots.length, 1, "legacy account should migrate into exactly one bot");
  assert.strictEqual(listed.bots[0].appId, "111", "legacy appId must survive migration");
  assert.strictEqual(listed.bots[0].name, "QQ Bot 1", "migrated bot gets a readable name");
  assert.strictEqual(listed.bots[0].configured, true, "migrated credentials must still be usable");
  assert.strictEqual(listed.bots[0].autoReply.config.characterSelection, "card:x", "migrated role must be preserved");
  assert.strictEqual(sim.state.config.appId, undefined, "the superseded legacy key must be gone");
  assert.ok(Array.isArray(sim.state.config.bots), "config must persist as a bot list");
  say("ok: legacy config migrated without losing credentials or role");

  // --- add a second bot with its own role
  const added = await service.receive({ action: "bot_add", params: {
    app_id: "222", app_secret: "bbb", name: "第二个", character_selection: "card:y", group_enabled: false } });
  assert.strictEqual(added.bots.length, 2, "two bots must coexist");
  const second = added.bots.find(item => item.appId === "222");
  assert.strictEqual(second.autoReply.config.characterSelection, "card:y", "each bot keeps its own role");
  assert.strictEqual(second.autoReply.config.groupEnabled, false, "each bot keeps its own scope");
  assert.strictEqual(second.service.status, "stopped", "a new bot must not connect unasked");
  say("ok: second bot added with an independent role");

  // --- duplicates rejected
  await assert.rejects(() => service.receive({ action: "bot_add", params: { app_id: "222", app_secret: "bbb" } }), /已经添加过/);
  say("ok: duplicate AppID rejected");

  // --- per-bot isolation of settings
  const patched = await service.receive({ action: "bot_update", params: { bot_id: second.botId, character_selection: "group:z", c2c_enabled: false } });
  const first = patched.bots.find(item => item.appId === "111");
  const changed = patched.bots.find(item => item.appId === "222");
  assert.strictEqual(changed.autoReply.config.characterSelection, "group:z", "the patch applies to its own bot");
  assert.strictEqual(changed.autoReply.config.c2cEnabled, false, "the patch applies its own scope");
  assert.strictEqual(first.autoReply.config.characterSelection, "card:x", "the other bot keeps its role");
  assert.strictEqual(first.autoReply.config.c2cEnabled, true, "the other bot keeps its scope");
  say("ok: per-bot settings are isolated");

  // --- stopping one bot does not stop the other
  await service.receive({ action: "bot_stop", bot_id: changed.botId });
  const afterStop = await service.receive({ action: "bots_list" });
  assert.strictEqual(afterStop.bots.find(item => item.appId === "111").listenerEnabled, true, "stopping B must not disable A");
  assert.strictEqual(afterStop.bots.find(item => item.appId === "222").listenerEnabled, false, "the addressed bot is stopped");
  say("ok: stop is scoped to one bot");

  // --- removal leaves the other intact
  const removed = await service.receive({ action: "bot_remove", bot_id: changed.botId });
  assert.strictEqual(removed.bots.length, 1, "removal leaves the other bot");
  assert.strictEqual(removed.bots[0].appId, "111", "the survivor is the untouched bot");
  say("ok: removal is scoped to one bot");

  // --- each bot opens its own gateway without waiting for a real READY
  const starting = service.receive({ action: "bot_start", bot_id: removed.bots[0].botId });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.ok(sim.state.socketOpens.some(url => url.includes("v=1")), "the addressed bot must negotiate its own gateway");
  const duringStart = await service.receive({ action: "bots_list" });
  assert.strictEqual(duringStart.bots[0].listenerEnabled, true, "start persists the listener flag before READY");
  say("ok: addressed bot opened its own gateway");
  // Release the pending start without asserting on an environment this test cannot authenticate.
  void starting.catch(() => {});
  // --- a fresh install must answer without inventing a bot
  const fresh = host({ bots: [], channelCapture: false, channelOnlyWhenNoAuto: false, channelConversationIds: null });
  const freshService = loadService(fresh);
  const emptyList = await freshService.receive({ action: "bots_list" });
  assert.deepStrictEqual(emptyList.bots, [], "a fresh install reports an empty list");
  assert.strictEqual(emptyList.status, undefined, "a fresh install has no selected bot");
  say("ok: fresh install answers with an empty list instead of failing");
  await assert.rejects(() => freshService.receive({ action: "start" }), /添加一个机器人/, "starting without a bot must explain what is missing");
  say("ok: starting with no bot gives a usable error");


  say("\nall multi-bot service checks passed");
  process.exit(0);
})().catch(error => { say("FAILED:", error.message); say(error.stack); process.exit(1); });