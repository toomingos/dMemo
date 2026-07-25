"""``dmemo-hermes-install`` — drop the plugin into ``$HERMES_HOME/plugins/dmemo``.

Hermes discovers user plugins by scanning that directory, so installing the
pip package is not enough on its own; two small files have to land there.
Doing it by hand is three lines of ``cp`` with a path nobody can remember,
which is exactly the kind of step that gets done wrong once and then
silently means "memory never loaded".
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_SOURCE = _HERE / "hermes_plugin"


def default_hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))


def install(hermes_home: Path, *, force: bool = False) -> Path:
    target = hermes_home / "plugins" / "dmemo"
    if target.exists() and not force:
        existing = sorted(p.name for p in target.iterdir())
        print(f"{target} already exists ({', '.join(existing) or 'empty'}); re-run with --force to overwrite")
        return target

    target.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(_SOURCE / "plugin_entry.py", target / "__init__.py")
    shutil.copyfile(_SOURCE / "plugin.yaml", target / "plugin.yaml")
    return target


def main(argv: list | None = None) -> int:
    parser = argparse.ArgumentParser(prog="dmemo-hermes-install", description=__doc__)
    parser.add_argument("--hermes-home", type=Path, default=None)
    parser.add_argument("--force", action="store_true", help="overwrite an existing install")
    args = parser.parse_args(argv)

    home = args.hermes_home or default_hermes_home()
    if not home.exists():
        print(f"HERMES_HOME does not exist: {home}", file=sys.stderr)
        print("Run Hermes once first, or pass --hermes-home.", file=sys.stderr)
        return 1

    target = install(home, force=args.force)
    print(f"installed dmemo plugin -> {target}")
    print()
    print("Next:")
    print(f"  1. enable it in {home / 'config.yaml'}:")
    print("       memory:\n         provider: dmemo")
    print("       plugins:\n         enabled: [dmemo]")
    print("  2. set DMEMO_PRIVATE_KEY (or run `npx dmemo connect`)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
