# Fork 分支策略 · CherryStudio 受管版

> 归属：企业受管版 v4.0 基建 · M1 批次 1（F-1/F-12）
> 仓库：`cherry-src`（本地工作副本）
> Remote：
> - `origin` = 官方 `CherryHQ/cherry-studio`（只读上游）
> - `managed` = 私有 `leappower/cherry-studio-managed`（Fork 交付目标）

## 一、分支总览

| 分支 | 指向 | 写权限 | 用途 |
|------|------|--------|------|
| `official/main` | 官方 `origin/main` 的只读镜像 | **只读镜像**，任何人不得直接提交 | 供 Fork 层比对、rebase 基准、识别官方新提交 |
| `managed/main` | 受管版主干 | Fork 开发唯一主分支 | 承载 M0/M1/M2... 全部受管改动 |

## 二、核心原则

1. **受管版永远基于官方最新**：`managed/main` 的基线必须时刻追上 `origin/main`，避免长期落后导致大 diff。
2. **受管改动与官方改动隔离**：受管提交只碰受管范围文件（见下「冲突边界」），官方升级时 rebase 干净、无冲突。
3. **official/main 是只读镜像**：由 `git fetch origin main && git branch -f official/main origin/main` 同步，禁止直接 commit/push 到 official/main。

## 三、official/main 镜像同步

```bash
git fetch origin main
git branch -f official/main origin/main
# 验证
git rev-parse official/main origin/main   # 两者应相等
```

## 四、managed/main 升级（rebase 官方最新）

```bash
# 1) 拉官方最新并刷新镜像
git fetch origin main
git branch -f official/main origin/main

# 2) 确保受管工作区干净
git stash push -u

# 3) 计算 merge-base（受管当前基线）
MB=$(git merge-base managed/main origin/main)

# 4) rebase 受管提交到官方最新之上
git rebase --onto origin/main "$MB" managed/main
```

> rebase 采用 `--onto`：仅把「从旧基线到 managed/main」这一段受管提交搬移到新官方 HEAD 之上，官方新增提交保持原样。

### 冲突处理
- 若 rebase 冲突，先 `git status` 定位冲突文件，逐文件解决后 `git rebase --continue`。
- 冲突通常是官方改动了受管已改的同文件。解决原则：**保留受管意图，吸收官方最新**。
- 参考「冲突边界」预判：受管文件集合与官方改动文件集合无交集时，rebase 必然无冲突（M1 批次 1 实测验证为零冲突）。

#### 冲突优先级与保留策略

1. **受管提交是 Fork 的「资产」，必须完整保留**，绝不因 rebase 顺手压缩或丢弃受管提交。rebase 采用 `--onto` 语义，受管提交逐一重放，天然保留全部 M0/M1 提交。
2. **保留受管意图、吸收官方最新**：受管改动的语义是最终目标，官方对应位置的改动作为基底被吸收进受管提交，而不是反向覆盖。
3. **受管独有文件，官方通常不碰**：如 `managedRegistry.ts`、`ManagedRegistryService.ts`、受管 db 相关、`.github/workflows/fork-*.yml`，天然无冲突。
4. **高风险共改文件**（双方都可能改、最易冲突），rebase 前重点检查：

| 文件 | 冲突风险 | 处理原则 |
|------|---------|---------|
| `src/main/features/apiGateway/routes/adminRoutes.ts` | 🔴 高（官方持续改 admin API） | 以受管路由集成为主，吸收官方新增/改动的 handler 与 schema，保留受管的鉴权/管理语义 |
| `src/main/features/apiGateway/routes/openapiDocs.ts` | 🔴 高（官方 OpenAPI 文档频繁变更） | 合并受管新增的受管专属端点文档，官方文档段整体吸收 |
| `src/main/i18n/locales/*` 与 `src/main/i18n/translate/*` | 🟡 中（官方加新语言 key） | 受管新增的受管文案 key 保留；官方新增 key 直接并入，避免覆盖 |
| `src/shared/data/preference/preferenceSchemas.ts` / `preferenceTypes.ts` | 🟡 中 | 受管新增 preference 字段保留，官方 schema 结构更新并入 |
| `src/renderer/hooks/useProvider.ts` / `useAgent.ts` | 🟡 中 | 受管锁死逻辑保留，官方 hook 变更吸收 |

5. **冲突无法干净解决时立即中止**：`git rebase --abort` 回到 rebase 前状态，人工介入，不在冲突中硬编造合并结果。

> ⛔ 禁止在冲突解决中「顺手重构」或「顺手压缩」受管提交。冲突解决只做语义合并，不做额外改动。

