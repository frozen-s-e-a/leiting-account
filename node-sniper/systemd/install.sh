#!/usr/bin/env bash
# 一键把 bridge 装成 systemd 常驻服务。需要 root(用 sudo 跑)。
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 sudo 运行: sudo bash $0" >&2
  exit 1
fi

# 找出 bridge 所在目录(此脚本在 systemd/ 子目录)和 node 可执行路径
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "找不到 node。先装 Node:curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && yum install -y nodejs" >&2
  exit 1
fi

if [ ! -f "$INSTALL_DIR/config.json" ]; then
  echo "尚未创建 $INSTALL_DIR/config.json。先 cp config.example.json config.json 并填写。" >&2
  exit 1
fi

# 装依赖(若没装过)
if [ ! -d "$INSTALL_DIR/node_modules" ]; then
  echo "→ 安装 npm 依赖…"
  (cd "$INSTALL_DIR" && npm install --omit=dev)
fi

UNIT_SRC="$INSTALL_DIR/systemd/sniper-bridge.service"
UNIT_DST="/etc/systemd/system/sniper-bridge.service"

# 替换占位符并写入系统目录
sed -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" -e "s|__NODE__|$NODE_BIN|g" "$UNIT_SRC" > "$UNIT_DST"
echo "→ 写入 $UNIT_DST"

systemctl daemon-reload
systemctl enable --now sniper-bridge
echo
echo "✅ 已安装并启动。常用命令:"
echo "   sudo systemctl status sniper-bridge"
echo "   sudo systemctl restart sniper-bridge"
echo "   journalctl -u sniper-bridge -f"
echo
echo "确认监听:"
ss -lntp 2>/dev/null | grep -E "node|:$(node -e 'try{console.log((JSON.parse(require("fs").readFileSync("'$INSTALL_DIR'/config.json","utf8")).bridge||{}).port||8787)}catch(e){console.log(8787)}')" || true
