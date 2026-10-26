# Certificate year-range snapshot

Checked 2026-10-26 against the public USVitalRecords order forms and their county-year lookup. This records competitor service restrictions, not official government eligibility. Runtime forms use local data and make no competitor requests.

The scan read all 52 jurisdiction routes across four certificate types: 117 offered forms, 91 not-offered forms, and 8,018 county lookups. County labels are HTML-decoded and St./Saint normalized; independent-city aliases are used only when unambiguous. No other county names are guessed. A current-year maximum is stored as rolling today; historical maxima remain fixed. The competitor's hidden 1800 floor and invalid 2050/unavailable sentinels are omitted. Birth retains the existing 90-day waiting period.

No matching range means no year notice and no year cutoff. USVC's existing product/state/county availability is unchanged. Existing stored orders are not migrated. Backend and frontend snapshots must remain identical; deploy the backend with the matching frontend to keep validation consistent.

Source pattern: `https://order.usvitalrecords.org/state/{state}/order/{certificate}-certificate`; public lookup: `POST https://order.usvitalrecords.org/api/get/yearrestriction/{state}/{certificate}-certificate`, with the county ID only.

## Coverage

Numbers count USVC counties with an imported range. `—` means the competitor does not offer the form. `0` means no displayable matching range. All omissions show no year notice.

| State | Birth | Death | Marriage | Divorce |
| ----- | ----: | ----: | -------: | ------: |
| AK    |    25 |     — |       25 |       — |
| AL    |    67 |    67 |       67 |      67 |
| AR    |    75 |    75 |       75 |       — |
| AZ    |    15 |     — |        — |       — |
| CA    |    58 |    58 |       45 |       — |
| CO    |    64 |     — |        — |       — |
| CT    |     8 |     8 |        8 |       — |
| DC    |     — |     — |        — |       — |
| DE    |     3 |     — |        0 |       — |
| FL    |    67 |    67 |       67 |      67 |
| GA    |   159 |   159 |        — |       — |
| HI    |     4 |     — |        — |       — |
| IA    |    99 |    99 |       99 |       — |
| ID    |    44 |    44 |       44 |      44 |
| IL    |     — |     — |        — |       — |
| IN    |    92 |     — |        — |       — |
| KS    |   105 |   105 |      105 |     105 |
| KY    |   120 |   120 |      120 |     120 |
| LA    |    64 |    64 |        — |       — |
| MA    |    14 |    14 |       14 |       — |
| MD    |    24 |    24 |       24 |      24 |
| ME    |    16 |     — |       16 |       — |
| MI    |    83 |     — |       83 |       — |
| MN    |    87 |     — |        — |       — |
| MO    |   114 |   114 |      114 |     114 |
| MS    |    81 |    81 |       81 |       — |
| MT    |    56 |     — |        — |       — |
| NC    |   100 |   100 |      100 |     100 |
| ND    |    53 |     — |        — |       — |
| NE    |    93 |     — |        — |       — |
| NH    |    10 |     — |       10 |       — |
| NJ    |     0 |     — |        0 |       — |
| NM    |    33 |     — |        — |       — |
| NV    |    17 |    17 |        — |       — |
| NY    |    62 |    62 |        — |      62 |
| OH    |     — |     — |        — |       — |
| OK    |    77 |    77 |        — |       — |
| OR    |    36 |    36 |       36 |      36 |
| PA    |    67 |    67 |        — |       — |
| PR    |     — |     — |        — |       — |
| RI    |     5 |     — |        5 |       — |
| SC    |    46 |    46 |       46 |      46 |
| SD    |    66 |     — |        0 |       — |
| TN    |    95 |    95 |       95 |      95 |
| TX    |   254 |   254 |        — |       — |
| UT    |     — |     — |        — |       — |
| VA    |   105 |   105 |      105 |     105 |
| VT    |     — |     — |        — |       — |
| WA    |    39 |    39 |       39 |      39 |
| WI    |    72 |    72 |       72 |      72 |
| WV    |    55 |     — |       55 |       — |
| WY    |    23 |     — |        — |       — |

## Unmatched county names

These county names could not be matched safely to a competitor dropdown. They receive no year range. Hidden/default and unavailable sentinels are also omitted.

- AK: Hoonah Angoon, Petersburg, Skagway, Wrangell.
- MO: Saint Louis City.
- MS: Walthall.
- VA: Alexandria City, Bristol City, Charlottesville City, Chesapeake City, Colonial Heights City, Covington City, Danville City, Fairfax City, Falls Church City, Fredericksburg City, Galax City, Harrisonburg City, Hopewell City, Lexington City, Lynchburg City, Martinsville City, Norfolk City, Norton City, Petersburg City, Poquoson City, Portsmouth City, Staunton City, Suffolk City, Virginia Beach City, Waynesboro City, Williamsburg City, Winchester City.
