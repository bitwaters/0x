## Context

项目从空仓库开始。GMGN 热门榜实测约 0.36–0.72 秒，主池解析约 0.38 秒；CoinGecko 固定池约 0.50 秒，8/8 个 GMGN 主池均被精确识别。CoinGecko G2 首包快，但正式裁决仍需 REST trades 的 `block_timestamp`；WebSocket 为 Beta 且无 SLA。两链必须独立验证和发布。

## Goals / Non-Goals

**Goals:**

- 一个进程完成发现、判断、推送和评估，规则可复现、失败可解释。
- 只使用 GMGN、CoinGecko Analyst 和 Telegram Bot API。
- 快速发现，但数据陈旧、字段不明或池方向不明时停止发送。

**Non-Goals:**

- 不做自动交易、钱包/私钥、收益承诺、机器学习或复杂评分。
- 不做微服务、消息队列、Redis、分布式数据库和首版网页后台。
- 不计算跨 AMM 池型的精确滑点，也不声称可证明用户订单一定可成交。

## Decisions

### 1. 单体 TypeScript 与 SQLite

使用一个 Node.js/TypeScript 长驻进程和 SQLite WAL。模块仅分为 `discovery`、`qualification`、`market`、`telegram`、`evaluation`，共享同一配置与数据库。

核心表为：

- `rule_versions`：不可变完整配置，并区分发现版本与发送决策版本；
- `candidates`、`rank_snapshot_fetches`、`rank_snapshots`：成功请求时间/条数、规范化 CA、首次 GMGN 基线、采样 high-water、状态；成功批次头不复制完整 Top100 JSON，避免无界存储膨胀；
- `pool_bindings`、`qualification_events`：固定池、候选方向、原始/规范化字段和拒绝原因；
- `message_outbox`：`PENDING/SENDING/SENT/UNCERTAIN`、Telegram message id；
- `evaluation_points`：时间点、路径结果、覆盖率和终止性结果。

SQLite 事务用于本地幂等；Telegram 外部调用无法与数据库原子提交，因此结果未知时停在 `UNCERTAIN` 并人工核对，不自动重发。这比引入消息系统更简单，也优先避免重复信号。

### 2. 每个 Token 只有一次机会

候选按规范化 `chain + CA` 永久唯一：SOL 保持合法 Base58，BSC 解析为 20-byte 后保存小写。状态简化为：

```text
DISCOVERED -> RADAR/PREHEAT -> POOL_BOUND -> MONITORING
                  |               |             |
                  |               |             +-> SIGNAL_SENT
                  |               +----------------> REJECTED/EXPIRED
                  +--------------------------------> REJECTED/EXPIRED
```

不建立可重开的 `signal_lifecycle`。硬风险失败、120 秒资格窗口结束、曾经发送或 GMGN 采样最大涨幅超过 80% 都是终态；重新上榜只继续留档，不再推送。这是避免重复和状态膨胀的最简单规则。

### 3. 榜单激活与首版市场范围

- 每链 1m 默认每 3 秒、5m 每 10 秒轮询并错峰。
- 双榜只使用年龄≤6秒的1m、≤15秒的5m，获取时间差≤12秒的成功快照。
- 另一路激活是三个相邻间隔≤6秒的成功1m快照严格升名次。
- 初始 GMGN 范围：市值 `$20k–$500k`；真实池流动性≥`$10k`；开池≤6小时。
- Bonding Curve 只进入雷达；绑定真实池后才开始120秒资格窗口。

GMGN 首次价与后续有效 GMGN 榜单价维护“采样最大涨幅”。发送前必须有≤15秒 GMGN 快照；采样 high-water 一旦超过80%永久拒绝。该指标明确不是轮询间隔内的真实 ATH，CoinGecko 价格不参与该计算。

### 4. 安全规则只保留可验证字段

