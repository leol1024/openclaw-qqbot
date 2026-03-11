#!/bin/bash

# qqbot 通过 npm 包升级
#
# 用法:
#   upgrade-via-npm.sh                                    # 升级到 latest（默认）
#   upgrade-via-npm.sh --version <version>                # 升级到指定版本
#   upgrade-via-npm.sh --self-version                     # 升级到当前仓库 package.json 版本

set -eo pipefail

PKG_NAME="@tencent-connect/openclaw-qqbot"
INSTALL_SRC=""
APPID=""
SECRET=""
STREAM=""
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

LOCAL_VERSION="$(node -e "
  try {
    const fs = require('fs');
    const path = require('path');
    const p = path.join('$PROJECT_DIR', 'package.json');
    const v = JSON.parse(fs.readFileSync(p, 'utf8')).version;
    if (v) process.stdout.write(String(v));
  } catch {}
" 2>/dev/null || true)"

print_usage() {
    echo "用法:"
    echo "  upgrade-via-npm.sh                              # 升级到 latest（默认）"
    echo "  upgrade-via-npm.sh --version <版本号>            # 升级到指定版本"
    echo "  upgrade-via-npm.sh --appid <appid> --secret <secret>  # 配置通道并启动"
    echo "  upgrade-via-npm.sh --stream <yes|no>              # 是否启用流式消息（仅C2C私聊生效）"
    if [ -n "$LOCAL_VERSION" ]; then
        echo "  upgrade-via-npm.sh --self-version               # 升级到当前仓库版本（$LOCAL_VERSION）"
    else
        echo "  upgrade-via-npm.sh --self-version               # 升级到当前仓库版本"
    fi
    echo ""
    echo "也可以通过环境变量设置:"
    echo "  QQBOT_APPID           QQ机器人 appid"
    echo "  QQBOT_SECRET          QQ机器人 secret"
    echo "  QQBOT_STREAM          是否启用流式消息（yes/no）"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --tag)
            [ -z "$2" ] && echo "❌ --tag 需要参数" && exit 1
            INSTALL_SRC="${PKG_NAME}@$2"
            shift 2
            ;;
        --version)
            [ -z "$2" ] && echo "❌ --version 需要参数" && exit 1
            INSTALL_SRC="${PKG_NAME}@$2"
            shift 2
            ;;
        --self-version)
            [ -z "$LOCAL_VERSION" ] && echo "❌ 无法从 package.json 读取版本" && exit 1
            INSTALL_SRC="${PKG_NAME}@${LOCAL_VERSION}"
            shift 1
            ;;
        --appid)
            [ -z "$2" ] && echo "❌ --appid 需要参数" && exit 1
            APPID="$2"
            shift 2
            ;;
        --secret)
            [ -z "$2" ] && echo "❌ --secret 需要参数" && exit 1
            SECRET="$2"
            shift 2
            ;;
        --stream)
            [ -z "$2" ] && echo "❌ --stream 需要参数" && exit 1
            STREAM="$2"
            shift 2
            ;;
        -h|--help)
            print_usage
            exit 0
            ;;
        *) echo "未知选项: $1"; print_usage; exit 1 ;;
    esac
done
INSTALL_SRC="${INSTALL_SRC:-${PKG_NAME}@latest}"

# 使用命令行参数或环境变量
APPID="${APPID:-$QQBOT_APPID}"
SECRET="${SECRET:-$QQBOT_SECRET}"
STREAM="${STREAM:-$QQBOT_STREAM}"

# 检测 CLI
CMD=""
for name in openclaw clawdbot moltbot; do
    command -v "$name" &>/dev/null && CMD="$name" && break
done
[ -z "$CMD" ] && echo "❌ 未找到 openclaw / clawdbot / moltbot" && exit 1

APP_CONFIG="$HOME/.$CMD/$CMD.json"
EXTENSIONS_DIR="$HOME/.$CMD/extensions"

echo "==========================================="
echo "  qqbot npm 升级: $INSTALL_SRC"
echo "==========================================="
echo ""

# [1/4] 备份并临时移除通道配置（避免 plugins install 因 unknown channel 拒绝执行）
echo "[1/4] 备份通道配置..."
if [ -f "$APP_CONFIG" ]; then
    node -e "
        const fs = require('fs');
        const cfg = JSON.parse(fs.readFileSync('$APP_CONFIG', 'utf8'));
        const keys = ['qqbot', 'openclaw-qqbot', 'openclaw-qq'];
        let saved = null;
        for (const key of keys) {
            const ch = cfg.channels && cfg.channels[key];
            if (ch) { saved = ch; delete cfg.channels[key]; break; }
        }
        // 清理 plugins.entries 中的旧记录（避免 stale config entry 告警）
        if (cfg.plugins && cfg.plugins.entries) {
            delete cfg.plugins.entries['openclaw-qqbot'];
        }
        if (saved) {
            fs.writeFileSync('$APP_CONFIG.qqbot-backup.json', JSON.stringify(saved, null, 2));
            fs.writeFileSync('$APP_CONFIG', JSON.stringify(cfg, null, 4) + '\n');
            console.log('  ✅ 已备份并临时移除 channels.qqbot');
        } else {
            console.log('  ℹ️  无已有通道配置');
        }
    " 2>/dev/null || echo "  ⚠️  备份失败"
else
    echo "  ℹ️  无配置文件"
fi

# [2/4] 清理旧插件目录
echo ""
echo "[2/4] 清理旧插件..."
for old_plugin in openclaw-qqbot qqbot openclaw-qq @sliverp/qqbot @tencent-connect/qqbot @tencent-connect/openclaw-qq @tencent-connect/openclaw-qqbot; do
    $CMD plugins uninstall "$old_plugin" 2>/dev/null && echo "  已卸载: $old_plugin" || true
