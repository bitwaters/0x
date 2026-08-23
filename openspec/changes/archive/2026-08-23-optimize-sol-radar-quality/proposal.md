## Why

现行 SOL 公开雷达仍会把发送时已离开门槛的 PENDING 卡、直接真实池和复苏机会投放到雷达频道。冻结分析窗口为`2026-08-23 12:10:06–18:29:46 UTC`，基线规则为`rules-b9dc9de37e02`：102条SENT雷达中86条以回执前6秒内最新GMGN 1m行为基线并具有回执后15分钟同币榜单路径，其中46/86先跌15%、32/86先涨30%；按时间顺序首个触阈值点判定先后，同一时间同时触及记为ambiguous且不计任一先后，无新鲜基线或后续点的16条只计缺失。同期37条发送时已存在固定池的雷达经CoinGecko同一固定池1秒OHLCV取得35条有效样本，入场取回执所在秒至回执后10秒的第一根K线open，以相同15分钟首触及/ambiguous口径计算，其中25/35先跌15%，2条合约错误只计缺失。这些样本只能支持可回滚的频道降噪，不能证明因果或盈利；需要在不改变内部正式资格的前提下减少晚到和高噪声公开卡。

## What Changes

- SOL Bonding 公开范围保持 `$10,000–$100,000` 与当前 1m Top5，但公开触发只接受连续两次新鲜 1m+5m 双榜；三次 1m 上升继续内部处理。
- SOL 直接真实池和老池复苏不再新建公开雷达；只有已经 SENT 的 SOL Bonding 卡可按现有门槛升级为“真实池验证中”并继续终态编辑。
- 使用当前规则版本的独立公开 readiness，并从持久化成功批次和排名快照重建发送时仍连续双榜，约束 SOL 首次发送；旧 PENDING、已离开当前门槛或已终态候选不得补发。
- 将 SOL 池开放快捷资格与公开卡状态解耦，复用现有 `bonding_shortcut_readiness` 事件，确保降噪不改变新池/复苏内部激活及正式资格机会。
- 复用 v7 不可变首次 envelope、现有 outbox 和资格事件；只追加无新业务字段的兼容迁移与测试，不增加表、API、依赖、评分模型或第二套管线。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `trending-candidate-discovery`: 收紧 SOL 公开 Bonding/真实池投影，并以独立事件保持内部池开放快捷资格和正式处理不变。
- `telegram-signal-delivery`: 约束 SOL 首次雷达发送与旧 PENDING 恢复，同时保留已 SENT 单卡升级和终态编辑。

## Impact

- 影响 `discovery`、`runtime`、SQLite migration/repository 与相应测试；BSC策略、SOL/BSC正式资格和评估阈值不变。共享规则哈希会生成新版本并让两链报告出现新分段，但不得重置activation、资格窗口/参考价、已投递样本、validation epoch或终态候选。
- GMGN 继续独占发现、持续热度、排名、市值、安全和主池解析；CoinGecko 继续只服务固定池验证与历史表现，不增加或混用数据权责。
- 外部服务仍只有 GMGN、CoinGecko Analyst 与 Telegram；部署继续执行本地修改、推送、服务器 fast-forward 重建和只读观察，禁止服务器直接改文件。