安全矩阵以 `fixed-pool-signal-qualification` 规格为准并服从正式 Key 的生产响应契约：token security 提供 Top10 与链特定合约风险；trending 提供 Dev Team、Rug、Wash Trading、Insider/偷跑与 Bundler。BSC 使用实测布尔字段 `is_honeypot`、`is_open_source`、`is_renounced`，不使用文档中的 yes/no 描述或数值别名兜底。字段缺失、范围外或契约变化一律关闭式拒绝。

首版删除无法稳定验证的 creator sell、blacklist、pause、mutable tax 和 LP 锁定期限等承诺。`burn_status`、锁仓信息可作为原始信息展示，但不作为已验证安全结论。这样避免用缺失字段偷偷放行，也避免为模糊规则增加额外推理。

### 5. 固定池绑定必须规范化候选方向

GMGN 给出 `biggest_pool_address` 后，CoinGecko network-scoped pool detail 必须同时满足：

1. 池地址按链规范化后匹配；
2. 候选 CA 等于且只等于 base 或 quote 一侧；
3. 保存 `candidate_side` 与对手 Token。

固定池 REST trades 始终使用 `token={candidate_side}`；返回的候选定向 `kind` 直接作为买卖方向，不再二次反转。候选 USD 价通过候选 CA 匹配 from/to Token 后选择对应 USD 字段。G2 只触发刷新，不参与正式方向或价格裁决。无法得到有限正数价格、数量或方向的事件不参与裁决并产生数据质量记录。

池绑定后不换池。主池变化、池消失或流动性跌破门槛直接终止候选。

### 6. 成交与 `$100` 只采用透明代理

池绑定和 G2 重连/事件触发后请求固定池 REST trades。REST 是最终事实，按提供商事件标识去重，只取最近30秒最多10笔；至少5笔、最新 `block_timestamp`≤15秒、买入笔数≥60%、净买入USD>0、最大单笔≤40%。

固定池 detail 启用 composition，以 `reserve_in_usd` 判断总流动性；两次成功 HTTP 请求的本地获取时间间隔至少10秒，两次均≥`$10k`且下降≤10%。候选为base使用`quote_token_liquidity_usd`，候选为quote使用`base_token_liquidity_usd`作为支付侧储备；`$100_depth_ratio = 100 / 支付侧USD储备`，要求≤3%。消息称其为“对手侧深度占比”，不称滑点或报价，也不直接从绩效中扣除。

### 7. 只保留两条 G2 实时连接

SOL/BSC 各一条 G2 OnchainTrade socket，每链高水位90、硬上限100。G2事件只把池标记为`dirty`；同池最多一个待处理/进行中的刷新，且间隔至少1秒。全部CoinGecko REST调用共用默认450请求/分钟的单进程令牌桶，避免活跃池耗尽Analyst 500 RPM。正式价格与新鲜度由REST trades裁决；固定池REST OHLCV用于后续评估，不建立G1或G3连接。

未发送候选按资格窗口到期释放订阅；已发送信号在90秒有效期结束后释放。后续1h/4h/24h评估走REST，因此长期累计不会占满100个实时槽位。

### 8. 三种频道用途与发送边界

- 雷达频道：Bonding Curve/预热，公开但明确非正式信号；
- 私有验证频道：每链公开 Beta 前的20条端到端样本；
- 正式频道：达到 Beta 的链发布 `🧪 Beta` 信号。

Telegram 调用前从同一固定池重新取新鲜成交。绝对漂移>8%时不创建主消息；成功发送后的90秒内，>8%编辑为勿追，>15%或到期编辑为过期。第30秒和第60秒各重取一次GMGN token security与CoinGecko pool detail；明确风险恶化时编辑为失效。复核失败只在3秒后重试一次，仍失败即编辑为“失效：数据不可确认”。初始正文记录请求时间，Telegram回执时间只保存在数据库。

每个 Token 最多一个验证或正式主消息。验证阶段已发送的 Token 不因进入 Beta 再补发。

### 9. 评估与快速 Beta

