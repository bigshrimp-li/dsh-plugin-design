const tokens = new Map();

async function read(response) {
  try {
    return await response.json();
  } catch {
    throw new Error('个人助手服务未就绪，请重新启用插件或重启DSH');
  }
}

export async function api(command, input = {}, oid = null, retry = true) {
  if (!tokens.has(oid)) {
    const query = oid ? '?objectiveId=' + encodeURIComponent(oid) : '';
    const response = await fetch('/okr-space/api/bootstrap' + query, {
      headers: { 'x-okr-client': 'workbench' },
    });
    const result = await read(response);
    if (!response.ok || !result.token) throw new Error(result.error?.message || '无法连接目标日程服务');
    tokens.set(oid, result.token);
  }
  const response = await fetch('/okr-space/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokens.get(oid) },
    body: JSON.stringify({ command, input }),
  });
  const result = await read(response);
  if (result.error?.code === 'CAPABILITY_EXPIRED' && retry) {
    tokens.delete(oid);
    return api(command, input, oid, false);
  }
  if (!response.ok || !['read', 'saved', 'accepted', 'trial', 'pending'].includes(result.kind)) {
    throw Object.assign(new Error(result.error?.message || '操作未完成'), {
      code: result.error?.code,
      result,
    });
  }
  return result.data;
}
