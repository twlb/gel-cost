#!/usr/bin/env python3
"""Read public cash USD/EUR/RUB quotes without accounts or browser automation.

BUY is the provider buying the customer's currency; snapshots are GEL per 1 unit.
Each failed provider keeps its own old timestamp and is explicitly unavailable.
"""
from __future__ import annotations

import json
import math
import re
import sys
from datetime import datetime, timezone
from decimal import Decimal
from html.parser import HTMLParser

from update_rates import ROOT, request, write_json_atomic
from update_bank_rates import fetch_reference, reference_value

OUTPUT = ROOT / "exchange-rates.json"
SOURCES = {"mjc": "https://mjc.ge/api/v1/exchange", "rico": "https://www.rico.ge/en/"}
CURRENCIES = ("USD", "EUR", "RUB")
DISPLAY_NOMINALS = {"USD": 1, "EUR": 1, "RUB": 100}
SOURCE_NOMINALS = {"mjc": {"USD": 1, "EUR": 1, "RUB": 1}, "rico": {"USD": 1, "EUR": 1, "RUB": 100}}
OUTPUTS = {"USD": OUTPUT, "EUR": ROOT / "exchange-rates-eur.json", "RUB": ROOT / "exchange-rates-rub.json"}


def decimal(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise ValueError("Unexpected rate type")
    if isinstance(value, str) and not re.fullmatch(r"\d+(?:\.\d+)?", value.strip()):
        raise ValueError("Unexpected numeric format")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("Non-finite rate")
    return result


def pair(buy, sell, currency="USD", source_nominal=1):
    if currency not in CURRENCIES or source_nominal not in (1, 100):
        raise ValueError("Unknown currency or source nominal")
    buy, sell = decimal(buy), decimal(sell)
    buy, sell = [float(Decimal(str(value)) / Decimal(source_nominal)) for value in (buy, sell)]
    display_nominal = DISPLAY_NOMINALS[currency]
    if not (0.5 / display_nominal <= buy <= sell <= 10 / display_nominal and sell / buy <= 1.3):
        raise ValueError("Invalid buy/sell pair")
    return buy, sell


def parse_mjc(body, currency="USD"):
    if currency not in CURRENCIES:
        raise ValueError("Unsupported currency")
    rows = json.loads(body)["currencies"][currency]
    nominal = SOURCE_NOMINALS["mjc"][currency]
    if not isinstance(rows, list) or len(rows) != 1 or rows[0].get("currency") != currency or decimal(rows[0].get("amount")) != nominal:
        raise ValueError("Ambiguous source nominal")
    return pair(rows[0]["buy"], rows[0]["sell"], currency, nominal)


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


def parse_rico(body, currency="USD"):
    if currency not in CURRENCIES:
        raise ValueError("Unsupported currency")
    parser = RicoTable()
    parser.feed(body.decode("utf-8")); parser.close()
    rows = [row for row in parser.rows if row and row[0] == currency]
    if len(rows) != 1:
        raise ValueError("Missing or ambiguous currency row")
    row = rows[0]
    nominal = SOURCE_NOMINALS["rico"][currency]
    if len(row) != 7 or row[1] != "Unit" or row[3] != "BUY" or row[5] != "SELL" or decimal(row[2]) != nominal:
        raise ValueError("Rico table layout or direction changed")
    return pair(row[4], row[6], currency, nominal)


def collect(fetch, now, previous=None, reference=None, currency="USD"):
    if currency not in CURRENCIES:
        raise ValueError("Unsupported currency")
    if previous and (previous.get("currency") != currency or previous.get("unit") != f"GEL per {currency}"):
        raise ValueError("Previous snapshot belongs to another currency")
    stamp = now.isoformat().replace("+00:00", "Z")
    past = {row["id"]: row for row in (previous or {}).get("offers", [])}
    offers, failures, reference_checked = [], [], False
    for provider, parser in (("mjc", parse_mjc), ("rico", parse_rico)):
        try:
            buy, sell = parser(fetch(SOURCES[provider]), currency)
            old = past.get(provider)
            if old and any(abs(new / decimal(old[key]) - 1) > 0.15 for new, key in ((buy, "buy"), (sell, "sell"))):
                raise ValueError("Abrupt change needs review")
            base = reference_value(reference, currency, now)
            if base is not None:
                if base <= 0 or abs(buy / base - 1) > 0.15:
                    raise ValueError("Disagrees with official reference")
                reference_checked = True
            offers.append({"id": provider, "buy": buy, "sell": sell, "nominal": 1, "sourceNominal": SOURCE_NOMINALS[provider][currency], "checkedAt": stamp, "sourceUpdatedAt": None})
        except Exception as exc:
            failures.append(provider)
            if provider in past: offers.append(past[provider])
            print(f"{provider}/{currency}: unavailable ({type(exc).__name__}: {exc})", file=sys.stderr)
    return {"schemaVersion": 1, "currency": currency, "unit": f"GEL per {currency}", "nominal": 1, "channel": "Cash", "side": "buy", "fetchedAt": stamp, "offers": offers, "failures": failures, "quality": {"officialReferenceChecked": reference_checked}}


def collect_all(fetch, now, previous=None, references=None):
    """Each public body is fetched once; parse failures remain currency-specific."""
    responses = {}
    for url in SOURCES.values():
        try:
            responses[url] = fetch(url)
        except Exception as exc:
            responses[url] = exc
    def cached_fetch(url):
        result = responses[url]
        if isinstance(result, Exception):
            raise result
        return result
    results = {}
    for currency in CURRENCIES:
        try:
            past = (previous or {}).get(currency)
            if isinstance(past, Exception):
                raise past
            results[currency] = collect(cached_fetch, now, past, (references or {}).get(currency), currency)
        except Exception as exc:
            results[currency] = exc
    return results


def main():
    previous = {}
    for currency, path in OUTPUTS.items():
        try:
            previous[currency] = json.loads(path.read_text()) if path.exists() else None
        except Exception as exc:
            previous[currency] = exc
    reference_path = ROOT / "rates.json"
    reference = json.loads(reference_path.read_text()) if reference_path.exists() else None
    now = datetime.now(timezone.utc)
    references = {"USD": reference, "RUB": reference}
    try:
        references["EUR"] = fetch_reference("EUR", now)
    except Exception as exc:
        print(f"EUR official reference unavailable: {exc}; reference check will be labelled false", file=sys.stderr)
    results = collect_all(request, now, previous, references)
    failed = False
    for currency, result in results.items():
        if isinstance(result, Exception):
            print(f"Cash {currency}: previous snapshot retained: {result}", file=sys.stderr)
            failed = True
            continue
        write_json_atomic(OUTPUTS[currency], result)
        print(f"Cash {currency} sources: {2-len(result['failures'])}/2 available")
        failed = failed or bool(result["failures"])
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
