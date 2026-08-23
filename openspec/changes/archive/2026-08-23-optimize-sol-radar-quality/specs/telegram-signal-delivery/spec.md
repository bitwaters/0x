## MODIFIED Requirements

### Requirement: 每链每个 Token 最多一个雷达消息
系统 SHALL 对同一规范化`chain + token_contract_address`最多创建一个雷达消息。SOL只有同时存在当前规则版本的`radar_public_readiness`事实并在发送时从持久化快照重新满足当前Bonding公开门槛的PENDING才可首次发送；已离开门槛、直接真实池、复苏或终态不得因旧PENDING补发。BSC继续允许策略驱动的新池公开层按当前第6–10名、池与流动性门槛写readiness并首发，只禁止复苏、未通过当前门槛或终态补发。

已经SENT的雷达继续只编辑同一message id：SOL只有初始envelope明确为Bonding的卡可升级为符合公开门槛的新池；历史NULL或明确非Bonding卡不执行非终态升级，但仍执行正式通过、拒绝、过期等终态编辑。BSC继续执行现有新区间和生命周期编辑。编辑失败 SHALL 持久化最新期望内容并有限重试，不得补发第二张。

首次雷达取得Telegram成功回执时，系统 SHALL 在同一数据库更新中保存SENT、message id、回执时间及不可变初始envelope：`{payload, sendRequestedAtMs, receiptAtMs, ruleVersion}`；payload必须是本次实际发送内容并含首次公开阶段、GMGN排名、市值和触发原因。后续编辑只更新当前期望内容，不得覆盖初始envelope；部署前历史雷达保持初始快照缺失，不得猜测回填。

#### Scenario: SOL首次发送仍满足门槛
- **WHEN** SOL Bonding PENDING存在当前规则公开事实，发送时仍为新鲜连续双榜、Top5且市值`$10,000–$100,000`
- **THEN** 系统首次发送Bonding雷达并原子保存完整初始envelope

#### Scenario: SOL旧PENDING离开门槛
- **WHEN** SOL旧PENDING候选已离开Top5、缺少当前公开事实、已进入真实池或终态
- **THEN** 系统不得首次发送热度等待、真实池、拒绝或过期卡

#### Scenario: SOL已发送Bonding卡升级
- **WHEN** 已SENT的SOL Bonding候选开放符合门槛的新池
- **THEN** 系统编辑原message id为“真实池验证中”并保留首次Bonding envelope

#### Scenario: SOL直接真实池不新建消息
- **WHEN** SOL候选没有已SENT Bonding卡但直接进入真实池内部资格
- **THEN** 系统不得创建雷达outbox或公开卡，正式资格流程不受影响

#### Scenario: SOL历史NULL卡只保留终态编辑
- **WHEN** SOL已SENT雷达的初始envelope为NULL且进入真实池非终态
- **THEN** 系统不得猜测Bonding来源或升级，之后终态仍编辑同一message id

#### Scenario: BSC首次发送和编辑保持不变
- **WHEN** BSC候选进入雷达首次发送或已SENT生命周期编辑
- **THEN** 系统继续执行现有BSC当前规则readiness、第6–10名首发和单卡编辑行为

#### Scenario: 雷达后续编辑不覆盖初始快照
- **WHEN** 已送达雷达的展示阶段、排名、市值或终态发生变化
- **THEN** 系统更新同一message id的当前期望内容，但不得修改首次envelope

#### Scenario: Bonding升级为真实池
- **WHEN** 已发送Bonding雷达的候选满足其链级变更后真实池公开门槛
- **THEN** 系统编辑原雷达消息为“真实池验证中”、保留首次Bonding快照且不创建新消息

#### Scenario: 雷达首次成功送达
- **WHEN** Telegram为首次雷达发送返回成功message id与回执时间
- **THEN** 系统以一次雷达专用数据库更新原子保存`SENT`、message id、回执时间和完整初始envelope

#### Scenario: 雷达后续编辑
- **WHEN** 已送达雷达的展示阶段、排名、市值或终态发生变化
- **THEN** 系统更新同一message id的当前期望内容，但不得修改首次快照

#### Scenario: 历史雷达没有初始快照
- **WHEN** 变更部署前已发送雷达的初始内容未被持久化
- **THEN** 系统保持`initial_snapshot_unavailable`且不得以当前payload回填

#### Scenario: BSC已发送雷达进入Top1–5
- **WHEN** 一张已SENT的BSC雷达从第6–10名升至Top1–5且尚未进入终态
- **THEN** 系统只编辑同一消息为“当前不在公开观察区间”并继续内部处理

#### Scenario: BSC复苏不因策略部署批量编辑
- **WHEN** 部署新规则时已有SENT的BSC复苏雷达仍处于非终态
- **THEN** 系统不得仅因SOL策略变化编辑该消息，之后终态仍可编辑同一message id

#### Scenario: 已有BSC Bonding或新池卡应用新区间
- **WHEN** 已SENT的BSC Bonding或新池卡后续位于Top1–5或第11–20名且尚未终态
- **THEN** 系统可编辑同一消息为“当前不在公开观察区间”，不得补发或删除

#### Scenario: SOL PENDING恢复保持不变
- **WHEN** SOL旧PENDING候选满足变更后的当前public readiness与Bonding首发条件
- **THEN** 系统只恢复仍处于公开门槛内的首次发送，不恢复直接真实池、复苏或终态卡

#### Scenario: 雷达编辑暂时失败
- **WHEN** Telegram明确返回可重试的编辑失败
- **THEN** 系统保留期望状态并重试同一message id，不得发送替代卡片或修改首次快照
