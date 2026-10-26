#!/usr/bin/env python3
"""Check the small, pinned reference set without importing model source."""
from pathlib import Path
import hashlib
import json
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
REVISION = "1bae0e1088993b9b82de08f59de5be5a34e42170"
EXPECTED = {
    "model-config": {"config.json", "inference/config.json", "LICENSE"},
    "model-architecture": {"inference/model.py", "inference/engram.py", "inference/vision.py"},
}
errors = []
count = total = 0
for directory, allowed in EXPECTED.items():
    base = ROOT / "references" / directory
    manifest = json.loads((base / "manifest.json").read_text())
    if manifest["revision"] != REVISION:
        errors.append(f"{directory}: unexpected revision")
    entries = manifest["downloaded_files"]
    if {entry["path"] for entry in entries} != allowed:
        errors.append(f"{directory}: download list differs from allowlist")
    for entry in entries:
        p = base / entry["path"]
        data = p.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        blob = hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()
        if len(data) != entry["size_bytes"] or digest != entry["sha256"] or blob != entry["git_blob_sha1"]:
            errors.append(f"{p.relative_to(ROOT)}: size/hash mismatch")
        if entry["revision"] != REVISION or f"/resolve/{REVISION}/" not in entry["source_url"]:
            errors.append(f"{p.relative_to(ROOT)}: unpinned source")
        if p.suffix == ".json":
            json.loads(data)
        count += 1
        total += len(data)

ignored = {".git", "node_modules", "output", ".playwright-cli", ".dsh"}
for p in ROOT.rglob("*"):
    if not p.is_file() or ignored.intersection(p.relative_to(ROOT).parts):
        continue
    if re.search(r"\.(safetensors|bin|pt|pth|ckpt|gguf)$", p.name, re.I):
        errors.append(f"forbidden weight-like file: {p.relative_to(ROOT)}")
for forbidden in ("deepinfer", "csrc", "vendor", ".gitmodules"):
    if (ROOT / forbidden).exists():
        errors.append(f"unexpected engine source tree: {forbidden}")

if errors:
    print("\n".join(errors), file=sys.stderr)
    sys.exit(1)
print(f"Verified {count} pinned reference files ({total:,} bytes); no weights or DeepInfer source tree.")
