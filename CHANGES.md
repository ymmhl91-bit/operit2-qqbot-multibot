# 与上游的差异（CHANGES）

上游: [AAswordman/Operit2](https://github.com/AAswordman/Operit2)
上游基线: plugins/packages/external/qqbot @ 1.4.2, plugins/packages/external/connector_hub @ 1.1.0
许可证: AGPL-3.0（未变更）

## plugins/packages/external/qqbot（1.4.2 -> 1.5.1）

### 架构: 单账号 -> 多账号

- src/model.ts
  - 新增 BotAccount 接口（id/name/appId/appSecret/useSandbox/listenerEnabled/waifuProfile/autoReply/bindings/processed/memberBindings/deliveries）
  - Config 改为 { bots: BotAccount[]; channelCapture; channelOnlyWhenNoAuto; channelConversationIds }
  - 新增 defaultBot() / defaultAutoReply() / newBotId() / normalizeConfig()：旧扁平配置自动迁移并立即落盘，保证 bot id 跨重启稳定
  - 所有请求类型增加可选 bot_id；新增 BotAddParams / BotUpdateParams 与 bots_list / bot_add / bot_update / bot_remove / bot_start / bot_stop 动作
  - Response 区分 AccountResponse（单账号）与 Response（附 bots[] 投影）；空配置时 status 可省略
- src/service.ts
  - 原 QQBotService 拆为 QQBotRuntime（每账号一个：独立 Gateway/事件队列/autoTick/绑定）+ QQBotHub（路由/聚合/生命周期）
  - 请求按 bot_id 路由；未指定时落到第一个启用监听的账号
  - 操作队列按账号隔离，A 的慢请求不阻塞 B；结构变更（增删）单独队列
  - channel.v1 新增 accounts 动作与 accountId 定向参数；status 响应带 accountId/name
  - manage start 语义修正：未显式传 autoReply 时默认开启自动回复（原版只连不答）
  - 修复：带 key 的 ack/peek/reply 先按消息 key 归属账号，不再误落到默认账号
- src/channel-api.ts
  - 新增 ChannelAccount 类型；ChannelRequest 增加 {action:"accounts"} 与可选 accountId
- src/ui/settings.ui.ts
  - 设置页改为「机器人列表 + 选中编辑」：添加/切换/删除机器人，每 Bot 独立凭据与角色卡
  - 「启动这个机器人」同时开启自动回复；已连接但未开回复时显示醒目提示
- src/tools.ts
  - 新增 6 个工具: qqbot_bots / qqbot_add_bot / qqbot_update_bot / qqbot_start_bot / qqbot_stop_bot / qqbot_remove_bot
  - 其余工具签名不变，另接受可选 bot_id
- src/openapi.ts: QQOpenApi 改为依赖 QQCredentials 结构类型，不再耦合整个 Config
- tests/（新增，Node 直跑，模拟宿主，无真实凭据）
  - migration.test.js: 旧配置迁移 / 已有 bots 优先 / 全新安装不造数据
  - multibot.test.js: 双 Bot 隔离 / 重复 AppID 拒绝 / 按 Bot 停止与删除 / 空配置可用 / 各自开 Gateway
  - connector.test.js: accounts 列表 / 按 accountId 读状态与切换回复 / 裸 start 即开回复 / ack 不串账号
  - realconfig.test.js: 真实配置迁移校验（使用者本地自行提供路径）

### 1.5.1

- src/service.ts: `manage start` 的自动回复开关改为直接写入 + 立即 flush + 回读校验
  - 旧实现走 `configureAuto({enabled, start_now:false})` 再 `request({action:"start"})` 两段式调用，两步之间存在写入窗口，后续 flush 可能把旧值写回磁盘
  - 现象：控制台/外部连接器开启自动回复后，重启 Operit 开关又变回关闭
  - 现在开关赋值后同步 `flush()`，并用 `JSON.parse(JSON.stringify(bot)).autoReply.enabled` 回读比对，不一致直接报错「自动回复开关写入未落盘，请重试」
  - `stop` 分支同样直写并 flush
- manifest.json: 版本 1.5.1

### 保留不变

QQ Gateway 协议、消息收发、Waifu 依赖、附件、引用、channel.v1 其余语义、installation_scope: device。

## plugins/packages/external/connector_hub（1.1.0 -> 1.2.2）

### 1.2.2

- 会话行副标题的机器人名改为仅在有账号元数据时显示（微信 / 飞书等无多账号能力的渠道不再显示原始 accountId，恢复官方版外观）
- tests/account-filter.test.js 对应更新：无元数据渠道断言为空串

### 1.2.1

- src/api.ts
  - 新增 ConnectorAccount（accountId/name/service/configured/listenerEnabled/autoReplyEnabled/directEnabled/groupMode/received/replied/failed/running/error）
  - Connector 增加可选 accounts: ConnectorAccount[]
  - Manage 的 start/stop/test 增加可选 accountId
- src/service.ts
  - dashboard() 对每个渠道额外调用 channel.v1 {action:"accounts"}（失败静默，兼容旧提供方）
  - manage 透传 accountId
- src/console.ui.ts
  - QQ 页新增「机器人账号」卡片列表：每账号显示名称/在线状态/私聊与群聊回复模式/收发计数，并带独立的 AI 自动回复开关与启动/停止监听按钮
  - 会话列表新增机器人筛选行（账号数 > 1 时出现），与渠道筛选/搜索叠加；切换渠道时重置
  - 会话行副标题显示归属机器人名（accountName()，找不到时回退原始 accountId）
- manifest.json: 版本 1.2.1；optional_requires 中 qqbot 最低版本升至 1.5.0
- tests/account-filter.test.js（新增）: 默认全量 / 单 Bot 过滤 / 搜索叠加 / 渠道作用域 / 行名回退 / 旧提供方兼容

## 未包含在本仓库

- .toolpkg 编译成品（按 README 构建节自行生成）
- 用户真实配置与密钥
