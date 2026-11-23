/* Proves the upgrade path keeps real bot data and drops superseded top-level keys. */
const path = require("path");
const assert = require("assert");

const root = path.join(__dirname, "..", "dist");
globalThis.Tools = null;
globalThis.PluginConfig = { use: async () => ({}), flush: async () => {} };
globalThis.ToolPkg = { ipc: { on() {} }, getLocalDataDir: () => "/tmp", callDependency: async () => [] };
globalThis.console = { log() {}, error() {} };

const { normalizeConfig } = require(path.join(root, "model.js"));
const say = message => process.stdout.write(`${message}\n`);

/** Leaves both a real bot list and stale single-account keys in one file. */
const stale = {
  appId: "999", appSecret: "zzz", listenerEnabled: true, waifuProfile: "native",
  autoReply: { enabled: true }, bindings: {}, processed: [],
  bots: [{ id: "bot-a", name: "A", appId: "111", appSecret: "aaa", useSandbox: false, listenerEnabled: true, waifuProfile: "default",
    autoReply: { enabled: true, c2cEnabled: true, groupEnabled: false, groupContext: "member", groupReplyMode: "all",
      listenGroupMessages: false, aiTimeoutMs: 5000, chatGroup: "G", characterSelection: "card:a", assistantInstruction: "i" },
    bindings: {}, processed: [] }],
  channelCapture: true, channelOnlyWhenNoAuto: false, channelConversationIds: null,
};

const { config: out, migrated } = normalizeConfig(stale);
assert.strictEqual(migrated, true, "an upgrade must be reported so it can be persisted");
assert.strictEqual(out.bots.length, 1, "an existing bot list must not be duplicated by the legacy keys");
assert.strictEqual(out.bots[0].id, "bot-a", "an existing bot identity must be preserved");
assert.strictEqual(out.bots[0].appId, "111", "the bot keeps its own AppID, not the stale one");
assert.strictEqual(out.bots[0].appSecret, "aaa", "the bot keeps its own secret");
assert.strictEqual(out.bots[0].autoReply.characterSelection, "card:a", "the bot keeps its own role");
assert.strictEqual(out.bots[0].autoReply.groupEnabled, false, "the bot keeps its own scope");
assert.strictEqual(out.bots[0].autoReply.aiTimeoutMs, 5000, "the bot keeps its own timeout");
assert.ok(!("appId" in out), "the stale top-level appId must be gone");
assert.ok(!("listenerEnabled" in out), "the stale listener flag must be gone");
assert.ok(!("autoReply" in out), "the stale reply config must be gone");
assert.strictEqual(out.channelCapture, true, "shared capture settings must survive");
say("ok: existing bot list wins over stale single-account keys");

/** Leaves a fresh install with nothing but defaults. */
const { config: empty, migrated: emptyMigrated } = normalizeConfig({ bots: [], channelCapture: false, channelOnlyWhenNoAuto: false, channelConversationIds: null });
assert.strictEqual(empty.bots.length, 0, "a fresh install must not invent a bot");
assert.strictEqual(emptyMigrated, false, "an already-clean config must not be rewritten");
say("ok: fresh install stays empty");

/** Leaves a legacy file with no bot list at all. */
const { config: legacyOnly } = normalizeConfig({ appId: "777", appSecret: "sss", listenerEnabled: true,
  autoReply: { characterSelection: "group:k" }, bindings: {}, processed: [] });
assert.strictEqual(legacyOnly.bots.length, 1, "a legacy account must become exactly one bot");
assert.strictEqual(legacyOnly.bots[0].appId, "777", "the legacy AppID must move into the bot");
assert.strictEqual(legacyOnly.bots[0].autoReply.characterSelection, "group:k", "the legacy role must move into the bot");
assert.strictEqual(legacyOnly.bots[0].autoReply.c2cEnabled, true, "missing legacy fields must fall back to defaults");
assert.strictEqual(legacyOnly.bots[0].listenerEnabled, true, "an enabled legacy listener stays enabled");
say("ok: legacy-only file migrates completely");

say("\nall upgrade-path checks passed");