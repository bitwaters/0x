## Purpose

定义从真实 Telegram 回执开始的模拟入场、路径评估、失败结果、规则版本和累计复评，使系统无需天数门槛即可快速验证技术链路并持续校准。

## ADDED Requirements

### Requirement: 验证与正式样本都以真实 Telegram 回执为准
系统 SHALL 将私有验证频道和公开正式频道中成功送达的主消息都视为 delivered signal sample，保存回执时间、发送前固定池价格及成交时间，并以回执后 10 秒作为 `$100` 模拟入场目标。系统 SHALL 固化入场策略版本和最大等待时间，且无论持久化任务的旧调度时间为何都等到目标后 3 秒再裁决；优先采用目标时刻成交，否则采用 `(目标, 目标+3秒]` 内第一笔真实固定池成交，保存实际成交时间与入场延迟；不得使用目标前成交伪装目标后入场。缺少策略元数据或当前进程不能执行该规则版本时必须 fail-closed 为 `PROVIDER_MISSING/ENTRY_POLICY_UNAVAILABLE`。预览、失败和 `UNCERTAIN` 消息不得计入样本。

#### Scenario: 私有验证消息成功
- **WHEN** Telegram 私有验证频道返回成功回执
- **THEN** 系统记录真实样本并标记 `delivery_stage=validation`

#### Scenario: 消息未确认成功
- **WHEN** 消息失败、仅生成预览或处于 `UNCERTAIN`
- **THEN** 系统不得把它计入样本或 Beta 计数

#### Scenario: 10 秒目标后出现真实成交
- **WHEN** 目标时刻没有成交，但 `(目标, 目标+3秒]` 内出现一笔或多笔固定池成交
- **THEN** 系统使用其中最早一笔作为模拟入场，保存实际成交时间和正入场延迟，并从该实际时间计算后续路径

#### Scenario: 成交页未覆盖入场窗口左边界
- **WHEN** CoinGecko 返回完整 300 笔最新成交且最早一笔晚于入场目标，即使页内仍有目标后 3 秒内成交
- **THEN** 系统记录 `PROVIDER_MISSING/ENTRY_WINDOW_NOT_COVERED`，不得把返回页中的最早成交误称为窗口第一笔；只有响应确认覆盖目标左边界且窗口内无成交时才记录 `ENTRY_UNAVAILABLE`

### Requirement: 保存统一时间点和 24 小时路径结果
系统 SHALL 对每条 delivered signal sample 记录 10 秒、30 秒、1 分钟、5 分钟、15 分钟、1 小时、4 小时和 24 小时结果。主要 MFE、MAE、收益率和阈值先后 SHALL 统一相对上述 10 秒目标的实际 `$100` 模拟入场成交计算；报告 SHALL 暴露入场延迟。发送前价格只用于展示延迟与机会损耗，不得混入主要绩效。90 秒有效期内路径使用固定池 REST trades，其后的 24 小时路径使用 CoinGecko 可得的最细固定池 REST OHLCV，并保存所用粒度。

#### Scenario: 同一 K 线同时触发上下阈值
- **WHEN** 缺少逐笔顺序且同一根 OHLCV 同时触及一组止盈和止损阈值
- **THEN** 系统记录 `AMBIGUOUS`，不得自行假定触发先后

#### Scenario: 路径结果完成
- **WHEN** 已取得覆盖评估窗口的成交或 OHLCV
- **THEN** 系统计算 MFE、MAE、`+30%/-15%` 和 `2x/-30%` 路径结果并标注数据粒度

### Requirement: 失败和缺失不得产生幸存者偏差
系统 SHALL 将所有 delivered signal sample 纳入报告总样本数。固定池消失、流动性归零或 GMGN 明确显示不可交易 SHALL 记为终止性负面结果；只有 CoinGecko/GMGN 服务故障或数据契约错误才记为 `provider_missing`。报告 SHALL 同时展示总样本、完整样本、终止性负面结果、provider missing 和覆盖率。

