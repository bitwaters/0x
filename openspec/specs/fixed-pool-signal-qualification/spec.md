# fixed-pool-signal-qualification Specification

## Purpose
定义真实池候选在可验证安全字段、固定池方向、短时成交动量、数据新鲜度和追高限制下成为正式信号的统一判定契约。
## Requirements
### Requirement: 外部数据源权责不可混用
系统 SHALL 以 GMGN 作为发现、市值、同源发现涨幅、代币安全和主池解析的唯一裁决源，以 CoinGecko 作为锁定池价格、逐笔成交、OHLCV、池组成和信号后表现的唯一裁决源。重叠字段不得平均、拼接或互相覆盖。

#### Scenario: 两个来源字段不一致
- **WHEN** GMGN 与 CoinGecko 对价格、市值或流动性给出不同值
- **THEN** 系统按字段权责使用指定来源、记录差异且不得混合数值

#### Scenario: 指定来源暂时不可用
- **WHEN** GMGN 或 CoinGecko 暂时不可用
- **THEN** 系统等待、拒绝或失效候选，不得调用第三方行情或链上风控 API 补位

### Requirement: 安全硬门槛只使用已定义 GMGN 字段
系统 SHALL 使用下列最小安全字段集，保存原始值和规范化值；任一必需字段缺失、类型错误或不满足条件时关闭式拒绝。未列入本契约的风险能力不得在消息中宣称已验证。

| 链 | GMGN 端点与字段 | 规范化类型 | 通过条件 |
|---|---|---|---|
| 两链 | token security `top_10_holder_rate` | 十进制字符串转 0–1 比例 | `≤0.25` |
| 两链 | trending `dev_team_hold_rate` | 0–1 数值 | `≤0.20` |
| 两链 | trending `rug_ratio` | 0–1 数值 | `≤0.30` |
| 两链 | trending `is_wash_trading` | 布尔 | `false` |
| 两链 | trending `rat_trader_amount_rate` | 0–1 比例 | `≤0.20` |
| 两链 | trending `bundler_rate` | 0–1 比例 | `≤0.20` |
| SOL | token security `renounced_mint` | 布尔 | `true` |
| SOL | token security `renounced_freeze_account` | 布尔 | `true` |
| BSC | token security `is_honeypot` | 布尔 | `false` |
| BSC | token security `is_open_source` | 布尔 | `true` |
| BSC | token security `is_renounced` | 布尔 | `true` |
| BSC | token security `buy_tax` | 十进制字符串转 0–1 比例 | `≤0.05` |
| BSC | token security `sell_tax` | 十进制字符串转 0–1 比例 | `≤0.05` |

#### Scenario: 必需字段全部通过
- **WHEN** 候选的所有适用字段均存在、可严格规范化且满足表中条件
- **THEN** 系统允许其继续固定池验证

#### Scenario: 未定义或无法解析的风险字段
- **WHEN** 必需字段缺失、值不在合法范围，或 GMGN 契约与保存的契约样本不一致
- **THEN** 系统拒绝正式资格、记录 `security_contract_error` 且不得使用名称相似字段替代

#### Scenario: 生产响应与文档别名不同
- **WHEN** BSC security 同时含有实测布尔字段和 `open_source`、`renounced` 等数值别名
- **THEN** 系统只按版本化实测契约读取 `is_open_source`、`is_renounced`，不得静默回退到别名

### Requirement: 发送前使用新鲜 GMGN 风险数据
系统 SHALL 要求用于最终裁决的 trending 候选快照年龄不超过 15 秒，token info 与 token security 请求完成时间不超过 30 秒。候选已离开最新有效榜单或任一数据过期时不得发送。

#### Scenario: 等待真实池后风险数据已过期
- **WHEN** 候选完成固定池绑定但原安全数据超过对应 TTL
- **THEN** 系统重新获取适用数据并重新执行全部硬门槛

#### Scenario: 无法获得新鲜风险数据
- **WHEN** 资格窗口内无法得到满足 TTL 的必需数据
- **THEN** 系统不得发送验证或正式信号

### Requirement: 固定池绑定必须确认链、地址和候选方向
系统 SHALL 使用 GMGN `token info.biggest_pool_address` 选择主池，并要求 CoinGecko 在对应 network-scoped URL 中识别同一池。SOL 池地址按合法 Base58 精确比较；BSC 池地址解析为 20-byte 后比较。CoinGecko `base_token` 或 `quote_token` 必须与规范化候选 CA 一致，系统 SHALL 持久化 `candidate_side`。逐笔成交或 OHLCV 只能使用当前进程中由 CoinGecko pool detail 验证并冻结的池组成；进程重启后 SHALL 重新验证，不得仅凭持久化方向直接查询。

