"""Regression: source selection must never discard a house continuation."""
import sys
from pathlib import Path
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import collect_power_pilot as power


class TerritoryIntegrity(unittest.TestCase):
    def test_house_slash_is_not_a_city_separator(self):
        text = 'ბათუმი, TEST STREET, შენ. 8/1'
        self.assertEqual(power.city_territory(text), (text, 'explicit-city-prefix'))

    def test_bare_comma_continuation_is_not_dropped(self):
        for text in ['ბათუმი/TEST STREET, 8/1', 'ბათუმი/TEST STREET, შენ. 8',
                     'ბათუმი/TEST STREET, UNKNOWN PRIVATE TAIL']:
            with self.subTest(text=text), self.assertRaises(power.InvalidData):
                power.city_territory(text)

    def test_all_explicit_number_fragments_are_retained(self):
        text = 'ბათუმი/TEST STREET 8/1, ბათუმი/TEST STREET 12–16'
        self.assertEqual(power.city_territory(text)[0], text)

    def test_multi_word_neighbour_city_is_not_misread_as_a_house_tail(self):
        text = 'სოფელი ტესტი/TEST VILLAGE, ბათუმი/TEST STREET 8/1'
        self.assertEqual(power.city_territory(text)[0], 'ბათუმი/TEST STREET 8/1')

    def test_private_details_and_controls_fail_closed(self):
        for tail in ['apt. 4','кв. 4','+995 555 00 00 00','აბო\u200bნენტი TEST']:
            with self.subTest(tail=tail), self.assertRaises(power.InvalidData):
                power.city_territory('ბათუმი, TEST STREET, '+tail)

    def test_mixed_prefix_cities_fail_closed(self):
        with self.assertRaises(power.InvalidData):
            power.city_territory('ბათუმი, TEST; ხელვაჩაური, TEST')
