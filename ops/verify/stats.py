#!/usr/bin/env python3
"""A07 最近秩百分位数与丢包率参考实现。"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path


def nearest_rank(values: list[float], percentile: float) -> float:
    if not values or not 0 < percentile <= 1:
        raise ValueError("non-empty values and percentile in (0,1] required")
    ordered = sorted(values)
    return ordered[math.ceil(percentile * len(ordered)) - 1]


def loss_ratio(received_delta: int, lost_delta: int) -> float:
    denominator = received_delta + lost_delta
    if received_delta < 0 or lost_delta < 0 or denominator <= 0:
        raise ValueError("non-negative deltas with a positive denominator required")
    return lost_delta / denominator


def main() -> int:
    fixture = Path(sys.argv[1])
    data = json.loads(fixture.read_text(encoding="utf-8"))
    actual = {
        "nearestRankP95Ms": nearest_rank(data["samplesMs"], 0.95),
        "lossRatio": loss_ratio(data["receivedDelta"], data["lostDelta"]),
    }
    valid = actual["nearestRankP95Ms"] == data["expectedNearestRankP95Ms"] and actual["lossRatio"] == data["expectedLossRatio"]
    print(json.dumps({"valid": valid, **actual}, indent=2, sort_keys=True))
    return 0 if valid else 1


if __name__ == "__main__":
    raise SystemExit(main())

