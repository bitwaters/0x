## Context

参见 [proposal.md](proposal.md) 的动机。当前发现策略由共享常量驱动，BSC与SOL使用相同的公开排名上界；内部新池一次有效热度触发即可进入`PREHEAT`。雷达采用一币一卡outbox，但`payload_json`会被后续生命周期编辑覆盖，无法恢复首次公开快照。

生产数据还显示BSC部分固定池的Pool Detail方向与Pool OHLCV元数据不一致。现有主规范已经分别定义本地错误池/方向为关键技术错误、提供商数据契约错误为`PROVIDER_MISSING`，本变更保持该差异，不设计自动反转或替代行情路径。

## Goals / Non-Goals

**Goals:**

- 以最小链级策略分支降低BSC公开雷达的追高和低信息噪音。
- 保持公开投影、内部候选和正式资格解耦，使未公开候选仍按现有条件进入完整资格。
- 用一个不可变初始envelope恢复未来雷达分析的可信锚点。
- 让本地方向错误与CoinGecko响应元数据冲突分别fail-closed并可审计。

**Non-Goals:**

- 不调整SOL阈值、激活、投影或正式资格行为；共享规则hash和报告分段允许随配置快照变化。
- 不调整BSC内部新池/复苏激活、正式安全、持仓、流动性、成交、漂移、资格窗口或发布门槛。
- 不增加评分、机器学习、多策略组合、第三方API或新的定时分析服务。
- 不回填历史雷达初始快照，不自动修复CoinGecko互相矛盾的池方向。
- 不在本变更内建立Token OHLCV研究管线或用Token OHLCV替代固定池评估。

## Decisions

### 1. 使用小型链级公开策略表，不复制发现引擎

在现有发现策略中增加三个链级公开决策：Bonding公开排名区间、真实池公开排名区间、复苏是否允许公开雷达。BSC分别取`6–10`、`6–10`、`false`；SOL保持当前`1–5`、`1–20`、`true`。

策略表只参与公开投影。现有实现把公开`RADAR`状态同时用于Bonding池开放快捷激活，因此BSC必须用现有`qualification_events`解开这个耦合：无真实池候选按旧条件满足持续热度、当前1m Top1–5及市值`$10,000–$100,000`时，只写一次`stage='bonding_shortcut_readiness'`、`reason_code='BONDING_POOL_OPEN_SHORTCUT_READY'`的内部事实而不发送公开卡；之后组装activation work时，BSC的原`RADAR_OPENED`快捷路径按精确stage与reason查询该事实，而不是读取公开`RADAR`状态。公开第6–10名本身不得授予该内部事实，SOL继续使用现有状态路径。

v7迁移从部署前BSC `status='RADAR'`候选已有的、`stage='activation'`且reason以`_BONDING_CURVE`结尾的不可变事件中，按`observed_at_ms,id`选择每币最早一条并确定性复制独立shortcut事实。桥接行继承源事件的`decision_rule_version`、`observed_at_ms`、source和全部审计JSON，只把stage、outcome及reason改为shortcut事实所需值；迁移时不依赖尚未注册的新规则版本。不按当前排名猜测、不把部署后第6–10名公开卡桥接为快捷资格。shortcut查询不要求当前规则版本，shortcut stage也不得参与`findFirstActivationReasonCode`；真实池开放后仍由后续`RADAR_OPENED_REAL_POOL`作为首次真正activation reason。

BSC新池继续按当前一次有效热度触发进入`PREHEAT`，BSC复苏继续按当前持续热度进入内部资格；Top1–5或11–20未公开不得改变激活基线、120秒资格窗口或正式发送。该方案复用既有事件表，不复制服务、不增加状态机或新的热度存储。

### 2. PENDING首发与SENT生命周期严格分开

