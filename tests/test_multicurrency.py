"""Isolated V5.7 source/nominal regressions; no network or user storage."""
import copy
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import update_bank_rates as banks
import update_exchange_rates as offices

NOW = datetime(2026, 9, 7, 16, tzinfo=timezone.utc)
META = [{"id": ident, "code": code, "isActive": True, "kCoeficient": nominal}
        for ident, code, nominal in ((5, "USD", 1), (6, "EUR", 1), (126, "RUB", 100))]
SUBJECTS = [{"id": i, "name": f"Bank {i}"} for i in range(1, 5)]
PAIRS = {"USD": ("2.61000", "2.61400"), "EUR": ("3.03100", "3.03600"), "RUB": ("0.02925", "0.02940")}


def mjc():
    return json.dumps({"currencies": {code: [{"currency": code, "buy": pair[0], "sell": pair[1], "amount": 1}]
                                     for code, pair in PAIRS.items()}}).encode()


def rico_row(code, nominal, buy, sell):
    return (f'<div class="currency-row"><div>{code}</div><div>Unit</div><div>{nominal}</div>'
            f'<div>BUY</div><div>{buy}</div><div>SELL</div><div>{sell}</div></div>').encode()


def rico():
    return b"".join((rico_row("USD", 1, "2.6090", "2.6140"), rico_row("EUR", 1, "3.0320", "3.0420"),
                     rico_row("RUB", 100, "2.6300", "3.0300"), rico_row("USD-EUR", 1, "0.856", "0.863")))


def fetch(url):
    return mjc() if "mjc" in url else rico()


def bank_rows(currency="USD"):
    buy, sell = {"USD": (2.61, 2.65), "EUR": (3.02, 3.07), "RUB": (2.90, 3.10)}[currency]
    return [{"name": f"Bank {i}", "exchanges": [{"exchangeType": "Branch", "exchangeRates": [
        {"operationType": "Buy", "value": buy + i / 1000}, {"operationType": "Sell", "value": sell}]}]}
        for i in range(1, 5)]


def reference(currency="EUR"):
    return {"currency": currency, "unit": f"GEL per {currency}", "nominal": 1,
            "rate": {"USD": 2.6128, "EUR": 3.0374, "RUB": .030271}[currency], "fetchedAt": NOW.isoformat()}


