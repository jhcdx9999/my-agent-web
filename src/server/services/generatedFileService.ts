import zlib from "node:zlib";
import { promisify } from "node:util";
import { generateImage } from "./openaiClient";
import { writeGeneratedFile } from "./fileStore";
import type { ChatAttachment } from "../../shared/types";

type GeneratedFormat =
  | "pdf"
  | "docx"
  | "pptx"
  | "xlsx"
  | "png"
  | "jpg"
  | "html"
  | "md"
  | "txt"
  | "json"
  | "csv";

type FileRenderOptions = {
  apiKey?: string;
  baseUrl?: string;
};

const deflateRaw = promisify(zlib.deflateRaw);

const formatSpecs: Record<GeneratedFormat, { extension: string; mimeType: string }> = {
  pdf: { extension: "pdf", mimeType: "application/pdf" },
  docx: {
    extension: "docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  },
  pptx: {
    extension: "pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  },
  xlsx: {
    extension: "xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  },
  png: { extension: "png", mimeType: "image/png" },
  jpg: { extension: "jpg", mimeType: "image/jpeg" },
  html: { extension: "html", mimeType: "text/html; charset=utf-8" },
  md: { extension: "md", mimeType: "text/markdown; charset=utf-8" },
  txt: { extension: "txt", mimeType: "text/plain; charset=utf-8" },
  json: { extension: "json", mimeType: "application/json; charset=utf-8" },
  csv: { extension: "csv", mimeType: "text/csv; charset=utf-8" }
};

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const normalizeText = (value: string): string =>
  value
    .replace(/\r\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();

export const detectGeneratedFileFormat = (prompt: string): GeneratedFormat => {
  const value = prompt.toLowerCase();
  if (/\b(pptx?|powerpoint|幻灯片|演示文稿)\b/i.test(prompt)) return "pptx";
  if (/\b(docx?|word)\b/i.test(prompt)) return "docx";
  if (/\bpdf\b|\.pdf/i.test(prompt)) return "pdf";
  if (/\b(xlsx?|excel)\b|Excel|\.xlsx/i.test(prompt)) return "xlsx";
  if (/表格/i.test(prompt)) return "xlsx";
  if (/\bcsv\b|\.csv/i.test(prompt)) return "csv";
  if (/\bjson\b|\.json/i.test(prompt)) return "json";
  if (/\bhtml?\b|网页|\.html/i.test(prompt)) return "html";
  if (/\b(markdown|md)\b|\.md/i.test(prompt)) return "md";
  if (/\b(txt|text)\b|\.txt/i.test(prompt)) return "txt";
  if (/\b(jpe?g)\b|\.jpe?g/i.test(prompt)) return "jpg";
  if (/\bpng\b|\.png/i.test(prompt)) return "png";
  if (value.includes("图片") || value.includes("海报") || value.includes("插画")) return "png";
  return "md";
};

const stripMarkdownFence = (value: string): string =>
  normalizeText(value)
    .replace(/^```(?:\w+)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

const titleFromContent = (content: string): string => {
  const firstLine = normalizeText(content).split("\n").find(Boolean) ?? "Generated File";
  return firstLine.replace(/^#+\s*/, "").slice(0, 80) || "Generated File";
};

const htmlFromMarkdownish = (content: string): string => {
  const blocks = normalizeText(content).split(/\n{2,}/);
  const body = blocks
    .map((block) => {
      const lines = block.split("\n");
      const first = lines[0]?.trim() ?? "";
      if (/^#{1,3}\s+/.test(first)) {
        const level = Math.min(3, first.match(/^#+/)?.[0].length ?? 2);
        return `<h${level}>${escapeHtml(first.replace(/^#+\s*/, ""))}</h${level}>`;
      }
      if (lines.every((line) => /^[-*]\s+/.test(line.trim()))) {
        return `<ul>${lines.map((line) => `<li>${escapeHtml(line.replace(/^[-*]\s+/, ""))}</li>`).join("")}</ul>`;
      }
      return `<p>${lines.map(escapeHtml).join("<br />")}</p>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(titleFromContent(content))}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 860px; margin: 40px auto; padding: 0 24px; line-height: 1.72; color: #172033; }
    h1, h2, h3 { line-height: 1.25; color: #0b1220; }
    pre, code { background: #f3f6fb; border-radius: 6px; padding: 2px 5px; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
};

const wrapPdfText = (text: string, maxChars = 58): string[] => {
  const rows: string[] = [];
  for (const paragraph of normalizeText(text).split("\n")) {
    let line = paragraph.trim();
    if (!line) {
      rows.push("");
      continue;
    }
    while (line.length > maxChars) {
      rows.push(line.slice(0, maxChars));
      line = line.slice(maxChars);
    }
    rows.push(line);
  }
  return rows;
};

const pdfHexText = (value: string): string => {
  const buffer = Buffer.alloc(value.length * 2);
  for (let index = 0; index < value.length; index += 1) {
    buffer.writeUInt16BE(value.charCodeAt(index), index * 2);
  }
  return buffer.toString("hex").toUpperCase();
};

const renderPdf = (content: string): Buffer => {
  const pageWidth = 595;
  const pageHeight = 842;
  const margin = 54;
  const lineHeight = 16;
  const linesPerPage = Math.floor((pageHeight - margin * 2) / lineHeight);
  const lines = wrapPdfText(content);
  const pages = Math.max(1, Math.ceil(lines.length / linesPerPage));
  const objects: string[] = [];

  const addObject = (body: string): number => {
    objects.push(body);
    return objects.length;
  };

  const catalogId = addObject("<< /Type /Catalog /Pages 2 0 R >>");
  const pagesId = addObject("");
  const fontId = addObject(
    "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [ << /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> >> ] >>"
  );
  const pageIds: number[] = [];

  for (let pageIndex = 0; pageIndex < pages; pageIndex += 1) {
    const pageLines = lines.slice(pageIndex * linesPerPage, (pageIndex + 1) * linesPerPage);
    const textOps = [
      "BT",
      "/F1 11 Tf",
      `1 0 0 1 ${margin} ${pageHeight - margin} Tm`,
      "14 TL",
      ...pageLines.map((line, index) => `${index === 0 ? "" : "T* "}<${pdfHexText(line)}> Tj`),
      "ET"
    ].join("\n");
    const contentId = addObject(`<< /Length ${Buffer.byteLength(textOps)} >>\nstream\n${textOps}\nendstream`);
    const pageId = addObject(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`
    );
    pageIds.push(pageId);
  }

  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  const chunks = ["%PDF-1.4\n"];
  const offsets: number[] = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(chunks.join("")));
    chunks.push(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`);
  }
  const xrefOffset = Buffer.byteLength(chunks.join(""));
  chunks.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  offsets.slice(1).forEach((offset) => {
    chunks.push(`${String(offset).padStart(10, "0")} 00000 n \n`);
  });
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  return Buffer.from(chunks.join(""), "utf8");
};

const crcTable = (() => {
  const table: number[] = [];
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

const crc32 = (buffer: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const dosDateTime = (): { date: number; time: number } => {
  const now = new Date();
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  return { date, time };
};

const createZip = async (files: Array<{ path: string; data: string | Buffer }>): Promise<Buffer> => {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  const { date, time } = dosDateTime();
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.path, "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, "utf8");
    const compressed = await deflateRaw(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, central, end]);
};

const docxParagraph = (line: string): string =>
  `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line || " ")}</w:t></w:r></w:p>`;

const renderDocx = async (content: string): Promise<Buffer> => {
  const paragraphs = normalizeText(content).split("\n").map(docxParagraph).join("");
  return createZip([
    {
      path: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
    },
    {
      path: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
    },
    {
      path: "word/document.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`
    }
  ]);
};

