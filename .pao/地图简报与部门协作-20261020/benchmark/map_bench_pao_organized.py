"""兼容入口：导入时映射为 ``bench.map_bench_pao_organized`` 同一模块。"""

from __future__ import annotations

from pathlib import Path
import sys

_REPOSITORY = Path(__file__).resolve().parents[3]
if str(_REPOSITORY) not in sys.path:
    sys.path.insert(0, str(_REPOSITORY))

from bench import map_bench_pao_organized as _implementation

if __name__ != "__main__":
    sys.modules[__name__] = _implementation
