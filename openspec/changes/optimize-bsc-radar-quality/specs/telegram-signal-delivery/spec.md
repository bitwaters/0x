## MODIFIED Requirements

### Requirement: 每链每个 Token 最多一个雷达消息
系统 SHALL 对同一规范化`chain + token_contract_address`最多创建一个雷达消息。对于BSC，Bonding、真实池验证、正式资格通过、公开区间之外或验证超时只编辑已经SENT的同一消息；旧BSC PENDING只有同时存在当前规则版本的`radar_public_readiness`事实并重新满足当前BSC公开首发门槛才可发送，SOL PENDING恢复和生命周期行为保持现状。编辑失败 SHALL 持久化最新期望内容并有限重试，不得补发第二张雷达卡。BSC已发送雷达离开第6–10名公开区间时 SHALL 使用中性“当前不在公开观察区间”文案，不得把Top1–5过热错误描述为热度不足。首次雷达取得Telegram成功回执时，系统 SHALL 在同一数据库更新中保存SENT、message id、回执时间及不可变初始envelope：`{payload, sendRequestedAtMs, receiptAtMs, ruleVersion}`；其中payload必须是本次实际发送内容并含首次公开阶段、GMGN排名、市值和触发原因。后续编辑只更新当前期望内容，不得覆盖初始envelope。变更部署前的历史雷达若没有初始快照 SHALL 明确保持缺失，不得用最终编辑内容回填或猜测。

#### Scenario: Bonding升级为真实池
- **WHEN** 已发送Bonding雷达的候选满足该链真实池公开门槛
- **THEN** 系统编辑原雷达消息为“真实池验证中”、保留首次Bonding快照且不创建新雷达消息

#### Scenario: 雷达首次成功送达
- **WHEN** Telegram为首次雷达发送返回成功message id与回执时间
- **THEN** 系统以一次雷达专用数据库更新原子保存`SENT`、message id、回执时间和完整初始envelope，不得产生新的SENT雷达但初始envelope为NULL

#### Scenario: 雷达后续编辑
- **WHEN** 已送达雷达的展示阶段、排名、市值或终态发生变化
- **THEN** 系统更新同一message id的当前期望内容，但不得修改首次快照

#### Scenario: 历史雷达没有初始快照
- **WHEN** 变更部署前已发送雷达的初始内容未被持久化
- **THEN** 系统保留`initial_snapshot_unavailable`事实且不得以当前payload回填

#### Scenario: BSC已发送雷达进入Top1–5
- **WHEN** 一张已SENT的BSC雷达从第6–10名升至Top1–5且尚未进入终态
- **THEN** 系统只编辑同一消息为“当前不在公开观察区间”并继续内部处理，不得显示“热度暂时不足”

#### Scenario: BSC复苏不因策略部署批量编辑
- **WHEN** 部署新规则时已有SENT的BSC复苏雷达仍处于非终态
- **THEN** 系统不得仅因复苏公开开关变化编辑该消息，但之后正式通过、拒绝或过期仍可编辑同一message id

#### Scenario: 已有BSC Bonding或新池卡应用新区间
- **WHEN** 部署新规则后已有SENT的BSC Bonding或新池卡在后续正常处理时位于Top1–5或第11–20名且尚未终态
- **THEN** 系统可将同一消息编辑为“当前不在公开观察区间”，不得补发或删除卡片

#### Scenario: SOL PENDING恢复保持不变
- **WHEN** SOL旧PENDING候选满足现有SOL恢复与公开条件
- **THEN** 系统继续按现有SOL行为发送或编辑雷达，不应用BSC PENDING限制

#### Scenario: 雷达编辑暂时失败
- **WHEN** Telegram明确返回可重试的编辑失败
- **THEN** 系统保留期望状态并重试同一message id，不得发送替代卡片或修改首次快照
