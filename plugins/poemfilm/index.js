import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const inject = ['tools'];

const runFile = promisify(execFile);
const launcher = fileURLToPath(new URL('./bin/poemfilm', import.meta.url));
const asset = { type: 'string', enum: ['script', 'art', 'voice'], description: '分镜、原画或声音。' };
const target = { type: 'string', minLength: 1, description: '原画填本版镜头 ID，声音填台词 ID。' };
const delivery = { type: 'string', minLength: 1, description: '描述这一段声音的演绎方式。' };

function failure(code, message) {
  return { schema_version: 1, ok: false, command: null, error: { code, message } };
}

async function run(args) {
  let stdout;
  let exitedWithError = false;
  try {
    ({ stdout } = await runFile(launcher, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EACCES') {
      return failure('launcher_unavailable', '无法启动插件自带的 bin/poemfilm，请检查安装路径和执行权限。');
    }
    stdout = error.stdout;
    exitedWithError = true;
  }
  try {
    const result = JSON.parse(stdout);
    if (result?.schema_version === 1) {
      if (result.ok === false && typeof result.error?.code === 'string') return result;
      if (result.ok === true && !exitedWithError && Object.hasOwn(result, 'data')) return result;
    }
  } catch {
    // 启动器或中断的子进程可能没有留下 CLI 的 JSON 输出。
  }
  return failure('cli_result_unavailable', '未收到完整的 CLI 结果。请用 bin/poemfilm --version 检查环境，缺少依赖时运行 bin/poemfilm --setup。生成请求应先核对任务记录。');
}

function generationArgs({ asset, target, delivery }) {
  if (asset === 'script') {
    if (target || delivery) throw new Error('分镜无需指定 target 或 delivery。');
    return [];
  }
  if (!target) throw new Error('请填写本版 show 返回的 target。');
  if (asset === 'art') {
    if (delivery) throw new Error('只有声音需要 delivery。');
    return [`--shot=${target}`];
  }
  if (!delivery) throw new Error('声音需要填写 delivery。');
  return [`--line=${target}`, `--delivery=${delivery}`];
}

export function apply(ctx, config = {}) {
  const work = config.work ?? process.env.POEMFILM_WORK;
  const edition = config.edition ?? process.env.POEMFILM_EDITION;
  const job = config.job ?? process.env.POEMFILM_JOB;
  const allowEdit = config.allowEdit ?? (process.env.POEMFILM_ALLOW_EDIT === '1');
  const bound = typeof work === 'string' && isAbsolute(work) && typeof edition === 'string' && edition.trim();
  const editionArg = `--edition=${edition}`;

  function register(name, description, properties, required, buildArgs) {
    ctx.tools.register({
      name: `poemfilm_${name}`,
      description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
      output: {
        schema: { type: 'object' },
        render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
      },
      async execute(args = {}) {
        if (!bound) return failure('work_unbound', '请在 DSH 宿主配置 work（作品绝对目录）与 edition（版本），或设置 POEMFILM_WORK、POEMFILM_EDITION 后重启宿主。');
        if (!args || typeof args !== 'object' || Array.isArray(args)) return failure('invalid_arguments', '工具参数须为对象。');
        try {
          for (const [key, value] of Object.entries(args)) {
            if (!Object.hasOwn(properties, key)) throw new Error(`未知参数 ${key}。`);
            const { enum: choices } = properties[key];
            if (typeof value !== 'string' || !value.trim() || value.includes('\0') || (choices && !choices.includes(value))) {
              throw new Error(`参数 ${key} 的取值无效。`);
            }
          }
          for (const key of required) {
            if (!Object.hasOwn(args, key)) throw new Error(`缺少参数 ${key}。`);
          }
          return run([`--work=${work}`, '--json', ...buildArgs(args)]);
        } catch (error) {
          return failure('invalid_arguments', error.message);
        }
      },
    });
  }

  register('show', '列出绑定版本的镜头、台词、候选与选择。', {}, [], () => ['show', editionArg]);
  register('plan', '按声音排镜并检查绑定版本的素材。', {}, [], () => ['plan', editionArg]);
  register('verify', '检查绑定版本的实际成片并列出人工审看项。', {}, [], () => ['verify', editionArg]);
  register('status', '查看本机凭证和赠金准入状态。', {}, [], () => ['auth', 'status']);
  register('estimate', '在本地估算一个生成请求。', { asset, target, delivery }, ['asset'], args =>
    ['generate', args.asset, editionArg, '--estimate-only', ...generationArgs(args)]);
  if (typeof job === 'string' && job.trim()) {
    register('job_status', '查看绑定任务的预算与预留。', {}, [], () => ['job', 'status', `--job=${job}`]);
    register('generate', '使用绑定任务的预算生成一个候选。', {
      asset, target, delivery,
      max_usd: { type: 'string', minLength: 1, description: '本次额度，以十进制美元字符串填写。' },
      take: { type: 'string', minLength: 1, description: '候选名称。重试已知任务时沿用相同名称。' },
    }, ['asset', 'max_usd'], args => [
      'generate', args.asset, editionArg, `--job=${job}`, `--max-usd=${args.max_usd}`,
      ...generationArgs(args), ...(args.take ? [`--take=${args.take}`] : []),
    ]);
  }
  if (allowEdit === true) {
    register('select', '将一个已有候选选入绑定版本。', {
      asset, candidate: { type: 'string', minLength: 1, description: 'show 返回的候选 ID。' },
    }, ['asset', 'candidate'], args => ['select', args.asset, editionArg, '--', args.candidate]);
    register('render', '按锁定的时间线在本地导出绑定版本。', {}, [], () => ['render', editionArg]);
  }
}
