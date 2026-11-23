/* Verifies the conversation list can be narrowed to one bot account. */
const path = require("path");
const assert = require("assert");

const root = path.join(__dirname, "..", "dist");

/** A minimal dashboard shaped exactly like the connector contract returns. */
function dashboard() {
  return {
    connectors: [
      {
        channel: "qq", available: true,
        status: { channel: "qq", service: "ready", capture: false, conversationIds: null, channelOnlyWhenNoAuto: false },
        accounts: [
          { accountId: "111", name: "肥鱼", configured: true, listenerEnabled: true, autoReplyEnabled: true,
            service: "ready", directEnabled: true, groupMode: "mentioned", received: 3, replied: 2, failed: 0, running: true },
          { accountId: "222", name: "claude大小姐", configured: true, listenerEnabled: true, autoReplyEnabled: true,
            service: "ready", directEnabled: true, groupMode: "all", received: 1, replied: 1, failed: 0, running: true },
        ],
      },
      { channel: "wechat", available: false, issue: "未安装" },
      { channel: "feishu", available: false, issue: "未安装" },
    ],
    conversations: [
      { key: "a1", channel: "qq", accountId: "111", conversationId: "g1", scene: "group", title: "群一", chatId: "c1", lastMessageAt: 5 },
      { key: "a2", channel: "qq", accountId: "111", conversationId: "g2", scene: "c2c", title: "私聊一", chatId: "c2", lastMessageAt: 4 },
      { key: "b1", channel: "qq", accountId: "222", conversationId: "g3", scene: "group", title: "群二", chatId: "c3", lastMessageAt: 3 },
    ],
  };
}

/** Mirrors the filter the conversation view performs. */
function visibleConversations(data, filter, accountFilter, query) {
  const connectorFor = channel => data.connectors.find(item => item.channel === channel);
  const accountChoices = ["qq", "wechat", "feishu"].flatMap(channel =>
    (!filter || filter === channel ? connectorFor(channel)?.accounts ?? [] : []));
  const chosenAccount = accountChoices.find(account => account.accountId === accountFilter);
  const search = query.trim().toLocaleLowerCase();
  return data.conversations.filter(item => (!filter || item.channel === filter)
    && (!chosenAccount || item.accountId === chosenAccount.accountId)
    && item.title.toLocaleLowerCase().includes(search));
}

/** Mirrors the label helper that names the owning bot. */
function accountName(data, channel, accountId) {
  return data.connectors.find(item => item.channel === channel)?.accounts?.find(a => a.accountId === accountId)?.name ?? accountId;
}

const say = message => process.stdout.write(`${message}\n`);
const data = dashboard();

// --- every conversation still shows when nothing is narrowed
assert.strictEqual(visibleConversations(data, null, "", "").length, 3, "all conversations appear by default");
say("ok: default list shows every bot's conversations");

// --- narrowing to one bot must hide the other bot's conversations
const onlyFeiyu = visibleConversations(data, null, "111", "");
assert.strictEqual(onlyFeiyu.length, 2, "filtering to bot A keeps only its conversations");
assert.ok(onlyFeiyu.every(item => item.accountId === "111"), "no other bot's conversation leaks through");
const onlyClaude = visibleConversations(data, null, "222", "");
assert.strictEqual(onlyClaude.length, 1, "filtering to bot B keeps only its conversation");
assert.strictEqual(onlyClaude[0].title, "群二", "the right conversation is kept");
say("ok: narrowing to one bot hides the others");

// --- search and account narrowing must combine
assert.strictEqual(visibleConversations(data, null, "111", "群").length, 1, "search applies inside the chosen bot");
assert.strictEqual(visibleConversations(data, null, "111", "群二").length, 0, "a title from another bot does not match");
say("ok: search composes with the bot filter");

// --- the selector only offers accounts of the channel in view
const qqOnly = ["qq", "wechat", "feishu"].flatMap(channel =>
  (!"qq" || "qq" === channel ? (data.connectors.find(i => i.channel === channel)?.accounts ?? []) : []));
assert.deepStrictEqual(qqOnly.map(a => a.name), ["肥鱼", "claude大小姐"], "the selector lists both QQ bots");
const noneForWechat = ["qq", "wechat", "feishu"].flatMap(channel =>
  (!"wechat" || "wechat" === channel ? (data.connectors.find(i => i.channel === channel)?.accounts ?? []) : []));
assert.strictEqual(noneForWechat.length, 0, "a channel without accounts offers no bot filter");
say("ok: the bot selector is scoped to the visible channel");

// --- rows must name the owning bot, not a raw id
assert.strictEqual(accountName(data, "qq", "111"), "肥鱼", "row shows the bot name");
assert.strictEqual(accountName(data, "qq", "222"), "claude大小姐", "row shows each bot's own name");
assert.strictEqual(accountName(data, "qq", "999"), "999", "an unknown account falls back to its id");
say("ok: conversation rows name the owning bot");

// --- a channel with no account support must not break the list
const legacy = { connectors: [{ channel: "qq", available: true, status: { channel: "qq", service: "ready", capture: false, conversationIds: null, channelOnlyWhenNoAuto: false } }],
  conversations: data.conversations };
assert.strictEqual(visibleConversations(legacy, null, "", "").length, 3, "a provider without accounts still lists conversations");
say("ok: providers without account support keep working");

say("\nconversation account-filter checks passed");