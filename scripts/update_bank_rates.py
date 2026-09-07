#!/usr/bin/env python3
"""Collect the public NBG bank table, never browser sessions or personal data."""
from __future__ import annotations

import json
import math
import statistics
import sys
from datetime import datetime, timezone
from decimal import Decimal
from urllib.parse import urlencode

from update_rates import ROOT, request, write_json_atomic

API = "https://tariffcompare.nbg.gov.ge/api/"
OUTPUT = ROOT / "market-rates.json"
# RUB metadata is understood, but its much wider bank spreads need a separate
# product/quality decision. Do not request or publish a pretend-empty RUB table.
BANK_CURRENCIES = ("USD", "EUR")
SOURCE_NOMINALS = {"USD": 1, "EUR": 1, "RUB": 100}
OUTPUTS = {"USD": OUTPUT, "EUR": ROOT / "market-rates-eur.json"}


def get_json(path: str):
    # The source requires a locale; without one it can return HTTP 500.
    return json.loads(request(API + path, headers={"Accept-Language": "en-US,en;q=0.9", "Accept": "application/json"}))


def numeric(value) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("Rate must be a finite JSON number")
    return float(value)


def reference_value(reference: dict | None, currency: str, now: datetime) -> float | None:
    """A reference is checked only for its own currency and observation time."""
    if not reference or not reference.get("fetchedAt"):
        return None
    checked = datetime.fromisoformat(reference["fetchedAt"].replace("Z", "+00:00"))
    if not 0 <= (now - checked).total_seconds() <= 2 * 86400:
        return None
    if currency == "USD" and "usdGel" in reference:
        return numeric(reference["usdGel"])
    if reference.get("currency") == currency:
        if reference.get("unit") != f"GEL per {currency}" or reference.get("nominal") != 1:
            raise ValueError("Reference nominal is not normalized")
        return numeric(reference["rate"])
    if currency == "RUB" and "usdGel" in reference and "usdRub" in reference:
        gel, rub = numeric(reference["usdGel"]), numeric(reference["usdRub"])
        if not (gel > 0 and rub > 0):
            raise ValueError("Invalid official cross reference")
        return float(Decimal(str(gel)) / Decimal(str(rub)))
    return None


def fetch_reference(currency: str, now: datetime) -> dict:
    """Read the current NBG table used by the public page; no invented date."""
    if currency not in SOURCE_NOMINALS:
        raise ValueError("Unsupported reference currency")
    path = "Exchanges/nbg-exchanges?" + urlencode({"codes": currency})
    rows = get_json(path)
    if not isinstance(rows, list) or len(rows) != 1 or rows[0].get("code") != currency:
        raise ValueError("Missing or ambiguous current NBG reference")
    nominal, rate = numeric(rows[0].get("quantity")), numeric(rows[0].get("rate"))
    if nominal != SOURCE_NOMINALS[currency] or rate <= 0:
        raise ValueError("Unexpected current NBG reference nominal")
    return {"currency": currency, "unit": f"GEL per {currency}", "nominal": 1,
            "sourceNominal": nominal, "rate": float(Decimal(str(rate)) / Decimal(str(nominal))),
            "fetchedAt": now.isoformat().replace("+00:00", "Z"), "sourceUpdatedAt": None, "source": API + path}


def normalize(rows: list, currencies: list, subjects: list, now: datetime, previous: dict | None = None, reference: dict | None = None, currency: str = "USD") -> dict:
    if currency not in SOURCE_NOMINALS:
        raise ValueError("Unsupported currency")
    selected = [c for c in currencies if c.get("code") == currency and c.get("isActive") is True]
    nominal = SOURCE_NOMINALS[currency]
    if len(selected) != 1 or numeric(selected[0].get("kCoeficient")) != nominal:
        raise ValueError("Unexpected currency nominal or metadata")
    if previous and (previous.get("currency") != currency or previous.get("unit") != f"GEL per {currency}"):
        raise ValueError("Previous snapshot belongs to another currency")
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
            buy, sell = [float(Decimal(str(value)) / Decimal(nominal)) for value in (buys[0], sells[0])]
            if not (0.5 / nominal <= buy <= sell <= 10 / nominal and sell / buy <= 1.3):
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
    base = reference_value(reference, currency, now)
    if base is not None:
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
        "schemaVersion": 1, "currency": currency, "unit": f"GEL per {currency}", "nominal": 1, "sourceNominal": nominal,
        "channel": "Branch", "userType": "PhysicalPerson", "queryAmountGel": 1000,
        "fetchedAt": now.isoformat().replace("+00:00", "Z"),
        "source": {"name": "Банковская витрина НБГ", "url": "https://nbg.gov.ge/en/currency-rates", "api": API + "Exchanges/get-exchanges"},
        "offers": sorted(offers, key=lambda o: (-o["buy"], o["bank"])),
        "quality": {"minimumBanks": 3, "rejectedCount": len(rejected), "officialReferenceChecked": reference_checked},
    }


def main() -> int:
    now = datetime.now(timezone.utc)
    currencies, subjects = get_json("Currency/currencies"), get_json("Subject/get-subjects")
    reference_path = ROOT / "rates.json"
    reference = json.loads(reference_path.read_text(encoding="utf-8")) if reference_path.exists() else None
    references = {"USD": reference}
    try:
        references["EUR"] = fetch_reference("EUR", now)
    except Exception as exc:
        print(f"EUR official reference unavailable: {exc}; reference check will be labelled false", file=sys.stderr)
    failures = []
    for currency in BANK_CURRENCIES:
        output = OUTPUTS[currency]
        previous = None
        try:
            previous = json.loads(output.read_text(encoding="utf-8")) if output.exists() else None
            selected = [c for c in currencies if c.get("code") == currency and c.get("isActive") is True]
            if len(selected) != 1:
                raise ValueError(f"{currency} not found")
            params = urlencode({"currencyId": selected[0]["id"], "amount": 1000, "userType": "PhysicalPerson", "operationType": "Buy", "exchangeType": "Branch", "datetime": now.isoformat().replace("+00:00", "Z")})
            rows = get_json("Exchanges/get-exchanges?" + params)
            payload = normalize(rows, currencies, subjects, now, previous, references.get(currency), currency)
            write_json_atomic(output, payload)
            print(f"{currency}: validated {len(payload['offers'])} bank branch quotes; rejected {payload['quality']['rejectedCount']}")
        except Exception as exc:
            failures.append(currency)
            # Do not relabel the previous rates as newly checked. EUR additionally
            # signals a failed attempt to new clients; legacy USD output is retained.
            if currency != "USD" and isinstance(previous, dict) and previous:
                write_json_atomic(output, {**previous, "refreshFailed": True, "lastAttemptAt": now.isoformat().replace("+00:00", "Z")})
            print(f"{currency}: previous bank snapshot retained: {exc}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Bank rate update failed; previous snapshot retained: {exc}", file=sys.stderr)
        raise SystemExit(1)
