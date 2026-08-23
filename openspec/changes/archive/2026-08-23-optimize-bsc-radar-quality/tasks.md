## 1. BSC链级发现与公开投影

- [x] 1.1 将Bonding公开排名、真实池公开排名和复苏公开开关收敛为小型链级策略并纳入共享规则快照；明确SOL只产生新报告分段而阈值与行为不变。
- [x] 1.2 复用现有`qualification_events`的独立`bonding_shortcut_readiness` stage记录一次BSC `BONDING_POOL_OPEN_SHORTCUT_READY`事实，并让activation work与池开放快捷路径精确读取该事实而非公开`RADAR`状态；测试Top3未公开仍保留旧快捷机会、Top7公开不凭卡片新增快捷机会，且SOL继续使用原状态路径。
- [x] 1.3 将BSC Bonding及新真实池公开区间改为1m排名6–10；测试Top1–5、11–20仅内部处理、已SENT卡离开区间使用中性文案及SOL原公开区间/文案不变。
- [x] 1.4 在通用`existing → heat_wait`回退前读取链级`revivalPublic`策略，仅在其为false时抑制复苏非终态公开投影，同时保留内部固定池资格和终态编辑；覆盖正常BSC直接复苏、已有Bonding卡、部署前已有SENT复苏卡，以及兼容回滚为true时复用原投影。
- [x] 1.5 在独立`radar_public_readiness` stage按当前规则版本幂等记录BSC公开首发事实：Bonding由发现引擎写入，真实池由公开投影层按链级公开策略表检查fresh 1m、机会类型、非终态、排名、市值、池证据和流动性后按需写入；正常BSC策略即新池6–10且复苏关闭。仅对BSC允许已SENT雷达执行生命周期编辑，BSC旧PENDING必须同时具备当前事实与当前首发门槛；覆盖旧RADAR/PENDING进入第7名但无新持续热度不发、形成两次双榜后可发、Top3新池进入PREHEAT后到Top7可发、旧PREHEAT/PENDING从Top3到fresh Top7可发、离开门槛/复苏/终态不补发，并回归SOL PENDING现有恢复行为不变。

## 2. 不可变首次雷达快照

- [x] 2.1 追加v7可空JSON列`message_outbox.initial_payload_json`，并按`observed_at_ms,id`从旧BSC RADAR最早的不可变`_BONDING_CURVE` activation事件每币确定性桥接一条独立shortcut事实；桥接行继承源事件ruleVersion、时间、source及审计JSON，绝不修改v1–v6。测试仅注册旧规则版本的Top3 v6文件库可原子升级且新行版本等于源事件、历史payload为NULL、Top7新规则事件不被桥接及失败时不写迁移记录。
- [x] 2.2 定义并严格解析`{payload,sendRequestedAtMs,receiptAtMs,ruleVersion}`，以雷达专用单次数据库更新原子写入SENT、message id、receipt和初始envelope；将通用`markSent`限制为signal，禁止雷达绕过专用写入。
- [x] 2.3 增加实际发送payload逐字段、首次发送重入、后续编辑、编辑重试和历史NULL测试；覆盖Top3 shortcut事实→开池→PREHEAT→正式资格后activation reason仍为`RADAR_OPENED`，以及候选随后位于6–10时首次雷达envelope触发原因完整，证明新SENT雷达不可能缺初始envelope且后续不可覆盖。

## 3. BSC固定池方向契约

- [x] 3.1 使用脱敏的BSC base、quote和冲突fixture审计映射；请求前验证冻结binding并由其构造network/pool/token，响应只验证稳定存在的meta base/quote字段。
- [x] 3.2 将本地冻结/请求方向错误分类为`LOCAL_POOL_IDENTITY_MISMATCH`并按现有关键错误路径拒绝或暂停链；不得降级为普通provider missing。
- [x] 3.3 将已证明本地请求正确但CoinGecko响应矛盾分类为`PROVIDER_POOL_META_CONFLICT`，有限重试后记录`PROVIDER_MISSING`及reason code且不生成路径结果。
- [x] 3.4 测试两类错误均不得反转价格、切换池、解析opaque data id或调用Token OHLCV补位，并确认正常固定池资格与评估行为不变。

## 4. 回归、评审与部署验证

- [x] 4.1 运行类型检查、lint、完整测试和生产构建，核对规则版本变化只包含预期的链级策略且没有新增API或依赖。
- [x] 4.2 结构化review实现与测试，重点检查SOL策略零行为变化、共享版本只增加报告分段、BSC池开放快捷资格不随公开区间增减、正式资格零变化、BSC PENDING不补发及v7迁移兼容性；修复到无阻塞问题。
- [x] 4.3 按本地修改、提交推送、服务器拉取重建的既定流程部署，禁止服务器直接编辑文件；检查容器健康、迁移、日志和Telegram异常。
- [x] 4.4 部署后观察BSC无旧PENDING/历史复苏补发、无新Top1–5公开、6–10公开正常、SOL策略行为不变及两类方向错误分别记录；发现问题时只在本地修复后重新推送部署。
- [x] 4.5 在部署前准备、提交并推送唯一兼容回滚构建；它只恢复旧公开排名与复苏开关，并保留v7 schema、shortcut/public-readiness事件、策略驱动的真实池readiness writer、专用`markRadarSent`及初始envelope。在v7数据库副本上smoke test：回滚规则下fresh Bonding Top3、Top15新池PENDING及Top12复苏PENDING可写当前版本readiness并首发，离区间/终态不写，且任一readiness都不使新Top7 RADAR获得shortcut。同步更新README并记录不可移动tag或精确commit SHA，默认回滚只使用该版本与当前v7数据库，禁止直接部署仍以公开`RADAR`状态判断BSC快捷激活的旧提交；旧数据库备份仅作为会丢失部署后累计信号与评估数据的灾难恢复。
