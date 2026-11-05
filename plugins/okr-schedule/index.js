import path from 'node:path';
import os from 'node:os';
import { createLegacyStore, LegacyStoreError } from './src/host/legacy.js';
import { createCompatibilityStore } from './src/host/compatibility.js';
import { createPluginService } from './src/host/service.js';
import { createDshAdapter } from './src/host/dsh-adapter.js';
import { registerRoutes } from './src/host/http.js';

export { createLegacyStore, LegacyStoreError } from './src/host/legacy.js';
export const inject = ['tools'];

function output(renderSuccess) {
  return {
    schema: { type: 'object' },
    render: (args, value) => [{
      type: 'text',
      text: value?.success === true ? renderSuccess(value) : `操作未完成: ${JSON.stringify(value)}`,
    }],
  };
}

function execute(work) {
  return async (args = {}) => {
    try { return await work(args); }
    catch (error) {
      return {
        success: false,
        code: error.code || 'STORAGE_ERROR',
        message: error.code ? error.message : '存储操作失败，未确认保存成功',
      };
    }
  };
}

/** Register compatibility tools against a trusted store, including a migration adapter. */
export function registerLegacyTools(ctx, store) {
  if (!ctx.tools) return;
  ctx.tools.register({
    name: 'okr_schedule_query',
    description: '查询目标、核心支撑点和日程。指定目标时仅返回该目标；日期默认按各空间时区取今天，all_dates=true 才查询全部日期。',
    parameters: {
      type: 'object',
      properties: {
        objective_id: { type: 'string', description: '指定目标 ID；省略时从可信全局入口查询所有目标' },
        date: { type: 'string', description: '查询日期 YYYY-MM-DD；省略时默认今天' },
        all_dates: { type: 'boolean', description: '显式查询全部日期，不能与 date 同时使用', default: false },
      },
    },
    output: output(value => JSON.stringify(value, null, 2)),
    execute: execute(args => store.query({ objectiveId: args.objective_id, date: args.date, allDates: args.all_dates })),
  });
  ctx.tools.register({
    name: 'okr_schedule_checkin',
    description: '为指定单次日程打卡并保存执行心得。归档目标、歧义 ID 和不能定位某次执行的周期日程拒绝写入。',
    parameters: {
      type: 'object',
      properties: {
        schedule_id: { type: 'string', description: '日程 ID' },
        objective_id: { type: 'string', description: '可选目标 ID，用于限定归属并消除歧义' },
        note: { type: 'string', description: '执行心得，可传空字符串清除心得' },
        status: { type: 'string', enum: ['completed', 'in_progress', 'skipped'], default: 'completed' },
        date: { type: 'string', description: '可选执行日期 YYYY-MM-DD' },
        occurrence_key: { type: 'string', description: '可选执行标识；旧 JSON 周期日程须先迁移分次执行模型' },
      },
      required: ['schedule_id'],
    },
    output: output(value => `打卡成功: ${JSON.stringify(value.schedule)}`),
    execute: execute(args => store.checkin({
      scheduleId: args.schedule_id, objectiveId: args.objective_id, status: args.status,
      note: args.note, date: args.date, occurrenceKey: args.occurrence_key,
    })),
  });
  ctx.tools.register({
    name: 'okr_inspiration_capture',
    description: '在指定的未归档目标下保存一条灵感，成功回执包含已落盘的灵感 ID。',
    parameters: {
      type: 'object',
      properties: {
        objective_id: { type: 'string', description: '归属目标 ID' },
        inspiration: { type: 'string', description: '灵感内容' },
      },
      required: ['objective_id', 'inspiration'],
    },
    output: output(value => `灵感已记录: ${value.inspiration.id}`),
    execute: execute(args => store.capture({ objectiveId: args.objective_id, inspiration: args.inspiration })),
  });
}

export function apply(ctx, config = {}) {
  const baseDir = path.join(os.homedir(), '.dsh_okr');
  const legacy = createLegacyStore({ baseDir });
  let currentAdapter = { available: false, disabledReason: '当前宿主未提供受控 Agent 服务' };
  const adapter = { get available() { return currentAdapter.available; }, get disabledReason() { return currentAdapter.disabledReason; }, open(options) { return currentAdapter.open(options); }, generate(options) { return currentAdapter.generate(options); } };
  let service;
  const getService = () => service ||= createPluginService({ baseDir, adapter });
  ctx.provide?.('okrTrace/v1', Object.freeze({
    version: 1,
    execute: (command, input, binding) => getService().trace.execute(command, input, binding),
  }));
  registerLegacyTools(ctx, createCompatibilityStore({ baseDir, legacy, getService }));
  ctx.inject?.(['agents'], host => {
    currentAdapter = createDshAdapter({ ctx: host, agentOptions: config.agentOptions || {} });
  });
  ctx.inject?.(['webServer'], host => {
    registerRoutes({ webServer: host.webServer, effect: work => host.effect(work), service: { execute: (...args) => getService().execute(...args) } });
  });
  ctx.effect?.(() => async () => { await service?.close(); await currentAdapter.close?.(); });
}
