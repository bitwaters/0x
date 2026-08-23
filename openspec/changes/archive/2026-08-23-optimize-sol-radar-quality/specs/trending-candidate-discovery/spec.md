## MODIFIED Requirements

### Requirement: 公开雷达与内部激活分离
系统 SHALL 保留 GMGN Top100 内部候选覆盖并按链执行公开 Bonding 雷达。SOL 只公开市值 `$10,000–$100,000`、尚无真实池、当前1m排名Top5且连续两个新1m快照均与新鲜5m快照形成双榜的候选；SOL连续三次1m上升继续内部处理但不得公开。BSC继续只公开同一市值范围、尚无真实池、当前1m排名第6–10名且满足连续两次双榜或连续三次1m上升的候选。公开条件不得成为内部真实池激活或正式资格前置条件。

系统 SHALL 以独立`bonding_shortcut_readiness`事实保留两链池开放快捷机会。SOL候选按变更前条件满足连续双榜或三次上升、当前1m Top5及市值范围时记录事实，但只有链级策略当前允许的公开触发写入当前规则版本`radar_public_readiness`；正常SOL策略只允许连续双榜。SOL首次发送的触发验证器 SHALL 同样由策略驱动：连续双榜必须从持久化数据证明最近连续两个成功1m批次均有该币，且每个1m批次都能配对当时可用、含该币的新鲜5m批次；两侧每行均处于内部`$10,000–$300,000`范围，1m/5m年龄分别不超过6/15秒且配对获取时间差不超过12秒。兼容回滚的三次上升必须证明最近三个连续成功1m批次均有该币、相邻间隔不超过6秒、每行处于内部市值范围且名次严格逐次变小。之后再叠加最新1m公开排名和公开市值门槛；缺榜、超时、市值越界或趋势重置均不得把历史readiness当作永久授权。BSC继续按其现有策略写公开事实和Top1–5旧快捷事实。两链池开放快捷路径 SHALL 读取独立事实而非公开`RADAR`状态，任一公开readiness不得授予快捷资格。

部署前只有当前仍为`RADAR`、尚未真实激活的SOL候选可从对应Bonding activation事件确定性桥接shortcut事实；`legacy_reopened_at_ms`非空时只允许选择该时间之后的最早Bonding activation，重置后未重新激活不得桥接。shortcut事实不得成为首次真实activation reason。

#### Scenario: SOL连续双榜公开
- **WHEN** SOL Bonding候选连续两个新1m快照均与新鲜5m快照形成双榜，且第二次当前1m排名为Top5、市值为`$10,000–$100,000`
- **THEN** 系统记录当前公开事实并发送一张非正式Bonding雷达卡

#### Scenario: SOL历史readiness不能替代当前双榜
- **WHEN** SOL候选曾写公开readiness，但最近两个成功1m批次任一缺榜、匹配5m缺榜或已过期，之后仅最新1m回到Top5
- **THEN** 系统不得首次发送，直到持久化快照重新形成当前连续两次双榜

#### Scenario: SOL配对5m市值越界不算双榜
- **WHEN** SOL候选最近两个1m批次均为Top5和公开市值，但任一配对5m行市值高于内部上限
- **THEN** 持久化重建结果必须与发现引擎一致判定双榜无效并禁止首次发送

#### Scenario: 回滚三次上升必须仍然连续
- **WHEN** 兼容回滚规则下候选曾写rising readiness，但最近三个成功1m批次缺榜、间隔超6秒或名次不再严格上升
- **THEN** 系统不得首次发送，直到重新形成当前三次连续上升

#### Scenario: SOL三次上升只内部处理
- **WHEN** SOL Bonding候选连续三次1m名次上升并最终进入Top5但没有连续两次双榜
- **THEN** 系统记录内部快捷事实并继续池解析，但不得写公开事实或发送雷达

#### Scenario: SOL内部快捷机会保持
- **WHEN** 仅以三次上升满足旧条件的SOL Top5 Bonding候选之后在当前双榜不成立时开放真实池
- **THEN** 系统使用独立shortcut事实沿用原池开放快捷路径，不依赖公开卡

