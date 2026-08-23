## Why

低市值 Meme 代币常在数分钟内完成主要涨跌，扫描全部新池既噪声极高，也容易在信号发出前错过行情。需要一个只依赖 GMGN 与 CoinGecko Analyst 市场数据、以 GMGN 1m/5m 热门榜缩小候选范围、并在固定真实池上快速验证后推送的 SOL/BSC Telegram 信号 Bot。

## What Changes

- 新增 SOL 与 BSC 的低市值 Meme 候选发现流程，以 GMGN 1m/5m Top100 热门榜作为唯一发现入口。
- 将 Bonding Curve 代币限制在独立雷达频道；只有已开放且可解析到真实主池的代币才能进入正式信号流程。
- 新增可由 GMGN 明确字段验证的链特定安全门槛、榜单动量激活、固定池方向/成交验证、价格追高限制及 `$100` 对手侧深度代理。
- 明确数据权责：GMGN 负责发现、榜单、代币安全与主池解析；CoinGecko 负责锁定池后的行情、成交、OHLCV 与信号后评估，重叠字段不得混合裁决。
- 新增公开雷达/正式双频道与内部私有验证频道、消息更新/失效、单 Token 一次信号和数据新鲜度保护。
- 新增模拟入场与累计评估：每链累计 20 条无关键技术错误即可独立进入 Beta；不设置天数门槛，并在 50/100/200 条及后续滚动窗口复评。
- 仅允许 GMGN 和 CoinGecko 作为外部市场数据 API；Telegram Bot API 仅承担消息传输，不引入其他行情、风控或链上数据 API。

## Capabilities

### New Capabilities

- `trending-candidate-discovery`: GMGN 热门榜轮询、跨周期激活、候选去重、Bonding Curve/真实池分流与基线记录。
- `fixed-pool-signal-qualification`: 链特定安全校验、GMGN 主池解析、CoinGecko 固定池验证及正式信号决策。
- `telegram-signal-delivery`: 雷达/正式频道推送、消息生命周期、有效期、追高失效与重复信号抑制。
- `signal-evaluation`: 模拟入场、分时表现、MFE/MAE、技术错误、规则版本与累计滚动评估。

### Modified Capabilities

无。

## Impact

- 新建一个可长期运行的 Bot 服务、持久化状态与配置，但保持单体、少组件、易维护。
- 外部依赖限定为 GMGN、CoinGecko Analyst 与 Telegram Bot API；不接入其他市场数据或安全 API。
- API 密钥必须仅从本地/部署环境注入，禁止记录或提交；当前 `.env.local` 已加入忽略规则并收紧为 `600`，实施和部署启动时须持续校验。
- GMGN token security 实测只承担 Top10 与链特定合约风险；`dev_team_hold_rate`、`rug_ratio`、`is_wash_trading`、`rat_trader_amount_rate`（官方定义为内幕/偷跑交易量占比）与 `bundler_rate` 从热门榜执行。BSC security 按实测布尔字段解析，不按文档中的 yes/no 描述或数值别名兜底；缺失或无法解析时关闭式拒绝。
- CoinGecko 正式价格必须使用锁定池 REST trades/detail，G2 只负责实时触发，评估使用固定池 REST OHLCV；首版不建立 G3 连接，也不得使用可能切换 top pool 的 G1 token price。
