"""Conservative KA/RU display labels for public Batumi outage territories.

This is NOT a privacy clearance, geocoder, house registry or general translator.
The caller must run its structural privacy gate before publishing any original
or translated text. ``needsReview`` describes incomplete translation only.
Unknown words, punctuation, spacing, house numbers and letters remain verbatim.
"""
from __future__ import annotations

import re
import unicodedata


class AddressNormalizationError(ValueError):
    """Only a stable reason code is exposed; never echo source address text."""


class UnsafeIndividualAddress(AddressNormalizationError):
    """Detected private or deliberately obscured content must be quarantined."""


# Exact paired source phrases checked by the collecting agent on 2026-09-09.
# Do not derive aliases, grammatical forms or reorderings from these entries.
RICO_SOURCES = ("https://www.rico.ge/ka/branches/", "https://www.rico.ge/ru/branches/")
STREET_TRANSLATIONS = {
    "ი.ჭავჭავაძის ქ.": {"display": "ул. И. Чавчавадзе", "sources": RICO_SOURCES},
    "ბარათაშვილის ქ.": {"display": "ул. Бараташвили", "sources": RICO_SOURCES},
    "აეროპორტის გზატკეცილი": {"display": "Аэропортовое шоссе", "sources": RICO_SOURCES},
    "კობალაძის ქ.": {"display": "ул. Кобаладзе", "sources": RICO_SOURCES},
    "შერიფ ხიმშიაშვილის": {"display": "Шериф Химшиашвили", "sources": RICO_SOURCES},
    "წმინდა სევერიანე აჭარელის ქუჩა": {
        "display": "улица Святого Севериана Аджарели", "sources": RICO_SOURCES,
    },
    "ფრიდონ ხალვაშის გამზირი": {
        "display": "проспект Фридона Халваши", "sources": ("https://medina.ge/ukrain/",),
    },
}
STRUCTURAL_TRANSLATIONS = {
    "ბათუმი": {"display": "Батуми", "sources": ("https://my.energo-pro.ge/ow/#/disconns",)},
    "შენ.": {"display": "д.", "sources": ("https://my.energo-pro.ge/ow/#/disconns",)},
}
DICTIONARY_CHECKED_ON = "2026-09-09"
VERIFIED_STREET_NAMES = frozenset(STREET_TRANSLATIONS)
MAX_ADDRESS_LENGTH = 4000

