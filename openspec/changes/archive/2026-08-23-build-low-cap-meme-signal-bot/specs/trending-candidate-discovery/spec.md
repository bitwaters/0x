## Purpose

定义 SOL 与 BSC 低市值 Meme 候选从 GMGN 1m/5m 热门榜被发现、激活、分流和留档的行为，并确保系统不退化为全量新池扫描器。

## ADDED Requirements

### Requirement: GMGN 热门榜是唯一候选发现入口
系统 SHALL 仅使用 GMGN SOL/BSC 1m 与 5m Top100 热门榜发现候选，不得使用 CoinGecko 或其他市场数据 API 补充候选，也不得扫描全部新池。Top100 是请求上限，不是固定返回数量。请求 SHALL 显式发送并版本化链级过滤器：SOL 为 `renounced,frozen`，BSC 为 `not_honeypot,verified,renounced`，不得依赖服务端默认值静默变化。

#### Scenario: 热门榜不足 100 条
- **WHEN** GMGN 某次 Top100 请求返回少于 100 条
- **THEN** 系统处理实际返回集合且不得把缺少的名次视为接口故障

#### Scenario: 其他来源出现新池
- **WHEN** CoinGecko 或其他来源出现一个不在 GMGN 热门榜中的新池
- **THEN** 系统不得据此创建候选或正式信号

### Requirement: 榜单快照具有明确有效期
系统 SHALL 保存每次成功榜单请求的 `fetched_at`、实际条数和发现规则版本；空榜也保存成功批次头，失败请求不写成功批次且不得刷新旧快照有效期。为限制长期数据库增长，批次头不复制整份 Top100 JSON，候选明细由规范化 `rank_snapshots` 保存。用于双榜激活时，1m 快照年龄 SHALL 不超过 6 秒、5m 快照年龄 SHALL 不超过 15 秒，且两者成功获取时间差 SHALL 不超过 12 秒。

#### Scenario: 双榜快照有效
- **WHEN** 同一 Token CA 出现在满足年龄和时间差限制的最新 1m 与 5m 成功快照
- **THEN** 系统立即激活该候选

#### Scenario: 旧快照或请求失败
- **WHEN** 任一快照超时、两者时间差超限或最新请求失败后旧快照已过期
- **THEN** 系统不得用该快照完成双榜激活

### Requirement: 连续上升激活必须来自连续新快照
系统 SHALL 在同一 Token CA 连续三次成功的 1m 快照中均出现且名次严格逐次变小时激活候选；相邻成功快照间隔超过 6 秒或成功快照中缺榜 SHALL 重置计数。名次数值变小表示上升。

#### Scenario: 连续三次上升
- **WHEN** 同一 Token CA 在三个符合间隔要求的成功 1m 快照中名次严格逐次变小
- **THEN** 系统在第三次快照后激活候选

#### Scenario: 连续性中断
- **WHEN** 相邻成功快照间隔超过 6 秒，或代币缺榜、名次不变或下降
- **THEN** 系统重置连续上升计数

### Requirement: 首版低市值范围是可版本化硬边界
系统 SHALL 以 GMGN 数据执行初始市场范围：市值 `$20,000–$500,000`；真实池流动性至少 `$10,000`；真实池开放时间不超过 6 小时。Bonding Curve 雷达候选只执行市值范围，不要求尚不存在的真实池流动性和开放时间。

#### Scenario: 真实池满足初始范围
- **WHEN** 候选的 GMGN 市值、真实池流动性和开放时间均在范围内
- **THEN** 系统允许其进入激活与资格流程

#### Scenario: 市场范围参数改变
- **WHEN** 操作者调整任一市场范围参数
- **THEN** 系统生成新规则版本且不得回写旧候选的配置快照

### Requirement: 候选身份按链规范化且每个代币最多一次正式机会
系统 SHALL 以规范化的 `chain + token_contract_address` 作为永久候选身份：SOL 地址保持合法 Base58 的大小写，BSC 地址解析为 20-byte 后使用统一小写形式。每个身份最多发送一次验证或正式主信号，不创建重复信号生命周期。

#### Scenario: BSC 地址大小写不同
- **WHEN** 同一 BSC Token CA 以 checksum 和小写形式出现
- **THEN** 系统将其合并为同一候选

#### Scenario: 终态代币重新上榜
- **WHEN** 已发送、拒绝或过期的候选再次进入热门榜
- **THEN** 系统可继续记录研究数据，但不得重新发送验证或正式主信号

### Requirement: 首次发现基线和 GMGN 高水位不可变
系统 SHALL 只在首次 GMGN 价格为有限正数时建立正式资格基线，永久记录发现规则版本、榜单位置、GMGN 价格、市值、流动性和时间，并只用有限正数的后续 GMGN 价格更新同源 high-water。首次发现后的历史最大涨幅一旦超过 80%，该候选 SHALL 永久失去正式资格，即使随后回落。

#### Scenario: GMGN 价格无效
- **WHEN** 首次或发送前 GMGN 价格缺失、非有限数或不大于零
- **THEN** 系统记录 `gmgn_price_contract_error` 且不得建立或通过正式资格

#### Scenario: 历史涨幅超过 80%
- **WHEN** 任一有效 GMGN 快照价格相对首次 GMGN 价格的涨幅超过 80%
- **THEN** 系统记录 high-water 拒绝并不得恢复正式资格

#### Scenario: 重复观察未突破阈值
- **WHEN** 候选再次出现但历史最大涨幅仍不超过 80%
- **THEN** 系统更新观察值但不得覆盖首次发现基线

### Requirement: Bonding Curve 与真实池严格分流
系统 SHALL 将未开放或无法解析真实主池的候选限制在 `RADAR` 状态。只有 GMGN 显示已开放且 `token info.biggest_pool_address` 非空，并通过发现阶段市值、流动性与池龄边界的候选才进入 `PREHEAT`；`PREHEAT` 仅表示等待第 5 章 CoinGecko 固定池验证，不得提前进入 `POOL_BOUND`。

#### Scenario: 仍在 Bonding Curve
- **WHEN** 候选尚未开放或无法解析真实主池
- **THEN** 系统最多发送雷达消息且不得发送验证或正式信号

#### Scenario: 真实池形成
- **WHEN** 雷达候选随后显示已开放且 GMGN 返回有效主池地址
- **THEN** 系统保留首次发现基线并开始真实池资格流程

### Requirement: 真实池资格窗口保持短暂
系统 SHALL 从固定池成功绑定时开始最多监控 120 秒。池记录、`POOL_BOUND` 状态和起始时间 SHALL 原子提交；到期扫描 SHALL 在启动时立即执行并由独立时钟持续执行，不得依赖 GMGN 请求成功。硬安全失败立即终止；成交或流动性等暂时条件可在窗口内重试，窗口结束仍未通过则永久过期。

#### Scenario: 暂时条件随后通过
- **WHEN** 候选在 120 秒窗口内从成交不足变为满足全部条件
- **THEN** 系统允许其继续发送前检查

#### Scenario: 资格窗口结束
- **WHEN** 固定池绑定后 120 秒仍未满足全部条件
- **THEN** 系统将候选标记过期且不因重新上榜重开

### Requirement: 完整记录候选与拒绝原因
系统 SHALL 保存所有通过市场范围预筛的候选、状态变化和结构化拒绝原因，而非只保存最终推送的代币。

#### Scenario: 候选被拒绝
- **WHEN** 候选未通过任一后续条件
- **THEN** 系统记录阶段、原始字段、规范化值、阈值、来源、快照时间和规则版本
