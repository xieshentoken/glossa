// Allow-list sanitizer for document HTML shown inside the app (Word, Markdown,
// local HTML files). Scripts, event handlers, forms and remote resources are removed.

const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div',
  'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark',
  'ol', 'p', 'pre', 'q', 's', 'samp', 'section', 'article', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'main', 'header', 'footer', 'aside', 'time',
]);
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'form', 'svg', 'math', 'link', 'meta', 'base']);
const ALLOWED_ATTRS = new Set(['href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'lang', 'dir', 'id', 'start', 'datetime']);

export function sanitizeHtml(html: string): { html: string; lang?: string; title?: string } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const lang = doc.documentElement.getAttribute('lang') || undefined;
  const title = doc.querySelector('title')?.textContent?.trim() || undefined;
  const clean = (el: Element) => {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase();
      if (DROP_WITH_CONTENT.has(tag)) {
        child.remove();
        continue;
      }
      clean(child);
      if (!ALLOWED_TAGS.has(tag)) {
        child.replaceWith(...Array.from(child.childNodes));
        continue;
      }
      for (const a of Array.from(child.attributes)) {
        const name = a.name.toLowerCase();
        const v = a.value.trim();
        const ok =
          ALLOWED_ATTRS.has(name) &&
          !(name === 'href' && !/^(https?:|#|mailto:)/i.test(v)) &&
          !(name === 'src' && !/^data:image\//i.test(v));
        if (!ok) child.removeAttribute(a.name);
      }
      if (tag === 'a') child.setAttribute('rel', 'noreferrer');
    }
  };
  clean(doc.body);
  return { html: doc.body.innerHTML, lang, title };
}
