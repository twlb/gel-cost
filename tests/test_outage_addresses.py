"""Synthetic number/privacy fixtures plus explicitly approved public phrases.

No network, real subscribers, coordinates or current-outage assertions.
"""
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import outage_addresses as addresses


class OutageAddressTests(unittest.TestCase):
    def test_exact_verified_phrase_keeps_public_original_and_number(self):
        result = addresses.normalize_address("ბათუმი, კობალაძის ქ. 8a")
        self.assertEqual(result, {
            "original": "ბათუმი, კობალაძის ქ. 8a",
            "display": "Батуми, ул. Кобаладзе 8a",
            "translationStatus": "verified-dictionary", "houseTokens": ["8a"], "needsReview": False,
        })

    def test_all_approved_street_phrases_have_sources_and_exact_display(self):
        self.assertEqual(len(addresses.VERIFIED_STREET_NAMES), 7)
        for original, entry in addresses.STREET_TRANSLATIONS.items():
            with self.subTest(original=original):
                result = addresses.normalize_address(original + " 17")
                self.assertEqual(result["display"], entry["display"] + " 17")
                self.assertEqual(result["translationStatus"], "verified-dictionary")
                self.assertTrue(entry["sources"])
                self.assertTrue(addresses.is_verified_street(original))
        self.assertFalse(addresses.is_verified_street("ხიმშიაშვილის"))
        self.assertFalse(addresses.is_verified_street(None))

    def test_real_safe_unknown_street_patterns_are_partial_not_invented(self):
        for street, number in [("პუშკინის", "156v"), ("ლეონიძეს", "2"), ("ჯავახიშვილის", "34")]:
            original = f"ბათუმი, {street}, შენ. {number}"
            result = addresses.normalize_address(original)
            self.assertEqual(result["original"], original)
            self.assertEqual(result["display"], f"Батуми, {street}, д. {number}")
            self.assertEqual(result["translationStatus"], "partial")
            self.assertTrue(result["needsReview"])
            self.assertEqual(result["houseTokens"], [number])

    def test_partial_multi_street_list_keeps_unknown_street_and_both_city_prefixes(self):
        original = "ბათუმი/ხანძთის, ბათუმი/ფრიდონ ხალვაშის გამზირი"
        result = addresses.normalize_address(original)
        self.assertEqual(result["display"], "Батуми/ხანძთის, Батуми/проспект Фридона Халваши")
        self.assertEqual(result["translationStatus"], "partial")
        self.assertEqual(result["houseTokens"], [])

    def test_unknown_original_is_returned_exactly_not_transliterated(self):
        for original in ["უცნობი 7ბ", "UNKNOWN STREET 8а", "  უცნობი\n8/2  ", "UNKNOWN e\u0301 8"]:
            result = addresses.normalize_address(original)
            self.assertEqual(result["original"], original)
            self.assertEqual(result["display"], original)
            self.assertEqual(result["translationStatus"], "original")
            self.assertTrue(result["needsReview"])

    def test_mixed_script_suffixes_are_never_equated(self):
        for number in ["8а", "8a", "8ა", "8А", "8A", "156v", "09", "0002"]:
            result = addresses.normalize_address("კობალაძის ქ. " + number)
            self.assertEqual(result["houseTokens"], [number])
            self.assertEqual(result["display"], "ул. Кобаладзе " + number)

    def test_ranges_fractions_letters_and_corpus_remain_exact(self):
        for number in ["8–12", "8-12", "8—12", "8 / 2", "8ა/2", "8-а", "8 А", "8 ა", "7 корпус 2", "7 корп. 2Б", "7 კორპუსი 2ა", "7 building 2"]:
            with self.subTest(number=number):
                result = addresses.normalize_address("კობალაძის ქ. " + number)
                self.assertEqual(result["houseTokens"], [number])
                self.assertEqual(result["display"], "ул. Кобаладзе " + number)

    def test_numbered_lists_and_duplicates_keep_order_and_punctuation(self):
        original = "ბათუმი/კობალაძის ქ. 8а, 8a, 8ა; 10/2; 12–16, 8а"
        result = addresses.normalize_address(original)
        self.assertEqual(result["houseTokens"], ["8а", "8a", "8ა", "10/2", "12–16", "8а"])
        self.assertEqual(result["display"], "Батуми/ул. Кобаладзе 8а, 8a, 8ა; 10/2; 12–16, 8а")

    def test_unknown_latin_words_are_partial_too(self):
        result = addresses.normalize_address("ბათუმი, UNKNOWN STREET 4")
        self.assertEqual(result["translationStatus"], "partial")
        self.assertTrue(result["needsReview"])

    def test_unknown_qualifier_is_not_silently_deleted(self):
        original = "ბათუმი, კობალაძის ქ. 8, მშენებარე"
        result = addresses.normalize_address(original)
        self.assertTrue(result["display"].endswith(", მშენებარე"))
        self.assertEqual(result["translationStatus"], "partial")

    def test_approved_phrases_do_not_match_word_fragments_or_unverified_reordering(self):
        for original in ["არაკობალაძის ქ. 8", "ხალვაშის ფრიდონ გამზირი 7", "ი. ჭავჭავაძის ქ. 8"]:
            result = addresses.normalize_address(original)
            self.assertEqual(result["display"], original)
            self.assertEqual(result["translationStatus"], "original")

    def test_individual_markers_and_phone_numbers_are_quarantined_without_echo(self):
        # Explicit synthetic data, not addresses or identifiers of real people.
        for private in ["ბინა 3", "ბინები 3", "ბინის 3", "აბონენტი TEST", "apt. 3", "APARTMENT 3", "кв. 3", "кв 3", "квартира 3", "абонент TEST", "лицевой счет TEST", "subscriber TEST", "account TEST", "000000000", "+000 000 00 00 00", "000 12 34 56", "name@example.invalid"]:
            original = "ბათუმი, კობალაძის ქ. 8, " + private
            with self.subTest(private=private), self.assertRaises(addresses.UnsafeIndividualAddress) as caught:
                addresses.normalize_address(original)
            self.assertEqual(str(caught.exception), "individual_address_content")
            self.assertNotIn(original, str(caught.exception))

    def test_zero_width_and_bidi_are_rejected_not_silently_removed(self):
        for mark in ["\u200b", "\u200c", "\u200d", "\ufeff", "\u202e", "\u2066"]:
            with self.assertRaises(addresses.UnsafeIndividualAddress) as caught:
                addresses.normalize_address("ბათუმი, ბი" + mark + "ნა 3")
            self.assertEqual(str(caught.exception), "obscured_address_text")

    def test_invalid_or_unsafe_text_has_only_safe_reason_codes(self):
        for original in [None, 12, "", "   ", "x" * 4001, "<script>x</script>", "ბათუმი\x00"]:
            with self.assertRaises(addresses.AddressNormalizationError) as caught:
                addresses.normalize_address(original)
            self.assertIn(str(caught.exception), ("invalid_address_text", "unsafe_address_text"))

    def test_dictionary_cannot_rewrite_or_add_digits(self):
        synthetic = {"TEST": {"display": "TEST 99", "sources": ("https://example.invalid/synthetic",)}}
        with patch.object(addresses, "STREET_TRANSLATIONS", synthetic):
            with self.assertRaisesRegex(addresses.AddressNormalizationError, "numeric_address_dictionary_entry"):
                addresses.normalize_address("TEST 8")

    def test_final_invariant_rejects_number_drift_even_if_dictionary_validation_is_bypassed(self):
        # Simulate a future formatter defect independently of the dictionary
        # validator. The final guard must still refuse a changed numeric value.
        with patch.object(addresses, "_dictionary", return_value={"TEST": "LABEL 99"}):
            with self.assertRaisesRegex(addresses.AddressNormalizationError, "address_number_invariant_failed"):
                addresses.normalize_address("TEST 8")

    def test_spacing_and_separators_outside_replacements_are_exact(self):
        original = "  ბათუმი/კობალაძის ქ.\t8a;\nბათუმი/ბარათაშვილის ქ.  10/2  "
        result = addresses.normalize_address(original)
        self.assertEqual(result["original"], original)
        self.assertEqual(result["display"], "  Батуми/ул. Кобаладзе\t8a;\nБатуми/ул. Бараташвили  10/2  ")
        self.assertEqual(result["houseTokens"], ["8a", "10/2"])

    def test_dictionary_never_translates_a_protected_spaced_house_letter(self):
        synthetic = {"ა": {"display": "А", "sources": ("https://example.invalid/synthetic",)}}
        with patch.object(addresses, "STREET_TRANSLATIONS", synthetic), patch.object(addresses, "STRUCTURAL_TRANSLATIONS", {}):
            result = addresses.normalize_address("8 ა")
            self.assertEqual(result["display"], "8 ა")
            self.assertEqual(result["houseTokens"], ["8 ა"])

    def test_longer_exact_phrase_wins_without_cascading_replacements(self):
        synthetic = {
            "TEST STREET": {"display": "LONG LABEL", "sources": ("https://example.invalid/synthetic",)},
            "TEST": {"display": "SHORT", "sources": ("https://example.invalid/synthetic",)},
            "LONG LABEL": {"display": "CASCADE", "sources": ("https://example.invalid/synthetic",)},
        }
        with patch.object(addresses, "STREET_TRANSLATIONS", synthetic), patch.object(addresses, "STRUCTURAL_TRANSLATIONS", {}):
            result = addresses.normalize_address("TEST STREET 8")
            self.assertEqual(result["display"], "LONG LABEL 8")

    def test_source_number_prefix_and_no_space_after_street_abbreviation_survive(self):
        result = addresses.normalize_address("ფრიდონ ხალვაშის გამზირი N237")
        self.assertEqual(result["display"], "проспект Фридона Халваши N237")
        self.assertEqual(result["houseTokens"], ["N237"])
        self.assertFalse(result["needsReview"])
        tight = addresses.normalize_address("კობალაძის ქ.8a")
        self.assertEqual(tight["display"], "კობალაძის ქ.8a")
        self.assertEqual(tight["houseTokens"], ["8a"])
        self.assertTrue(tight["needsReview"])


if __name__ == "__main__":
    unittest.main()
