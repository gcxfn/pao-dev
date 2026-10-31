"""`python -m bench` 的唯一显式入口。"""

from .cli import main


if __name__ == "__main__":
    raise SystemExit(main())
