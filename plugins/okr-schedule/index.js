import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const inject = ['tools'];

const BASE_DIR = path.join(os.homedir(), '.dsh_okr');

/**
 * 目标与日程管理插件 Host 端 (V2.2 增强版)
 * 采用 ~/.dsh_okr 目录深度组织，按 O 分组存储元数据、正文、日程与复盘
 * 提供全流程的自主编辑、增删改查与 Agent Tools 接口
 */
export function apply(ctx) {
  // 确保存储根目录存在
  if (!fs.existsSync(BASE_DIR)) {
    fs.mkdirSync(BASE_DIR, { recursive: true });
  }

  /**
   * 从 ~/.dsh_okr 读取全量数据
   */
  function loadAllData() {
    const indexPath = path.join(BASE_DIR, 'global_index.json');
    if (!fs.existsSync(indexPath)) {
      return { objectives: [], key_points: [], schedules: [], inspirations: [], results: [] };
    }

    try {
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      const objectives = [];
      const keyPoints = [];
      const schedules = [];
      const inspirations = [];
      const results = [];

      for (const item of (index.objectives || [])) {
        const oDir = path.join(BASE_DIR, item.id);
        if (!fs.existsSync(oDir)) continue;

        // 1. 读取 meta.json
        const metaPath = path.join(oDir, 'meta.json');
        const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf-8')) : item;
        objectives.push(meta);

        // 2. 读取 keypoints.json
        const kpPath = path.join(oDir, 'keypoints.json');
        if (fs.existsSync(kpPath)) {
          const kps = JSON.parse(fs.readFileSync(kpPath, 'utf-8'));
          kps.forEach(k => {
            keyPoints.push({ ...k, objective_id: item.id });
          });
        }

        // 3. 读取 schedules.json
        const schPath = path.join(oDir, 'schedules.json');
        if (fs.existsSync(schPath)) {
          const schs = JSON.parse(fs.readFileSync(schPath, 'utf-8'));
          schs.forEach(s => {
            schedules.push({ ...s, objective_id: item.id });
          });
        }

        // 4. 读取 inspirations.json
        const insPath = path.join(oDir, 'inspirations.json');
        if (fs.existsSync(insPath)) {
          const inss = JSON.parse(fs.readFileSync(insPath, 'utf-8'));
          inss.forEach(i => {
            inspirations.push({ ...i, objective_id: item.id });
          });
        }

        // 5. 读取 results.json
        const resPath = path.join(oDir, 'results.json');
        if (fs.existsSync(resPath)) {
          const ress = JSON.parse(fs.readFileSync(resPath, 'utf-8'));
          ress.forEach(r => {
            results.push({ ...r, target_id: r.target_id || item.id });
          });
        }
      }

      return { objectives, key_points: keyPoints, schedules, inspirations, results };
    } catch (e) {
      console.error('[OKR-Plugin-Host] Failed to load data:', e);
      return { objectives: [], key_points: [], schedules: [], inspirations: [], results: [] };
    }
  }

  /**
   * 保存或更新日程
   */
  function saveOrUpdateSchedule(scheduleData) {
    const oId = scheduleData.objective_id;
    const oDir = path.join(BASE_DIR, oId);
    if (!fs.existsSync(oDir)) return null;

    const schPath = path.join(oDir, 'schedules.json');
    let schs = fs.existsSync(schPath) ? JSON.parse(fs.readFileSync(schPath, 'utf-8')) : [];

    const isExisting = scheduleData.id && schs.some(s => s.id === scheduleData.id);
    if (isExisting) {
      schs = schs.map(s => s.id === scheduleData.id ? { ...s, ...scheduleData } : s);
    } else {
      const newSchedule = {
        id: scheduleData.id || 'SCH_' + Date.now(),
        ...scheduleData
      };
      schs.push(newSchedule);
      scheduleData = newSchedule;
    }

    fs.writeFileSync(schPath, JSON.stringify(schs, null, 2), 'utf-8');
    return scheduleData;
  }

  /**
   * 删除日程
   */
  function deleteSchedule(scheduleId) {
    const data = loadAllData();
    const target = data.schedules.find(s => s.id === scheduleId);
    if (!target) return false;

    const oDir = path.join(BASE_DIR, target.objective_id);
    const schPath = path.join(oDir, 'schedules.json');
    if (fs.existsSync(schPath)) {
      let schs = JSON.parse(fs.readFileSync(schPath, 'utf-8'));
      schs = schs.filter(s => s.id !== scheduleId);
      fs.writeFileSync(schPath, JSON.stringify(schs, null, 2), 'utf-8');
      return true;
    }
    return false;
  }

  /**
   * 保存特定日程状态与打卡心得
   */
  function saveScheduleCheckin(scheduleId, status, note) {
    const data = loadAllData();
    const target = data.schedules.find(s => s.id === scheduleId);
    if (!target) return null;

    target.status = status || 'completed';
    if (note) target.checkin_note = note;

    const oDir = path.join(BASE_DIR, target.objective_id);
    const schPath = path.join(oDir, 'schedules.json');
    if (fs.existsSync(schPath)) {
      const schs = JSON.parse(fs.readFileSync(schPath, 'utf-8'));
      const idx = schs.findIndex(s => s.id === scheduleId);
      if (idx !== -1) {
        schs[idx].status = target.status;
        if (note) schs[idx].checkin_note = note;
        fs.writeFileSync(schPath, JSON.stringify(schs, null, 2), 'utf-8');
      }
    }
    return target;
  }

  /**
   * 保存新灵感到对应 O
   */
  function saveInspiration(objectiveId, text) {
    const oDir = path.join(BASE_DIR, objectiveId);
    if (!fs.existsSync(oDir)) return null;

    const insPath = path.join(oDir, 'inspirations.json');
    const inss = fs.existsSync(insPath) ? JSON.parse(fs.readFileSync(insPath, 'utf-8')) : [];
    const item = {
      id: 'INS_' + Date.now(),
      date: new Date().toISOString().slice(0, 10),
      text: text
    };
    inss.unshift(item);
    fs.writeFileSync(insPath, JSON.stringify(inss, null, 2), 'utf-8');
    return item;
  }

  // 注册面向 Agent 的专属智能体工具
  if (ctx.tools) {
    // 1. 查询目标与今日日程
    ctx.tools.register({
      name: 'okr_schedule_query',
      description: '查询当前用户的目标(O)、核心支撑点(K)及今日日程(Schedule)执行情况。数据来源自 ~/.dsh_okr 目录。',
      parameters: {
        type: 'object',
        properties: {
          objective_id: { type: 'string', description: '可选：指定目标ID，如 O_super_agent, O_learn_english' },
          date: { type: 'string', description: '可选：指定查询日期，格式 YYYY-MM-DD，默认今天' }
        }
      },
      output: {
        schema: { type: 'object' },
        render: (args, val) => [{ type: 'text', text: JSON.stringify(val, null, 2) }]
      },
      async execute(args) {
        const meta = loadAllData();
        let schedules = meta.schedules || [];
        if (args.date) {
          schedules = schedules.filter(s => s.date === args.date);
        }
        if (args.objective_id) {
          schedules = schedules.filter(s => s.objective_id === args.objective_id);
        }
        return {
          objectives: meta.objectives || [],
          key_points: meta.key_points || [],
          schedules: schedules
        };
      }
    });

    // 2. 日程打卡
    ctx.tools.register({
      name: 'okr_schedule_checkin',
      description: '为用户的指定日程完成打卡，更新 ~/.dsh_okr 对应目标目录下的 schedules.json，标记状态为 completed 并记录执行心得。',
      parameters: {
        type: 'object',
        properties: {
          schedule_id: { type: 'string', description: '日程 ID，例如 SCH_REC_duolingo, SCH_20261025_01' },
          note: { type: 'string', description: '执行心得、感受或反思' },
          status: { type: 'string', enum: ['completed', 'in_progress', 'skipped'], default: 'completed' }
        },
        required: ['schedule_id']
      },
      output: {
        schema: { type: 'object' },
        render: (args, val) => [{ type: 'text', text: `打卡成功: ${JSON.stringify(val)}` }]
      },
      async execute(args) {
        const updated = saveScheduleCheckin(args.schedule_id, args.status, args.note);
        if (!updated) {
          return { success: false, message: `未找到 ID 为 ${args.schedule_id} 的日程` };
        }
        return { success: true, schedule: updated };
      }
    });

    // 3. 灵感捕获
    ctx.tools.register({
      name: 'okr_inspiration_capture',
      description: '记录用户在某个方向（O）上的突发灵感或思考点子，自动写入 ~/.dsh_okr/<O_ID>/inspirations.json。',
      parameters: {
        type: 'object',
        properties: {
          objective_id: { type: 'string', description: '归属目标ID，如 O_super_agent, O_learn_english' },
          inspiration: { type: 'string', description: '灵感思考内容' }
        },
        required: ['objective_id', 'inspiration']
      },
      output: {
        schema: { type: 'object' },
        render: (args, val) => [{ type: 'text', text: `灵感已记录: ${val.id}` }]
      },
      async execute(args) {
        const item = saveInspiration(args.objective_id, args.inspiration);
        if (!item) {
          return { success: false, message: `未找到目标 ${args.objective_id}` };
        }
        return { success: true, inspiration: item };
      }
    });
  }
}