#### Scenario: 候选是 base token
- **WHEN** CoinGecko 固定池的 `base_token` 等于候选 CA
- **THEN** 系统保存 `candidate_side=base` 并用该方向请求候选定向成交

#### Scenario: 候选是 quote token
- **WHEN** CoinGecko 固定池的 `quote_token` 等于候选 CA
- **THEN** 系统保存 `candidate_side=quote` 并用该方向请求候选定向成交

#### Scenario: 地址或池组成不匹配
- **WHEN** network、规范化池地址或池中 Token 组成任一不匹配
- **THEN** 系统关闭式拒绝且不得切换到 CoinGecko 自动选择的 top pool

### Requirement: 主池绑定后不得静默切换
系统 SHALL 在候选唯一120秒资格窗口内绑定一个固定池。固定池消失、流动性归零、池组成改变或GMGN返回另一主池时 SHALL 终止候选且不得换池；非零流动性低于门槛或短时下降只作为可恢复等待，不得静默切池或立即永久拒绝。

#### Scenario: 锁定池失效
- **WHEN** 已锁定池消失、流动性归零、组成改变或GMGN主池地址发生变化
- **THEN** 系统将候选标记失效并释放实时订阅

#### Scenario: 非零流动性暂时不足
- **WHEN** 已锁定池仍存在且组成不变但流动性暂时低于门槛
- **THEN** 系统保持同池并在原资格窗口内等待恢复

### Requirement: 最近成交必须来自明确的 30 秒固定池窗口
系统 SHALL 使用 CoinGecko network-scoped 固定池 REST trades，以 `token={candidate_side}` 获取候选定向成交并按提供商事件标识去重。正式裁决 SHALL 使用最近30秒内至少5笔、最多最新10笔成交，要求最新成交年龄不超过15秒、样本总成交额至少`$500`、买入笔数占比至少60%、买入USD占比至少60%且最大单笔不超过样本成交额40%。`net_buy_usd`继续保存为证据，但不得替代买入金额占比。G2 Trade只触发REST刷新，不参与正式价格、方向或金额裁决。

#### Scenario: 逐笔条件通过
- **WHEN** 至少5笔成交的总额不低于`$500`、最新年龄不超过15秒、买入笔数和USD占比均至少60%且最大单笔不超过40%
- **THEN** 系统允许其继续发送前检查

#### Scenario: 小买单掩盖大卖单
- **WHEN** 买入笔数占比达到60%但买入USD占比低于60%
- **THEN** 系统在资格窗口内等待新成交且不得通过

#### Scenario: 成交额不足
- **WHEN** 其他成交条件通过但样本总成交额低于`$500`
- **THEN** 系统在资格窗口内等待新成交且不得通过

#### Scenario: 回填或新鲜度不足
- **WHEN** 无法回填固定池成交、最新成交超过15秒或30秒内不足5笔
- **THEN** 系统在资格窗口内等待，窗口结束仍不足则过期

### Requirement: 流动性检查采用简单固定池门槛和深度代理
系统 SHALL 使用 `include_composition=true` 的 CoinGecko fixed-pool detail，以 `reserve_in_usd` 判断总流动性不低于`$10,000`，并要求两次成功请求的本地 `fetched_at` 间隔至少10秒、样本间下降不超过10%。候选为base时支付侧使用quote USD流动性，候选为quote时使用base USD流动性；`$100_depth_ratio = 100 / counter_side_liquidity_usd`必须不超过3%。池仍存在、组成不变且流动性非零时，任一样本暂时低于门槛、下降超10%或深度超限 SHALL 以当前同池样本重建首样本并继续等待，但不得改变原120秒截止时间。

#### Scenario: 固定池流动性稳定
- **WHEN** 两次成功请求间隔至少10秒、样本均不低于`$10,000`、下降不超过10%且深度占比不超过3%
- **THEN** 系统允许继续发送前检查

#### Scenario: 两次请求间隔不足
- **WHEN** 任一请求失败或两次成功请求的本地获取时间间隔不足10秒
- **THEN** 系统继续等待且不得按流动性稳定通过

#### Scenario: 瞬时下降后重采样
- **WHEN** 第二次样本下降12%但池仍存在、组成不变且流动性非零
- **THEN** 系统以第二次样本重新开始10秒观察并保留原资格截止时间

#### Scenario: 池消失或归零
- **WHEN** 固定池消失、池组成改变或流动性归零
- **THEN** 系统永久拒绝候选且不得重采样

