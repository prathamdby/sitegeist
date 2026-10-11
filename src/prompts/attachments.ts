export const ATTACHMENTS_RUNTIME_DESCRIPTION = `
### User Attachments

Read files the user uploaded to the conversation.

#### When to Use
- Process user-uploaded files (CSV, JSON, Excel, images, PDFs)

#### Functions
- listAttachments() - List all attachments, returns array of {id, fileName, mimeType, size}
- readTextAttachment(id) - Read attachment as text, returns string
- readBinaryAttachment(id) - Read attachment as binary data, returns Uint8Array

Use listAttachments() to find a file by its fileName, then pass its id to a read function.
For CSV or JSON, use readTextAttachment(id). For Excel or images, use readBinaryAttachment(id).
`;

export const EXTRACT_DOCUMENT_DESCRIPTION = `# Extract Document

Extract plain text from documents on the web (PDF, DOCX, XLSX, PPTX).

## When to Use
User wants you to read a document at a URL.

## Input
- { url: "https://example.com/document.pdf" } - URL to PDF, DOCX, XLSX, or PPTX

## Returns
Structured plain text with page/sheet/slide delimiters.`;
