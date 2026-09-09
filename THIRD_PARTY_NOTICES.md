# Third-party notices

## Lucide — ArrowRightLeft

The inline currency-swap icon in `index.html` is from [Lucide](https://lucide.dev/icons/arrow-right-left).
[Original SVG](https://github.com/lucide-icons/lucide/blob/main/icons/arrow-right-left.svg).

ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

## Lucide navigation icons

`brand/icons/navigation/arrow-right-left.svg`, `calculator.svg` and
`shield-plus.svg` are unchanged originals downloaded on 2026-09-08 from
https://github.com/lucide-icons/lucide/tree/main/icons.
The Lucide ISC notice above applies. These assets are local; navigation does
not need a runtime request to a third-party icon service.

## Lucide weather icons

Files in `brand/icons/weather/` are original SVGs downloaded from
https://github.com/lucide-icons/lucide/tree/main/icons on 2026-09-08:
sun, moon, cloud, cloud-sun, cloud-moon, cloud-rain, cloud-snow,
cloud-lightning, cloud-fog. Geometry is unchanged. The ISC notice above applies.
The moon icon is additionally derived from Feather and carries this notice:

The MIT License (MIT)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Lucide interface icons

`brand/icons/interface/house-plug.svg`, `zap.svg`, `droplet.svg`, `flame.svg`,
and `x.svg` are unchanged original SVGs from
https://github.com/lucide-icons/lucide/tree/main/icons (2026-09-08).
The ISC notice above applies. Theme switching reuses the existing sun and moon
assets, with the relevant ISC/MIT notices above. No runtime icon CDN is used.

## Open-Meteo attribution placement

The weather reading itself links directly to Open-Meteo; its accessible name
and tooltip identify the provider. The expandable sources block names
Open-Meteo, links CC BY 4.0, and explains rounding and translation.
Placement checked against https://open-meteo.com/en/licence on 2026-09-08.

## Open-Meteo weather data

Weather is model-derived current data from https://open-meteo.com/, under
CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). The UI rounds the
temperature to whole Celsius degrees and translates WMO descriptions to Russian.
City centres were resolved using the Open-Meteo geocoding API (GeoNames).

The free endpoint is for NON-COMMERCIAL testing/use only; it is not licensed for
advertising-supported, subscription or commercial promotional use. Before
monetisation, arrange an appropriate API plan. No availability guarantee applies.
Terms: https://open-meteo.com/en/terms · Documentation: https://open-meteo.com/en/docs
Checked 2026-09-08. No user geolocation or personal financial data is sent.
The direct request necessarily exposes the connection IP to the weather provider.
