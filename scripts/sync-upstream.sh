#!/usr/bin/env bash
#
# sync-upstream.sh — CherryStudio 受管版 Fork 上游同步脚本（F-12）
#
# 目标：把官方 origin/main 的更新平滑 rebase 到受管主干 managed/main，
#       同时维护只读镜像 official/main，并保证受管改动与官方隔离。
#
# 流程：fetch 官方 -> 刷新 official/main 镜像 -> rebase managed/main 到 official/main
#       -> 验证受管提交完整保留 -> typecheck + 关键受管测试。
#
# 用法：
#   bash scripts/sync-upstream.sh --dry-run   # 只 fetch + 预览将发生的 rebase，不改分支
#   bash scripts/sync-upstream.sh             # 实际同步 + 验证
#
# 说明：
#   - 本脚本不 push。push 由主 Agent 统一执行。
#   - rebase 遇冲突立即 --abort 并打印人工处理指引，绝不强行继续。

set -euo pipefail

# ---------- 常量 ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

WORK_BRANCH="managed/main"     # 受管主干
MIRROR_BRANCH="official/main"  # 官方只读镜像
UPSTREAM_REF="origin/main"     # 官方远端引用

# 关键受管测试（rebase 后必须全绿）
MANAGED_TESTS=(
  "src/main/features/apiGateway/routes/__tests__/routes.integration.test.ts"
  "src/main/data/services/__tests__/ManagedRegistryService.test.ts"
  "src/renderer/utils/__tests__/managedEntity.test.ts"
  "src/main/services/file/utils/__tests__/managedStorageGuard.test.ts"
)

DRY_RUN=0

# ---------- 参数解析 ----------
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=1 ;;
    -h|--help)
      echo "用法: $0 [--dry-run]"
      echo "  --dry-run   只 fetch + 预览将发生的 rebase 动作，不改动任何分支"
      exit 0
      ;;
    *)
      echo "[错误] 未知参数: $arg" >&2
      exit 1
      ;;
  esac
done

cd "${REPO_ROOT}"

# ---------- 前置校验 ----------
echo "==> [1/6] 校验 remote 与分支状态"

# 校验 remote 存在
for r in origin managed; do
  if ! git remote | grep -qx "${r}"; then
    echo "[错误] 缺少 remote: ${r}。请先配置：git remote add ${r} <url>" >&2
    exit 1
  fi
done

# 校验当前分支（必须干净，且建议在受管工作分支）
CURRENT_BRANCH="$(git branch --show-current)"
if [ -z "${CURRENT_BRANCH}" ]; then
  echo "[错误] 当前处于 detached HEAD，请先 checkout ${WORK_BRANCH}" >&2
  exit 1
fi

if [ "${CURRENT_BRANCH}" != "${WORK_BRANCH}" ]; then
  echo "[警告] 当前分支是 ${CURRENT_BRANCH}，非 ${WORK_BRANCH}。"
  echo "       rebase 会作用于 ${WORK_BRANCH}。是否继续？(y/N)"
  read -r answer
  if [ "${answer}" != "y" ] && [ "${answer}" != "Y" ]; then
    echo "已取消。"
    exit 1
  fi
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "[错误] 工作区不干净。请先提交或 stash 你的改动再运行。" >&2
  echo "       git stash push -u   # 暂存" >&2
  exit 1
fi

# ---------- fetch 官方 ----------
echo "==> [2/6] fetch 官方 origin/main"
git fetch origin main

UPSTREAM_SHA="$(git rev-parse "${UPSTREAM_REF}")"
echo "       官方 origin/main = ${UPSTREAM_SHA:0:12}"

if [ "${DRY_RUN}" -eq 1 ]; then
  echo "==> [dry-run] 停止：仅 fetch，未改动任何分支。"
  exit 0
fi

