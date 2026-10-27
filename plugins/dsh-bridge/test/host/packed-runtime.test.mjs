import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('loads the distributed Host and its SDK without the Core checkout or workspace node_modules', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-bridge-packed-'));
  try {
    await cp(new URL('../../dist/', import.meta.url), join(directory, 'dist'), { recursive: true });
    await writeFile(join(directory, 'package.json'), '{"type":"module"}\n');
    const probe = `
      const host = await import('./dist/host/index.js');
      const { createCoreServiceFor } = await import('./dist/host/core-service.js');
      if (typeof host.apply !== 'function') throw new Error('Missing Host entry');
      const service = await createCoreServiceFor({ options: { home: '.', socketPath: './absent.sock' }, client: {} });
      if (typeof service.subscribe !== 'function') throw new Error('Missing bundled SDK service');
      console.log('PACKED_HOST_OK');
    `;
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: directory, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' },
    })).toContain('PACKED_HOST_OK');
    // The same distribution also boots in DSH's actual Electron Node runtime.
    if (process.env.DSH_ELECTRON) {
      expect(execFileSync(process.env.DSH_ELECTRON, ['--input-type=module', '-e', probe], {
        cwd: directory, encoding: 'utf8', env: { ...process.env, NODE_PATH: '', ELECTRON_RUN_AS_NODE: '1' },
      })).toContain('PACKED_HOST_OK');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
