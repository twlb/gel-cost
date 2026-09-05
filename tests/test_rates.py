import copy
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import update_rates as official
import update_bank_rates as banks

NOW = datetime(2026, 9, 5, 8, tzinfo=timezone.utc)
CURRENCIES = [{"id": 5, "code": "USD", "kCoeficient": 1, "isActive": True}]
SUBJECTS = [{"id": i, "name": f"Bank {i}"} for i in range(1, 5)]


def rows():
    return [{"name": f"Bank {i}", "exchanges": [
        {"exchangeType": "InternetBank", "exchangeRates": [{"operationType": "Buy", "value": 3}, {"operationType": "Sell", "value": 3.1}]},
        {"exchangeType": "Branch", "exchangeRates": [{"operationType": "Sell", "value": 2.7}, {"operationType": "Buy", "value": 2.6 + i / 1000}]},
    ]} for i in range(1, 5)]


class BankTests(unittest.TestCase):
    def test_side_channel_nominal_and_check_time(self):
        data = banks.normalize(rows(), CURRENCIES, SUBJECTS, NOW)
        self.assertEqual(len(data["offers"]), 4)
        self.assertEqual(data["offers"][0]["buy"], 2.604)
        self.assertEqual(data["offers"][0]["id"], "4")
        self.assertIsNone(data["offers"][0]["sourceUpdatedAt"])
        self.assertEqual(data["fetchedAt"], "2026-09-05T08:00:00Z")

    def test_malformed_and_empty_payload_rejected(self):
        for payload in ([], {}, ["server error"]):
            with self.assertRaises((ValueError, TypeError)):
                banks.normalize(payload, CURRENCIES, SUBJECTS, NOW)

    def test_duplicate_identity_rejected(self):
        data = rows();data[1]["name"] = data[0]["name"]
        with self.assertRaises(ValueError):
            banks.normalize(data, CURRENCIES, SUBJECTS, NOW)

    def test_wrong_nominal_rejected(self):
        currencies = copy.deepcopy(CURRENCIES);currencies[0]["kCoeficient"] = 100
        with self.assertRaises(ValueError):
            banks.normalize(rows(), currencies, SUBJECTS, NOW)

    def test_invalid_pair_quarantined_but_minimum_required(self):
        data = rows();data[0]["exchanges"][1]["exchangeRates"][1]["value"] = 0
        result = banks.normalize(data, CURRENCIES, SUBJECTS, NOW)
        self.assertEqual(len(result["offers"]), 3)
        self.assertEqual(result["quality"]["rejectedCount"], 1)
        data[1]["exchanges"][1]["exchangeRates"][1]["value"] = 9
        with self.assertRaises(ValueError):
            banks.normalize(data, CURRENCIES, SUBJECTS, NOW)

    def test_abrupt_change_rejected(self):
        previous = banks.normalize(rows(), CURRENCIES, SUBJECTS, NOW)
        previous["offers"][0]["buy"] = 1.0
        with self.assertRaises(ValueError):
            banks.normalize(rows(), CURRENCIES, SUBJECTS, NOW, previous)

    def test_reference_rejects_systematic_wrong_scale(self):
        reference = {"fetchedAt": NOW.isoformat(), "usdGel": 2.62}
        self.assertTrue(banks.normalize(rows(), CURRENCIES, SUBJECTS, NOW, reference=reference)["quality"]["officialReferenceChecked"])
        reference["usdGel"] = 1.0
        with self.assertRaises(ValueError):
            banks.normalize(rows(), CURRENCIES, SUBJECTS, NOW, reference=reference)

    def test_numeric_values_not_booleans_or_nonfinite(self):
        for value in (True, float("nan"), float("inf"), "2.6", None):
            with self.assertRaises(ValueError):
                banks.numeric(value)


class OfficialTests(unittest.TestCase):
    def test_dates_are_kept_separately(self):
        data = official.make_payload(88, "2026-09-04T00:00:00Z", 2.62, "2026-09-05T00:00:00Z", NOW)
        self.assertEqual(data["updatedAt"], "2026-09-04T00:00:00Z")
        self.assertEqual(data["sources"]["usdGel"]["date"], "2026-09-05T00:00:00Z")

    def test_bad_values_and_future_dates_rejected(self):
        for rate in (0, -2, float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                official.make_payload(rate, "2026-09-05", 2.62, "2026-09-05", NOW)
        with self.assertRaises(ValueError):
            official.make_payload(88, "2026-09-06", 2.62, "2026-09-05", NOW)

    def test_atomic_write_rejects_nonfinite_without_replacing_good_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rates.json"
            official.write_json_atomic(path, {"valid": 1})
            before = path.read_bytes()
            with self.assertRaises(ValueError):
                official.write_json_atomic(path, {"invalid": float("nan")})
            self.assertEqual(path.read_bytes(), before)

    def test_cbr_nominal_and_current_date_request(self):
        xml = b'<ValCurs Date="05.09.2026"><Valute><CharCode>USD</CharCode><Nominal>100</Nominal><Value>8658,57</Value></Valute></ValCurs>'
        with patch.object(official, "request", return_value=xml) as request:
            rate, date = official.fetch_cbr()
        self.assertAlmostEqual(rate, 86.5857)
        self.assertIn("date_req=", request.call_args.args[0])
        self.assertTrue(date.startswith("2026-09-05"))

    def test_nbg_current_operation_and_quantity(self):
        xml = b'<root><CurrencyRate><Code>USD</Code><Quantity>10</Quantity><Rate>26.126</Rate><ValidFromDate>2026-09-05T00:00:00</ValidFromDate></CurrencyRate></root>'
        with patch.object(official, "request", return_value=xml) as request:
            rate, date = official.fetch_nbg()
        self.assertAlmostEqual(rate, 2.6126)
        self.assertIn("GetCurrentRates", request.call_args.kwargs["headers"]["SOAPAction"])


if __name__ == "__main__":
    unittest.main()
