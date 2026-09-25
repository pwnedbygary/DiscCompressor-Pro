#!/usr/bin/env bash
# Build fully static Linux x86-64 copies of chdman (MAME) and maxcso from their
# official source releases and install them into resources/bin/linux-x64.
#
# Static binaries run on any x86-64 Linux, which is what the AppImage needs.
# The script runs on Debian or Ubuntu (x86-64), because it records the Debian
# packages whose static libraries end up in the binaries. It needs:
#   build-essential python3 curl file pkg-config libsdl2-dev libuv1-dev liblz4-dev zlib1g-dev
# SDL2 headers are only needed by MAME's project generator; chdman itself does
# not link SDL (see the clipboard stand-ins below).
#
# $DCP_TOOLS_CACHE (default: node_modules/.cache/dcp-tools) keeps the downloads
# and, in built/, each finished binary with the record of how it was built. A
# tool is rebuilt from scratch whenever this script, the compiler, binutils or
# one of the linked packages changes. Next to the installed binaries,
# BUILD-INFO.txt records what they were built from and licenses/ holds the
# copyright files of the system libraries linked into them.
#
# With --print-toolchain, the script prints those records instead of building,
# which CI uses in the key of its cache.
set -euo pipefail

if [[ $# -gt 1 || ($# -eq 1 && $1 != --print-toolchain) ]]; then
  echo "Usage: $0 [--print-toolchain]" >&2
  exit 2
fi

MAME_VERSION=0289
# The source archive GitHub generates for the release tag. MAME's own source
# release (mame0289s.exe on the same page) has Windows line endings throughout,
# so it cannot be built on Linux unmodified. GitHub keeps these archives stable,
# but should the checksum ever change, the download fails instead of using it.
MAME_SHA256=0929cc749afabcef892900e10dd90bd8b05f94a7dde8f367ac6a5d2082589f84
MAXCSO_VERSION=1.13.0
# maxcso publishes no source archive of its own either.
MAXCSO_SHA256=af9c05add1a1d199ec184d3471081af1b91d591b2473800ea989c882fb632730

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CACHE=${DCP_TOOLS_CACHE:-$ROOT/node_modules/.cache/dcp-tools}
BUILD=$CACHE/build
BUILT=$CACHE/built
OUT=$ROOT/resources/bin/linux-x64
JOBS=${JOBS:-$(nproc)}
SCRIPT_HASH=$(sha256sum "${BASH_SOURCE[0]}" | cut -d' ' -f1)

if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  echo "This script builds Linux x86-64 binaries and must run on Linux x86-64." >&2
  exit 1
fi
for tool in gcc g++ make ar python3 curl tar strip file sha256sum dpkg-query sdl2-config; do
  command -v "$tool" >/dev/null || { echo "Missing required tool: $tool (this script needs Debian or Ubuntu)" >&2; exit 1; }
done
for lib in libuv.a liblz4.a libz.a; do
  gcc -print-file-name="$lib" | grep -q / || { echo "Missing static library: $lib" >&2; exit 1; }
done

GCC_MAJOR=$(gcc -dumpversion | cut -d. -f1)

# toolchain PACKAGE... — the compiler, binutils (as, ld and strip) and the Debian
# packages whose static libraries a tool links, as recorded in BUILD-INFO.txt.
toolchain() {
  echo "  $(gcc --version | head -n 1)"
  dpkg-query -W -f '  ${Package} ${Version}\n' binutils || return
  dpkg-query -W -f '  ${Package} ${Version} (source: ${source:Package} ${source:Version})\n' \
    libc6-dev "libstdc++-$GCC_MAJOR-dev" "libgcc-$GCC_MAJOR-dev" "$@"
}

MAXCSO_PACKAGES=(libuv1-dev liblz4-dev zlib1g-dev)
CHDMAN_RECORD=$(toolchain)
MAXCSO_RECORD=$(toolchain "${MAXCSO_PACKAGES[@]}")
if [[ ${1-} == --print-toolchain ]]; then
  printf 'chdman:\n%s\nmaxcso:\n%s\n' "$CHDMAN_RECORD" "$MAXCSO_RECORD"
  exit 0
fi

mkdir -p "$CACHE" "$BUILD" "$BUILT"

# up_to_date TOOL RECORD — whether TOOL was built by this script with the toolchain in RECORD.
up_to_date() {
  local dir=$BUILT/$1
  [[ -x $dir/$1 && $(cat "$dir/build-script" 2>/dev/null) == "$SCRIPT_HASH" && $(cat "$dir/build-info" 2>/dev/null) == "$2" ]]
}

# keep TOOL BINARY RECORD PACKAGE... — store a finished binary with its record and the
# copyright files of the packages linked into it.
keep() {
  local tool=$1 binary=$2 record=$3 package
  shift 3
  local dir=$BUILT/$tool
  rm -rf "$dir"
  mkdir -p "$dir/copyright"
  cp "$binary" "$dir/$tool"
  printf '%s\n' "$record" > "$dir/build-info"
  for package in libc6-dev "libstdc++-$GCC_MAJOR-dev" "libgcc-$GCC_MAJOR-dev" "$@"; do
    cp -L "/usr/share/doc/$package/copyright" "$dir/copyright/$package.copyright"
  done
  echo "$SCRIPT_HASH" > "$dir/build-script"
}

# download URL FILE SHA256
download() {
  local url=$1 file=$CACHE/$2 sha=$3
  if [[ ! -f $file ]] || ! echo "$sha  $file" | sha256sum --check --status; then
    echo "Downloading $url"
    curl --fail --location --silent --show-error --retry 3 --retry-delay 5 --retry-all-errors --output "$file.part" "$url"
    mv "$file.part" "$file"
  fi
  echo "$sha  $file" | sha256sum --check --quiet || { echo "$2 does not have the pinned SHA-256 $sha" >&2; exit 1; }
}

# extract ARCHIVE DIR — unpack a fresh copy of a .tar.gz whose single top-level folder becomes DIR.
extract() {
  local archive=$1 dir=$2
  rm -rf "$dir" "$dir.tmp"
  mkdir -p "$dir.tmp"
  tar -xzf "$archive" -C "$dir.tmp" --strip-components=1
  mv "$dir.tmp" "$dir"
}

# --- maxcso -----------------------------------------------------------------
download "https://github.com/unknownbrackets/maxcso/archive/refs/tags/v$MAXCSO_VERSION.tar.gz" \
  "maxcso-$MAXCSO_VERSION.tar.gz" "$MAXCSO_SHA256"
if ! up_to_date maxcso "$MAXCSO_RECORD"; then
  echo "Building maxcso $MAXCSO_VERSION"
  src=$BUILD/maxcso
  extract "$CACHE/maxcso-$MAXCSO_VERSION.tar.gz" "$src"
  # Upstream's Makefile links the system libuv, lz4 and zlib; -static makes the
  # result self-contained (the static glibc lookups libuv warns about are never used).
  # Its `CC ?= gcc` never applies, because make's built-in CC is cc, which may be
  # another compiler such as clang; CC and CXX name the recorded one instead.
  make -C "$src" -j"$JOBS" CC=gcc CXX=g++ CFLAGS="-O2" CXXFLAGS="-O2 -static" maxcso
  keep maxcso "$src/maxcso" "$MAXCSO_RECORD" "${MAXCSO_PACKAGES[@]}"
  rm -rf "$src"
fi

# --- chdman -----------------------------------------------------------------
download "https://github.com/mamedev/mame/archive/refs/tags/mame$MAME_VERSION.tar.gz" \
  "mame$MAME_VERSION.tar.gz" "$MAME_SHA256"
if ! up_to_date chdman "$CHDMAN_RECORD"; then
  echo "Building chdman 0.${MAME_VERSION#0}"
  # Always a fresh tree, so that no object built with an earlier toolchain is linked in.
  src=$BUILD/mame
  extract "$CACHE/mame$MAME_VERSION.tar.gz" "$src"

  # chdman never uses the clipboard, but MAME's Unix OSD library implements
  # clipboard access with SDL2. A stand-in libSDL2.a with those four functions,
  # found first on the library path, lets chdman link statically without SDL.
  STUB=$BUILD/sdl-stub
  rm -rf "$STUB"
  mkdir -p "$STUB"
  cat > "$STUB/sdl_clipboard_stub.c" <<'EOF'
#include <stdlib.h>
typedef enum { SDL_FALSE = 0, SDL_TRUE = 1 } SDL_bool;
SDL_bool SDL_HasClipboardText(void) { return SDL_FALSE; }
char *SDL_GetClipboardText(void) { return NULL; }
int SDL_SetClipboardText(const char *text) { (void)text; return -1; }
void SDL_free(void *mem) { free(mem); }
EOF
  gcc -O2 -c "$STUB/sdl_clipboard_stub.c" -o "$STUB/sdl_clipboard_stub.o"
  ar rcs "$STUB/libSDL2.a" "$STUB/sdl_clipboard_stub.o"

  MAME_OPTIONS=(
    TOOLS=1 EMULATOR=0 NOWERROR=1 OSD=sdl PYTHON_EXECUTABLE=python3
    NO_X11=1 NO_USE_XINPUT=1 NO_OPENGL=1 USE_QTDEBUG=0
    NO_USE_MIDI=1 NO_USE_PORTAUDIO=1 NO_USE_PULSEAUDIO=1 NO_USE_PIPEWIRE=1
    # The source archive has no git metadata; report the release tag like official builds.
    IGNORE_GIT=1 "NEW_GIT_VERSION=mame$MAME_VERSION"
    LDOPTS=-static
  )
  make -C "$src" -j"$JOBS" "${MAME_OPTIONS[@]}" generate build/projects/sdl/mame/gmake-linux/Makefile
  make -C "$src/build/projects/sdl/mame/gmake-linux" -j"$JOBS" config=release64 precompile
  make -C "$src/build/projects/sdl/mame/gmake-linux" -j"$JOBS" config=release64 LDFLAGS="-L$STUB" chdman
  keep chdman "$src/chdman" "$CHDMAN_RECORD"
  # About 1.5 GB that the next rebuild recreates from scratch anyway.
  rm -rf "$src" "$STUB"
fi

# Install into an emptied folder, so that nothing else ends up in the AppImage.
rm -rf "$OUT"
mkdir -p "$OUT/licenses/chdman" "$OUT/licenses/maxcso"
# The build ID is a hash that includes the (stripped) debug information and so
# the build folder; without it the binaries do not depend on where they were built.
for tool in chdman maxcso; do
  strip --remove-section=.note.gnu.build-id -o "$OUT/$tool" "$BUILT/$tool/$tool"
done
chmod 755 "$OUT/maxcso" "$OUT/chdman"

# Refuse to install anything that does not run or is not fully static. Both
# tools exit with status 1 after printing their banner, hence `|| true`.
for binary in "$OUT/chdman" "$OUT/maxcso"; do
  file "$binary" | grep -q 'statically linked' || { echo "$binary is not statically linked" >&2; exit 1; }
done
chdman_banner=$("$OUT/chdman" 2>&1 || true)
maxcso_banner=$("$OUT/maxcso" --version 2>&1 || true)
grep -q "manager 0\.${MAME_VERSION#0} (mame$MAME_VERSION)" <<<"$chdman_banner" || { echo "Unexpected chdman version: ${chdman_banner%%$'\n'*}" >&2; exit 1; }
grep -q "maxcso v$MAXCSO_VERSION" <<<"$maxcso_banner" || { echo "Unexpected maxcso version: $maxcso_banner" >&2; exit 1; }

# Record what went into the binaries.
cp "$BUILT"/chdman/copyright/* "$OUT/licenses/chdman/"
cp "$BUILT"/maxcso/copyright/* "$OUT/licenses/maxcso/"
{
  echo "chdman and maxcso in this folder were built by scripts/build-linux-tools.sh from the"
  echo "unmodified source releases of MAME 0.${MAME_VERSION#0} (sha256 $MAME_SHA256)"
  echo "and maxcso $MAXCSO_VERSION (sha256 $MAXCSO_SHA256). Each list below starts with the"
  echo "compiler and binutils the tool was built with, followed by the packages whose system"
  echo "libraries are statically linked into it. The copyright files of those packages are in"
  echo "licenses/<tool>/, and each release's sources archive contains their source packages,"
  echo "except GCC's runtime libraries, which the GCC Runtime Library Exception covers."
  echo
  echo "chdman was built with:"
  cat "$BUILT/chdman/build-info"
  echo
  echo "maxcso was built with:"
  cat "$BUILT/maxcso/build-info"
  echo
  echo "SHA-256:"
  (cd "$OUT" && sha256sum chdman maxcso | sed 's/^/  /')
} > "$OUT/BUILD-INFO.txt"

echo "Installed into $OUT:"
echo "  ${chdman_banner%%$'\n'*}"
echo "  $maxcso_banner"
sha256sum "$OUT/chdman" "$OUT/maxcso"
