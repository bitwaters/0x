## Context

当前消息由 `telegram/messages.ts` 输出纯文本，transport 只发送 `chat_id + text`；安全事实以 JSON 展示，快照没有名称、Symbol、当前市值、当前排名或激活文案。所需身份和榜单字段已存在于 GMGN trending 原始响应，固定池事实已存在于 CoinGecko 资格快照，因此无需新增请求、依赖或数据库表。详见 proposal.md 与 `telegram-signal-card-presentation` 规格。

## Goals / Non-Goals

**Goals:**

- 用一个共享信号模板和一个共享雷达模板实现 SOL/BSC 明显区分。
- 让新消息和后续 edit 使用相同 HTML 正文与唯一 GMGN URL 按钮。
- 复用发送决策时已有事实，保持 outbox、回执与评估快照可复现。
- 对历史 outbox/followup 快照保持安全兼容。

**Non-Goals:**

- 不改变发现、资格、安全、追高、Beta 或评估规则。
- 不增加图片、Logo、图表、综合评分、自动交易、回调处理或新 API。
- 不承诺所有 Telegram 客户端对正文代码实体使用完全相同的单击复制手势。

## Decisions

### 1. 渲染结果包含正文和唯一按钮

消息渲染器返回轻量 presentation：HTML 正文、`parse_mode=HTML`、关闭链接预览的选项，以及一行一个 GMGN URL 按钮。send 与 edit 共用该 presentation，避免状态编辑丢失按钮或回退为纯文本。

替代方案是把 URL 写入正文或引入图片卡；前者降低可扫读性，后者增加下载、缓存和失败路径，因此不采用。

### 2. CA 使用正文代码实体，不使用 copy_text 按钮

完整 CA 位于名称之后并用 `<code>`/`<pre>` 表达，兼容客户端可提供原生复制交互。Inline keyboard 只含 GMGN URL；不使用 Telegram `copy_text`，以满足底部只有 GMGN 的产品约束。

### 3. 展示 DTO 只增加已有事实

GMGN trending 合同严格解析 `name` 与 `symbol`，资格快照补充最新 1m 排名、市值、同源当前涨幅和激活原因。雷达渲染从已持久化的最新 rank snapshot 与 activation event 取得相同展示字段。所有内容均来自当前调用或 SQLite 证据，不额外请求 GMGN/CoinGecko。

新增字段集中在 presentation snapshot，不把展示字段变成筛选条件。旧持久化 snapshot 缺少 presentation 时使用有界兼容渲染，避免重启中的历史状态编辑崩溃。

### 4. 一个主体模板，仅风险尾部按链分支

共同顺序为：链与状态 → 身份/CA → 市场 → 热度/成交 → 深度 → 风险 → 固定池/时间 → 风险声明。SOL 只追加 Mint/Freeze；BSC 只追加蜜罐、开源、权限和税率。不会复制两个完整模板。

### 5. 名称和链接均关闭式处理

名称/Symbol 在展示前去除首尾空白、限制 Unicode code point 长度并执行 HTML 转义；地址继续走现有链规范化。GMGN URL 由固定 origin、`sol|bsc` 枚举和编码后的 CA 构造，不读取 raw URL、社交链接或 referral 字段。

### 6. 用户状态原因使用固定中文映射

已知内部原因码映射为短中文；未知且已经脱敏的错误统一显示“最新风险数据无法确认”，原代码与详细证据只留数据库。价格状态如当前流程没有保存精确漂移比例，则不伪造数值，只显示已确认阈值原因。

## Risks / Trade-offs

- [不同 Telegram 客户端的正文复制手势不同] → 使用标准 code/pre entity，并在 iOS、Android、Desktop 实测；不声称 Bot 能强制客户端剪贴板行为。
- [新增严格名称字段导致提供商契约变化时批次失败] → 仅在已确认生产字段存在后纳入合同，并以 fixture 覆盖转义、空值和长度边界。
- [旧快照缺少展示字段] → 渲染器提供只读兼容路径，且不修改历史 outbox payload。
- [HTML 注入或按钮链错配] → 全部外部文本转义，URL 只从已验证 chain + CA 构造并测试 SOL/BSC 精确目标。
- [卡片过长] → 使用紧凑金额/百分比/相对时间格式并对两链最大地址长度做 4096 字符边界测试。

## Migration Plan

1. 在 Telegram 禁用模式运行两链预览，对比卡片内容与长度。
2. 运行 transport、send/edit、重启兼容和无敏感信息测试。
3. 在私有验证频道发送一条受控消息并验证 HTML、正文 CA、唯一 GMGN 按钮及 edit 后按钮保留。
4. 通过后部署；回滚只需恢复旧 renderer/transport，数据库无 schema 回滚。
