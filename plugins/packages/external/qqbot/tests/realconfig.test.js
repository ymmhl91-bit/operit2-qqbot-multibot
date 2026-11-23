/* Replays the user's real persisted config through the upgrade path. */
const path = require("path");
const fs = require("fs");
const assert = require("assert");

const root = path.join(__dirname, "..", "dist");
const source = process.argv[2];

globalThis.Tools = null;
globalThis.PluginConfig = { use: async () => ({}), flush: async () => {} };
globalThis.ToolPkg = { ipc: { on() {} }, getLocalDataDir: () => "/tmp", callDependency: async () => [] };
globalThis.console = { log() {}, error() {} };

const { normalizeConfig } = require(path.join(root, "model.js"));
const say = message => process.stdout.write(`${message}\n`);

const before = JSON.parse(fs.readFileSync(source, "utf8"));
const { config: after, migrated } = normalizeConfig(JSON.parse(JSON.stringify(before)));
assert.strictEqual(migrated, true, "the real legacy file must be recognised as needing an upgrade");
const bot = after.bots[0];

assert.strictEqual(after.bots.length, 1, "the single real account becomes exactly one bot");
assert.strictEqual(bot.appId, before.appId, "AppID must survive");
assert.strictEqual(bot.appSecret, before.appSecret, "AppSecret must survive");
assert.strictEqual(bot.useSandbox, before.useSandbox, "sandbox flag must survive");
assert.strictEqual(bot.listenerEnabled, before.listenerEnabled, "listener flag must survive");
assert.strictEqual(bot.waifuProfile, before.waifuProfile, "waifu profile must survive");
assert.deepStrictEqual(bot.autoReply, { ...bot.autoReply, ...before.autoReply }, "reply config must survive");
assert.deepStrictEqual(bot.bindings, before.bindings, "existing chat bindings must survive");
assert.deepStrictEqual(bot.processed, before.processed, "processed marker must survive");
assert.strictEqual(bot.bindingsAccountId, before.bindingsAccountId ?? before.appId, "binding owner must survive");
assert.strictEqual((bot.memberBindings ?? {}).constructor, Object, "member bindings stay addressable");
assert.strictEqual((bot.deliveries ?? []).length, (before.deliveries ?? []).length, "pending replies must not be dropped silently");
assert.strictEqual(after.channelCapture, before.channelCapture, "shared capture flag must survive");
assert.strictEqual(after.channelConversationIds, before.channelConversationIds, "capture allowlist must survive");
assert.ok(!("appId" in after), "superseded top-level appId must be removed");
assert.ok(!("autoReply" in after), "superseded top-level autoReply must be removed");
assert.ok(!("deliveries" in after), "superseded top-level deliveries must be removed");

say(`ok: real account migrated — ${Object.keys(bot.bindings).length} bindings, ${(bot.deliveries ?? []).length} deliveries kept`);
say(`ok: bot name derived as "${bot.name}"`);
say(`ok: reply scope c2c=${bot.autoReply.c2cEnabled} group=${bot.autoReply.groupEnabled} mode=${bot.autoReply.groupReplyMode}`);
say("\nreal-config migration verified");