# Browser libraries

These pinned distributions are served locally, including in the Docker image. No CDN or install step is required at runtime.

- [Marked](https://github.com/markedjs/marked), version 18.1.1: `lib/marked.esm.js` from the npm package, saved as `marked.js`. MIT license in `marked.LICENSE`.
- [DOMPurify](https://github.com/cure53/DOMPurify), version 3.4.17: `dist/purify.es.mjs` from the npm package, saved as `dompurify.js`. Dual Apache-2.0 / MPL-2.0 licenses in `dompurify.LICENSE` and `dompurify.LICENSE-MPL`.

To update, copy the corresponding files and licenses from a reviewed npm release, update the versions here, and verify Markdown rendering and sanitization in the browser.
