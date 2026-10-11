import JSZip from "jszip";
import * as XLSX from "xlsx";

export function pdfFixture() {
	const text = ["PDF fixture page one", "PDF fixture page two"];
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 180] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
		`<< /Length ${text[0].length + 33} >>\nstream\nBT /F1 16 Tf 20 100 Td (${text[0]}) Tj ET\nendstream`,
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 180] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
		`<< /Length ${text[1].length + 33} >>\nstream\nBT /F1 16 Tf 20 100 Td (${text[1]}) Tj ET\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let pdf = "%PDF-1.4\n";
	const offsets = [0];
	for (const [index, object] of objects.entries()) {
		offsets.push(Buffer.byteLength(pdf));
		pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const start = Buffer.byteLength(pdf);
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
		.slice(1)
		.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
		.join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
	return Buffer.from(pdf);
}

export async function documentFixtures() {
	const docx = new JSZip();
	docx.file(
		"[Content_Types].xml",
		'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
	);
	docx.file(
		"_rels/.rels",
		'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
	);
	docx.file(
		"word/document.xml",
		'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX fixture heading</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>',
	);
	const workbook = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(
		workbook,
		XLSX.utils.aoa_to_sheet([
			["Name", "Value"],
			["Alpha", 42],
			["<script>unsafe</script>", 7],
		]),
		"Data",
	);
	XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Second sheet"], ["Beta"]]), "Notes");
	return [
		{
			id: "pdf",
			type: "document",
			fileName: "report.pdf",
			mimeType: "application/pdf",
			bytes: pdfFixture(),
			extractedText: "PDF fixture page one\nPDF fixture page two",
		},
		{
			id: "docx",
			type: "document",
			fileName: "memo.docx",
			mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			bytes: await docx.generateAsync({ type: "nodebuffer" }),
			extractedText: "DOCX fixture heading\nSecond paragraph",
		},
		{
			id: "xlsx",
			type: "document",
			fileName: "data.xlsx",
			mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			bytes: XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }),
			extractedText: "Sheet: Data\nName\tValue\nAlpha\t42\nSheet: Notes\nSecond sheet\nBeta",
		},
	].map(({ bytes, ...fields }) => ({ ...fields, content: bytes.toString("base64"), size: bytes.length }));
}