class OfficeCurrencyTests(unittest.TestCase):
    def test_exact_currency_and_rub_nominal_normalized_once(self):
        for currency in PAIRS:
            self.assertEqual(offices.parse_mjc(mjc(), currency), tuple(map(float, PAIRS[currency])))
        self.assertEqual(offices.parse_rico(rico(), "EUR"), (3.032, 3.042))
        self.assertEqual(offices.parse_rico(rico(), "RUB"), (.0263, .0303))
        with self.assertRaises(ValueError):
            offices.parse_rico(rico_row("USD-EUR", 1, 3.03, 3.04), "EUR")

    def test_unexpected_source_nominal_or_wrong_scale_rejected(self):
        for nominal, buy, sell in ((1, 2.63, 3.03), (100, .0263, .0303), (100, 263, 303)):
            with self.subTest(nominal=nominal, buy=buy), self.assertRaises(ValueError):
                offices.parse_rico(rico_row("RUB", nominal, buy, sell), "RUB")
        data = json.loads(mjc()); data["currencies"]["RUB"][0]["amount"] = 100
        with self.assertRaises(ValueError): offices.parse_mjc(json.dumps(data), "RUB")

    def test_public_bodies_fetched_once_for_all_three_currencies(self):
        with patch.object(offices, "request", side_effect=fetch) as request:
            results = offices.collect_all(request, NOW)
        self.assertEqual(request.call_count, 2)
        for code, payload in results.items():
            self.assertEqual(payload["currency"], code)
            self.assertEqual(payload["unit"], f"GEL per {code}")
            self.assertEqual(payload["nominal"], 1)
            self.assertEqual(payload["failures"], [])
            self.assertFalse(payload["quality"]["officialReferenceChecked"])
        rub = {o["id"]: o for o in results["RUB"]["offers"]}
        self.assertEqual((rub["mjc"]["sourceNominal"], rub["rico"]["sourceNominal"]), (1, 100))

    def test_missing_currency_keeps_only_its_old_source_date(self):
        before = offices.collect_all(fetch, NOW)
        body = json.loads(mjc()); del body["currencies"]["EUR"]
        after = offices.collect_all(lambda url: json.dumps(body).encode() if "mjc" in url else rico(),
                                    NOW + timedelta(minutes=30), before)
        self.assertEqual(after["EUR"]["failures"], ["mjc"])
        self.assertEqual(after["EUR"]["offers"][0], before["EUR"]["offers"][0])
        self.assertNotEqual(after["EUR"]["offers"][1]["checkedAt"], before["EUR"]["offers"][1]["checkedAt"])
        for code in ("USD", "RUB"):
            self.assertEqual(after[code]["failures"], [])
            self.assertNotEqual(after[code]["offers"][0]["checkedAt"], before[code]["offers"][0]["checkedAt"])

    def test_source_network_failure_shared_but_freshness_not_shared(self):
        before = offices.collect_all(fetch, NOW)
        def partial(url):
            if "rico" in url: raise OSError("offline")
            return mjc()
        after = offices.collect_all(partial, NOW + timedelta(minutes=30), before)
        for code in PAIRS:
            self.assertEqual(after[code]["failures"], ["rico"])
            self.assertEqual(after[code]["offers"][1], before[code]["offers"][1])
            self.assertNotEqual(after[code]["offers"][0]["checkedAt"], before[code]["offers"][0]["checkedAt"])

    def test_invalid_previous_currency_isolated_not_silently_imported(self):
        before = offices.collect_all(fetch, NOW)
        before["EUR"] = before["USD"]
        after = offices.collect_all(fetch, NOW, before)
        self.assertIsInstance(after["EUR"], ValueError)
        self.assertEqual(after["USD"]["failures"], [])
        self.assertEqual(after["RUB"]["failures"], [])
        after = offices.collect_all(fetch, NOW, {"EUR": ValueError("broken JSON")})
        self.assertIsInstance(after["EUR"], ValueError)
        self.assertIsInstance(after["USD"], dict)

    def test_reference_currency_isolation_and_rub_cross_units(self):
        legacy = {"usdGel": 2.6128, "usdRub": 86.5857, "fetchedAt": NOW.isoformat()}
        refs = {"USD": legacy, "EUR": reference(), "RUB": legacy}
        results = offices.collect_all(fetch, NOW, references=refs)
        for code in PAIRS:
            self.assertEqual(results[code]["failures"], [])
            self.assertTrue(results[code]["quality"]["officialReferenceChecked"])
        self.assertIsNone(banks.reference_value(legacy, "EUR", NOW))
        wrong = reference(); wrong["rate"] = 2.6
        result = offices.collect(fetch, NOW, reference=wrong, currency="EUR")
        self.assertEqual(result["failures"], ["mjc", "rico"])
        self.assertEqual(result["offers"], [])
        stale = reference(); stale["fetchedAt"] = (NOW - timedelta(days=3)).isoformat()
        result = offices.collect(fetch, NOW, reference=stale, currency="EUR")
        self.assertEqual(result["failures"], [])
        self.assertFalse(result["quality"]["officialReferenceChecked"])