#### Scenario: 部署前SOL Bonding候选保持快捷机会
- **WHEN** 部署前SOL候选已有`_BONDING_CURVE` activation事件，部署后开放真实池且当前双榜不成立
- **THEN** 系统使用迁移桥接的shortcut事实保留原内部激活机会

#### Scenario: legacy reset后未重新激活不桥接
- **WHEN** SOL候选的旧Bonding activation早于`legacy_reopened_at_ms`且重置后没有新的Bonding activation
- **THEN** v8不得桥接shortcut事实，候选必须重新满足内部激活

#### Scenario: BSC公开与快捷规则不变
- **WHEN** BSC候选满足现有第6–10名公开条件或Top1–5内部快捷条件
- **THEN** 系统继续按现有BSC公开与内部事实规则处理，不应用SOL双榜专属限制

#### Scenario: 连续双榜进入公开雷达
- **WHEN** 候选连续两个新1m快照均与新鲜5m快照形成双榜并进入其链级公开排名和市值区间
- **THEN** 系统按当前规则记录公开事实并允许一张非正式Bonding雷达卡

#### Scenario: BSC Top1–5仅内部处理
- **WHEN** BSC候选满足持续热度但当前1m排名为1–5
- **THEN** 系统继续内部解析和后续真实池检测，但不得发送公开Bonding雷达

#### Scenario: BSC Top3保留原池开放快捷机会
- **WHEN** 无真实池BSC候选满足原持续热度、市值范围且当前1m排名为3，之后在当前双榜不成立时开放真实池
- **THEN** 系统不发送Bonding雷达但记录内部快捷事实，并允许真实池沿用原池开放快捷路径

#### Scenario: 部署前旧Top3雷达保留快捷机会
- **WHEN** 部署前BSC Top3候选已有`_BONDING_CURVE` activation事件和`RADAR`状态，部署后首个处理快照直接显示池开放且当前双榜不成立
- **THEN** 系统以迁移桥接的内部事实沿用原池开放快捷路径并进入`PREHEAT`

#### Scenario: BSC Top7公开不新增池开放快捷机会
- **WHEN** 无真实池BSC候选以当前1m排名7发送Bonding雷达但从未满足内部快捷事实，之后在当前双榜不成立时开放真实池
- **THEN** 系统不得仅因已有公开雷达进入原池开放快捷路径

#### Scenario: SOL公开规则保持不变
- **WHEN** SOL Bonding候选满足Top5、市值和连续两次双榜公开门槛
- **THEN** 系统保持原Top5与市值边界发送非正式雷达，但三次上升只保留内部机会

#### Scenario: 后排名次上升仅内部处理
- **WHEN** 候选1m排名从90升至70再升至50
- **THEN** 系统保留并解析内部候选但不得公开雷达卡

### Requirement: 真实池雷达使用独立公开门槛
系统 SHALL 仅在GMGN最大池地址有效、GMGN流动性至少`$10,000`且满足链级公开投影时展示“真实池验证中”。SOL只有v7初始envelope明确记录Bonding首次阶段的SENT卡，才可在机会类型为新池、市值`$20,000–$300,000`且当前1m排名Top20时升级；历史NULL envelope不得被猜测为Bonding，非终态升级fail-closed但仍允许终态编辑。SOL直接真实池和复苏机会不得新建或升级公开雷达，但仍按现有内部条件进入同一正式资格流程。BSC继续只公开同一市值范围、当前1m排名第6–10名且机会类型为新池的候选，并继续抑制复苏公开。未达到公开门槛不得阻止内部等待、固定池验证或正式资格。

#### Scenario: SOL Bonding卡升级为真实池
- **WHEN** 初始envelope明确为Bonding的SENT SOL候选开放不超过30分钟的新池并满足市值、Top20、池地址和流动性门槛
- **THEN** 系统编辑原卡为“真实池验证中”且不得创建第二张

