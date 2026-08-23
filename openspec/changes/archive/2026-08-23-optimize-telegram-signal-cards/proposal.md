## Why

现有 Telegram 消息更接近工程审计日志，安全 JSON、内部方向和规则版本削弱了低市值 Meme 用户在数秒内识别链、复制 CA、判断热度与风险的效率。需要在不改变任何信号规则或数据源职责的前提下，将 GMGN 与 CoinGecko 固定池事实融合成移动端易读卡片。

## What Changes

- 统一雷达、私有验证与正式信号的状态优先卡片结构，并用 `🟣 SOLANA`、`🟡 BNB CHAIN` 显著区分两条链。
- 将名称、Symbol 与完整 CA 提到卡片前部；CA 使用 Telegram 代码样式，正文不增加复制按钮。
- 按价格、市值、流动性、热度、成交、深度和风险的用户决策顺序融合展示 GMGN 与 CoinGecko 固定池事实。
- 用固定顺序、链特定的中文风险行替代原始 JSON；移除公开消息中的候选方向、规则版本和数据源实现页脚。
- 卡片底部仅保留一个 URL 按钮，按链和 CA 跳转到 GMGN 对应代币页面。
- 状态编辑将有效、波动超限、过期或失效放在消息顶部，并保留初始可核验快照。
- 不增加图片、Logo、图表生成、综合评分、自动买入或任何新 API。

## Capabilities

### New Capabilities

- `telegram-signal-card-presentation`: 定义 SOL/BSC 雷达与信号卡片的信息层级、融合指标、CA 展示、GMGN 跳转和状态编辑行为。

### Modified Capabilities

无。

## Impact

- 影响 Telegram 消息快照、渲染器、send/edit transport 参数及相关单元/集成测试。
- 需要从当前已经获取并持久化的 GMGN 响应中严格解析少量展示字段，不增加额外请求。
- CoinGecko 继续只负责锁定固定池价格、流动性、池龄、成交和深度代理；GMGN 继续负责身份、热门榜、市值与安全事实。
- 不改变候选发现、资格门槛、Telegram outbox、信号生命周期、评估算法、数据库密钥或正式频道发布边界。
