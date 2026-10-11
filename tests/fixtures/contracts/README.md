# Recorded public contracts

These expectations were captured from the historical public browser fixtures during Wave 8, before retiring the old runtime. They contain observed results, text, geometry, and original Chromium PNGs, not implementation source. The SITE-8, SITE-9, and SITE-11 handoffs establish the historical expectations; the attachment parser fixtures retain their previously recorded text and byte contracts.

The current tests execute only application-owned modules and compare against these fixed records. Storage compatibility uses an independently declared version-3 IndexedDB schema and a native IndexedDB reader. Runtime-provider tests define their expected helper behavior independently. No historical package or sibling checkout is needed.

Browser suites and exact Chromium pixel comparisons are opt-in local checks through `node scripts/test-suite.mjs browser`. They are not part of the critical CI suite. Pixel fixtures use Chromium 145 on Linux with the existing fonts; another browser/font platform may need the equivalent local environment. Do not regenerate expectations from the implementation under test.
