## Context

参见`proposal.md`。当前公开投影、内部池开放快捷和候选`RADAR`状态仍在SOL路径上耦合；BSC已经使用独立shortcut/public readiness与v7首次envelope解决同类问题。现有数据库和事件结构足够支持SOL，不应复制第二套机制。

## Goals / Non-Goals

**Goals:**

- 将SOL公开首发收敛到仍然新鲜的连续双榜Bonding候选。
- 复用现有事件和outbox原语，保持SOL内部新池/复苏与正式资格机会不变。
- 让部署前SOL快捷资格与旧PENDING具备确定、可审计的兼容行为。

**Non-Goals:**

- 不修改SOL/BSC正式资格阈值、评估口径或Telegram卡片视觉。
- 不根据小样本增加名次碎片规则、价格漂移、技术指标、评分或额外轮询。
- 不重新评价、补写或删除历史雷达和历史首次envelope。

## Decisions

### 1. 扩展现有链级公开策略，不建立SOL专用管线

在现有`publicRadar`链级策略中增加公开触发类型与直接真实池开关：SOL为`dual-only`、不允许直接真实池和复苏；BSC保持当前配置。发现、公开投影和测试读取同一小型策略对象。该对象进入共享规则哈希，因此部署会为两链报告创建新分段，但不得重置任何运行状态。

替代方案是在SOL代码分支硬编码条件；该方案会让两条链的首发边界再次分散，因此不采用。

### 2. shortcut与public readiness继续使用两个既有stage

`bonding_shortcut_readiness`记录变更前允许池开放快捷激活的内部事实，SOL双榜和三次上升都可写；`radar_public_readiness`由链级策略驱动，正常SOL只为连续双榜写，兼容回滚可为三次上升及允许的直接新池/复苏写当前版本事实。池开放逻辑只读shortcut，首次发送只读public readiness，二者不得互相授权。

readiness只证明本规则版本曾满足公开条件。SOL首次发送时另由仓储层按链级触发策略重建当前证据：dual verifier读取最近两个连续成功1m批次及各自当时可用的5m批次，复用发现引擎完整谓词（两侧内部市值、缺榜重置、1m/5m年龄6/15秒、配对差12秒）；rising verifier读取最近三个连续成功1m批次，复用每行内部市值、缺榜、相邻6秒和名次严格上升谓词。二者再重验最新公开排名和市值。这样不新增事件流水，也不会让历史readiness永久授权。

### 3. v8只桥接SOL旧shortcut事实

追加v8迁移，只处理当前仍为`RADAR`且尚未真实激活的SOL候选，从最早有效`*_BONDING_CURVE` activation事件按币确定性桥接一条shortcut事实；若`legacy_reopened_at_ms`存在，源事件必须晚于该时间。桥接继承原事件时间、来源、审计JSON与规则版本。迁移不写当前public readiness、不修改候选状态、不回填历史envelope，也不增加业务列或表。

### 4. SOL首次发送采用与BSC相同的双重门槛

SOL PENDING必须同时具备当前规则public readiness和发送时由持久化快照重建的连续双榜公开条件。只有SENT记录可越过首次门槛进行允许的生命周期编辑；新卡以不可变initial envelope的stage判定是否Bonding，历史NULL非终态升级fail-closed、终态仍编辑。直接真实池或复苏没有可证明的已SENT Bonding卡时不创建雷达outbox。通用`markRadarSent`与不可变envelope保持不变。

### 5. 兼容回滚只恢复公开开关

回滚构建恢复SOL三次上升、直接真实池和复苏公开，并由同一策略驱动writer为三类当前机会写回滚规则版本readiness；首次发送仍重验各自当前持续热度/真实池门槛。回滚保留v8、两类readiness、专用`markRadarSent`和初始envelope，且任何public readiness都不得授予shortcut。禁止回滚到仍以公开`RADAR`状态授予SOL快捷资格的旧提交。

## Risks / Trade-offs

- [公开雷达将减少且可能漏掉直接真实池暴涨] → 内部Top100、新池/复苏激活和正式资格不变，公开频道只承担早期观察；不对降幅作无样本外推。
- [Bonding样本本身仍高度波动] → 卡片继续明确非正式，不引入未经数据支持的漂移或评分门槛。
- [历史PENDING数量可能较多] → 不桥接public readiness，必须由持久化快照重新满足当前双榜和发送门槛，避免批量补发。
- [迁移桥接错误会改变池开放快捷机会] → 只从旧SOL Bonding activation事实确定性桥接，并在v7数据库副本上测试原子升级和幂等性。

## Migration Plan

1. 在本地数据库副本按`RADAR`、真实激活和legacy reset边界验证v8源事件数等于桥接数，并覆盖失败原子性，运行完整测试与构建。
2. 准备保留v8与两类readiness的兼容回滚提交和不可移动tag；smoke覆盖rising-only Bonding、直接新池和复苏PENDING可按回滚策略首发，且均不泄漏shortcut。
3. 停止服务器容器并备份SQLite，服务器工作区干净后只执行`git pull --ff-only`、Compose构建与启动。
4. 记录部署时间与规则版本，核对v8源/桥接精确数量，观察至少10个成功SOL 1m周期和3个成功5m周期；保存自部署时间起按`chain + current rule + initial stage + activation trigger`分组的只读首发报告。通过条件为SOL rising-only、direct real-pool、revival、terminal及不满足当前触发验证器的旧PENDING首发均为0；SOL dual Top5和BSC direct-new-pool若自然出现则必须符合门槛，否则分别标记“现场未验证”。
5. 对比部署前后qualification/evaluation策略子快照必须字节等价；对部署前行断言activation时间、资格参考价、已投递样本和validation epoch没有被重置，终态候选重开数为0。任一不等或重置均失败并回滚。
6. 若发现问题，只在本地修复、测试、推送后重新部署；不得在服务器编辑文件。
