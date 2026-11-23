# Operit2 QQ Bot Multi-Bot Fork

基于 [AAswordman/Operit2](https://github.com/AAswordman/Operit2) 官方插件 `qqbot`(1.4.2) 与 `connector_hub`(1.1.0) 的分叉，让一个设备同时连接并运行**多个 QQ 机器人**，每个机器人使用自己的角色卡、凭据、事件队列与 AI 回复循环。

**License: AGPL-3.0**（继承自上游，未变更）。

## 为什么分叉

官方版 QQ Bot 是单账号设计：一份配置只能挂一个 AppID、一个 Gateway、一个事件队列、一个回复循环。这个分叉把它改成多账号架构：

- 配置改为 `bots[]` 数组，每个元素是一个完整 Bot 配置（凭据/角色/范围/绑定）
- 每个 Bot 独立 Gateway 连接、事件队列（各 200 条）、AI 回复循环
- 按账号启停，启停一个 Bot 不影响其他 Bot
- 每 Bot 独立操作队列，A 的慢请求不阻塞 B
- 旧配置首次加载自动迁移为 `bots[0]` 并立即落盘，不丢凭据/角色/会话绑定

外部连接器随之升级：QQ 页新增「机器人账号」面板（每账号独立开关），会话列表新增「按机器人筛选」。

## 下载

从 [Releases](https://github.com/ymmhl91-bit/operit2-qqbot-multibot/releases/latest) 下载编译好的插件包：

- [qqbot-1.5.0.toolpkg](https://github.com/ymmhl91-bit/operit2-qqbot-multibot/releases/latest/download/qqbot-1.5.0.toolpkg)
- [connector_hub-1.2.1.toolpkg](https://github.com/ymmhl91-bit/operit2-qqbot-multibot/releases/latest/download/connector_hub-1.2.1.toolpkg)

命令行直下：

```sh
curl -LO https://github.com/ymmhl91-bit/operit2-qqbot-multibot/releases/latest/download/qqbot-1.5.0.toolpkg
curl -LO https://github.com/ymmhl91-bit/operit2-qqbot-multibot/releases/latest/download/connector_hub-1.2.1.toolpkg
```

想自己编译则看下文「构建」。

## 仓库结构

```
plugins/packages/external/
+-- qqbot/          QQ Bot 多机器人分叉 (1.5.0): src/ tests/ manifest.json tsconfig.json README.md
+-- connector_hub/  外部连接器多账号分叉 (1.2.1): src/ tests/ resources/ manifest.json tsconfig.json README.md
```

`.toolpkg` 成品不在 git 中，按「构建」一节自行编译。

## 与上游的差异

详见 [CHANGES.md](CHANGES.md)。摘要：

| 包 | 上游 | 本分叉 | 主要改动 |
|---|---|---|---|
| qqbot | 1.4.2 | 1.5.0 | 单账号改多账号; 新增 6 个管理工具; channel.v1 加 accounts/accountId; 启动即开回复; ack 按账号路由修复 |
| connector_hub | 1.1.0 | 1.2.1 | 机器人账号面板; 会话列表按机器人筛选; 依赖 qqbot>=1.5.0 |

## 构建

每个包独立编译，不依赖上游 monorepo：

```sh
npm install typescript@5.6.3
cd plugins/packages/external/qqbot
npx tsc -p tsconfig.json
# dist/ 生成后，与 manifest.json src/ 一起 zip 成 .toolpkg
```

connector_hub 同理，注意带上 src/vendor/qrcode.js。

## 测试

所有测试用模拟宿主（mock Tools/PluginConfig/ToolPkg），不需要真实 QQ 凭据：

```sh
cd plugins/packages/external/qqbot
node tests/migration.test.js     # 旧配置自动迁移
node tests/multibot.test.js      # 多机器人隔离与启停
node tests/connector.test.js     # 外部连接器契约
node tests/realconfig.test.js path/to/qqbot.json   # 真实配置迁移验证（本地运行）

cd ../connector_hub
node tests/account-filter.test.js
```

## 安装

把编译产物（manifest.json + dist/ + src/）zip 后改名 .toolpkg，在 Operit2 插件管理导入。connector_hub 声明 com.operit.qqbot_bundle >= 1.5.0，先装 qqbot。

## 同账户相关项目

- [waifu-manager](https://github.com/ymmhl91-bit/waifu-manager) — 同一账户下的另一个 Operit2 插件分叉：给 waifu 插件补上自定义情绪分类能力，并附带命令行批量整理工具。与本项目的 qqbot 多账号分叉兼容（waifu fork 保持同名包 id，多机器人版的 Waifu 分句依赖无需改动即可使用）。

## 上游与许可

- 上游: https://github.com/AAswordman/Operit2 （AGPL-3.0）
- 上游插件位于 plugins/packages/external/{qqbot,connector_hub}，本身不带 LICENSE 文件，许可来自宿主仓库 AGPL-3.0
- 本仓库是 AGPL-3.0 衍生作品，按协议随源码分发
- 修改明细见 CHANGES.md，商标与第三方说明见 NOTICES.md
