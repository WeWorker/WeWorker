#!/bin/bash
# publish.sh — 发布 WebCLI 到 npm，并同步 skill 描述与版本
#
# 一次完成两件事：
#   1) 更新并发布 npm 包（we worker-webcli）
#   2) 同步 npm、Skill 与插件的版本账本
#
# 用法:
#   bash webcli/publish.sh                    # patch 递增后发布
#   bash webcli/publish.sh 1.2.0              # 指定版本号发布
#   bash webcli/publish.sh --dry-run          # 只做校验与打包预览，不上传、不改工作区
#   bash webcli/publish.sh --dry-run 1.2.0    # 预览指定版本
#   bash webcli/publish.sh --skip-tests       # 跳过发布前测试（应急，慎用）
#
# 环境变量:
#   NPM_REGISTRY   可选，默认 https://registry.npmjs.org
#   NPM_TOKEN      可选，发布凭证；未设置时使用本机 `npm login` 的配置
#
# 说明:
#   - 版本参数是发布真源；脚本把所有发布账本同步成同一版本
#   - 发布前会扫描内部信息，命中即中止（见 DENY_PATTERNS）
#   - 发布是对外动作：--dry-run 不会上传，可用于发布前预演
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
PKG_FILE="$SCRIPT_DIR/package.json"
LOCK_FILE="$SCRIPT_DIR/package-lock.json"
VERSION_FILE="$SCRIPT_DIR/version.json"
PLUGIN_FILE="$SCRIPT_DIR/.claude-plugin/plugin.json"
SKILL_FILE="$SCRIPT_DIR/skills/webcli/SKILL.md"
MARKETPLACE_FILE="$SCRIPT_DIR/MARKETPLACE.md"

DRY_RUN=false
SKIP_TESTS=false
NEW_VERSION=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --skip-tests) SKIP_TESTS=true ;;
    [0-9]*.[0-9]*.[0-9]*) NEW_VERSION="$arg" ;;
  esac
done

# ─── 内部信息守卫 ────────────────────────────────────────────────────────────
# 公开仓库不得出现内部域名、内部网段与内部系统名。
DENY_PATTERNS=(
  'weoa\.com'
  'webank\.com'
  'wnpm[a-z.]*'
  '[^0-9]10\.[0-9]+\.[0-9]+\.[0-9]+'
  '[^0-9]172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+'
  '[^0-9]192\.168\.[0-9]+\.[0-9]+'
  'ProjectDemo'
  'ExpenseDemo'
  '\bITSM\b'
)
# 扫描范围：随包发布的 skill 描述与 adapter 数据
SCAN_PATHS=("$SKILL_FILE" "$MARKETPLACE_FILE" "$PLUGIN_FILE" "$SCRIPT_DIR/adapters")

guard_internal_info() {
  echo "[2/6] 扫描内部信息..."
  local hits=0
  for pattern in "${DENY_PATTERNS[@]}"; do
    for target in "${SCAN_PATHS[@]}"; do
      [ -e "$target" ] || continue
      local found
      found=$(grep -rInE "$pattern" "$target" 2>/dev/null | grep -v '^Binary file' | head -5 || true)
      if [ -n "$found" ]; then
        echo "  ✗ 命中 /$pattern/:"
        echo "$found" | sed "s#^#      #"
        hits=$((hits + 1))
      fi
    done
  done
  if [ "$hits" -gt 0 ]; then
    echo ""
    echo "[ERROR] 发现 $hits 类内部信息，发布中止。"
    echo "        先清理后重跑；不要把这些内容发布到公开 npm。"
    exit 1
  fi
  echo "      未发现内部信息 ✓"
}

# ─── 版本计算 ────────────────────────────────────────────────────────────────

win_path() { cygpath -w "$1" 2>/dev/null || echo "$1"; }

read_pkg_version() {
  node -e "console.log(JSON.parse(require('fs').readFileSync(String.raw\`$(win_path "$PKG_FILE")\`,'utf8')).version)"
}

bump_patch() {
  local major minor patch
  IFS='.' read -r major minor patch <<< "$1"
  echo "${major}.${minor}.$((patch + 1))"
}

CURRENT_VERSION=$(read_pkg_version)
if [ -n "$NEW_VERSION" ]; then
  VERSION="$NEW_VERSION"
elif [ "$DRY_RUN" = "true" ]; then
  VERSION="$CURRENT_VERSION"
else
  VERSION=$(bump_patch "$CURRENT_VERSION")
fi

echo "==> WebCLI 发布"
echo "    当前版本: $CURRENT_VERSION"
echo "    发布版本: $VERSION"
echo "    Registry: $REGISTRY"
echo "    模式:     $([ "$DRY_RUN" = "true" ] && echo 'dry-run（不上传）' || echo '正式发布')"
echo ""

# ─── [1/6] 前置检查 ─────────────────────────────────────────────────────────

echo "[1/6] 前置检查..."
if [ "$DRY_RUN" = "false" ] && [ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]; then
  echo "  ✗ 工作区不干净——发布应来自受控提交。"
  echo "    先提交或清理，或改用 --dry-run 预览。"
  exit 1
fi
echo "      分支: $(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '未知')"
echo "      工作区: $([ "$DRY_RUN" = "true" ] && echo 'dry-run 忽略' || echo '干净 ✓')"

# ─── [2/6] 内部信息守卫 ─────────────────────────────────────────────────────

guard_internal_info

# ─── [3/6] 版本统一 ─────────────────────────────────────────────────────────

