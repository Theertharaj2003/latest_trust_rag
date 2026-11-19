import { getDocumentProxy } from 'unpdf';
import mammoth from 'mammoth';
import { unzipSync } from 'fflate';
import { InputError } from './research.mjs';

export async function extractDocument(filename, buffer) {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'txt' || ext === 'md') {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch { throw new InputError('Text files must be UTF-8 encoded.', 400); }
  }
  if (!['pdf', 'docx'].includes(ext)) throw new InputError('Upload PDF, DOCX, TXT or Markdown.', 415);
  const deadline = Date.now() + 12000;
  let pdf;
  try {
    let text;
    if (ext === 'pdf') {
      // unpdf embeds its serverless PDF.js implementation, so no external worker
      // file or native graphics library needs to be copied into the deploy.
      pdf = await getDocumentProxy(new Uint8Array(buffer), { isEvalSupported: false, maxImageSize: 16777216, useSystemFonts: true });
      if (pdf.numPages > 300) throw new InputError('Document exceeds 300 pages. Upload a smaller PDF.');
      const pages = [];
      let chars = 0;
      for (let i = 1; i <= pdf.numPages; i++) {
        if (Date.now() > deadline) throw new InputError('Document processing exceeded 12 seconds. Upload a smaller PDF.');
        const page = await pdf.getPage(i), content = await page.getTextContent();
        let line = '';
        for (const item of content.items) if ('str' in item) line += item.str + (item.hasEOL ? '\n' : ' ');
        chars += line.length;
        if (chars > 2000000) throw new InputError('Extracted text exceeds 2 million characters.');
        pages.push(line); page.cleanup();
      }
      text = pages.join('\n');
    } else {
      let expanded = 0;
      unzipSync(buffer, { filter(entry) {
        expanded += entry.originalSize;
        if (expanded > 20 * 1024 * 1024) throw new InputError('DOCX expanded size exceeds 20 MB. Use a smaller document.');
        return false;
      } });
      text = (await mammoth.extractRawText({ buffer })).value;
    }
    if (text.length > 2000000) throw new InputError('Extracted text exceeds 2 million characters.');
    return text;
  } catch (err) {
    if (err instanceof InputError) throw err;
    throw new InputError('Unable to read this file. Upload a valid, unencrypted PDF or DOCX. Scanned-image PDFs require OCR.');
  } finally { if (pdf) await pdf.loadingTask.destroy(); }
}