#### Scenario: 历史NULL envelope不执行非终态升级
- **WHEN** 部署前SOL SENT雷达的初始envelope为NULL且候选进入真实池非终态
- **THEN** 系统不得猜测其首次阶段或升级卡片，但之后正式通过、拒绝或过期仍可编辑同一message id

#### Scenario: SOL直接真实池不公开
- **WHEN** 未发送Bonding雷达的SOL新池候选满足完整内部激活和真实池条件
- **THEN** 系统不得新建雷达，但仍进入`PREHEAT`并继续固定池正式资格

#### Scenario: SOL复苏只内部处理
- **WHEN** SOL老池复苏满足持续热度和完整内部激活条件
- **THEN** 系统不得创建或升级公开雷达，但仍允许其通过固定池资格进入验证或正式频道

#### Scenario: BSC真实池规则保持不变
- **WHEN** BSC新池或复苏候选进入公开投影
- **THEN** 系统继续执行现有BSC第6–10名新池公开、复苏关闭及当前规则readiness约束

#### Scenario: Bonding雷达升级
- **WHEN** 已有SENT Bonding雷达的候选满足其变更后的链级真实池公开门槛
- **THEN** 系统编辑原雷达卡为“真实池验证中”且不得创建第二张

#### Scenario: 直接发现真实池
- **WHEN** 未发送Bonding雷达的候选首次发现时已存在真实池
- **THEN** SOL不得新建雷达，BSC仅在满足现有第6–10名新池公开门槛时创建一张雷达卡

#### Scenario: 真实池公开热度不足
- **WHEN** 真实池候选不满足其链级公开排名或机会类型门槛
- **THEN** 系统不得公开真实池雷达，但保留内部候选和资格流程

#### Scenario: BSC Top1–5新池继续内部资格
- **WHEN** BSC新池按现有内部条件激活且当前1m排名为1–5
- **THEN** 系统不得公开真实池雷达，但仍进入`PREHEAT`并可继续完整正式资格

#### Scenario: BSC第11–20名新池继续内部资格
- **WHEN** BSC新池按现有内部条件激活且当前1m排名为11–20
- **THEN** 系统不得公开真实池雷达，但仍进入`PREHEAT`并可继续完整正式资格

#### Scenario: BSC Top3新池稍后进入公开区间
- **WHEN** BSC新池在Top3进入`PREHEAT`且未公开，之后以fresh 1m排名7满足当前市值、池证据和流动性首发门槛
- **THEN** 公开投影幂等写入当前规则公开事实并可首次发送“真实池验证中”

#### Scenario: BSC复苏只进入内部资格
- **WHEN** BSC老池复苏满足现有持续热度及完整内部激活条件
- **THEN** 系统不得创建或升级公开雷达，但仍允许其进入固定池资格

#### Scenario: 旧PENDING雷达不补发
- **WHEN** 旧PENDING候选缺少当前规则公开事实、离开当前首发门槛、属于关闭的机会类型或已进入终态
- **THEN** 系统不得因PENDING记录存在而发送热度等待、真实池、拒绝或过期卡片

#### Scenario: 旧Bonding PENDING需要当前公开事实
- **WHEN** 旧Bonding PENDING候选当前进入链级排名区间但未重新形成当前公开持续热度
- **THEN** 系统不得发送；只有写入当前规则公开事实且发送时仍满足门槛才可首次发送

#### Scenario: 旧真实池PENDING没有当前公开事实
- **WHEN** 旧真实池PENDING没有当前规则版本的公开首发事实
- **THEN** SOL不得直接首发，BSC只有重新满足其新池第6–10名完整门槛时才可写事实并首发

#### Scenario: SOL PENDING恢复保持不变
- **WHEN** SOL旧PENDING候选重新满足变更后的连续双榜Bonding首发门槛
- **THEN** 系统允许按当前readiness恢复；直接真实池、复苏、离榜或终态不再恢复首发

#### Scenario: SOL真实池公开规则保持不变
- **WHEN** 已SENT的SOL Bonding候选开放新池并满足原市值、Top20、池地址和流动性门槛
- **THEN** 系统继续编辑原卡为真实池状态，但没有已SENT Bonding卡时不新建公开雷达
