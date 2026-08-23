## MODIFIED Requirements

### Requirement: GMGN 与 CoinGecko 事实按决策顺序融合
系统 SHALL 在同一信息层级中依次展示名称与 Symbol、信号价、当前市值、固定池流动性、池龄、热门激活原因及当前 1m 排名、发现后当前与最高涨幅、60 秒成交笔数/买入占比/净买入、`$100` 深度占比、链通用风险、链特定合约风险、完整固定池、信号时间、首次发现相对时间和最新成交相对时间。显示事实 SHALL 来自发送时已经取得的 GMGN 与 CoinGecko 固定池快照，不得为卡片额外调用 API。

#### Scenario: 融合正式卡片
- **WHEN** 候选通过全部资格并取得发送前固定池价格
- **THEN** 用户按市场、热度、成交、风险顺序读取融合卡片，且同一字段只出现一次

#### Scenario: SOL 风险区
- **WHEN** 卡片链为 SOL
- **THEN** 风险区展示 Top10、Insider、Bundler、Dev、Rug、刷量、Mint 与 Freeze 事实

#### Scenario: BSC 风险区
- **WHEN** 卡片链为 BSC
- **THEN** 风险区展示 Top10、Insider、Bundler、Dev、Rug、刷量、蜜罐、开源、权限与买卖税率事实

### Requirement: 雷达与信号状态保持明显分层
系统 SHALL 将雷达标记为非正式并只展示身份、市值、榜单/激活、推送时相对首次发现涨幅、推送后最高涨幅、首次发现和当前阶段；推送时涨幅已达到80%的雷达 SHALL 显示高追风险。正式或私有验证卡片 SHALL 展示完整融合事实。后续编辑 SHALL 把 `🟠 波动超限`、`⌛ 已过期` 或 `🔴 已失效` 置于卡片顶部，同时保留初始事实和 GMGN 按钮。

#### Scenario: Bonding Curve 雷达
- **WHEN** 候选仍无可验证真实池
- **THEN** 卡片显著显示 `非正式` 和 `Bonding Curve 观察中`，并分列推送时涨幅和推送后最高涨幅

#### Scenario: 推送时已高涨
- **WHEN** 雷达首次推送时相对首次发现涨幅达到80%
- **THEN** 卡片显示高追风险且不得把该涨幅描述为推送后收益

#### Scenario: 已发送信号失效
- **WHEN** 已发送信号触发流动性、安全、数据确认或有效期终态
- **THEN** 原消息顶部显示中文状态与原因，初始快照和唯一 GMGN 按钮继续保留

