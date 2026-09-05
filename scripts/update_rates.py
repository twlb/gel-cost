#!/usr/bin/env python3
"""Fetch official USD/RUB and USD/GEL rates and write rates.json."""

from __future__ import annotations

import json
import math
import os
import sys
import tempfile
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "rates.json"
CBR_URL = "https://www.cbr.ru/scripts/XML_daily.asp"
NBG_URL = "https://services.nbg.gov.ge/Rates/Service.asmx"
USER_AGENT = "gel-cost-rates/1.0 (+https://github.com/twlb/gel-cost)"


def request(url: str, *, data: bytes | None = None, headers: dict[str, str] | None = None) -> bytes:
    merged = {"User-Agent": USER_AGENT, **(headers or {})}
    req = urllib.request.Request(url, data=data, headers=merged)
    with urllib.request.urlopen(req, timeout=20) as response:
        body = response.read(2_000_001)
        if len(body) > 2_000_000:
            raise ValueError("Source response exceeds the size limit")
        return body


def write_json_atomic(path: Path, payload: dict) -> None:
    """Replace a snapshot only after collection and validation succeeded."""
    encoded = json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as output:
        temporary = Path(output.name)
        try:
            output.write(encoded)
            output.flush()
            os.fsync(output.fileno())
            output.close()
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def iso_date(value: str) -> str:
    for pattern in ("%d.%m.%Y", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            parsed = datetime.strptime(value[:19], pattern)
            return parsed.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
        except ValueError:
            continue
    raise ValueError(f"Unsupported source date: {value!r}")


def fetch_cbr() -> tuple[float, str]:
    # Request the effective local date explicitly, not a future published rate.
    date = datetime.now(ZoneInfo("Europe/Moscow")).strftime("%d/%m/%Y")
    root = ET.fromstring(request(CBR_URL + "?date_req=" + date))
    for item in root.findall("Valute"):
        if item.findtext("CharCode") == "USD":
            nominal = float(item.findtext("Nominal", "1"))
            value = float(item.findtext("Value", "0").replace(",", "."))
            if nominal > 0 and value > 0:
                return value / nominal, iso_date(root.attrib["Date"])
    raise RuntimeError("USD is missing from the CBR response")


def fetch_nbg() -> tuple[float, str]:
    body = b'''<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetCurrentRates xmlns="http://www.nbg.ge/">
      <Currencies>USD</Currencies>
    </GetCurrentRates>
  </soap:Body>
</soap:Envelope>'''
    xml = request(
        NBG_URL,
        data=body,
        headers={
            "Content-Type": "text/xml; charset=utf-8",
            "SOAPAction": "http://www.nbg.ge/GetCurrentRates",
        },
    )
    root = ET.fromstring(xml)
    for item in root.iter():
        children = {child.tag.rsplit("}", 1)[-1]: child.text for child in item}
        if children.get("Code") == "USD":
            quantity = float(children.get("Quantity") or 1)
            rate = float(children.get("Rate") or 0)
            source_date = children.get("ValidFromDate") or children.get("Date") or ""
            if quantity > 0 and rate > 0:
                return rate / quantity, iso_date(source_date)
    raise RuntimeError("USD is missing from the NBG response")


def make_payload(usd_rub: float, cbr_date: str, usd_gel: float, nbg_date: str, now: datetime) -> dict:
    if not (math.isfinite(usd_rub) and math.isfinite(usd_gel) and 1 <= usd_rub <= 1000 and 0.5 <= usd_gel <= 10):
        raise ValueError("Official rate is outside validation limits")
    today = now.astimezone(ZoneInfo("Asia/Tbilisi")).date()
    for source_date in (cbr_date, nbg_date):
        effective = datetime.fromisoformat(source_date.replace("Z", "+00:00")).date()
        if effective > today or (today - effective).days > 14:
            raise ValueError("Official source date is invalid, future, or too old")
    # Preserve both effective dates; never label both sources with the newer one.
    updated_at = min(cbr_date, nbg_date)
    payload = {
        "usdRub": round(usd_rub, 6),
        "usdGel": round(usd_gel, 6),
        "updatedAt": updated_at,
        "fetchedAt": now.isoformat().replace("+00:00", "Z"),
        "sources": {
            "usdRub": {"name": "Банк России", "url": CBR_URL, "date": cbr_date},
            "usdGel": {"name": "Национальный банк Грузии", "url": NBG_URL, "date": nbg_date},
        },
    }
    return payload


def main() -> int:
    usd_rub, cbr_date = fetch_cbr()
    usd_gel, nbg_date = fetch_nbg()
    payload = make_payload(usd_rub, cbr_date, usd_gel, nbg_date, datetime.now(timezone.utc))
    write_json_atomic(OUTPUT, payload)
    print(f"USD/RUB={usd_rub:.4f}; USD/GEL={usd_gel:.4f}; dates={cbr_date}, {nbg_date}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Rate update failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