对于BSC，运行时只有已经SENT的雷达outbox才可因`heat_wait`、正式通过、拒绝或过期执行生命周期编辑。Bonding的公开首发事实由发现引擎在满足当前持续热度、排名及市值条件时写入；即使候选已是旧`RADAR`，重新形成持续热度也可写入。真实池的公开首发事实由现有公开投影层在首次发送前按新鲜1m事实幂等写入，不依赖是否恰好在激活瞬间：状态须为`PREHEAT/POOL_BOUND/MONITORING`，并按当前链级公开策略表检查机会类型、排名区间、市值范围、已有激活证据证明GMGN最大池有效及当前GMGN流动性至少`$10,000`；终态永不写入。正常BSC策略因此只允许`new_pool`第6–10名，复苏不写；兼容回滚策略恢复Top1–20及复苏公开时，同一writer按回滚规则版本写readiness，不需要另一条分支。

两条路径都写入`stage='radar_public_readiness'`、`reason_code='BSC_RADAR_PUBLIC_READY'`及当前`decision_rule_version`，每币每规则版本只保留第一条事实。该写入复用现有发现/投影执行，不增加轮询或后台任务。

旧规则遗留的BSC PENDING记录不构成公开资格：只有当前排名、市值、池型等再次满足对应BSC首发门槛，且存在当前规则版本的上述公开事实时才可发送；PENDING候选进入终态也不得补发终态卡。由旧规则进入PREHEAT但没有当前公开事实的PENDING不得仅凭状态发送。SOL保留现有PENDING恢复和生命周期行为。

公开投影在非终态阶段读取同一链级`revivalPublic`策略；仅当其为`false`时，才在通用`existing → heat_wait`回退之前跳过该链复苏投影。正常BSC策略因此抑制复苏雷达，兼容回滚恢复为`true`时则复用原投影与策略驱动的readiness writer，不增加专用分支。部署前已SENT的复苏卡不因正常策略开关发生批量非终态编辑，但之后正式通过、拒绝或过期仍编辑原message id。已有BSC Bonding/新池SENT卡在后续正常处理时可按新区间执行一次中性状态编辑；离开6–10时沿用`heat_wait`状态但使用“当前不在公开观察区间”文案。SOL文案保持现状。

### 3. 初始雷达快照使用outbox单列、只写一次

追加v7迁移，为`message_outbox`增加可空列`initial_payload_json TEXT CHECK(initial_payload_json IS NULL OR json_valid(initial_payload_json))`；同一原子迁移按前述不可变旧Bonding事件桥接BSC shortcut事实。绝不修改已应用的v1–v6。旧outbox记录的初始快照保持NULL，不回填。

初始JSON固定为`{payload, sendRequestedAtMs, receiptAtMs, ruleVersion}`。`payload`是本次实际传给Telegram的`{text,snapshot}`，首次公开发送必须具有排名、当前市值和触发原因；`ruleVersion`是渲染本次雷达时的共享规则版本。雷达使用专用`markRadarSent`，以同一条UPDATE或同一数据库事务把`SENDING → SENT`、message id、receipt及`initial_payload_json`一起写入，条件要求`message_kind='radar' AND status='SENDING' AND initial_payload_json IS NULL`。通用`markSent`限制为`message_kind='signal'`，雷达不得绕过专用写入；后续雷达编辑只更新现有`payload_json`与hash。

### 4. 固定池方向冲突区分本地错误与提供商冲突

请求前先验证冻结binding：chain、pool address、base/quote组成和`candidate_side`必须自洽，再由这些冻结值构造network-scoped URL及`token={candidate_side}`。OHLCV响应没有稳定回显network、pool address或请求token，因此响应只校验文档存在的`meta.base/quote.address`与冻结组成，不解析opaque `data.id`猜测身份。

- 若冻结binding、请求路径或本地candidate side映射自相矛盾，分类为`LOCAL_POOL_IDENTITY_MISMATCH`：发送前候选关闭式拒绝；若已进入delivered evaluation，则按现有关键错误规范暂停该链，不得记为普通缺失。
- 若已证明本地请求正确，而同池Pool Detail与OHLCV `meta.base/quote`仍互相矛盾，分类为`PROVIDER_POOL_META_CONFLICT`：按现有提供商契约错误有限重试，最终记录`PROVIDER_MISSING`及reason code，不生成MFE、MAE或路径。

