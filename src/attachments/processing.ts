import { parseAsync } from "docx-preview";
import JSZip from "jszip";
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy, PDFWorker } from "pdfjs-dist";
import { read, utils } from "xlsx";
import type { Attachment } from "./types.js";

GlobalWorkerOptions.workerSrc = "pdfjs-dist/build/pdf.worker.min.mjs";

export async function loadPdfDocument(
	data: ArrayBuffer | Uint8Array,
	signal?: AbortSignal,
): Promise<{
	document: PDFDocumentProxy;
	destroy(): Promise<void>;
}> {
	if (signal?.aborted) throw new DOMException("PDF loading aborted", "AbortError");
	const workerUrl =
		location.protocol === "chrome-extension:"
			? chrome.runtime.getURL(GlobalWorkerOptions.workerSrc)
			: new URL(GlobalWorkerOptions.workerSrc, document.baseURI).href;
	const port = new Worker(workerUrl, { type: "module" });
	const worker = PDFWorker.create({ port });
	const loading = getDocument({
		data: data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0)),
		worker,
		isEvalSupported: false,
	});
	let onAbort: () => void;
	let onWorkerError: (event: ErrorEvent) => void;
	const interrupted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(new DOMException("PDF loading aborted", "AbortError"));
		onWorkerError = (event) => reject(new Error(event.message || "Failed to load PDF worker"));
		signal?.addEventListener("abort", onAbort, { once: true });
		port.addEventListener("error", onWorkerError, { once: true });
	});
	let destroyed = false;
	const destroy = async () => {
		if (destroyed) return;
		destroyed = true;
		try {
			await loading.destroy();
		} finally {
			worker.destroy();
			port.terminate();
		}
	};
	try {
		return { document: await Promise.race([loading.promise, interrupted]), destroy };
	} catch (error) {
		await destroy();
		throw error;
	} finally {
		signal?.removeEventListener("abort", onAbort!);
		port.removeEventListener("error", onWorkerError!);
	}
}

interface DocumentNode {
	type: string;
	text?: string;
	children?: DocumentNode[];
}

interface ParsedWordDocument {
	documentPart: { body: DocumentNode };
}

const documentTypes: Record<string, string> = {
	pdf: "application/pdf",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	xls: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const textExtensions = new Set(["txt", "md", "json", "xml", "html", "css", "js", "ts", "jsx", "tsx", "yaml", "yml"]);

export async function loadAttachment(
	source: string | File | Blob | ArrayBuffer,
	fileName?: string,
): Promise<Attachment> {
	let bytes: ArrayBuffer;
	let mimeType = "";
	if (typeof source === "string") {
		const response = await fetch(source);
		if (!response.ok) throw new Error("Failed to fetch file");
		const blob = await response.blob();
		bytes = await blob.arrayBuffer();
		mimeType = blob.type;
		fileName ||= source.split("/").pop() || "document";
	} else if (source instanceof Blob) {
		bytes = await source.arrayBuffer();
		mimeType = source.type;
		fileName ||= source instanceof File ? source.name : "unnamed";
	} else {
		bytes = source;
		fileName ||= "unnamed";
	}

	const extension = fileName.split(".").pop()?.toLowerCase() || "";
	if (
		mimeType === "text/plain" ||
		!(
			mimeType.startsWith("image/") ||
			mimeType.startsWith("text/") ||
			Object.values(documentTypes).includes(mimeType) ||
			mimeType === "application/vnd.ms-excel"
		)
	) {
		mimeType = documentTypes[extension] || (textExtensions.has(extension) ? "text/plain" : mimeType);
	}
	mimeType ||= "application/octet-stream";
	const data = new Uint8Array(bytes);
	let binary = "";
	for (let offset = 0; offset < data.length; offset += 32768) {
		binary += String.fromCharCode(...data.subarray(offset, offset + 32768));
	}
	const content = btoa(binary);
	const attachment: Attachment = {
		id: `${fileName}_${Date.now()}_${Math.random()}`,
		type: mimeType.startsWith("image/") ? "image" : "document",
		fileName,
		mimeType,
		size: bytes.byteLength,
		content,
	};
	if (attachment.type === "image") {
		attachment.preview = content;
		return attachment;
	}
	if (mimeType.startsWith("text/")) {
		attachment.extractedText = new TextDecoder().decode(bytes);
		return attachment;
	}

	let format: "PDF" | "DOCX" | "PPTX" | "Excel";
	if (mimeType === documentTypes.pdf) format = "PDF";
	else if (mimeType === documentTypes.docx) format = "DOCX";
	else if (mimeType === documentTypes.pptx) format = "PPTX";
	else if (mimeType === documentTypes.xlsx || mimeType === "application/vnd.ms-excel") format = "Excel";
	else throw new Error(`Unsupported file type: ${mimeType}`);

	try {
		if (format === "PDF") {
			const loaded = await loadPdfDocument(bytes);
			try {
				const pdf = loaded.document;
				const pages: string[] = [];
				for (let number = 1; number <= pdf.numPages; number++) {
					const page = await pdf.getPage(number);
					const text = await page.getTextContent();
					pages.push(
						`<page number="${number}">\n${text.items.map((item) => ("str" in item ? item.str : "")).join(" ")}\n</page>`,
					);
					if (number === 1) {
						const canvas = document.createElement("canvas");
						const viewport = page.getViewport({ scale: 160 / page.getViewport({ scale: 1 }).width });
						canvas.width = viewport.width;
						canvas.height = viewport.height;
						await page.render({ canvas, viewport }).promise;
						attachment.preview = canvas.toDataURL("image/png").split(",")[1];
					}
					page.cleanup();
				}
				attachment.extractedText = `<pdf filename="${fileName}">\n${pages.join("\n")}\n</pdf>`;
			} finally {
				await loaded.destroy();
			}
		} else if (format === "DOCX") {
			const parsed: ParsedWordDocument = await parseAsync(bytes);
			const paragraphText = (node: DocumentNode): string =>
				node.type === "text" ? (node.text ?? "") : (node.children?.map(paragraphText).join("") ?? "");
			const paragraphs = (parsed.documentPart.body.children ?? [])
				.filter((node) => node.type === "paragraph")
				.map(paragraphText)
				.filter((text) => text.trim());
			attachment.extractedText = `<docx filename="${fileName}">\n<page number="1">\n${paragraphs.join("\n")}\n</page>\n</docx>`;
		} else if (format === "PPTX") {
			const zip = await JSZip.loadAsync(bytes);
			const slides = Object.keys(zip.files)
				.filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
				.sort((a, b) => Number(a.match(/slide(\d+)/)?.[1]) - Number(b.match(/slide(\d+)/)?.[1]));
			const parts: string[] = [];
			for (let index = 0; index < slides.length; index++) {
				const xml = await zip.files[slides[index]].async("string");
				const text = Array.from(xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g), (match) => match[1]);
				parts.push(`<slide number="${index + 1}">\n${text.join("\n")}\n</slide>`);
			}
			attachment.extractedText = `<pptx filename="${fileName}">\n${parts.join("\n")}\n</pptx>`;
		} else {
			const workbook = read(bytes, { type: "array" });
			const sheets = workbook.SheetNames.map(
				(name, index) =>
					`<sheet name="${name}" index="${index + 1}">\n${utils.sheet_to_csv(workbook.Sheets[name])}\n</sheet>`,
			);
			attachment.extractedText = `<excel filename="${fileName}">\n${sheets.join("\n")}\n</excel>`;
		}
	} catch (error) {
		throw new Error(`Failed to process ${format}: ${String(error)}`);
	}
	return attachment;
}