echo "[3/6] 写入版本号到发布账本..."
# 备份（dry-run 结束时回滚）
PKG_BACKUP="$(mktemp)"; LOCK_BACKUP="$(mktemp)"; VERSION_BACKUP="$(mktemp)"; PLUGIN_BACKUP="$(mktemp)"; SKILL_BACKUP="$(mktemp)"
cp "$PKG_FILE" "$PKG_BACKUP"; cp "$LOCK_FILE" "$LOCK_BACKUP"; cp "$VERSION_FILE" "$VERSION_BACKUP"
cp "$PLUGIN_FILE" "$PLUGIN_BACKUP"; cp "$SKILL_FILE" "$SKILL_BACKUP"

cleanup() {
  if [ "$DRY_RUN" = "true" ]; then
    cp "$PKG_BACKUP" "$PKG_FILE"; cp "$LOCK_BACKUP" "$LOCK_FILE"; cp "$VERSION_BACKUP" "$VERSION_FILE"
    cp "$PLUGIN_BACKUP" "$PLUGIN_FILE"; cp "$SKILL_BACKUP" "$SKILL_FILE"
    echo "    已回滚 dry-run 的版本改动"
  fi
  rm -f "$PKG_BACKUP" "$LOCK_BACKUP" "$VERSION_BACKUP" "$PLUGIN_BACKUP" "$SKILL_BACKUP"
  [ -n "$TEMP_NPMRC" ] && rm -f "$TEMP_NPMRC"
  return 0
}
trap cleanup EXIT

node "$SCRIPT_DIR/scripts/set-release-version.mjs" "$VERSION"
echo "      package.json / package-lock.json / version.json / plugin.json / SKILL.md → $VERSION"

# ─── [4/6] 一致性校验 ───────────────────────────────────────────────────────

echo "[4/6] 校验发布账本版本一致..."
check_version() {
  local file="$1" actual="$2"
  if [ "$actual" != "$VERSION" ]; then
    echo "  ✗ $file 版本为 $actual，期望 $VERSION"
    exit 1
  fi
  echo "      $file ✓"
}
check_version "package.json" "$(node -e "console.log(require(String.raw\`$(win_path "$PKG_FILE")\`).version)")"
check_version "package-lock.json" "$(node -e "console.log(require(String.raw\`$(win_path "$LOCK_FILE")\`).version)")"
check_version "package-lock root" "$(node -e "console.log(require(String.raw\`$(win_path "$LOCK_FILE")\`).packages[''].version)")"
check_version "version.json" "$(node -e "console.log(require(String.raw\`$(win_path "$VERSION_FILE")\`).version)")"
check_version "plugin.json" "$(node -e "console.log(require(String.raw\`$(win_path "$PLUGIN_FILE")\`).version)")"
check_version "SKILL.md" "$(grep -m1 '^version:' "$SKILL_FILE" | sed 's/^version:[[:space:]]*//')"

# ─── [5/6] 测试 ─────────────────────────────────────────────────────────────

if [ "$SKIP_TESTS" = "true" ]; then
  echo "[5/6] 跳过测试（--skip-tests）⚠️"
else
  echo "[5/6] 运行测试..."
  ( cd "$SCRIPT_DIR" && npm test --silent ) || { echo "  ✗ 测试未通过，发布中止"; exit 1; }
  echo "      测试通过 ✓"
fi

# ─── [6/6] 发布 ─────────────────────────────────────────────────────────────

if [ "$DRY_RUN" = "true" ]; then
  echo "[6/6] dry-run: 打包预览（不上传）..."
  ( cd "$SCRIPT_DIR" && npm pack --dry-run --registry="$REGISTRY" 2>&1 | tail -12 )
  echo ""
  echo "[dry-run] 已完成校验与预览；工作区版本改动已回滚。"
  exit 0
fi

echo "[6/6] npm publish..."
# 凭证二选一：
#   - 已 `npm login`：直接用本机 ~/.npmrc
#   - 设了 NPM_TOKEN：写进临时配置并只对本次发布生效，不改动本机 ~/.npmrc
PUBLISH_ARGS=(--registry="$REGISTRY")
TEMP_NPMRC=""
if [ -n "$NPM_TOKEN" ]; then
  TEMP_NPMRC="$(mktemp)"
  printf '//%s/:_authToken=%s\n' "${REGISTRY#*//}" "$NPM_TOKEN" > "$TEMP_NPMRC"
  chmod 600 "$TEMP_NPMRC"
  PUBLISH_ARGS+=(--userconfig="$(win_path "$TEMP_NPMRC")")
  echo "      使用 NPM_TOKEN（临时配置，不写入 ~/.npmrc）"
fi
( cd "$SCRIPT_DIR" && npm publish "${PUBLISH_ARGS[@]}" )

echo ""
echo "==> 发布完成! weworker-webcli@$VERSION"
echo "    Registry: $REGISTRY"
echo ""
echo "    提示：发布脚本改写了发布账本与 skill 描述，记得一并提交："
echo "          webcli/package.json webcli/package-lock.json webcli/version.json webcli/.claude-plugin/plugin.json"
echo "          webcli/skills/webcli/SKILL.md"
echo ""
echo "    注意：skill 通过 npm 包内的 SKILL.md + 公共 CDN 分发（npx skills add <unpkg URL>），"
echo "          CDN 对不带版本号的地址有缓存，新版本通常要几分钟才生效，别急着判定没发成功。"
