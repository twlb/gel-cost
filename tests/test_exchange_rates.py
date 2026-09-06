import json
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from update_exchange_rates import collect, parse_mjc, parse_rico


def mjc(**changes):
    row = {"currency": "USD", "buy": "2.61300", "sell": "2.61600", "amount": 1}
    row.update(changes)
    return json.dumps({"currencies": {"USD": [row]}}).encode()


def rico(currency="USD", unit="1", buy="2.6100", sell="2.6150"):
    return (f'<section><div class="currencies-table-body"><div class="currency-row">'
            f'<div class="currency-info"><strong>{currency}</strong></div>'
            f'<div class="currency-unit"><span>Unit</span><strong>{unit}</strong></div>'
            f'<div class="currency-rate"><span>BUY</span><strong>{buy}</strong></div>'
            f'<div class="currency-rate"><span>SELL</span><strong>{sell}</strong></div>'
            f'</div></div></section>').encode()


class ExchangeTests(unittest.TestCase):
    def test_buy_direction_and_nominal(self):
        self.assertEqual(parse_mjc(mjc()), (2.613, 2.616))
        self.assertEqual(parse_rico(rico()), (2.61, 2.615))

    def test_mjc_rejects_ambiguous_or_invalid_data(self):
        for changes in ({"amount": 100}, {"amount": True}, {"currency": "EUR"}, {"buy": "NaN"},
                        {"buy": 0}, {"buy": 2.7}, {"sell": "2.61 RUB"}, {"buy": True}):
            with self.subTest(changes=changes), self.assertRaises((ValueError, TypeError)):
                parse_mjc(mjc(**changes))
        raw = json.loads(mjc()); raw["currencies"]["USD"] *= 2
        with self.assertRaises(ValueError): parse_mjc(json.dumps(raw))

    def test_rico_requires_exact_usd_not_cross_pair(self):
        self.assertEqual(parse_rico(rico("USD-EUR", buy=".9", sell="1.1") + rico()), (2.61, 2.615))
        with self.assertRaises(ValueError): parse_rico(rico("USD-EUR"))
        with self.assertRaises(ValueError): parse_rico(rico() + rico())

    def test_rico_changed_order_and_layout_fail_closed(self):
        for body in (rico(unit="100"), rico(buy="NaN"), rico(buy="2.8"),
                     rico().replace(b"BUY", b"SELL"), rico().replace(b"Unit", b"Amount"),
                     rico().replace(b"currency-row", b"new-row")):
            with self.subTest(body=body), self.assertRaises(ValueError): parse_rico(body)

    def test_script_comment_and_other_currencies_cannot_be_quotes(self):
        junk = b'<script>USD Unit 1 BUY 9 SELL 10</script><!-- USD Unit 1 BUY 8 SELL 9 -->'
        self.assertEqual(parse_rico(junk + rico("EUR") + rico()), (2.61, 2.615))

    def test_partial_failure_keeps_own_date_and_does_not_block_other_source(self):
        now = datetime.now(timezone.utc)
        first = collect(lambda url: mjc() if "mjc" in url else rico(), now)
        def fetch(url):
            if "mjc" in url: raise OSError("unavailable")
            return rico(buy="2.611")
        later = collect(fetch, now + timedelta(minutes=30), first)
        self.assertEqual(later["failures"], ["mjc"])
        self.assertEqual(later["offers"][0], first["offers"][0])
        self.assertNotEqual(later["offers"][1]["checkedAt"], first["offers"][1]["checkedAt"])
        self.assertEqual(later["offers"][1]["buy"], 2.611)

    def test_missing_source_has_failure_not_invented_quote(self):
        def fail(url): raise OSError("offline")
        data = collect(fail, datetime.now(timezone.utc))
        self.assertEqual(data["offers"], [])
        self.assertEqual(data["failures"], ["mjc", "rico"])

    def test_jump_and_reference_mismatch_are_quarantined(self):
        now = datetime.now(timezone.utc)
        old = collect(lambda url: mjc() if "mjc" in url else rico(), now)
        jumped = collect(lambda url: mjc(buy="4", sell="4.1") if "mjc" in url else rico(), now, old)
        self.assertEqual(jumped["failures"], ["mjc"])
        self.assertEqual(jumped["offers"][0]["buy"], 2.613)
        reference = {"fetchedAt": now.isoformat(), "usdGel": 4}
        quarantined = collect(lambda url: mjc() if "mjc" in url else rico(), now, reference=reference)
        self.assertEqual(quarantined["failures"], ["mjc", "rico"])
