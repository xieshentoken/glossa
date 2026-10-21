/** A small PDF with one line of text per entry (see make-pdf.mjs). */
export function makePdf(lines: string[]): Uint8Array;
/** A PDF with one page per entry, each with its own lines. */
export function makePdfPages(pages: string[][]): Uint8Array;
