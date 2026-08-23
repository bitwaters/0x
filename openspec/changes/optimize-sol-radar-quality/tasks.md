## 1. 策略与兼容事实

- [x] 1.1 扩展现有链级公开策略，配置SOL仅连续双榜公开、禁止直接真实池/复苏首发，保持Top5、市值和BSC配置不变；规则快照只产生预期版本变化。
- [x] 1.2 让SOL按旧池开放条件幂等记录`bonding_shortcut_readiness`，由链级策略驱动`radar_public_readiness` writer；正常策略只允许连续双榜Top5，兼容回滚恢复三次上升/直接新池/复苏writer，且任一public readiness不得授权shortcut。
- [x] 1.3 追加v8无新业务字段迁移，只为当前`RADAR`、未真实激活的SOL候选桥接有效`*_BONDING_CURVE` shortcut事实；legacy reset后只选重开时间之后的事件，覆盖未重激活不桥接、源/桥接计数、原子失败与幂等升级。

## 2. SOL公开投影与交付

- [x] 2.1 SOL三次上升继续内部跟踪但不公开；直接真实池和复苏不创建雷达outbox，且内部`PREHEAT`、固定池资格和正式信号路径不变。
- [x] 2.2 SOL只有initial envelope明确为Bonding的SENT卡可在新池且满足原Top20、市值、池与流动性门槛时升级；历史NULL非终态升级fail-closed但保留终态编辑和不可变首次envelope。
- [x] 2.3 实现策略驱动首发trigger verifier：dual从最近两个成功1m及各自配对5m重建，rising从最近三个成功1m重建，完整复用内部市值、缺榜/间隔、年龄/配对差和名次谓词；PENDING还须具有当前public readiness并满足最新公开门槛，覆盖5m存在但市值越界及旧readiness后中断不补发。
- [x] 2.4 回归BSC第6–10名新池策略writer/readiness/shortcut/复苏关闭行为；断言两链activation时间、资格窗口/参考价、已投递样本、validation epoch、终态候选和qualification/evaluation策略快照不被重置或重开。

## 3. 验证与审查

- [x] 3.1 添加发现、运行时、数据库与Telegram表驱动测试，覆盖SOL双榜首发、三次上升内部shortcut、池开放、直接真实池/复苏抑制、旧PENDING及v8迁移。
- [x] 3.2 运行完整测试、typecheck、lint、生产构建、`git diff --check`和OpenSpec严格验证，确认无新增API、依赖、表、评分或重复管线。
- [x] 3.3 使用结构化agent review检查SOL内部机会零损失、BSC零回归、v8兼容、PENDING不补发和envelope不可变；修复并重复审查直到无问题。

## 4. 回滚、部署与观察

- [ ] 4.1 准备并测试唯一v8兼容回滚构建：策略writer恢复SOL三次上升、直接新池和复苏当前版本readiness及首发，保留v8、两类readiness、shortcut解耦、`markRadarSent`及首次envelope；smoke三类PENDING并证明public readiness不授权shortcut，提交不可移动tag和README说明。
- [ ] 4.2 本地提交推送后，停止服务器容器、备份并校验SQLite，再由服务器`git pull --ff-only`与Docker Compose重建启动；禁止服务器直接编辑文件。
- [ ] 4.3 记录部署时间/规则版本，核对v8合格源事件数与桥接数相等，观察至少10个成功SOL 1m和3个成功5m周期；保存按链/当前规则/初始阶段/触发分组的首发报告并断言SOL禁止类型和失效PENDING为0，SOL dual与BSC direct-new-pool无自然样本时分别标记未验证。
- [ ] 4.4 断言部署前后qualification/evaluation策略子快照字节等价，既有activation时间、资格参考价、已投递样本和validation epoch重置数为0，终态重开数为0；任一失败只在本地修复或执行兼容回滚。
- [ ] 4.5 完成观察后同步主规范并归档提案，推送最终文档提交并让服务器fast-forward保持Git一致。