const slideText = (content: string): string => {
  const lines = normalizeText(content).split("\n").filter(Boolean).slice(0, 12);
  const text = lines.map((line) => `<a:p><a:r><a:t>${escapeXml(line)}</a:t></a:r></a:p>`).join("");
  return text || "<a:p><a:r><a:t>Generated Presentation</a:t></a:r></a:p>";
};

const renderPptx = async (content: string): Promise<Buffer> =>
  createZip([
    {
      path: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`
    },
    {
      path: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`
    },
    {
      path: "ppt/_rels/presentation.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`
    },
    {
      path: "ppt/presentation.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`
    },
    {
      path: "ppt/slides/slide1.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Content"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="700000" y="600000"/><a:ext cx="10800000" cy="5600000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${slideText(content)}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
    }
  ]);

const columnName = (index: number): string => {
  let value = "";
  let current = index + 1;
  while (current > 0) {
    current -= 1;
    value = String.fromCharCode(65 + (current % 26)) + value;
    current = Math.floor(current / 26);
  }
  return value;
};

const rowsFromContent = (content: string): string[][] => {
  const stripped = stripMarkdownFence(content);
  const lines = stripped.split(/\r?\n/).filter((line) => line.trim());
  if (lines.some((line) => line.includes(","))) {
    return lines.map((line) => line.split(",").map((cell) => cell.trim().replace(/^"|"$/g, "")));
  }

  return [["内容"], ...lines.map((line) => [line.trim()])];
};

