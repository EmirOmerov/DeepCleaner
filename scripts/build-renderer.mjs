// Bundles the renderer and the sandboxed preload (which cannot require local
// files), then copies static renderer assets into dist/. Runs after `tsc`.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');

await build({
  entryPoints: [join(root, 'src/renderer/app.ts')],
  outfile: join(out, 'renderer/app.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome130',
  sourcemap: true,
});

await build({
  entryPoints: [join(root, 'src/preload/preload.ts')],
  outfile: join(out, 'preload/preload.js'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: ['electron'],
  target: 'node22',
});

mkdirSync(join(out, 'renderer'), { recursive: true });
for (const f of ['index.html', 'styles.css']) {
  copyFileSync(join(root, 'src/renderer', f), join(out, 'renderer', f));
}
console.log('renderer + preload bundled');