## 五、冲突边界（受管文件白名单）

受管提交**只允许**触碰以下文件，超出即视为越界（审计会打回）：

- `src/main/features/apiGateway/**`（admin 路由、auth、openapi、集成测试）
- `src/shared/data/preference/preferenceSchemas.ts` / `preferenceTypes.ts`
- `src/main/i18n/locales/*` / `src/main/i18n/translate/*`（受管通知文案）
- `src/renderer/hooks/useProvider.ts` / `useAgent.ts`、受管 UI 锁死相关组件
- `.github/workflows/fork-*.yml`（Fork 专用 CI）
- 受管独立 db（`managed_registry.db` 相关，M2 Sidecar）与 `ManagedRegistryService`（F-8）

> 凡新增受管文件（如 `managedRegistry.ts`、`ManagedRegistryService.ts`）天然不与官方冲突；风险集中在双方都改的既有文件（如 `preferenceSchemas.ts`、`useProvider.ts`、`adminRoutes.ts`）。

## 六、官方更新 → rebase → 验证（AC③）

每次官方 `origin/main` 有新提交后，完整升级链路如下，rebase 后必须跑验证，确保 **managed/main 保留全部 M0/M1 提交且无回归测试失败**：

```bash
# 0) 进入受管工作副本，确认在 managed/main
cd cherry-src && git checkout managed/main && git status --short   # 工作区必须干净

# 1) 拉官方最新并刷新只读镜像
scripts/sync-upstream.sh --dry-run   # 或手动：
git fetch origin main

# 2) 执行 rebase（推荐用 sync 脚本，含 dry-run / 交互确认 / 冲突中止）
scripts/sync-upstream.sh

# 3) 验证受管提交完整保留：应仅含 M0/M1... 受管提交，无官方提交混入
#    ① 提交集合校验
git log --oneline origin/main..managed/main   # 全部应为受管提交（feat/fork-*、feat/m0-*）
git rev-parse official/main origin/main        # 镜像同步
#    ② 基线对齐校验
git merge-base managed/main origin/main        # 应等于 origin/main
#    ③ 受管提交数量/内容未丢失（对比 rebase 前记录）
#       若此前有备份： git log --oneline <backup>..managed/main | wc -l

# 4) 无回归验证：typecheck + 关键受管测试（必须全绿）
pnpm typecheck
pnpm test -- src/main/features/apiGateway/routes/__tests__/routes.integration.test.ts \
          src/main/data/services/__tests__/ManagedRegistryService.test.ts \
          src/renderer/utils/__tests__/managedEntity.test.ts \
          src/main/services/file/utils/__tests__/managedStorageGuard.test.ts
#   （或运行完整 test 脚本：pnpm test）
```

> **验证通过标准**：① typecheck 零错误；② 上述关键受管测试全通过；③ `git log origin/main..managed/main` 仅含受管提交；④ 无受管提交被压缩/丢失。任一失败则 `git rebase --abort`（若已继续则 `git reset --hard` 到 rebase 前备份 ref），排查后重跑。

## 七、sync-upstream.sh 自动化脚本

`scripts/sync-upstream.sh` 封装上述流程，特性：

- `set -euo pipefail` 严格模式；启动即校验 `origin` / `managed` remote 存在。
- `--dry-run`：仅 fetch 并打印将发生的 rebase 动作，不实际改分支。
- 交互确认：实际 rebase 前提示确认，`y` 继续。
- 冲突自动中止：rebase 遇冲突立即 `git rebase --abort` 并打印人工处理指引，不强行继续。
- rebase 成功后自动跑 `pnpm typecheck` + 关键受管测试（受管文件无变化时可跳过）。

```bash
# 用法
bash scripts/sync-upstream.sh --dry-run   # 预览
bash scripts/sync-upstream.sh             # 实际同步 + 验证
```

## 八、提交流程

1. 每个 F 完成一次独立 commit（`git commit`），不堆叠多个 F 到一个 commit。
2. commit message 遵循 `feat(fork-<F>): <描述>` 或 `feat(m0-xx): <描述>` 风格，可中文说明。
3. 改完必须跑 `pnpm typecheck` + 相关测试，全绿再 commit。
4. push 到私有 `managed` remote（需 PAT 认证）。

## 九、AC 验收

- `git rev-parse official/main` == `git rev-parse origin/main`（镜像同步）
- `git log --oneline origin/main..managed/main` 仅含受管（M0/M1...）提交，无官方提交混入
- `git merge-base managed/main origin/main` == `origin/main`（rebase 干净、基线对齐）
- 受管提交文件集 ⊆ 冲突边界白名单
