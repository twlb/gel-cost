#!/usr/bin/env python3
"""Read two public cash USD quotes. No accounts, cookies or browser automation.

BUY is the provider buying the customer's USD; all values are GEL per 1 USD.
Each failed provider keeps its own old timestamp and is explicitly unavailable.
"""
from __future__ import annotations

import json
import math
import re
import sys
from datetime import datetime, timezone
from html.parser import HTMLParser

from update_rates import ROOT, request, write_json_atomic

OUTPUT = ROOT / "exchange-rates.json"
SOURCES = {"mjc": "https://mjc.ge/api/v1/exchange", "rico": "https://www.rico.ge/en/"}


def decimal(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise ValueError("Unexpected rate type")
    if isinstance(value, str) and not re.fullmatch(r"\d+(?:\.\d+)?", value.strip()):
        raise ValueError("Unexpected numeric format")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("Non-finite rate")
    return result


def pair(buy, sell):
    buy, sell = decimal(buy), decimal(sell)
    if not (0.5 <= buy <= sell <= 10 and sell / buy <= 1.3):
        raise ValueError("Invalid buy/sell pair")
    return buy, sell


def parse_mjc(body):
    rows = json.loads(body)["currencies"]["USD"]
    if not isinstance(rows, list) or len(rows) != 1 or rows[0].get("currency") != "USD" or decimal(rows[0].get("amount")) != 1:
        raise ValueError("Ambiguous USD nominal")
    return pair(rows[0]["buy"], rows[0]["sell"])


class RicoTable(HTMLParser):
    def __init__(self):
        super().__init__()
        self.depth = 0
        self.row_depth = None
        self.row = []
        self.rows = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style"}: self.skip += 1
        if tag == "div":
            self.depth += 1
            if "currency-row" in dict(attrs).get("class", "").split():
                if self.row_depth is not None: raise ValueError("Nested rate row")
                self.row_depth = self.depth
                self.row = []

    def handle_endtag(self, tag):
        if tag in {"script", "style"}: self.skip = max(0, self.skip - 1)
        if tag == "div":
            if self.row_depth == self.depth:
                self.rows.append(self.row)
                self.row_depth = None
            self.depth -= 1

    def handle_data(self, data):
        if self.row_depth is not None and not self.skip and data.strip():
            self.row.append(data.strip())


def parse_rico(body):
    parser = RicoTable()
    parser.feed(body.decode("utf-8")); parser.close()
    rows = [row for row in parser.rows if row and row[0] == "USD"]
    if len(rows) != 1:
        raise ValueError("Missing or ambiguous USD row")
    row = rows[0]
    if len(row) != 7 or row[1] != "Unit" or row[3] != "BUY" or row[5] != "SELL" or decimal(row[2]) != 1:
        raise ValueError("Rico table layout or direction changed")
    return pair(row[4], row[6])


def collect(fetch, now, previous=None, reference=None):
    stamp = now.isoformat().replace("+00:00", "Z")
    past = {row["id"]: row for row in (previous or {}).get("offers", [])}
    offers, failures = [], []
    for provider, parser in (("mjc", parse_mjc), ("rico", parse_rico)):
        try:
            buy, sell = parser(fetch(SOURCES[provider]))
            old = past.get(provider)
            if old and any(abs(new / decimal(old[key]) - 1) > 0.15 for new, key in ((buy, "buy"), (sell, "sell"))):
                raise ValueError("Abrupt change needs review")
            if reference and reference.get("fetchedAt"):
                age = (now - datetime.fromisoformat(reference["fetchedAt"].replace("Z", "+00:00"))).total_seconds()
                if 0 <= age <= 172800 and abs(buy / decimal(reference["usdGel"]) - 1) > 0.15:
                    raise ValueError("Disagrees with official reference")
            offers.append({"id": provider, "buy": buy, "sell": sell, "nominal": 1, "checkedAt": stamp, "sourceUpdatedAt": None})
        except Exception as exc:
            failures.append(provider)
            if provider in past: offers.append(past[provider])
            print(f"{provider}: unavailable ({type(exc).__name__}: {exc})", file=sys.stderr)
    return {"schemaVersion": 1, "currency": "USD", "unit": "GEL per USD", "channel": "Cash", "side": "buy", "fetchedAt": stamp, "offers": offers, "failures": failures}


def main():
    previous = json.loads(OUTPUT.read_text()) if OUTPUT.exists() else None
    reference_path = ROOT / "rates.json"
    reference = json.loads(reference_path.read_text()) if reference_path.exists() else None
    result = collect(request, datetime.now(timezone.utc), previous, reference)
    write_json_atomic(OUTPUT, result)
    print(f"Cash USD sources: {2-len(result['failures'])}/2 available")
    return 1 if result["failures"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
