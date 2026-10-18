// Minimal single-page PDF with Helvetica text lines, for tests. No dependencies.

export function makePdf(lines) {
  return makePdfPages([lines]);
}

/** One page per entry of `pages` (each a list of lines). */
export function makePdfPages(pages) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  // 1 catalog, 2 pages, 3 font, 4 info, then a page + content object per page.
  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Title (Fixture paper) >>',
  ];
  pages.forEach((lines, i) => {
    const content = ['BT', '/F1 13 Tf', '16 TL', '60 760 Td', ...lines.map((l) => `(${esc(l)}) Tj T*`), 'ET'].join('\n');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${6 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