# ---------- 刷新 official/main 镜像 ----------
echo "==> [3/6] 刷新只读镜像 ${MIRROR_BRANCH}"
git branch -f "${MIRROR_BRANCH}" "${UPSTREAM_REF}"
MIRROR_SHA="$(git rev-parse "${MIRROR_BRANCH}")"
if [ "${MIRROR_SHA}" != "${UPSTREAM_SHA}" ]; then
  echo "[错误] 镜像同步失败：${MIRROR_BRANCH} != ${UPSTREAM_REF}" >&2
  exit 1
fi
echo "       镜像 ${MIRROR_BRANCH} 已对齐 origin/main"

# ---------- 计算基线并判断是否有新提交 ----------
MERGE_BASE="$(git merge-base "${WORK_BRANCH}" "${UPSTREAM_REF}")"
if [ "${MERGE_BASE}" = "${UPSTREAM_SHA}" ]; then
  echo "==> 无新官方提交，managed/main 已是最新，无需 rebase。"
  exit 0
fi

echo "==> [4/6] 将 rebase ${WORK_BRANCH} 到 ${UPSTREAM_REF}"
echo "       merge-base      = ${MERGE_BASE:0:12}"
echo "       目标官方 HEAD   = ${UPSTREAM_SHA:0:12}"
echo "       待重放受管提交数 = $(git rev-list --count "${MERGE_BASE}".."${WORK_BRANCH}")"

echo ""
echo "即将执行: git rebase --onto ${UPSTREAM_REF} ${MERGE_BASE} ${WORK_BRANCH}"
echo "是否继续？(y/N)"
read -r answer
if [ "${answer}" != "y" ] && [ "${answer}" != "Y" ]; then
  echo "已取消，未改动任何分支。"
  exit 1
fi

# ---------- 执行 rebase（冲突即中止） ----------
if ! git rebase --onto "${UPSTREAM_REF}" "${MERGE_BASE}" "${WORK_BRANCH}"; then
  echo ""
  echo "[错误] rebase 冲突。已自动中止（git rebase --abort），分支回到 rebase 前状态。" >&2
  echo "" >&2
  echo "人工处理指引（详见 docs/fork-branch-strategy.md「冲突处理」）：" >&2
  echo "  1. 在 rebase 中逐文件解决冲突（保留受管意图、吸收官方最新）" >&2
  echo "  2. git add <已解决文件> && git rebase --continue" >&2
  echo "  3. 若无法干净解决：git rebase --abort 放弃本次同步" >&2
  exit 1
fi

echo "==> rebase 成功。"

# ---------- 验证受管提交完整保留 ----------
echo "==> [5/6] 验证受管提交完整保留"
REBASE_COUNT="$(git rev-list --count "${UPSTREAM_REF}".."${WORK_BRANCH}")"
echo "       rebase 后受管提交数 = ${REBASE_COUNT}"
echo "       --- 受管提交列表（应全为 feat/fork-*、feat/m0-*） ---"
git log --oneline "${UPSTREAM_REF}".."${WORK_BRANCH}"

# ---------- 无回归验证：typecheck + 关键测试 ----------
echo "==> [6/6] 无回归验证（typecheck + 关键受管测试）"
echo "       pnpm typecheck ..."
if ! pnpm typecheck; then
  echo "[错误] typecheck 失败。请修复后重试。" >&2
  exit 1
fi

echo "       pnpm test (关键受管测试) ..."
TEST_ARGS=""
for t in "${MANAGED_TESTS[@]}"; do
  TEST_ARGS="${TEST_ARGS} ${t}"
done
# shellcheck disable=SC2086
if ! pnpm test -- ${TEST_ARGS}; then
  echo "[错误] 关键受管测试失败。请修复后重试。" >&2
  exit 1
fi

echo ""
echo "==> 同步完成。managed/main 已 rebase 到官方最新，typecheck + 关键测试全绿。"
echo "    push 由主 Agent 统一执行，本脚本不 push。"
