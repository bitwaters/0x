# telegram-signal-delivery Specification

## Purpose
定义雷达、私有验证和正式信号在 Telegram 中的隔离、消息内容、首次发送、状态更新和重复抑制，使用户只看到仍可参考的正式信号。
## Requirements
### Requirement: 雷达、验证与正式消息用途隔离
系统 SHALL 使用雷达频道展示经过公开门槛的Bonding Curve/真实池观察，使用私有验证频道累计公开Beta前的5条可评估端到端样本，使用正式频道发布已达Beta链的有效信号。未公开雷达的内部候选仍可进入验证或正式频道；私有验证频道不属于公开产品频道。

#### Scenario: 候选尚无真实池
- **WHEN** 候选满足公开雷达条件但尚无可验证真实池
- **THEN** 消息只出现在雷达频道并明确标注“非正式信号”

#### Scenario: 链处于验证状态
- **WHEN** 候选通过全部条件但该链尚未达到Beta
- **THEN** 系统将消息发送到私有验证频道且不得发送到公开正式频道

#### Scenario: 链处于 Beta
- **WHEN** 候选通过全部条件且该链处于Beta
- **THEN** 系统将消息发送到公开正式频道并显著标注`🧪 Beta`

### Requirement: 信号消息包含可核验快照
系统 SHALL 在验证和正式卡片中展示链、规范化Token CA、固定池、发送请求时间、发送前固定池价格及成交时间、首次发现时间、面向用户的GMGN安全摘要、CoinGecko 30秒成交摘要、池流动性、`$100`对手侧深度占比、当前状态和风险声明。数据库 SHALL 另存候选方向、Telegram成功回执时间、完整决策快照与决策规则版本；卡片正文不得显示候选base/quote方向、规则版本、内部原因码或实现页脚。深度占比只称为代理，不得描述为滑点、价格冲击或可执行报价。

#### Scenario: 消息成功发送
- **WHEN** Telegram返回成功回执
- **THEN** 系统保存message id、回执时间、完整决策快照与规则版本，同时公开卡片不显示内部规则版本

### Requirement: 每链每个 Token 最多一个信号主消息
系统 SHALL 对同一规范化 `chain + token_contract_address` 最多创建一个验证或正式主消息。验证阶段已发送的代币在链进入 Beta 后不得补发到正式频道；后续状态变化只编辑原消息。

#### Scenario: 同一代币重复触发
- **WHEN** 已发送主消息的候选再次满足条件或重新上榜
- **THEN** 系统不得创建第二条主消息

### Requirement: 首次发送使用最小持久化 outbox
系统 SHALL 在 SQLite 中使用 `PENDING → SENDING → SENT` 状态发送主消息。请求超时或进程在结果未知时中断 SHALL 标记 `UNCERTAIN`、停止自动重发并告警；只有 Telegram 明确返回失败时才可重试同一 outbox 记录。

#### Scenario: 成功回执后持久化
- **WHEN** Telegram 明确返回成功和 message id
- **THEN** 系统原子保存 `SENT`、message id 与回执时间

#### Scenario: 请求结果未知
- **WHEN** 请求超时或进程无法确认 Telegram 是否接收消息
- **THEN** 系统标记 `UNCERTAIN` 且不得自动创建或重发主消息

### Requirement: 发送前漂移超限时不创建主消息
系统 SHALL 仅在固定池5秒复核全部通过且价格相对本次窗口不可刷新资格参考价位于`-5%～+8%`时创建首次信号outbox。暂时越界、超时或数据不足时不得创建主消息，也不得向频道发送“勿追”占位消息；系统 SHALL 保留候选并按原120秒截止重试。

#### Scenario: 发送前漂移不超过 8%
- **WHEN** 复核价格新鲜、相对资格参考价处于`-5%～+8%`且其他条件仍通过
- **THEN** 系统创建outbox并尝试发送

#### Scenario: 发送前漂移超过 8%
- **WHEN** 复核价格相对资格参考价低于-5%或高于+8%
- **THEN** 系统不创建主消息并在原资格窗口内重试，且不得改变参考价

### Requirement: 已发送信号有效期为 90 秒
系统 SHALL 从 Telegram 成功回执开始计算 90 秒有效期。已发送信号价格相对发送前价格绝对漂移超过 8% 时编辑为“勿追”，超过 15% 或到达 90 秒时编辑为“过期”；关键安全或流动性风险触发时编辑为“失效”。有效期内系统 SHALL 在第 30 秒和第 60 秒重取 GMGN token security 与 CoinGecko pool detail；持续榜单轮询中若候选仍在榜则同时复核 trending 风险字段。字段明确恶化或流动性不满足门槛时失效，单纯离榜不作为新增安全结论。任一次定时复核失败时 SHALL 在 3 秒后重试一次；重试仍无法取得新鲜完整数据时编辑为“失效：数据不可确认”。

#### Scenario: 已发送信号价格快速变化
- **WHEN** 有效期内绝对漂移超过 8% 但不超过 15%
- **THEN** 系统编辑原消息为“勿追”且不创建新消息

#### Scenario: 信号过期或风险失效
- **WHEN** 漂移超过 15%、到达 90 秒或触发关键风险
- **THEN** 系统编辑原消息为“过期”或“失效”并保留初始快照

#### Scenario: 定时风险复核持续失败
- **WHEN** 第 30 秒或第 60 秒复核失败且 3 秒后的单次重试仍失败
- **THEN** 系统编辑原消息为“失效：数据不可确认”并记录具体提供商错误

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
