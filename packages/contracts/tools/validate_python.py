from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path


contracts_path = (
    Path(__file__).parents[1] / "generated" / "python" / "contracts.py"
)
spec = importlib.util.spec_from_file_location("symphony_contracts", contracts_path)
if spec is None or spec.loader is None:
    raise RuntimeError("unable to load generated Python contracts")
contracts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contracts)


def load_fixtures(directory: str) -> list[tuple[Path, dict[str, object]]]:
    return [
        (path, json.loads(path.read_text()))
        for path in sorted(Path(directory).glob("*.json"))
    ]


for _, fixture in load_fixtures(sys.argv[1]):
    contracts.decode_contract(fixture["schema"], fixture["value"])

for fixture_path, fixture in load_fixtures(sys.argv[2]):
    try:
        contracts.decode_contract(fixture["schema"], fixture["value"])
    except ValueError:
        continue
    raise ValueError(f"invalid fixture was accepted: {fixture_path}")
