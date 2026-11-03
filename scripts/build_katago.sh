#!/usr/bin/env bash
# 用 Android NDK 交叉编译 KataGo（arm64），产出两个可执行文件：
#   out/libkatago_eigen.so  —— CPU 版
#   out/libkatago_cl.so     —— GPU 版（OpenCL，运行时用手机自带的 libOpenCL.so）
# 文件名用 lib*.so 是为了能放进 APK 的 jniLibs 并在手机上执行。
set -euo pipefail

KATAGO_VERSION="${KATAGO_VERSION:-v1.18.2}"
API=28
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/build-native"
OUT="$WORK/out"
mkdir -p "$WORK" "$OUT"

NDK="${ANDROID_NDK_LATEST_HOME:-${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}}"
[ -d "$NDK" ] || { echo "找不到 Android NDK"; exit 1; }
echo "NDK: $NDK"
TC="$NDK/build/cmake/android.toolchain.cmake"
LLVM="$NDK/toolchains/llvm/prebuilt/linux-x86_64"
SYSROOT="$LLVM/sysroot"
CC="$LLVM/bin/aarch64-linux-android${API}-clang"

cd "$WORK"

# 1) KataGo 源码
if [ ! -d katago ]; then
  git clone --depth 1 --branch "$KATAGO_VERSION" https://github.com/lightvector/KataGo.git katago
fi

# 2) Eigen（只需要头文件）
if [ ! -d eigen ]; then
  curl -fL --retry 3 -o eigen.tar.gz https://gitlab.com/libeigen/eigen/-/archive/3.4.0/eigen-3.4.0.tar.gz
  mkdir eigen && tar -xzf eigen.tar.gz -C eigen --strip-components=1
fi

# 3) OpenCL 头文件 + 仅用于链接的空壳 libOpenCL.so（手机上会用系统自带的真库）
if [ ! -d OpenCL-Headers ]; then
  git clone --depth 1 https://github.com/KhronosGroup/OpenCL-Headers.git
fi
mkdir -p clstub
python3 - "$WORK/OpenCL-Headers/CL/cl.h" "$WORK/clstub/stub.c" <<'EOF'
import re, sys
src = open(sys.argv[1]).read()
names = sorted(set(re.findall(r'CL_API_CALL\s+(cl[A-Z][A-Za-z0-9_]*)\s*\(', src)))
with open(sys.argv[2], "w") as f:
    for n in names:
        f.write(f"void {n}(void) {{}}\n")
print(f"OpenCL stub: {len(names)} 个函数")
EOF
"$CC" -shared -fPIC -o clstub/libOpenCL.so -Wl,-soname,libOpenCL.so clstub/stub.c

COMMON=(
  -DCMAKE_TOOLCHAIN_FILE="$TC"
  -DANDROID_ABI=arm64-v8a
  -DANDROID_PLATFORM=android-$API
  -DANDROID_STL=c++_static
  -DCMAKE_BUILD_TYPE=Release
  -DNO_GIT_REVISION=1
  -DCMAKE_CXX_FLAGS="-include endian.h"   # bionic 的 sys/types.h 不带字节序定义
  -DZLIB_INCLUDE_DIR="$SYSROOT/usr/include"
  -DZLIB_LIBRARY="$SYSROOT/usr/lib/aarch64-linux-android/$API/libz.so"
)

# 4) CPU 版
cmake -S katago/cpp -B build-eigen "${COMMON[@]}" \
  -DUSE_BACKEND=EIGEN -DEIGEN3_INCLUDE_DIRS="$WORK/eigen"
cmake --build build-eigen --target katago -j"$(nproc)" -- -k
cp build-eigen/katago "$OUT/libkatago_eigen.so"

# 5) GPU 版
cmake -S katago/cpp -B build-cl "${COMMON[@]}" \
  -DUSE_BACKEND=OPENCL \
  -DOpenCL_INCLUDE_DIR="$WORK/OpenCL-Headers" \
  -DOpenCL_LIBRARY="$WORK/clstub/libOpenCL.so"
cmake --build build-cl --target katago -j"$(nproc)" -- -k
cp build-cl/katago "$OUT/libkatago_cl.so"

"$LLVM/bin/llvm-strip" "$OUT"/*.so
ls -la "$OUT"

# 6) 放进 App
DEST="$ROOT/app/src/main/jniLibs/arm64-v8a"
mkdir -p "$DEST"
cp "$OUT"/*.so "$DEST/"
echo "完成：$DEST"