done
for dir_name in openclaw-qqbot qqbot openclaw-qq; do
    if [ -d "$EXTENSIONS_DIR/$dir_name" ]; then
        rm -rf "$EXTENSIONS_DIR/$dir_name"
        echo "  已清理残留目录: $dir_name"
    fi
done

# [3/4] 安装新版本
echo ""
echo "[3/4] 安装新版本..."
$CMD plugins install "$INSTALL_SRC" 2>&1

# 恢复通道配置
BACKUP_FILE="$APP_CONFIG.qqbot-backup.json"
if [ -f "$BACKUP_FILE" ] && [ -f "$APP_CONFIG" ]; then
    node -e "
        const fs = require('fs');
        const cfg = JSON.parse(fs.readFileSync('$APP_CONFIG', 'utf8'));
        const saved = JSON.parse(fs.readFileSync('$BACKUP_FILE', 'utf8'));
        cfg.channels = cfg.channels || {};
        cfg.channels.qqbot = saved;
        fs.writeFileSync('$APP_CONFIG', JSON.stringify(cfg, null, 4) + '\n');
        fs.unlinkSync('$BACKUP_FILE');
        console.log('  ✅ 通道配置已恢复');
    " 2>/dev/null || echo "  ⚠️  通道配置恢复失败，请手动检查: $APP_CONFIG"
fi

# 配置通道（如果提供了 appid 和 secret）
if [ -n "$APPID" ] && [ -n "$SECRET" ]; then
    echo ""
    echo "配置机器人通道..."
    DESIRED_TOKEN="${APPID}:${SECRET}"

    # 读取当前配置中的 token
    CURRENT_TOKEN=""
    if [ -f "$APP_CONFIG" ]; then
        CURRENT_TOKEN=$(node -e "
            const cfg = JSON.parse(require('fs').readFileSync('$APP_CONFIG', 'utf8'));
            const keys = ['qqbot', 'openclaw-qqbot', 'openclaw-qq'];
            for (const key of keys) {
                const ch = cfg.channels && cfg.channels[key];
                if (!ch) continue;
                if (ch.token) { process.stdout.write(ch.token); process.exit(0); }
                if (ch.appId && ch.clientSecret) { process.stdout.write(ch.appId + ':' + ch.clientSecret); process.exit(0); }
            }
        " 2>/dev/null || true)
    fi

    if [ "$CURRENT_TOKEN" = "$DESIRED_TOKEN" ]; then
        echo "  ✅ 当前配置已是目标值，跳过写入"
    elif $CMD channels add --channel qqbot --token "$DESIRED_TOKEN" 2>&1; then
        echo "  ✅ 机器人通道配置成功"
    else
        echo "  ⚠️  通道配置失败，请手动执行: $CMD channels add --channel qqbot --token \"$DESIRED_TOKEN\""
    fi
fi

# 配置 stream 选项（仅在明确指定时才配置）
if [ -n "$STREAM" ]; then
    echo ""
    echo "配置 stream 选项..."
    if [ "$STREAM" = "yes" ] || [ "$STREAM" = "y" ] || [ "$STREAM" = "true" ]; then
        STREAM_VALUE="true"
        echo "启用流式消息（仅C2C私聊生效）..."
    else
        STREAM_VALUE="false"
        echo "禁用流式消息..."
    fi

    CURRENT_STREAM_VALUE=$(node -e "
      const fs = require('fs');
      const path = require('path');
      const home = process.env.HOME;
      for (const app of ['openclaw', 'clawdbot', 'moltbot']) {
        const f = path.join(home, '.' + app, app + '.json');
        if (!fs.existsSync(f)) continue;
        try {
          const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
          const keys = ['qqbot', 'openclaw-qqbot', 'openclaw-qq'];
          for (const key of keys) {
            const ch = cfg.channels && cfg.channels[key];
            if (!ch) continue;
            if (typeof ch.streamSupport === 'boolean') { process.stdout.write(String(ch.streamSupport)); process.exit(0); }
          }
        } catch {}
      }
    " 2>/dev/null || true)

    if [ "$CURRENT_STREAM_VALUE" = "$STREAM_VALUE" ]; then
        echo "  ✅ stream 配置已是目标值，跳过写入"
    elif $CMD config set channels.qqbot.streamSupport "$STREAM_VALUE" 2>&1; then
        echo "  ✅ stream 配置成功"
    else
        echo "  ⚠️  $CMD config set 失败，尝试直接编辑配置文件..."
        if [ -f "$APP_CONFIG" ] && node -e "
          const fs = require('fs');
          const cfg = JSON.parse(fs.readFileSync('$APP_CONFIG', 'utf-8'));
          if (!cfg.channels) cfg.channels = {};
          if (!cfg.channels.qqbot) cfg.channels.qqbot = {};
          const target = $STREAM_VALUE;
          if (cfg.channels.qqbot.streamSupport === target) process.exit(0);
          cfg.channels.qqbot.streamSupport = target;
          fs.writeFileSync('$APP_CONFIG', JSON.stringify(cfg, null, 4) + '\n');
        " 2>&1; then
            echo "  ✅ stream 配置成功（直接编辑配置文件）"
        else
            echo "  ⚠️  stream 配置设置失败，不影响后续运行"
        fi
    fi
fi

# [4/4] 重启网关
echo ""
echo "[4/4] 重启网关..."
$CMD gateway restart 2>&1 || true

echo ""
echo "==========================================="
echo "  ✅ 升级完成"
echo "==========================================="
echo ""
echo "常用命令:"
echo "  $CMD logs --follow        # 跟踪日志"
echo "  $CMD gateway restart      # 重启服务"
echo "  $CMD plugins list         # 查看插件列表"