class BankCurrencyTests(unittest.TestCase):
    def test_eur_currency_and_reference_metadata(self):
        result = banks.normalize(bank_rows("EUR"), META, SUBJECTS, NOW, reference=reference(), currency="EUR")
        self.assertEqual((result["currency"], result["unit"], result["nominal"], result["sourceNominal"]),
                         ("EUR", "GEL per EUR", 1, 1))
        self.assertTrue(result["quality"]["officialReferenceChecked"])
        self.assertAlmostEqual(result["offers"][0]["buy"], 3.024)
        self.assertIsNone(result["offers"][0]["sourceUpdatedAt"])
        legacy = {"usdGel": 2.0, "fetchedAt": NOW.isoformat()}
        self.assertFalse(banks.normalize(bank_rows("EUR"), META, SUBJECTS, NOW, reference=legacy,
                                         currency="EUR")["quality"]["officialReferenceChecked"])

    def test_future_rub_normalizer_but_no_quality_relaxation(self):
        result = banks.normalize(bank_rows("RUB"), META, SUBJECTS, NOW, reference=reference("RUB"), currency="RUB")
        self.assertEqual(result["sourceNominal"], 100)
        self.assertAlmostEqual(result["offers"][0]["buy"], .02904)
        rows = bank_rows("RUB")
        for row in rows[:2]: row["exchanges"][0]["exchangeRates"][1]["value"] = 3.99
        with self.assertRaises(ValueError): banks.normalize(rows, META, SUBJECTS, NOW, currency="RUB")
        for currency in ("USD", "EUR"):
            rows = bank_rows(currency)
            for row in rows[:2]: row["exchanges"][0]["exchangeRates"][1]["value"] = 5
            with self.assertRaises(ValueError): banks.normalize(rows, META, SUBJECTS, NOW, currency=currency)

    def test_wrong_nominal_duplicate_metadata_and_previous_currency_rejected(self):
        for code in ("EUR", "RUB"):
            metadata = copy.deepcopy(META)
            row = next(r for r in metadata if r["code"] == code)
            row["kCoeficient"] = 100 if code == "EUR" else 1
            with self.assertRaises(ValueError): banks.normalize(bank_rows(code), metadata, SUBJECTS, NOW, currency=code)
        with self.assertRaises(ValueError): banks.normalize(bank_rows("EUR"), META + [META[1]], SUBJECTS, NOW, currency="EUR")
        usd = banks.normalize(bank_rows(), META, SUBJECTS, NOW)
        with self.assertRaises(ValueError): banks.normalize(bank_rows("EUR"), META, SUBJECTS, NOW, previous=usd, currency="EUR")

    def test_current_official_reference_exact_nominal_and_no_invented_date(self):
        with patch.object(banks, "get_json", return_value=[{"code": "RUB", "quantity": 100, "rate": 3.0271}]) as get:
            result = banks.fetch_reference("RUB", NOW)
        self.assertEqual(result["rate"], .030271)
        self.assertIsNone(result["sourceUpdatedAt"])
        self.assertEqual(get.call_args.args[0], "Exchanges/nbg-exchanges?codes=RUB")
        for rows in ([], [{"code": "EUR", "quantity": 100, "rate": 3.03}],
                     [{"code": "USD", "quantity": 1, "rate": 3.03}],
                     [{"code": "EUR", "quantity": 1, "rate": 3.03}] * 2):
            with patch.object(banks, "get_json", return_value=rows), self.assertRaises(ValueError):
                banks.fetch_reference("EUR", NOW)

    def run_main(self, root, failure=None):
        calls = []
        def api(path):
            calls.append(path)
            if path == "Currency/currencies": return META
            if path == "Subject/get-subjects": return SUBJECTS
            params = parse_qs(urlparse(path).query)
            if path.startswith("Exchanges/nbg-exchanges"):
                return [{"code": "EUR", "quantity": 1, "rate": 3.0374}]
            ident = int(params["currencyId"][0])
            self.assertNotEqual(ident, 126, "RUB banks must not be requested")
            code = {5: "USD", 6: "EUR"}[ident]
            if code == failure: raise OSError("simulated outage")
            return bank_rows(code)
        outputs = {"USD": root / "market-rates.json", "EUR": root / "market-rates-eur.json"}
        with patch.object(banks, "ROOT", root), patch.object(banks, "OUTPUTS", outputs), patch.object(banks, "get_json", side_effect=api):
            status = banks.main()
        return status, calls, outputs

    def test_main_only_requests_and_writes_usd_eur_no_rub_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            status, calls, outputs = self.run_main(root)
            self.assertEqual(status, 0)
            self.assertEqual(len(calls), 5)
            self.assertEqual(set(p.name for p in root.iterdir()), {p.name for p in outputs.values()})

    def test_main_eur_outage_keeps_original_timestamp_and_usd_succeeds(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old = banks.normalize(bank_rows("EUR"), META, SUBJECTS, NOW, currency="EUR")
            banks.write_json_atomic(root / "market-rates-eur.json", old)
            status, _, outputs = self.run_main(root, "EUR")
            self.assertEqual(status, 1)
            self.assertTrue(outputs["USD"].exists())
            kept = json.loads(outputs["EUR"].read_text())
            self.assertEqual(kept["fetchedAt"], old["fetchedAt"])
            self.assertEqual(kept["offers"], old["offers"])
            self.assertTrue(kept["refreshFailed"])

    def test_main_usd_outage_does_not_block_eur_or_relabel_usd(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old = banks.normalize(bank_rows(), META, SUBJECTS, NOW)
            banks.write_json_atomic(root / "market-rates.json", old)
            status, _, outputs = self.run_main(root, "USD")
            self.assertEqual(status, 1)
            self.assertEqual(json.loads(outputs["USD"].read_text()), old)
            self.assertEqual(json.loads(outputs["EUR"].read_text())["currency"], "EUR")

    def test_main_malformed_eur_previous_shape_does_not_escape_error_handler(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            banks.write_json_atomic(root / "market-rates-eur.json", ["malformed snapshot"])
            status, _, outputs = self.run_main(root)
            self.assertEqual(status, 1)
            self.assertTrue(outputs["USD"].exists())
            self.assertEqual(json.loads(outputs["EUR"].read_text()), ["malformed snapshot"])


if __name__ == "__main__":
    unittest.main()
