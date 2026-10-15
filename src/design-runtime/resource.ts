/** Shared runtime resource for the editor, renderer and HTML exporter. */
import { fileURLToPath } from 'node:url';
import { templateText } from './markup.ts';
export function runtimePath(): string {
  return fileURLToPath(new URL('./support.js', import.meta.url));
}
/** Preserve the original template before the browser repairs table/select markup. */
export function prepareBoardHtml(html: string): string {
  const payload = JSON.stringify(templateText(html)).replace(/</g, '\\u003c');
  const tag = `<script type="application/json" data-design-template>${payload}</script>`;
  return html.replace(/<x-dc(?:\s[^>]*)?>/i, match => tag + match);
}