#### Scenario: 固定池消失
- **WHEN** 已发送信号的锁定池在评估期间消失或流动性归零
- **THEN** 系统记录终止性负面结果且不得从绩效分母静默排除

#### Scenario: 提供商暂时故障
- **WHEN** 因指定 API 故障无法取得某时间点数据
- **THEN** 系统记录 `provider_missing`、有限重试并在报告中显示缺失，不得以前值或其他池填充

### Requirement: 可卖出性和收益只作为可验证代理
系统 SHALL 记录同一固定池在信号后是否出现候选方向的真实卖出成交，作为 `sell_trade_observed` 代理；同时报告已知税率、池流动性与毛价格变化。系统不得把该代理描述为用户订单一定可成交，也不得输出未经真实报价验证的净收益。

#### Scenario: 观察到卖出成交
- **WHEN** 信号后同一固定池出现规范化后的候选卖出成交
- **THEN** 系统记录 `sell_trade_observed=true` 及首次观察时间

### Requirement: 每条规则版本可追溯
系统 SHALL 分别保存不可变的 `discovery_rule_version` 与 `decision_rule_version` 及完整配置快照。参数变化后，只有尚未发送且非终态的候选 SHALL 使用最新版本重新执行完整资格判断；旧样本不得回写，报告按 `decision_rule_version` 分层。

#### Scenario: 参数规则改变
- **WHEN** 操作者改变任一阈值或判定逻辑
- **THEN** 系统生成新决策版本并在发送前按新版本重新判断非终态候选，终态候选不得恢复

### Requirement: 每链使用简单发布状态
系统 SHALL 为 SOL 与 BSC 独立维护 `VALIDATING`、`BETA`、`SUSPENDED` 三种发布状态及整数 `validation_epoch`。初始为 `VALIDATING`；私有验证消息进入 `SENT` 时 SHALL 在同一 SQLite 事务中保存当前 epoch 并按链分配单调 `validation_seq`。只有当前 epoch 内连续 20 个序号均完成 15 分钟评估且无关键技术错误后才进入 `BETA`，不得跨越更早的未决样本，也不设置天数门槛。20 条只证明技术链路可运行，不证明盈利能力。

#### Scenario: 验证样本乱序完成
- **WHEN** 较晚序号先完成 15 分钟评估而较早序号仍未决
- **THEN** 系统不得越过较早序号推进连续计数或进入 Beta

#### Scenario: 单链达到 20 条
- **WHEN** SOL 或 BSC 独立达到 20 条符合条件的连续验证样本
- **THEN** 仅该链进入 `BETA` 并允许后续信号发送到公开正式频道

#### Scenario: 发现关键技术错误
- **WHEN** 出现错误 CA/池/方向、Honeypot 被判安全、不可交易代币通过、陈旧价格推送、重复消息、数据源混用或终止性消息错误
- **THEN** 系统将该链置为 `SUSPENDED`、终止所有未发送候选，在修复后递增 `validation_epoch` 并只用新 epoch 从零累计

#### Scenario: 旧验证轮次迟到完成
- **WHEN** 修复前 epoch 的样本在新 epoch 开始后才完成评估
- **THEN** 系统保留其历史结果但不得推进新 epoch 的 Beta 计数

### Requirement: 按累计样本滚动复评
系统 SHALL 在每链累计 50、100、200 条 delivered signal sample 时生成阶段报告；200 条是稳定性评估点而非上线门槛。达到 200 条后每新增 100 条生成滚动报告，每新增 20 条允许一次小范围参数复查。报告 SHALL 按链、规则版本和 delivery stage 分层，参数调整一次只改变一个参数族。

#### Scenario: 达到累计评估点
- **WHEN** 某链达到 50、100、200 或后续 +100 样本
- **THEN** 系统生成包含覆盖率和各规则版本样本数的报告且不等待固定天数

#### Scenario: 小范围参数调整
- **WHEN** 新增 20 条样本支持调整
- **THEN** 系统一次只改变一个参数族并生成新规则版本
