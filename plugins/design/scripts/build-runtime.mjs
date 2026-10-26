import { build } from 'esbuild';
const result = await build({
  entryPoints: ['src/design-runtime/browser.js'], outfile: 'dist/design-runtime/support.js',
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome110', minify: true,
  metafile: true, legalComments: 'none',
});
const external = Object.keys(result.metafile.inputs).filter(p => !p.startsWith('src/design-runtime/'));
if (external.length) throw new Error(`Runtime contains external code: ${external.join(', ')}`);
console.log('Local DOM runtime -> dist/design-runtime/support.js (no bundled dependencies)');
