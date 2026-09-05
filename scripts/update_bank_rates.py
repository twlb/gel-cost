#!/usr/bin/env python3
"""Collect the public NBG bank table, never browser sessions or personal data."""
from __future__ import annotations

import json
import math
import statistics
import sys
from datetime import datetime, timezone
from urllib.parse import urlencode

from update_rates import ROOT, request, write_json_atomic

API = "https://tariffcompare.nbg.gov.ge/api/"
OUTPUT = ROOT / "market-rates.json"


def get_json(path: str):
    # The source requires a locale; without one it can return HTTP 500.
    return json.loads(request(API + path, headers={"Accept-Language": "en-US,en;q=0.9", "Accept": "application/json"}))


def numeric(value) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("Rate must be a finite JSON number")
    return float(value)


def normalize(rows: list, currencies: list, subjects: list, now: datetime, previous: dict | None = None, reference: dict | None = None) -> dict:
    usd = [c for c in currencies if c.get("code") == "USD" and c.get("isActive") is True]
    if len(usd) != 1 or numeric(usd[0].get("kCoeficient")) != 1:
        raise ValueError("Unexpected USD nominal or currency metadata")
    if not isinstance(rows, list) or not rows:
        raise ValueError("No bank rates returned")
    names = {s["name"]: str(s["id"]) for s in subjects if isinstance(s, dict) and isinstance(s.get("name"), str) and isinstance(s.get("id"), int)}
    if len(names) < 3:
        raise ValueError("Insufficient bank identity metadata")
    offers, seen, rejected = [], set(), []
    for row in rows:
        name = row.get("name") if isinstance(row, dict) else None
        if name not in names or names[name] in seen:
            raise ValueError("Unknown or duplicate bank identity")
        seen.add(names[name])
        branches = [x for x in row.get("exchanges", []) if x.get("exchangeType") == "Branch"]
        if len(branches) != 1:
            rejected.append(name)
            continue
        values = branches[0].get("exchangeRates", [])
        try:
            buys = [numeric(x.get("value")) for x in values if x.get("operationType") == "Buy"]
            sells = [numeric(x.get("value")) for x in values if x.get("operationType") == "Sell"]
            if len(buys) != 1 or len(sells) != 1:
                raise ValueError("Ambiguous buy/sell pair")
            buy, sell = buys[0], sells[0]
            if not (0.5 <= buy <= sell <= 10 and sell / buy <= 1.3):
                raise ValueError("Invalid buy/sell spread")
            offers.append({"id": names[name], "bank": name, "buy": buy, "sell": sell, "sourceUpdatedAt": None})
        except ValueError:
            rejected.append(name)
    if len(offers) < 3:
        raise ValueError("Fewer than three valid banks; retaining previous snapshot")
    median = statistics.median(o["buy"] for o in offers)
    if any(abs(o["buy"] / median - 1) > 0.15 for o in offers):
        raise ValueError("Cross-bank outlier; retaining previous snapshot")
    reference_checked = False
    if reference and reference.get("fetchedAt"):
        checked = datetime.fromisoformat(reference["fetchedAt"].replace("Z", "+00:00"))
        if 0 <= (now - checked).total_seconds() <= 2 * 86400:
            base = numeric(reference["usdGel"])
            if base <= 0 or any(abs(o["buy"] / base - 1) > 0.15 for o in offers):
                raise ValueError("Quotes disagree with the official reference; retaining previous snapshot")
            reference_checked = True
    if previous:
        past = {o["id"]: o for o in previous.get("offers", [])}
        for offer in offers:
            old = past.get(offer["id"])
            if old and (abs(offer["buy"] / numeric(old["buy"]) - 1) > 0.15 or abs(offer["sell"] / numeric(old["sell"]) - 1) > 0.15):
                raise ValueError("Abrupt rate change requires review; retaining previous snapshot")
    return {
        "schemaVersion": 1, "currency": "USD", "unit": "GEL per USD",
        "channel": "Branch", "userType": "PhysicalPerson", "queryAmountGel": 1000,
        "fetchedAt": now.isoformat().replace("+00:00", "Z"),
        "source": {"name": "Банковская витрина НБГ", "url": "https://nbg.gov.ge/en/currency-rates", "api": API + "Exchanges/get-exchanges"},
        "offers": sorted(offers, key=lambda o: (-o["buy"], o["bank"])),
        "quality": {"minimumBanks": 3, "rejectedCount": len(rejected), "officialReferenceChecked": reference_checked},
    }


def main() -> int:
    now = datetime.now(timezone.utc)
    currencies, subjects = get_json("Currency/currencies"), get_json("Subject/get-subjects")
    usd = [c for c in currencies if c.get("code") == "USD" and c.get("isActive") is True]
    if len(usd) != 1:
        raise ValueError("USD not found")
    params = urlencode({"currencyId": usd[0]["id"], "amount": 1000, "userType": "PhysicalPerson", "operationType": "Buy", "exchangeType": "Branch", "datetime": now.isoformat().replace("+00:00", "Z")})
    rows = get_json("Exchanges/get-exchanges?" + params)
    previous = json.loads(OUTPUT.read_text(encoding="utf-8")) if OUTPUT.exists() else None
    reference_path = ROOT / "rates.json"
    reference = json.loads(reference_path.read_text(encoding="utf-8")) if reference_path.exists() else None
    payload = normalize(rows, currencies, subjects, now, previous, reference)
    write_json_atomic(OUTPUT, payload)
    print(f"Validated {len(payload['offers'])} bank branch quotes; rejected {payload['quality']['rejectedCount']}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Bank rate update failed; previous snapshot retained: {exc}", file=sys.stderr)
        raise SystemExit(1)
