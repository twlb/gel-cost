"""Inteli rollout: strict parsing, per-currency isolation, old snapshot compatibility."""
import json
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import update_exchange_rates as offices
from test_multicurrency import mjc, rico


def inteli():
    return ('<table><thead><tr><th><center><i></i> ვალუტის სტანდარტული კურსები</center></th></tr></thead>'
            '<tbody><tr><td>GEL</td><td>USD</td><td>2.609</td><td>2.614</td></tr>'
            '<tr><td>EUR</td><td>USD</td><td>1.160</td><td>1.164</td></tr>'
            '<tr><td>GEL</td><td>EUR</td><td>3.027</td><td>3.040</td></tr>'
            '<tr><td>GEL</td><td>RUB</td><td>0.027</td><td>0.030</td></tr></tbody></table>').encode()


def fetch(url):
    return inteli() if url == offices.INTELI_SOURCE else mjc() if "mjc" in url else rico()


class InteliTests(unittest.TestCase):
    def test_standard_pairs_are_not_cross_pairs(self):
        for code, expected in (("USD", (2.609, 2.614)), ("EUR", (3.027, 3.04)), ("RUB", (.027, .03))):
            self.assertEqual(offices.parse_inteli(inteli(), code), expected)
        self.assertEqual(offices.parse_inteli(b'<script>GEL USD 9 10</script><!--bad-->' + inteli()), (2.609, 2.614))

    def test_missing_duplicate_changed_and_invalid_rows_fail_closed(self):
        cases = [inteli() * 2, inteli().replace(b"<td>USD</td>", b"<td>GBP</td>"),
                 inteli().replace(b"2.609", b"NaN"), inteli().replace(b"2.609", b"2,609"),
                 inteli().replace(b"2.609", b"2.7"), inteli().replace(b"2.609", b"0"),
                 inteli().replace(b"</table>", b""), inteli().replace(b"2.609", b"2.609</td><td>1"),
                 inteli().replace("სტანდარტული".encode(), b"changed")]
        for body in cases:
            with self.subTest(body=body), self.assertRaises(ValueError): offices.parse_inteli(body)
        with self.assertRaises(ValueError): offices.parse_inteli(inteli(), "USDT")
        with self.assertRaises(ValueError): offices.parse_inteli(inteli().replace(b"0.027", b"2.7"), "RUB")

    def test_one_fetch_per_source_and_legacy_upgrade(self):
        now = datetime.now(timezone.utc)
        old = offices.collect_all(fetch, now)
        calls = []
        def record(url):
            calls.append(url)
            return fetch(url)
        new = offices.collect_all(record, now, old, include_inteli=True)
        self.assertEqual(len(calls), 3)
        self.assertEqual(len(set(calls)), 3)
        for code in offices.CURRENCIES:
            self.assertEqual(old[code]["schemaVersion"], 1)
            self.assertEqual(new[code]["schemaVersion"], 2)
            self.assertEqual(new[code]["failures"], [])
            self.assertEqual(len(new[code]["offers"]), 3)
            self.assertEqual(new[code]["offers"][-1]["sourceNominal"], 1)

    def test_outage_keeps_timestamp_and_others_work(self):
        now = datetime.now(timezone.utc)
        old = offices.collect_all(fetch, now, include_inteli=True)
        def fail(url):
            if url == offices.INTELI_SOURCE: raise OSError("offline")
            return fetch(url)
        new = offices.collect_all(fail, now + timedelta(minutes=30), old, include_inteli=True)
        for code in offices.CURRENCIES:
            self.assertEqual(new[code]["failures"], ["inteli"])
            self.assertEqual(new[code]["offers"][-1], old[code]["offers"][-1])
            self.assertNotEqual(new[code]["offers"][0]["checkedAt"], old[code]["offers"][0]["checkedAt"])
        first = offices.collect_all(fail, now, include_inteli=True)
        self.assertEqual(len(first["USD"]["offers"]), 2)

    def test_currency_loss_and_abrupt_change_are_isolated(self):
        now = datetime.now(timezone.utc)
        old = offices.collect_all(fetch, now, include_inteli=True)
        for body in (inteli().replace(b"<td>RUB</td>", b"<td>RUR</td>"),
                     inteli().replace(b"0.027", b"0.04").replace(b"0.030", b"0.041")):
            new = offices.collect_all(lambda url: body if url == offices.INTELI_SOURCE else fetch(url),
                                      now, old, include_inteli=True)
            self.assertEqual(new["RUB"]["failures"], ["inteli"])
            self.assertEqual(new["USD"]["failures"], [])
            self.assertEqual(new["EUR"]["failures"], [])


if __name__ == "__main__": unittest.main()