const renderXlsx = async (content: string): Promise<Buffer> => {
  const rows = rowsFromContent(content).slice(0, 500);
  const sheetData = rows
    .map((row, rowIndex) => {
      const cells = row
        .slice(0, 50)
        .map((cell, cellIndex) => {
          const ref = `${columnName(cellIndex)}${rowIndex + 1}`;
          return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(cell)}</t></is></c>`;
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");

  return createZip([
    {
      path: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`
    },
    {
      path: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    },
    {
      path: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`
    },
    {
      path: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`
    },
    {
      path: "xl/worksheets/sheet1.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetData}</sheetData></worksheet>`
    }
  ]);
};

const jsonFromContent = (content: string): string => {
  const stripped = stripMarkdownFence(content);
  try {
    return `${JSON.stringify(JSON.parse(stripped), null, 2)}\n`;
  } catch {
    return `${JSON.stringify({ title: titleFromContent(content), content: stripped }, null, 2)}\n`;
  }
};

const csvFromContent = (content: string): string => {
  const stripped = stripMarkdownFence(content);
  if (stripped.includes(",") || stripped.includes("\t")) {
    return `${stripped}\n`;
  }
  return `section,content\n"Generated","${stripped.replaceAll('"', '""')}"\n`;
};

const dataForFormat = async (
  content: string,
  format: GeneratedFormat,
  prompt: string,
  options: FileRenderOptions
): Promise<{ data: Buffer | string; mimeType: string; extension: string; note?: string }> => {
  const spec = formatSpecs[format];
  switch (format) {
    case "pdf":
      return { ...spec, data: renderPdf(content) };
    case "docx":
      return { ...spec, data: await renderDocx(content) };
    case "pptx":
      return { ...spec, data: await renderPptx(content) };
    case "xlsx":
      return { ...spec, data: await renderXlsx(content) };
    case "html":
      return { ...spec, data: htmlFromMarkdownish(content) };
    case "json":
      return { ...spec, data: jsonFromContent(content) };
    case "csv":
      return { ...spec, data: csvFromContent(content) };
    case "txt":
      return { ...spec, data: `${stripMarkdownFence(content)}\n` };
    case "png":
    case "jpg":
      if (options.apiKey) {
        const image = await generateImage(prompt, {
          apiKey: options.apiKey,
          baseUrl: options.baseUrl,
          outputFormat: format
        });
        return { data: image.buffer, mimeType: image.mimeType, extension: image.extension };
      }
      throw new Error("生成 PNG/JPG 需要先配置 API Key，以便调用图片生成模型。");
    case "md":
    default:
      return { ...formatSpecs.md, data: `${normalizeText(content)}\n` };
  }
};

export const buildGeneratedFilePrompt = (userPrompt: string, format: GeneratedFormat): string => `
请根据用户要求生成一个适合保存为 ${formatSpecs[format].extension.toUpperCase()} 文件的完整正文。
要求：
- 直接输出文件正文内容。
- 不要输出解释、寒暄或 Markdown 代码围栏。
- 如果目标是 PPT/PPTX，请按“封面标题 + 每页幻灯片标题 + 要点”的结构输出。
- 如果目标是 CSV/JSON，请输出合法、干净、可解析的数据内容。
- 如果目标是 PDF/Word/Markdown/TXT/HTML，请内容结构清晰，标题、段落、列表完整。
用户要求：${userPrompt}
`.trim();

export const createGeneratedFile = async (
  userPrompt: string,
  content: string,
  options: FileRenderOptions = {}
): Promise<{ attachment: ChatAttachment; format: GeneratedFormat; note?: string }> => {
  const format = detectGeneratedFileFormat(userPrompt);
  const rendered = await dataForFormat(content, format, userPrompt, options);
  const filename = `${Date.now()}-generated-document.${rendered.extension}`;
  const attachment = await writeGeneratedFile(filename, rendered.data, rendered.mimeType);

  return {
    attachment: {
      ...attachment,
      mimeType: rendered.mimeType,
      kind: rendered.mimeType.startsWith("image/") || rendered.extension === "svg" ? "image" : attachment.kind
    },
    format,
    note: rendered.note
  };
};