两类均不得反转价格、切换top pool或调用Token OHLCV补位。使用脱敏的BSC base、quote和元数据冲突fixture覆盖两条错误路径，不新增评估状态。

### 5. 规则版本和既有候选

链级公开策略进入现有共享规则配置hash，部署会生成新规则版本并使SOL后续报告出现新分段；不为此引入每链版本系统。SOL阈值和行为保持不变，既有激活基线、资格参考价和已发送样本不得因版本变化重置。

非终态候选按现有机制继续判断。不得恢复既有安全拒绝、超时或已发送候选，也不得再次执行历史复苏批量重开。既有SENT雷达不删除；旧SENT复苏卡不因复苏公开开关执行非终态策略编辑，已有Bonding/新池卡之后仍可按正常生命周期执行中性区间或终态编辑。

## Risks / Trade-offs

- [BSC公开雷达数量明显下降] → 内部Top100覆盖、内部激活和正式资格保持；部署后按新规则版本独立统计。
- [排名6–10可能错过仍在Top1–5继续上涨的少数代币] → Top1–5继续内部处理和正式资格，不把公开雷达当成候选准入门槛。
- [旧雷达没有初始快照] → 明确保留缺失，不进行有前视偏差的回填。
- [方向冲突使部分固定池评估继续缺失或触发链暂停] → 只有已证明的本地身份错误才暂停；提供商自相矛盾单列缺失，避免错误收益污染。
- [共享规则版本使SOL报告分段] → 接受元数据分段，测试保证SOL策略和既有资格事实不变，不增加每链版本复杂度。

## Migration Plan

1. 追加v7可空JSON列及确定性旧BSC shortcut桥接迁移，不修改v1–v6、不回填历史初始payload；用已应用v6且含历史SENT雷达和旧Bonding事件的文件库验证升级、桥接边界与失败原子性。
2. 实现链级公开策略、两个独立资格事件stage、BSC PENDING首发边界、BSC复苏投影短路和BSC中性区间文案，保持内部激活机会集合、真实activation reason与SOL行为不变。
3. 增加雷达专用原子`markRadarSent`及初始envelope只写一次持久化。
4. 增加本地身份错误与提供商元数据冲突的fixture、分类和现有fail-closed路径测试。
5. 本地执行单元、集成、配置与生产构建测试；确认规则版本变化只来自预期配置。
6. 按既定流程本地提交、推送、服务器拉取并重建部署；服务器不直接修改文件。
7. 部署前生成并记录唯一兼容回滚Git ref，在v7数据库副本上完成smoke test，并同步更新README回滚runbook；部署后检查健康状态、无旧PENDING/复苏补发、SOL策略未变、BSC公开投影及方向错误日志符合预期。

回滚时只允许部署README记录的不可移动tag或精确commit SHA。该兼容回滚构建只恢复旧公开排名区间与复苏开关；真实池readiness writer读取该链级策略，因此可按回滚规则版本恢复Top1–20新池与复苏首发。构建必须继续保留v7 schema兼容、`bonding_shortcut_readiness`读取、`radar_public_readiness`门禁、专用`markRadarSent`及不可变初始envelope，并使用当前v7数据库。readiness仅授权公开首发，绝不得授予池开放shortcut。不得在新规则已创建第6–10名`RADAR`后直接部署完全旧提交，否则旧状态耦合会错误授予快捷资格；也不得用旧数据库备份覆盖当前库。v7附加历史事件可与旧公开策略共存，不需要删除或破坏性数据库回滚。旧库恢复只作为明确接受丢失部署后累计信号与评估数据的灾难恢复；已按新规则发送的雷达不删除或补发。
