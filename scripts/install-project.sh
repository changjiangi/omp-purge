#!/usr/bin/env bash
# Install omp-purge into a project's local plugin root (<project>/.omp/plugins).
# Usage: ./scripts/install-project.sh [project-dir]
set -euo pipefail

SRC="${OMP_PURGE_SRC:-$HOME/.omp/plugins-src/omp-purge}"
PROJECT="${1:-$PWD}"
PLUGINS="$PROJECT/.omp/plugins"

if [[ ! -f "$SRC/package.json" ]]; then
  echo "omp-purge source not found: $SRC" >&2
  exit 1
fi

mkdir -p "$PLUGINS/node_modules"
ln -sfn "$SRC" "$PLUGINS/node_modules/omp-purge"

python3 - "$SRC" "$PLUGINS" <<'PY'
import json, os, sys
from pathlib import Path

src = Path(sys.argv[1]).resolve()
plugins = Path(sys.argv[2])
version = json.loads((src / "package.json").read_text()).get("version", "1.0.0")

pkg_path = plugins / "package.json"
if pkg_path.exists():
    pkg = json.loads(pkg_path.read_text())
else:
    pkg = {"name": "omp-plugins", "private": True}
pkg.setdefault("private", True)
pkg.setdefault("dependencies", {})["omp-purge"] = f"file:{src}"
pkg_path.write_text(json.dumps(pkg, ensure_ascii=False, indent=2) + "\n")

lock_path = plugins / "omp-plugins.lock.json"
if lock_path.exists():
    lock = json.loads(lock_path.read_text())
else:
    lock = {"plugins": {}, "settings": {}}
lock.setdefault("plugins", {})["omp-purge"] = {
    "version": version,
    "enabledFeatures": None,
    "enabled": True,
}
lock.setdefault("settings", {})
lock_path.write_text(json.dumps(lock, ensure_ascii=False, indent=2) + "\n")
PY

cat <<MSG
✔ omp-purge linked into $PLUGINS

Next:
  1. restart the omp session in $PROJECT
  2. /purge status
  3. /purge on
MSG