私有验证和公开正式消息只有取得 Telegram 成功回执才成为样本；记录回执时间、发送前价，并以回执后10秒为`$100`模拟入场目标。为适应高频池最新300笔可能快速滚动，持久化入场策略版本与最大等待时间，并在服务层确保旧调度任务也延后到目标+3秒：使用目标时刻或其后3秒内第一笔真实成交，保存实际成交时刻和入场延迟，不使用目标前成交。完整300笔只有最早成交不晚于目标时刻才证明覆盖左边界，否则记`provider_missing/ENTRY_WINDOW_NOT_COVERED`；缺少或无法执行固化策略记`provider_missing/ENTRY_POLICY_UNAVAILABLE`；确认覆盖但无成交才记`ENTRY_UNAVAILABLE`。所有已送达样本进入报告总数：撤池、流动性归零或明确不可交易记终止性负面结果；只有提供商故障或指定接口无法覆盖目标窗口记 `provider_missing`，并同时报告覆盖率。

主要绩效统一相对10秒目标对应的实际模拟入场成交；发送前价只衡量延迟损耗，报告同时展示入场延迟。90秒内路径使用固定池REST trades；之后到24小时使用最细可得固定池REST OHLCV。若同一K线同时触及上下阈值则记`AMBIGUOUS`。`sell_trade_observed`仅表示同池观察到卖出成交，不代表用户订单必定可执行。

每链发布状态只有`VALIDATING/BETA/SUSPENDED`。私有验证消息成功时在同一事务保存当前`validation_epoch`和单调序号，只按当前epoch的发送序列推进；连续20个序号均完成15分钟评估且无关键技术错误后进入Beta，不设天数。关键技术错误立即暂停该链、终止未发送候选，修复后递增epoch并从零验证；旧epoch迟到结果只留档。普通参数变更不暂停，只有未发送的非终态候选按最新决策版本重新判断。

50/100/200及后续+100生成报告，每+20允许一次单参数族复查；结果按链、规则版本和验证/正式阶段分层，20条不用于宣称盈利。

### 10. 密钥和 API 预算

密钥只从环境读取且不记录。`.env.local` 已加入 `.gitignore` 并收紧为`600`。日志脱敏请求头、URL查询参数、Telegram token和聊天标识。

GMGN榜单基础请求约52次/分钟；详情/安全请求使用每链最多2并发的有界队列，并按正式 Key 实测采取保守的10请求/秒、容量10令牌桶和指数退避。热门榜显式发送并纳入规则版本的链级过滤器（SOL `renounced,frozen`；BSC `not_honeypot,verified,renounced`），不依赖服务端默认值。CoinGecko实时走两条G2，REST只用于绑定、裁决和定点评估。无可用限流头时不主动压测容量。

## Risks / Trade-offs

- [热门榜会漏掉未上榜机会] → 接受该取舍以减少垃圾池噪声。
- [每个Token只发一次可能错过二次行情] → 优先去重和可解释性，符合新币早期机会定位。
- [删除不可验证安全项会留下剩余风险] → 消息只陈述已验证字段，不制造完整安全承诺；所有信号仍标注高风险。
- [深度占比不是实际滑点] → 明确命名和展示限制，不输出净收益承诺。
- [WebSocket Beta可能中断] → REST trades仍是裁决事实；断线时降低触发速度但不换源。
- [20条样本统计能力很弱] → 只作为技术 Beta 门槛，绩效持续在50/100/200复评。
- [SQLite和单进程是单点] → 当前容量优先简单部署，定期备份并由进程守护恢复。

## Migration Plan

1. 建立单体、SQLite schema、配置和脱敏契约测试。
2. 先运行无 Telegram 的预览 dry-run，验证字段、方向、池绑定和拒绝原因。
3. 开启私有验证频道，为每链累计20条完成15分钟观察的真实送达样本。
4. 达标链独立进入公开 `🧪 Beta`；未达标链继续私有验证。
5. 关键错误将单链置为 `SUSPENDED`；回滚只关闭该链发送开关并保留全部数据。
