# telegram-signal-card-presentation Specification

## Purpose
让低市值 Meme 用户在 Telegram 移动端按链、身份、市场、动量与风险顺序快速读取雷达和信号，并能从完整 CA 直接复制或跳转 GMGN 核验，而不暴露内部实现字段。
## Requirements
### Requirement: 卡片显著区分 SOL 与 BSC
系统 SHALL 在雷达、私有验证、正式信号和后续状态编辑的首屏标题中使用固定链标识：SOL 使用 `🟣 SOLANA`，BSC 使用 `🟡 BNB CHAIN`。同一链在标题和唯一 GMGN 按钮中 SHALL 使用一致标识，且不得仅依赖 Token 名称或 CA 格式区分链。

#### Scenario: SOL 正式信号
- **WHEN** SOL 候选进入正式信号卡片
- **THEN** 标题显著显示 `🟣 SOLANA`，底部按钮显著显示 `GMGN · SOL`

#### Scenario: BSC 正式信号
- **WHEN** BSC 候选进入正式信号卡片
- **THEN** 标题显著显示 `🟡 BNB CHAIN`，底部按钮显著显示 `GMGN · BSC`

### Requirement: CA 前置并使用正文原生复制格式
系统 SHALL 在 Token 名称和 Symbol 之后、全部市场指标之前展示完整规范化 CA，并使用 Telegram `code` 或 `pre` 实体，使兼容客户端提供正文原生复制交互。卡片不得缩短 CA，不得把 CA 伪装成外部链接，也不得增加复制 CA 按钮。

#### Scenario: 用户查看卡片身份
- **WHEN** 雷达或信号卡片成功渲染
- **THEN** 完整 CA 位于卡片前部且被标记为 Telegram 代码实体，底部键盘不存在复制按钮

### Requirement: GMGN 与 CoinGecko 事实按决策顺序融合
系统 SHALL 在同一信息层级中依次展示名称与 Symbol、信号价、当前市值、固定池流动性、池龄、热门激活原因及当前 1m 排名、发现后当前与最高涨幅、30 秒成交笔数/买入占比/净买入、`$100` 深度占比、链通用风险、链特定合约风险、完整固定池、信号时间、首次发现相对时间和最新成交相对时间。显示事实 SHALL 来自发送时已经取得的 GMGN 与 CoinGecko 固定池快照，不得为卡片额外调用 API。

#### Scenario: 融合正式卡片
- **WHEN** 候选通过全部资格并取得发送前固定池价格
- **THEN** 用户按市场、热度、成交、风险顺序读取融合卡片，且同一字段只出现一次

#### Scenario: SOL 风险区
- **WHEN** 卡片链为 SOL
- **THEN** 风险区展示 Top10、Insider、Bundler、Dev、Rug、刷量、Mint 与 Freeze 事实

#### Scenario: BSC 风险区
- **WHEN** 卡片链为 BSC
- **THEN** 风险区展示 Top10、Insider、Bundler、Dev、Rug、刷量、蜜罐、开源、权限与买卖税率事实

### Requirement: 公开卡片不暴露内部实现信息
系统 SHALL 从雷达、私有验证、正式信号和状态编辑正文中移除原始安全 JSON、候选 base/quote 方向、规则版本、`GMGN + CoinGecko 固定池` 实现页脚及内部原因码。失效原因 SHALL 映射为简短中文用户文案；完整原始事实和内部代码继续保存在数据库审计记录中。

#### Scenario: 用户阅读信号
- **WHEN** 系统渲染新的公开或私有信号卡片
- **THEN** 正文不包含 JSON、`candidateSide`、`rules-`、规则短哈希或内部英文原因码

### Requirement: 卡片底部只提供对应 GMGN 代币页
系统 SHALL 为每张雷达、私有验证和正式信号卡片附加且仅附加一个 URL 按钮。按钮 SHALL 从已验证链和规范化 CA 确定性构造对应 GMGN 代币页面：SOL 使用 SOL 页面，BSC 使用 BSC 页面。消息状态编辑 SHALL 保留同一按钮，不得加入买入、复制、回调或第三方页面按钮。

#### Scenario: 用户打开 GMGN
- **WHEN** 用户点击 SOL 或 BSC 卡片底部按钮
- **THEN** Telegram 打开同链同 CA 的 GMGN 代币页面

### Requirement: 雷达与信号状态保持明显分层
系统 SHALL 将雷达标记为非正式并只展示身份、市值、榜单/激活、发现后最高涨幅、首次发现和当前阶段；正式或私有验证卡片 SHALL 展示完整融合事实。后续编辑 SHALL 把 `🟠 波动超限`、`⌛ 已过期` 或 `🔴 已失效` 置于卡片顶部，同时保留初始事实和 GMGN 按钮。

#### Scenario: Bonding Curve 雷达
- **WHEN** 候选仍无可验证真实池
- **THEN** 卡片显著显示 `非正式` 和 `Bonding Curve 观察中`，且不展示为已通过的固定池风险事实

#### Scenario: 已发送信号失效
- **WHEN** 已发送信号触发流动性、安全、数据确认或有效期终态
- **THEN** 原消息顶部显示中文状态与原因，初始快照和唯一 GMGN 按钮继续保留

### Requirement: 展示文本安全且长度有界
系统 SHALL 对来自提供商的名称和 Symbol 执行 HTML 转义与长度限制，对所有数值执行有限值格式化，并保证 Telegram 消息不超过文本长度上限。构造 GMGN URL 时 SHALL 只使用内部验证后的链枚举和规范化 CA，不得使用提供商返回的任意 URL。

#### Scenario: Token 名称包含格式字符
- **WHEN** GMGN 名称或 Symbol 包含 `<`、`>`、`&` 或超长文本
- **THEN** 卡片仍作为普通文本安全显示，不得注入 Telegram 格式或改变 GMGN 跳转目标