_LETTERS = r"A-Za-zА-Яа-яЁё\u10a0-\u10ff\u1c90-\u1cbf"
_LETTER = "[" + _LETTERS + "]"
# Adjacent letters can be a source-specific suffix. Spaced short letters are
# also kept; a long following street word must not be swallowed as a suffix.
_NUMBER = rf"\d+(?:{_LETTER}+|[ \t]+{_LETTER}{{1,3}}(?!{_LETTER}))?"
_PART = rf"(?:{_NUMBER}|{_LETTER}{{1,3}}(?!{_LETTER}))"
_BODY = rf"{_NUMBER}(?:[ \t]*[/\-–—][ \t]*{_PART})*"
_CORPUS = r"(?:корпус(?:а)?|корп\.?|строение|стр\.|building|bldg\.?|block|კორპუსი|კორპ\.)"
_HOUSE = re.compile(rf"(?<!\w)(?:[N№][ \t]*)?{_BODY}(?:[ \t]+{_CORPUS}[ \t]*{_BODY})*", re.IGNORECASE)
_PRIVATE = re.compile(
    r"ბინა|ბინები|ბინის|აბონენტ|"
    r"(?<!\w)(?:кв(?:\.|(?=\s|\d|$))|квартир\w*|абонент\w*|"
    r"лицев\w*\s+сч[её]т\w*|apt\.?|apartment\w*|subscriber\w*|account\w*)(?![A-Za-zА-Яа-яЁё])",
    re.IGNORECASE,
)
_LONG_NUMBER = re.compile(r"\d{9,}")
_SPACED_NUMBER = re.compile(r"(?<!\w)\+?\d(?:[ \t().-]*\d){8,}(?!\w)")
_EMAIL = re.compile(r"[^\s@]+@[^\s@]+")
_UNSAFE_TEXT = re.compile(r"[<>\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def is_verified_street(text):
    """Exact approved phrase only; not an address/privacy/location guarantee."""
    return isinstance(text, str) and text in VERIFIED_STREET_NAMES


def _validate_text(original):
    if not isinstance(original, str) or not original.strip() or len(original) > MAX_ADDRESS_LENGTH:
        raise AddressNormalizationError("invalid_address_text")
    # Zero-width/bidi marks can conceal subscriber and apartment markers. Do not
    # silently remove them and publish the now-different original.
    if any(unicodedata.category(char) in ("Cf", "Cs") for char in original):
        raise UnsafeIndividualAddress("obscured_address_text")
    if _UNSAFE_TEXT.search(original):
        raise AddressNormalizationError("unsafe_address_text")
    if _PRIVATE.search(original) or _LONG_NUMBER.search(original) or _SPACED_NUMBER.search(original) or _EMAIL.search(original):
        raise UnsafeIndividualAddress("individual_address_content")


def _house_matches(text):
    return list(_HOUSE.finditer(text))


def house_tokens(text):
    """Raw numeric address fragments in order, not verified individual houses.

    A number in an unknown street name may also appear here. Its interpretation
    is deliberately not guessed. The original territory remains authoritative.
    """
    return [match.group() for match in _house_matches(text)]


def _overlaps(start, end, spans):
    return any(start < right and left < end for left, right in spans)


def _dictionary():
    result = {}
    for entries in (STREET_TRANSLATIONS, STRUCTURAL_TRANSLATIONS):
        for phrase, entry in entries.items():
            if not isinstance(phrase, str) or not phrase or not isinstance(entry, dict):
                raise AddressNormalizationError("invalid_address_dictionary")
            replacement = entry.get("display")
            sources = entry.get("sources")
            if not isinstance(replacement, str) or not replacement or not isinstance(sources, (tuple, list)) or not sources:
                raise AddressNormalizationError("invalid_address_dictionary")
            if any(not isinstance(source, str) or not source.startswith("https://") for source in sources):
                raise AddressNormalizationError("invalid_address_dictionary")
            # Numeric street names need a separate reviewed contract. A display
            # dictionary must never add/remove a house number or number prefix.
            if re.search(r"\d", phrase + replacement):
                raise AddressNormalizationError("numeric_address_dictionary_entry")
            if any(unicodedata.category(char) in ("Cf", "Cs") for char in phrase + replacement) or _UNSAFE_TEXT.search(phrase + replacement):
                raise AddressNormalizationError("unsafe_address_dictionary")
            if phrase in result and result[phrase] != replacement:
                raise AddressNormalizationError("conflicting_address_dictionary")
            result[phrase] = replacement
    return result


def normalize_address(original):
    """Return a lossless dictionary-only label plus explicit translation status.

    Original/partial results are not cleared for publication by this function.
    The caller's independent structural privacy gate is always required.
    """
    _validate_text(original)
    numeric_spans = [(match.start(), match.end()) for match in _house_matches(original)]
    replacements = []
    occupied = []
    # Prefer complete long phrases; never cascade a translation into another.
    for phrase, replacement in sorted(_dictionary().items(), key=lambda item: (-len(item[0]), item[0])):
        left = r"(?<!\w)" if phrase[0].isalnum() else ""
        # A source abbreviation followed immediately by a house number must
        # not become a joined Russian street/number such as "Кобаладзе8a".
        right = r"(?!\w)"
        for match in re.finditer(left + re.escape(phrase) + right, original):
            start, end = match.span()
            if _overlaps(start, end, occupied) or _overlaps(start, end, numeric_spans):
                continue
            occupied.append((start, end))
            replacements.append((start, end, replacement))
    replacements.sort()
    cursor, output = 0, []
    for start, end, replacement in replacements:
        output.extend((original[cursor:start], replacement))
        cursor = end
    output.append(original[cursor:])
    display = "".join(output)
    before = house_tokens(original)
    if house_tokens(display) != before or re.findall(r"\d+", display) != re.findall(r"\d+", original):
        raise AddressNormalizationError("address_number_invariant_failed")
    # Anything alphabetic not covered by exact dictionary phrases or protected
    # numeric fragments remains unknown, regardless of its writing system.
    residue = list(original)
    for start, end in occupied + numeric_spans:
        residue[start:end] = " " * (end - start)
    incomplete = any(char.isalpha() for char in residue)
    status = "original" if not replacements else "partial" if incomplete else "verified-dictionary"
    return {
        "original": original, "display": display, "translationStatus": status,
        "houseTokens": before, "needsReview": status != "verified-dictionary",
    }
