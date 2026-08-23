# signal-evaluation Specification

## Purpose
定义从真实 Telegram 回执开始的模拟入场、路径评估、失败结果、规则版本和累计复评，使系统无需天数门槛即可快速验证技术链路并持续校准。
## Requirements
### Requirement: 验证与正式样本都以真实 Telegram 回执为准
系统 SHALL 将私有验证和公开正式频道成功送达的主消息视为delivered signal sample，保存回执时间、发送前固定池价格及成交时间。系统 SHALL 在回执后的10秒闭区间内选择CoinGecko同一固定池第一笔有效成交作为`$100`模拟入场，保存入场策略版本、实际成交时间与延迟；不得使用发送前、其他池或窗口外价格。只有成交响应确认覆盖回执时刻且窗口内确无成交时才记录`ENTRY_UNAVAILABLE`；覆盖不足、策略不可执行或提供商错误必须fail-closed为`PROVIDER_MISSING`。预览、失败和`UNCERTAIN`消息不得计入样本。

#### Scenario: 私有验证消息成功
- **WHEN** Telegram私有验证频道返回成功回执
- **THEN** 系统记录真实样本并标记`delivery_stage=validation`

#### Scenario: 消息未确认成功
- **WHEN** 消息失败、仅生成预览或处于`UNCERTAIN`
- **THEN** 系统不得把它计入样本或Beta计数

#### Scenario: 10 秒目标后出现真实成交
- **WHEN** Telegram回执后7秒出现同池第一笔有效成交且响应覆盖回执时刻
- **THEN** 系统使用该成交建立模拟入场并从实际成交时间计算路径

#### Scenario: 十秒内没有成交
- **WHEN** 响应确认覆盖回执时刻且之后10秒内没有同池成交
- **THEN** 系统记录`ENTRY_UNAVAILABLE`且不得伪造入场收益

#### Scenario: 成交页未覆盖入场窗口左边界
- **WHEN** CoinGecko最新成交页无法证明覆盖Telegram回执时刻
- **THEN** 系统记录`PROVIDER_MISSING/ENTRY_WINDOW_NOT_COVERED`且不得把页内最早成交称为窗口第一笔

### Requirement: 保存统一时间点和 24 小时路径结果
系统 SHALL 对每条delivered signal sample保留10秒、30秒、1分钟、5分钟、15分钟、1小时、4小时和24小时结果。主要MFE、MAE、收益率和阈值先后 SHALL 统一相对回执后10秒窗口内选出的实际`$100`模拟入场成交计算，并暴露实际入场延迟；发送前价格只用于展示机会损耗，不得混入主要绩效。90秒内路径使用固定池REST trades，之后使用CoinGecko可得的最细固定池REST OHLCV并保存粒度。

#### Scenario: 同一 K 线同时触发上下阈值
- **WHEN** 缺少逐笔顺序且同一根OHLCV同时触及一组止盈和止损阈值
- **THEN** 系统记录`AMBIGUOUS`且不得自行假定触发先后

#### Scenario: 路径结果完成
- **WHEN** 已取得覆盖评估窗口的成交或OHLCV
- **THEN** 系统相对实际模拟入场计算MFE、MAE、`+30%/-15%`和`2x/-30%`并标注数据粒度

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
系统 SHALL 分别保存不可变的`discovery_rule_version`与`decision_rule_version`及完整配置快照。参数变化后，尚未发送且非终态的候选使用最新版本重新执行完整资格；旧样本不得回写，报告按规则版本分层。新规则部署时只允许从未发送且终态原因为`POOL_TOO_OLD`、`POOL_AGE_OUT_OF_RANGE`或旧基线`CHASE_LIMIT_EXCEEDED`的候选执行一次审计迁移；安全、池身份、已发送和其他终态不得恢复。

#### Scenario: 参数规则改变
- **WHEN** 操作者改变任一阈值或判定逻辑
- **THEN** 系统生成新决策版本并按新版本重新判断允许处理的候选，旧样本保持不变

#### Scenario: 终态迁移受限
- **WHEN** 旧终态候选不属于三个允许原因之一或已经发送主信号
- **THEN** 系统不得恢复该候选

### Requirement: 每链使用简单发布状态
系统 SHALL 为SOL与BSC独立维护`VALIDATING`、`BETA`、`SUSPENDED`和整数`validation_epoch`。初始为`VALIDATING`；当前epoch内累计5条具有有效模拟入场且形成15分钟`COMPLETE`、`AMBIGUOUS`或`TERMINAL_NEGATIVE`结果的私有验证样本，并且链未处于`SUSPENDED`时 SHALL 进入`BETA`，不设置天数门槛。`ENTRY_UNAVAILABLE`与`PROVIDER_MISSING`保留并报告，但不计入也不阻塞可评估计数。五条只证明技术链路可运行，不证明盈利能力。

#### Scenario: 不可评估样本被跳过
- **WHEN** 一条私有验证样本为`ENTRY_UNAVAILABLE`且后续样本形成有效15分钟结果
- **THEN** 后续样本正常计入可评估总数且发布进度不被前者阻塞

#### Scenario: 验证样本乱序完成
- **WHEN** 较晚发送的样本先形成有效15分钟结果而较早样本仍为不可评估或未决
- **THEN** 系统只统计已经成熟且可评估的样本，不得把未决样本伪装为完成

#### Scenario: 单链达到五条
- **WHEN** SOL或BSC独立累计5条可评估验证样本
- **THEN** 仅该链进入`BETA`并允许后续信号进入公开正式频道

#### Scenario: 单链达到 20 条
- **WHEN** 已进入`BETA`的单链累计达到20条可评估样本
- **THEN** 系统保持该链发布状态并生成后续复盘数据，不把20条重新解释为上线门槛

#### Scenario: 发现关键技术错误
- **WHEN** 出现错误CA/池/方向、Honeypot被判安全、不可交易代币通过、陈旧价格推送、重复消息、数据源混用或终止性消息错误
- **THEN** 系统将该链置为`SUSPENDED`、终止所有未发送候选，在修复后递增`validation_epoch`并只用新epoch从零累计

#### Scenario: 旧验证轮次迟到完成
- **WHEN** 修复前epoch的样本在新epoch开始后才完成评估
- **THEN** 系统保留历史结果但不得推进新epoch的五条计数

### Requirement: 按累计样本滚动复评
系统 SHALL 在每链每决策规则版本首次累计5条可评估样本及之后每新增20条时生成复盘数据，并在同一报告内按机会类型和delivery stage分层展示模拟入场覆盖率、5分钟与15分钟MFE/MAE、`+30%/-15%`和`2x/-30%`路径结果。参数调整一次只改变一个参数族并生成新规则版本，不设置固定天数或200条上线门槛。

#### Scenario: 达到累计评估点
- **WHEN** 某链在当前规则版本达到5条可评估样本
- **THEN** 系统生成含新池/复苏和频道阶段分段的报告并明确五条不构成盈利证明

#### Scenario: 小范围参数调整
- **WHEN** 同一链与规则版本在上次复盘后新增20条可评估样本
- **THEN** 系统生成新复盘数据且一次只允许调整一个参数族
