# QQ Bot（多机器人分叉版）

在官方 `com.operit.qqbot_bundle` 1.4.2 基础上改成**同时连接多个 QQ 机器人**。
每个机器人有自己的 AppID / AppSecret、角色卡、事件队列、会话绑定和自动回复循环，
互不影响；停止或删除其中一个不会动到其他机器人。

## 和原版的差别

| 项目 | 原版 1.4.2 | 本版 1.5.2 |
| --- | --- | --- |
| 账号数量 | 单个 | 任意多个，独立运行 |
| 角色卡 | 全局一个 | 每个 Bot 一个 |
| Gateway | 一个 | 每个 Bot 一个独立连接 |
| 事件队列 | 一个 | 每个 Bot 一个（各 200 条） |
| 启停 | 只能整体启停 | 可按 Bot 启停 |
| 配置存储 | 顶层扁平字段 | `bots: [...]` 数组 |

## 数据结构

配置迁移是自动的：首次加载时如果发现旧的顶层 `appId` / `appSecret` /
`autoReply` 等字段，会整体转成 `bots[0]`（名称「QQ Bot 1」），保留原有角色、
回复范围、会话绑定和待处理回复，然后删掉这些过期的顶层键。之后的配置形如：

```jsonc
{
  "bots": [
    {
      "id": "bot-xxx",
      "name": "猫娘",
      "appId": "…", "appSecret": "…",
      "useSandbox": false,
      "listenerEnabled": true,
      "waifuProfile": "default",
      "autoReply": { "characterSelection": "card:…", "c2cEnabled": true, "groupEnabled": false, … },
      "bindings": {}, "processed": [], "deliveries": []
    }
  ],
  "channelCapture": false,
  "channelOnlyWhenNoAuto": false,
  "channelConversationIds": null
}
```

`channelCapture` 这三个外部连接器字段仍然是全局共享的。

## 使用

1. 在「QQ 机器人」设置页点「添加第一个机器人」，填名称、AppID、AppSecret，
   选好这个机器人要用的角色卡。
2. 添加后卡片会出现在「我的机器人」列表里，点卡片切换正在编辑的机器人。
3. 对当前选中的机器人设置回复范围（私聊 / 群消息）、是否按成员隔离上下文等，
   然后按「启动这个机器人」——只启动它一个。
4. 需要更多角色就再点「再添加一个机器人」，重复上面的步骤。多个机器人可以同时在线。

每个私聊和群聊仍然各自绑定一个持久化的原生聊天；某次入站消息里带的
`openid` / `group_openid` 只属于收到它的那个机器人。

## 工具

新增的多机器人工具（其余工具保持原有签名，另接受可选的 `bot_id`）：

| 工具 | 用途 |
| --- | --- |
| `qqbot_bots` | 列出所有机器人及各自连接、队列、角色状态 |
| `qqbot_add_bot` | 添加一个机器人（AppID、AppSecret、名称、角色卡、是否立即启动） |
| `qqbot_update_bot` | 修改指定机器人的凭据、名称、角色卡或回复范围 |
| `qqbot_start_bot` | 只启动指定机器人 |
| `qqbot_stop_bot` | 只停止指定机器人 |
| `qqbot_remove_bot` | 停止并删除指定机器人配置 |

不传 `bot_id` 时，操作落在「第一个启用的机器人」上；只有一个机器人时行为和原版一致。
`qqbot_chat_context` 不需要 `bot_id`，它按当前聊天自动找到所属机器人。

## 并发模型

- 结构变更（添加 / 删除）单独排队，不会和任何机器人的操作交错。
- 每个机器人的操作在自己的一条队列上串行，A 机器人的慢请求不会挡住 B 机器人。
- 共享同一个 `ChannelStore`：它的内部写操作本身是串行的，保证 SQLite 一致性；
  这只影响写入次序，不影响每个机器人自己的连接和回复循环。

## 回滚

```sh
cp /data/user/0/app.operit/files/qqbot_work/qqbot.orig.toolpkg \
   <runtime>/extensions/device/packages/qqbot.toolpkg
rm -rf <runtime>/cache/toolpkg/com.operit.qqbot_bundle-*
```

然后完全重启 Operit。注意回滚后新版的 `bots` 数组不会被旧版识别，
旧版会从空配置开始，需要重新填一次 AppID / AppSecret。

## 已知限制

- **这是分叉，不是补丁。** 在市场里点更新 QQ Bot 会整个覆盖掉这些改动。
- 角色卡只在**新建会话**时生效；已经绑定过的群/私聊继续用原来的角色。
  想让某个群换角色，需要删掉对应的 Bot 会话绑定后重新触发。
- `installation_scope` 仍是 `device`，多机器人配置不随空间同步。
- 所有机器人共用同一个应用的 `channelCapture` 外部连接器设置。

## 构建与测试

```sh
cd <dev_root>
./node_modules/.bin/tsc -p packages/external/qqbot/tsconfig.json
node packages/external/qqbot/tests/multibot.test.js    # 多机器人隔离与启停
node packages/external/qqbot/tests/migration.test.js   # 旧配置升级路径
```

`multibot.test.js` 用模拟宿主验证：旧配置迁移、添加第二个机器人、重复 AppID 拒绝、
每个机器人配置互不干扰、按 Bot 停止、按 Bot 删除、首次安装空列表、各自打开 Gateway。
