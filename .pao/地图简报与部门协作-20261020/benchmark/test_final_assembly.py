"""兼容测试入口：映射到 ``bench.tests.test_final_assembly``，不复制测试实现。"""

from __future__ import annotations

from pathlib import Path
import sys
import unittest

_REPOSITORY = Path(__file__).resolve().parents[3]
if str(_REPOSITORY) not in sys.path:
    sys.path.insert(0, str(_REPOSITORY))

from bench.tests import test_final_assembly as _implementation


if __name__ != "__main__":
    sys.modules[__name__] = _implementation
else:
    unittest.main(module=_implementation)
