## Why

生产漏斗显示安全通过并绑定固定池的候选连续 17/17 在 120 秒内过期，现有 30 秒成交条件的交集对低市值池过严；同时长期 PREHEAT 会与已绑定候选竞争资格轮询，雷达涨幅又混用了首次发现与推送后的口径。

## What Changes

- 将固定池成交窗口调整为 60 秒、至少 3 笔和 `$200`，买入 USD 占比至少 55%、最大单笔占比不超过 50%，删除买入笔数占比硬门槛，保留最新成交 15 秒限制。
- 将固定池资格窗口由 120 秒调整为 180 秒，保持同池、流动性、安全、80% 追高和发送前复核规则不变。
- 资格调度优先处理 `MONITORING/POOL_BOUND`；`PREHEAT` 仅在本地最新 1m 成功批次仍为 Top20 且市值在正式范围内时调用资格 API。
- 以每分钟低基数聚合日志记录资格 WAIT 原因，不增加数据库表或外部服务。
- 雷达卡分列“推送时已涨”和“推送后最高”，并对推送时已超过 80% 的候选显示高追风险。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `fixed-pool-signal-qualification`: 调整固定池成交门槛、资格窗口和资格调度要求，并增加轻量 WAIT 诊断。
- `telegram-signal-card-presentation`: 调整成交窗口文案和雷达涨幅展示口径。
- `telegram-signal-delivery`: 将资格与发送前重试的原截止窗口同步为 180 秒。

## Impact

影响资格策略与规则、运行时候选调度、Telegram 卡片渲染、配置默认值及对应测试。继续只使用 GMGN 与 CoinGecko，不新增依赖、数据库迁移、API 或后台服务。