#### Scenario: 流动性或对手侧储备不适用
- **WHEN** 池仍存在且组成不变，但总流动性非零且低于门槛、下降超过10%或对手侧深度暂时超限
- **THEN** 系统重建首样本并在原资格窗口内等待，不得把深度代理描述为可执行报价

### Requirement: 正式发送使用 CoinGecko 新鲜成交价格
系统 SHALL 使用满足15秒年龄门槛的固定池REST trade价格作为首次资格价，并在发送前使用年龄不超过5秒的同池REST trade价格复核。首次同时满足完整资格时 SHALL 固化本次120秒窗口的资格参考价和时间；后续暂时失败与重试不得刷新该参考价。G2时间只用于连接健康和触发REST，不得代替REST `block_timestamp`。

#### Scenario: 首次资格价被固化
- **WHEN** 候选第一次同时满足完整安全、固定池、流动性和成交条件
- **THEN** 系统保存资格参考价与时间，后续重试继续使用该价格计算发送前漂移

#### Scenario: WebSocket 首包到达但成交陈旧
- **WHEN** G2收到首包但发送前固定池REST最新成交超过5秒
- **THEN** 系统不得把首包时间当作新鲜成交并暂停本轮发送

### Requirement: CoinGecko 正式行情限定为固定池接口
系统 SHALL 只使用固定池 REST detail、固定池 REST trades、固定池 REST OHLCV 和 G2 OnchainTrade；不得使用会按 token top pool 自动路由的 G1 OnchainSimpleTokenPrice。首版不得建立 G3 实时连接。

#### Scenario: G2 暂时中断
- **WHEN** 固定池 G2 WebSocket 断开或返回异常状态
- **THEN** 系统重连并使用固定池 REST trades/detail 有限补偿，在重新满足数据条件前暂停发送

### Requirement: G2 刷新必须合并并受全局 REST 预算控制
系统 SHALL 将同一池的连续 G2 事件合并为一个 `dirty` 标记，同池已有请求或待刷新时不得重复排队；所有 CoinGecko REST 调用 SHALL 共用单进程全局令牌桶，默认软上限 450 请求/分钟，单池刷新间隔不得短于 1 秒。

#### Scenario: 活跃池短时产生大量成交
- **WHEN** 同一池在一秒内收到多个 G2 事件
- **THEN** 系统最多保留一个待刷新任务且不得绕过全局令牌桶

#### Scenario: REST 预算暂时不足
- **WHEN** 全局令牌桶没有可用额度
- **THEN** 系统合并等待或使候选超时，不得并发突发请求

### Requirement: 所有数值必须严格解析
系统 SHALL 根据字段契约显式转换有限数值、布尔和枚举，保存原始值；空字符串、NaN、无穷值、未知枚举或范围外值不得按安全值处理。

#### Scenario: 字段可合法规范化
- **WHEN** 原始字段符合预期类型或文档允许的字符串编码
- **THEN** 系统转换后按阈值判断并保留原始值

#### Scenario: 字段无法规范化
- **WHEN** 字段格式错误、未知或超出定义范围
- **THEN** 系统关闭式拒绝并记录数据契约错误

### Requirement: 正式资格使用最终Top20
系统 SHALL 只允许市值`$20,000–$300,000`且最终新鲜1m排名Top20的候选通过正式资格；排名暂时不足或离开最新榜单 SHALL 在剩余资格窗口内等待，候选未发送公开雷达不得成为拒绝原因。

#### Scenario: 内部候选直接通过
- **WHEN** 未公开雷达的候选市值为`$90,000`且最终1m排名为18
- **THEN** 系统可以继续其正式资格

#### Scenario: 最终排名暂时不足
- **WHEN** 候选资格检查时1m排名为21
- **THEN** 系统不得发送并在剩余窗口内等待排名恢复

### Requirement: 发送前复核保持同池且总耗时有界
系统 SHALL 在Telegram调用前对同一固定池执行一次共享总时限不超过5秒的detail与trades复核，不得在该阶段再次等待10秒。复核必须确认池组成不变、总流动性至少`$10,000`、`$100`深度占比不超过3%、对手侧流动性相对资格快照下降不超过20%、完整成交质量仍通过、最新成交年龄不超过5秒，且价格相对不可刷新资格参考价处于`-5%～+8%`闭区间。

#### Scenario: 发送前全部通过
- **WHEN** 同池复核在5秒内完成且流动性、成交、最新年龄和价格区间全部满足
- **THEN** 系统立即允许Telegram首次发送

#### Scenario: 复核超时或暂时越界
- **WHEN** 复核超过5秒、数据过旧、对手侧下降超过20%或价格超出`-5%～+8%`
- **THEN** 系统暂停本轮发送并在原120秒窗口内重试，不得刷新资格参考价
