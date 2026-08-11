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

## 五、冲突边界（受管文件白名单）

受管提交**只允许**触碰以下文件，超出即视为越界（审计会打回）：

- `src/main/features/apiGateway/**`（admin 路由、auth、openapi、集成测试）
- `src/shared/data/preference/preferenceSchemas.ts` / `preferenceTypes.ts`
- `src/main/i18n/locales/*` / `src/main/i18n/translate/*`（受管通知文案）
- `src/renderer/hooks/useProvider.ts` / `useAgent.ts`、受管 UI 锁死相关组件
- `.github/workflows/fork-*.yml`（Fork 专用 CI）
- 受管独立 db（`managed_registry.db` 相关，M2 Sidecar）与 `ManagedRegistryService`（F-8）

> 凡新增受管文件（如 `managedRegistry.ts`、`ManagedRegistryService.ts`）天然不与官方冲突；风险集中在双方都改的既有文件（如 `preferenceSchemas.ts`、`useProvider.ts`、`adminRoutes.ts`）。

## 六、提交流程

1. 每个 F 完成一次独立 commit（`git commit`），不堆叠多个 F 到一个 commit。
2. commit message 遵循 `feat(fork-<F>): <描述>` 或 `feat(m0-xx): <描述>` 风格，可中文说明。
3. 改完必须跑 `pnpm typecheck` + 相关测试，全绿再 commit。
4. push 到私有 `managed` remote（需 PAT 认证）。

## 七、AC 验收

- `git rev-parse official/main` == `git rev-parse origin/main`（镜像同步）
- `git log --oneline origin/main..managed/main` 仅含受管（M0/M1...）提交，无官方提交混入
- `git merge-base managed/main origin/main` == `origin/main`（rebase 干净、基线对齐）
- 受管提交文件集 ⊆ 冲突边界白名单
