#!/bin/sh
# 安装 WattWatch 轮询器：配置文件 + 命令包装 + cron。
# 用法: sh scripts/install.sh
set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$HOME/.local/bin"
CFG="$HOME/.config/wattwatch"
mkdir -p "$BIN" "$CFG"

[ -f "$CFG/config.json" ] || { cp "$REPO/config.example.json" "$CFG/config.json"; echo "已生成 $CFG/config.json（请填写 worker_url 等）"; }

cat > "$BIN/wattwatch-poll" <<EOS
#!/bin/sh
# 不加随机抖动：每小时在本小时 :10~:58 之间读表，与学校后台的整点刷新对齐（寝室数变时各寝室时刻会整体平移）
exec python3 "$REPO/monitor/poller.py" "\$@"
EOS
chmod +x "$BIN/wattwatch-poll"

# 清理 v1 的命令与本地看板
rm -f "$BIN/wattwatch-run" "$BIN/wattwatch-web"
pkill -f '[w]attwatch/monitor/web.py' 2>/dev/null || true

# 学校后台在整点后 :02~:04 之间刷新读数；整点任务 :10 启动（poller 强制起点 ≥:10），把读数匀速分布到 :10~:58
( crontab -l 2>/dev/null | grep -v 'wattwatch' ; \
  echo "10 * * * * $BIN/wattwatch-poll" ; \
  echo "*/2 * * * * $BIN/wattwatch-poll --new" ; \
  echo "40 4 * * 1 $BIN/wattwatch-poll --sync-dir" ) | crontab -

echo "安装完成："
echo "  配置:     $CFG/config.json"
echo "  同步目录: wattwatch-poll --sync-dir   （首次部署后先跑一次）"
echo "  导入旧数据: wattwatch-poll --import-state ~/.local/share/wattwatch/state.json"
echo "  手动读表: wattwatch-poll"
echo "  cron:     每小时 :10~:58 匀速读表；每 2 分钟补读新寝室（注册后一两分钟内有数）；每周一 04:40 同步目录"
