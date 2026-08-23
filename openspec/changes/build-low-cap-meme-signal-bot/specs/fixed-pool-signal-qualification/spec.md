## Purpose

定义真实池候选在可验证安全字段、固定池方向、短时成交动量、数据新鲜度和追高限制下成为正式信号的统一判定契约。

## ADDED Requirements

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
系统 SHALL 在本候选的唯一资格窗口内绑定一个固定池。该池消失、流动性异常或 GMGN 返回另一主池时，系统 SHALL 终止候选，不得换池后继续发送。

#### Scenario: 锁定池失效
- **WHEN** 已锁定池消失、流动性低于门槛或 GMGN 主池地址发生变化
- **THEN** 系统将候选标记失效并释放实时订阅

### Requirement: 最近成交必须来自明确的 30 秒固定池窗口
系统 SHALL 在绑定或重连时调用 CoinGecko network-scoped 固定池 trades REST，并以 `token={candidate_side}` 请求候选定向成交；REST 的候选定向 `kind` SHALL 直接作为买卖方向，不得再按 base/quote 二次反转。候选 USD 价格 SHALL 通过候选 CA 匹配成交的 from/to Token 后选择对应 USD 价格字段。G2 Trade 只标记池需要刷新，不参与正式价格或方向裁决。正式裁决 SHALL 以 REST trades 为最终事实，按提供商事件标识去重，使用最近 30 秒内至少 5 笔、最多取最新 10 笔成交，且最新 `block_timestamp` 年龄不超过 15 秒。

#### Scenario: 逐笔条件通过
- **WHEN** 观察窗内至少 5 笔成交、买入笔数占比不低于 60%、净买入 USD 为正、最大单笔不超过窗口成交额 40%
- **THEN** 系统允许其继续发送前检查

#### Scenario: 回填或新鲜度不足
- **WHEN** 无法回填逐笔成交、最新 block timestamp 超过 15 秒或 30 秒内不足 5 笔
- **THEN** 系统在资格窗口内等待，窗口结束仍不足则过期

### Requirement: 流动性检查采用简单固定池门槛和深度代理
系统 SHALL 使用 `include_composition=true` 的 CoinGecko fixed-pool detail，以 `reserve_in_usd` 判断总流动性不低于 `$10,000`，并要求两次成功 HTTP 请求的本地 `fetched_at` 间隔至少 10 秒，样本间流动性下降不超过 10%。候选为 base 时支付侧 SHALL 使用 `quote_token_liquidity_usd`，候选为 quote 时使用 `base_token_liquidity_usd`；计算 `$100_depth_ratio = 100 / counter_side_liquidity_usd` 并要求不超过 3%。该值只称为“对手侧深度占比”，不得称为滑点、价格冲击或可执行报价。

#### Scenario: 固定池流动性稳定
- **WHEN** 两次成功请求的本地获取时间间隔至少 10 秒，样本均不低于 `$10,000`、下降不超过 10% 且 `$100_depth_ratio≤0.03`
- **THEN** 系统允许继续发送前检查

#### Scenario: 两次请求间隔不足
- **WHEN** 任一请求失败或两次成功请求的本地获取时间间隔不足 10 秒
- **THEN** 系统继续等待且不得按流动性稳定通过

#### Scenario: 流动性或对手侧储备不适用
- **WHEN** 任一样本低于门槛、下降超过 10%、对手侧 USD 储备缺失/非正数或深度占比超限
- **THEN** 系统拒绝当前候选

### Requirement: 正式发送使用 CoinGecko 新鲜成交价格
系统 SHALL 使用满足 15 秒 `block_timestamp` 门槛的固定池 REST trade 价格作为决策价和发送前复核价。G2 的时间只用于连接健康和触发 REST 刷新，不得代替 REST `block_timestamp` 完成发送价新鲜度判断。

#### Scenario: WebSocket 首包到达但成交陈旧
- **WHEN** G2 收到首包但固定池 REST 最新成交超过 15 秒
- **THEN** 系统不得把首包到达时间当作新鲜成交并暂停发送

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
