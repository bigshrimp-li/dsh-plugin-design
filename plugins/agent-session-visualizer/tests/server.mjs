import assert from 'node:assert/strict';
import { createAsvServer } from '../server.mjs';

const server = createAsvServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  assert.equal(response.status, 200);
  const policy = response.headers.get('content-security-policy');
  const ancestors = policy.match(/frame-ancestors ([^;]+)/)?.[1].split(' ');
  assert.ok(ancestors.includes('dsh-app://app'), 'DSH custom-scheme parent must be allowed explicitly');
  assert.ok(ancestors.includes("'self'"));
  assert.ok(ancestors.includes('http://127.0.0.1:*'));
  assert.ok(!ancestors.includes('*'), 'frame ancestors must stay limited to the DSH app and local pages');
  assert.match(await response.text(), /app\.js/);
  console.log('PASS: DSH custom-scheme frame embedding and static entrypoint headers');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
