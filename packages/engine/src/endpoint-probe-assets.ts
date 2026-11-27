import { crc32, deflateSync } from "node:zlib";
import type { ToolImage } from "@agenteschat/providers";

const DIGITS = ["75557", "26227", "71747", "71717", "55711", "74717", "74757", "71111", "75757", "75717"];

/** Render a short challenge into a real PNG without relying on system fonts or native drawing packages. */
export function probeImage(code: string): ToolImage {
  const scale = 14;
  const w = (code.length * 4 + 1) * scale;
  const h = 7 * scale;
  const pixels = Buffer.alloc((w + 1) * h, 255);
  for (let y = 0; y < h; y++) pixels[y * (w + 1)] = 0;
  for (const [i, digit] of [...code].entries()) {
    for (const [y, row] of [...(DIGITS[Number(digit)] ?? "")].entries()) {
      for (let x = 0; x < 3; x++) {
        if (!(Number(row) & (4 >> x))) continue;
        for (let dy = 0; dy < scale; dy++) {
          const start = ((y + 1) * scale + dy) * (w + 1) + (i * 4 + x + 1) * scale + 1;
          pixels.fill(0, start, start + scale);
        }
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w);
  header.writeUInt32BE(h, 4);
  header[8] = 8;
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4);
    return out;
  };
  const png = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return { mediaType: "image/png", data: png.toString("base64") };
}

export function probePdf(code: string): ToolImage {
  const text = `BT /F 28 Tf 20 36 Td (${code}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  let table = "0000000000 65535 f \n";
  for (const [i, object] of objects.entries()) {
    table += `${String(pdf.length).padStart(10, "0")} 00000 n \n`;
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = pdf.length;
  pdf += `xref\n0 6\n${table}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return { mediaType: "application/pdf", name: "probe.pdf", pages: 1, data: Buffer.from(pdf).toString("base64") };
}
