# Attachment parser fixtures

These are synthetic documents generated for the clean-room attachment migration. `sample.pdf` has two text pages; `sample.docx` contains paragraphs and a table; `breaks.docx` contains explicit page/line breaks; `sample.pptx` has slide files inserted in order 10, 2, 1; the XLS/XLSX pair contains two sheets with quoted CSV values.

`expected.json` records black-box outputs from the linked baseline's public `loadAttachment` runtime. No deleted web-ui implementation was read or copied. Preserved quirks include DOCX table omission and ignored page breaks, PPTX entity text remaining escaped, XLS MIME inference using the XLSX MIME, and raw text/code without markup.

The tests also compare the baseline runtime directly, so parser outputs, MIME/source rules, errors and extract-document renderer behavior are independently exercised rather than only asserted against a local implementation.
