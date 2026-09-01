#!/usr/bin/env python3
import json
import os
import subprocess
import sys
from pathlib import Path


def resolve_manifest_path():
    configured = os.environ.get("FARAI_TOOL_MANIFEST")
    candidates = [
        Path(configured) if configured else None,
        Path("/usr/local/share/farai/farai-tool-manifest.json"),
        Path(__file__).with_name("farai-tool-manifest.json"),
    ]
    for candidate in candidates:
        if candidate is not None and candidate.is_file():
            return candidate
    raise FileNotFoundError("farai tool manifest not found")


MANIFEST_PATH = resolve_manifest_path()
MANIFEST = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
CONTRACT = MANIFEST["contract"]
APT_PACKAGES = tuple(MANIFEST["aptPackages"])
WORKFLOWS = MANIFEST["workflows"]
PINNED_TOOLS = MANIFEST["pinnedTools"]
PINNED_ASSETS = MANIFEST["pinnedAssets"]
REQUIRED = tuple(dict.fromkeys(command for commands in WORKFLOWS.values() for command in commands))


def installed_commands():
    commands = {}
    for directory in os.environ.get("PATH", "").split(os.pathsep):
        resolved = os.path.realpath(directory)
        if not resolved or not os.path.isdir(resolved):
            continue
        try:
            names = os.listdir(resolved)
        except OSError:
            continue
        for name in names:
            path = os.path.join(resolved, name)
            if name not in commands and os.path.isfile(path) and os.access(path, os.X_OK):
                commands[name] = path
    return commands


def missing_packages():
    missing = []
    for package in APT_PACKAGES:
        result = subprocess.run(
            ["dpkg-query", "-W", "-f=${Status}", package],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0 or result.stdout.strip() != "install ok installed":
            missing.append(package)
    return missing


commands = installed_commands()
missing = [name for name in REQUIRED if name not in commands]
missing_apt_packages = missing_packages()
missing_assets = [name for name, asset in PINNED_ASSETS.items() if not Path(asset["path"]).exists()]
payload = {
    "contract": CONTRACT,
    "manifest": str(MANIFEST_PATH),
    "inventoryCount": len(commands),
    "packageCount": len(APT_PACKAGES),
    "requiredCount": len(REQUIRED),
    "missing": missing,
    "missingPackages": missing_apt_packages,
    "missingAssets": missing_assets,
    "pinnedTools": PINNED_TOOLS,
    "pinnedAssets": PINNED_ASSETS,
    "workflows": WORKFLOWS,
}

if len(sys.argv) == 3 and sys.argv[1] == "--write":
    payload["commands"] = sorted(commands)
    destination = Path(sys.argv[2])
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n", encoding="utf-8")
else:
    print(json.dumps(payload, ensure_ascii=True, separators=(",", ":")))

raise SystemExit(0 if not missing and not missing_apt_packages and not missing_assets else 1)
