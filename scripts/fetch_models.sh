#!/usr/bin/env bash
# 下载两个模型放进 App 的 assets：
#   main.txt.gz  —— KataGo b10c128（判断胜率/推荐点）
#   human.bin.gz —— KataGo 人类棋风模型（按段位模仿人类落子）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/app/src/main/assets/models"
mkdir -p "$DEST"

get() {  # get <输出文件> <最小字节数> <地址...>
  local out="$1" min="$2"; shift 2
  if [ -f "$out" ] && [ "$(stat -c%s "$out")" -ge "$min" ]; then echo "已存在 $out"; return 0; fi
  for url in "$@"; do
    echo "下载 $url"
    if curl -fL --retry 3 --connect-timeout 30 -o "$out.part" "$url" \
       && [ "$(stat -c%s "$out.part")" -ge "$min" ]; then
      mv "$out.part" "$out"; echo "OK $(stat -c%s "$out") 字节"; return 0
    fi
    echo "失败，换下一个地址"
  done
  echo "所有地址都下载失败：$out"; exit 1
}

[ -f "$DEST/main.txt" ] || get "$DEST/main.txt.gz" 10000000 \
  "https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-b10c128-s1141046784-d204142634.txt.gz" \
  "https://huggingface.co/salty-flower/weiqi-models/resolve/main/kata1-b10c128.txt.gz"

[ -f "$DEST/human.bin" ] || get "$DEST/human.bin.gz" 90000000 \
  "https://github.com/lightvector/KataGo/releases/download/v1.15.0/b18c384nbt-humanv0.bin.gz"

# 安卓打包工具会自动解压 .gz 资源并去掉扩展名，这里先自己解压好，文件名就固定了
for f in main.txt human.bin; do
  if [ ! -f "$DEST/$f" ]; then gunzip -c "$DEST/$f.gz" > "$DEST/$f.part" && mv "$DEST/$f.part" "$DEST/$f"; fi
done
rm -f "$DEST"/*.gz
ls -la "$DEST"
