# Attachment parser fixtures

These are synthetic documents generated for the clean-room attachment migration. `sample.pdf` has two text pages; `sample.docx` contains paragraphs and a table; `breaks.docx` contains explicit page/line breaks; `sample.pptx` has slide files inserted in order 10, 2, 1; the XLS/XLSX pair contains two sheets with quoted CSV values.

`expected.json` records black-box outputs from the linked baseline's public `loadAttachment` runtime. No deleted web-ui implementation was read or copied. Preserved quirks include DOCX table omission and ignored page breaks, PPTX entity text remaining escaped, XLS MIME inference using the XLSX MIME, and raw text/code without markup.

The tests also compare the baseline runtime directly, so parser outputs, MIME/source rules, errors and extract-document renderer behavior are independently exercised rather than only asserted against a local implementation.

`special-names.xlsx` contains a sheet named `Quote" <angle>&`; `edge-cases.json` records separately probed special-name, zero-byte and headerless-download outcomes. The XML-like filename/sheet annotations and document bodies remain raw, untrusted user-role prompt text, not parsed or trusted XML. Escaping only the names would alter the baseline rather than make the document body trusted. Host/scheme contract tests stub every fetch, including link-local addresses; they make no metadata-service network requests.

The old extraction tool derives filenames by splitting the original URL on `/` before removing text after `?`, rather than reading the URL pathname. Pure fragments and query values containing slashes can consequently determine the inferred format. Regression cases retain that behavior, including real PDF parsing when the resulting name ends in `.pdf` and raw PDF bytes decoded as text when a query value ends in `.txt`.
