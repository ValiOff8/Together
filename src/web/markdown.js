import { marked } from './vendor/marked.js';
import DOMPurify from './vendor/dompurify.js';

export function renderMarkdown(source) {
  // Limit output to document content: shared notes must not introduce app controls.
  return DOMPurify.sanitize(marked.parse(source, { gfm: true, async: false }), {
    ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del',
      'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input'],
    ALLOWED_ATTR: ['href', 'title', 'src', 'alt', 'start', 'align', 'type', 'checked', 'disabled'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
}
