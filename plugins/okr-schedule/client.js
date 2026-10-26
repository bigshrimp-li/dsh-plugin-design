window.__ModuleLoader__.load({
  id: '@local/okr-schedule',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef } = React;

    let pluginCtx = null;

    // 自治数据源 (对齐 ~/.dsh_okr 结构)
    const initialData = {
      objectives: [
        { id: "O_super_agent", title: "开发 Super Agent 运行时系统", category: "技术工程", color: "#3B82F6", icon: "🤖", is_archived: false, vision: "打造具备自主状态机编排、本地安全沙箱隔离及上下文自适应的长程执行 Agent，赋能日常科研、代码开发与知识管理自动化。", progress: 68 },
        { id: "O_learn_english", title: "英语日常进阶与技术表达", category: "个人成长", color: "#10B981", icon: "🌍", is_archived: false, vision: "具备流畅阅读英文技术前沿论文、日常无字幕听力及流畅技术交流表达能力。", progress: 45 },
        { id: "O_fitness", title: "体态管理与卧推冲击80kg", category: "健康生活", color: "#F59E0B", icon: "🏋️", is_archived: false, vision: "系统性胸肩三头抗阻训练，体脂率降至15%，卧推达到 80kg 5x5。", progress: 82 },
        { id: "O_quant_finance_archive", title: "量化回测工具轻量预研 (已归档)", category: "探索研究", color: "#8B5CF6", icon: "📦", is_archived: true, vision: "探索个人量化因子分析与策略回测原型，评估长期投入产出比。", progress: 100 }
      ],
      key_points: [
        { id: "K_agent_core", objective_id: "O_super_agent", title: "K1: Agent Core 调度引擎与状态机", progress: 75, target_window: "10月第1周 ~ 10月第4周", doc_path: "keypoints/K_agent_core.md" },
        { id: "K_agent_sandbox", objective_id: "O_super_agent", title: "K2: 多层级安全沙箱与权限白名单", progress: 55, target_window: "10月第3周 ~ 11月第2周", doc_path: "keypoints/K_agent_sandbox.md" },
        { id: "K_english_vocab", objective_id: "O_learn_english", title: "K1: 连续打卡积累核心词汇库", progress: 60, target_window: "9月中旬 ~ 11月底", doc_path: "keypoints/K_english_vocab.md" },
        { id: "K_bench_press_80", objective_id: "O_fitness", title: "K1: 卧推负荷递增与离心控制", progress: 85, target_window: "8月 ~ 11月中旬", doc_path: "keypoints/K_bench_press_80.md" }
      ],
      schedules: [
        { id: "SCH_20261025_01", objective_id: "O_super_agent", key_point_id: "K_agent_core", title: "Agent Core 状态机转移图设计与测试", date: "2026-10-25", start_time: "14:00", end_time: "16:30", status: "completed", checkin_note: "状态机拆解为显式转换后，Turn 重试与异常捕获逻辑全部跑通。" },
        { id: "SCH_20261025_02", objective_id: "O_super_agent", key_point_id: "K_agent_sandbox", title: "测试沙箱文件白名单与环境变量防护", date: "2026-10-25", start_time: "17:00", end_time: "18:30", status: "in_progress", checkin_note: "正在验证权限逃逸边界，防御策略生效正常。" },
        { id: "SCH_20261026_01", objective_id: "O_super_agent", key_point_id: "K_agent_core", title: "工具异常熔断与会话恢复测试", date: "2026-10-26", start_time: "10:00", end_time: "12:00", status: "in_progress", checkin_note: "" },
        { id: "SCH_REC_duolingo", objective_id: "O_learn_english", key_point_id: "K_english_vocab", title: "Duolingo 每日打卡半小时 (习惯提醒)", date: "2026-10-25", start_time: "21:00", end_time: "21:30", status: "pending", checkin_note: "" },
        { id: "SCH_20261025_04", objective_id: "O_fitness", key_point_id: "K_bench_press_80", title: "胸肩三头训练日：冲刺 75kg 5x5", date: "2026-10-25", start_time: "19:30", end_time: "20:45", status: "pending", checkin_note: "" }
      ],
      inspirations: [
        { id: "INS_01", objective_id: "O_super_agent", date: "2026-10-24", text: "考虑引入检查点快照机制，在每个重要工具调用前后保存增量状态，遇不可逆错误时单步倒带（Undo）。" },
        { id: "INS_02", objective_id: "O_super_agent", date: "2026-10-20", text: "Tool 参数反射可参考 OpenAPI 3.1 的 Schema Validator，避免 LLM 生成参数不合法时触发 Python 异常。" }
      ],
      results: [
        { id: "R_agent_core_alpha", target_id: "O_super_agent", title: "K1 阶段成果：Core 状态机闭环跑通", score_or_verdict: "达成预期 (90分)", summary: "经过两周集中迭代，工具分发、异常熔断与会话恢复机制全部通过集成测试。" }
      ]
    };

    // 自包含高保真深色样式
    const stylesCss = `
      .okr-v22-root {
        all: initial;
        box-sizing: border-box;
        position: absolute !important;
        inset: 0 !important;
        width: 100% !important;
        height: 100% !important;
        background-color: #0b0f19 !important;
        color: #f8fafc !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif !important;
        -webkit-font-smoothing: antialiased;
        display: flex !important;
        flex-direction: column !important;
        overflow: hidden !important;
        z-index: 25 !important;
      }
      .okr-v22-root * { box-sizing: border-box; font-family: inherit; }
      .okr-v22-root button { font-family: inherit; cursor: pointer; border: none; outline: none; }
      .okr-v22-root input, .okr-v22-root select, .okr-v22-root textarea { font-family: inherit; outline: none; }
      .okr-v22-root ::-webkit-scrollbar { width: 6px; height: 6px; }
      .okr-v22-root ::-webkit-scrollbar-track { background: transparent; }
      .okr-v22-root ::-webkit-scrollbar-thumb { background: rgba(148, 163, 184, 0.25); border-radius: 9999px; }
      .okr-v22-root ::-webkit-scrollbar-thumb:hover { background: rgba(148, 163, 184, 0.4); }

      .nav-tab-btn {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 16px;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 500;
        color: #94a3b8;
        background: transparent;
        transition: all 0.18s ease;
      }
      .nav-tab-btn:hover { color: #ffffff; background: rgba(255, 255, 255, 0.05); }
      .nav-tab-btn.active {
        color: #ffffff !important;
        background: #2563eb !important;
        box-shadow: 0 2px 10px rgba(37, 99, 235, 0.35) !important;
        font-weight: 600;
      }

      .dim-pill-btn {
        padding: 5px 12px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 500;
        color: #94a3b8;
        background: transparent;
        transition: all 0.15s ease;
      }
      .dim-pill-btn:hover { color: #ffffff; }
      .dim-pill-btn.active {
        color: #ffffff !important;
        background: #2563eb !important;
        font-weight: 600;
        box-shadow: 0 1px 6px rgba(37, 99, 235, 0.3) !important;
      }

      .glass-card {
        background: #111827 !important;
        border: 1px solid rgba(255, 255, 255, 0.08) !important;
        border-radius: 14px;
      }
      .okr-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        border-radius: 8px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        border: 1px solid rgba(255, 255, 255, 0.1);
        background: #1e293b;
        color: #cbd5e1;
        transition: all 0.15s ease;
      }
      .okr-btn:hover { background: #334155; color: #ffffff; }
      .okr-btn-primary {
        background: linear-gradient(135deg, #2563eb, #6366f1) !important;
        color: #ffffff !important;
        border: none !important;
        font-weight: 600;
        box-shadow: 0 2px 10px rgba(37, 99, 235, 0.35);
      }
      .okr-btn-primary:hover { filter: brightness(1.1); }
      .okr-btn-danger {
        background: rgba(239, 68, 68, 0.15) !important;
        color: #ef4444 !important;
        border: 1px solid rgba(239, 68, 68, 0.3) !important;
      }

      /* 24h 时间轴容器 */
      .week-24h-container {
        position: relative;
        height: 600px;
        overflow-y: auto;
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px;
        background: #0d1322;
      }
      .hour-row {
        height: 60px;
        display: grid;
        grid-template-columns: 60px repeat(7, 1fr);
        border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      }
      .hour-label {
        font-size: 11px;
        color: #64748b;
        text-align: right;
        padding-right: 10px;
        transform: translateY(-8px);
        user-select: none;
      }
      .grid-day-col {
        border-left: 1px solid rgba(255, 255, 255, 0.04);
        position: relative;
        cursor: pointer;
      }
      .grid-day-col:hover {
        background: rgba(255, 255, 255, 0.015);
      }

      /* 当前时间标尺红线 */
      .current-time-line {
        position: absolute;
        left: 60px;
        right: 0;
        height: 2px;
        background: #ef4444;
        z-index: 25;
        pointer-events: none;
      }
      .current-time-tag {
        position: absolute;
        left: -58px;
        top: -9px;
        background: #ef4444;
        color: #ffffff;
        font-size: 10px;
        font-weight: 700;
        padding: 1px 5px;
        border-radius: 4px;
        display: flex;
        align-items: center;
        gap: 3px;
        box-shadow: 0 1px 4px rgba(239, 68, 68, 0.4);
      }

      .week-event-card {
        position: absolute;
        left: 3px;
        right: 3px;
        border-radius: 6px;
        padding: 6px 8px;
        font-size: 11px;
        line-height: 1.35;
        cursor: pointer;
        z-index: 20;
        overflow: hidden;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        transition: transform 0.15s, box-shadow 0.15s;
      }
      .week-event-card:hover {
        transform: scale(1.02);
        z-index: 22;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
      }
      .week-event-in-progress {
        border-style: dashed !important;
      }
    `;

    /** 主 React 应用组件 */
    function OkrScheduleApp() {
      const [curData, setCurData] = useState(initialData);
      const [curView, setCurView] = useState('calendar'); // 'calendar' | 'gantt' | 'workspace'
      const [curDim, setCurDim] = useState('week'); // 默认展示飞书同款 24h 时间轴
      const [curOId, setCurOId] = useState('O_super_agent');
      const [ganttMode, setGanttMode] = useState('timeline'); // 'timeline' | 'board'

      // 多选筛选
      const [oFilterList, setOFilterList] = useState(['O_super_agent', 'O_learn_english', 'O_fitness', 'O_quant_finance_archive']);
      const [showFilterPopover, setShowFilterPopover] = useState(false);

      // 弹窗与抽屉状态
      const [showCheckinModal, setShowCheckinModal] = useState(false);
      const [showAiDrawer, setShowAiDrawer] = useState(false);
      const [aiQuery, setAiQuery] = useState('');
      const [aiLogs, setAiLogs] = useState([
        { sender: 'ai', text: '您好！我是您的日程与目标管理 AI 伙伴。无论是记录灵感、打卡日程、制定任务清单，还是对归档目标生成长效复盘，只需一句话告诉我即可。' }
      ]);
      const [dailyNote, setDailyNote] = useState('');

      // 优化点 1: 全套自主编辑弹窗状态
      const [editScheduleTarget, setEditScheduleTarget] = useState(null); // null 或者 schedule 对象
      const [editObjectiveTarget, setEditObjectiveTarget] = useState(null); // null 或者 objective 对象
      const [editKeypointTarget, setEditKeypointTarget] = useState(null); // null 或者 keypoint 对象

      const curO = curData.objectives.find(o => o.id === curOId) || curData.objectives[0];
      const scrollRef = useRef(null);

      // 优化点 3: 退出日程回到 DSH 会话 (通过 layout.selectPanel(null) 原生返回 Conversation)
      const exitToDsh = () => {
        try {
          if (pluginCtx && pluginCtx.layout && typeof pluginCtx.layout.selectPanel === 'function') {
            pluginCtx.layout.selectPanel(null);
            return;
          }
        } catch (e) {
          console.error('[OKR-Plugin] Error selecting panel:', e);
        }

        // 兼容备用方案
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: 'dsh-navigate-view', view: 'conversation' }, '*');
        }
        const sidebarSession = document.querySelector('[data-session-id], .sidebar-session-row');
        if (sidebarSession) sidebarSession.click();
      };

      // 优化点 1: 全局网状互跳
      const navigateTo = ({ view, oId, dim }) => {
        if (oId) setCurOId(oId);
        if (dim) setCurDim(dim);
        if (view) setCurView(view);
      };

      // 优化点 2: 键盘切换尺度与翻页
      useEffect(() => {
        const handleKeyDown = (e) => {
          if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            setCurDim(prev => (prev === 'day' ? 'week' : 'month'));
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setCurDim(prev => (prev === 'month' ? 'week' : 'day'));
          } else if (e.key === 't' || e.key === 'T') {
            e.preventDefault();
            setCurDim('week');
          }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
      }, []);

      // 滚动周视图到当前时间 (13:00 附近)
      useEffect(() => {
        if (curDim === 'week' && curView === 'calendar' && scrollRef.current) {
          scrollRef.current.scrollTop = 760;
        }
      }, [curDim, curView]);

      const toggleSchedule = (id) => {
        setCurData(prev => ({
          ...prev,
          schedules: prev.schedules.map(s => s.id === id ? {
            ...s,
            status: s.status === 'completed' ? 'in_progress' : 'completed',
            checkin_note: s.status === 'completed' ? '' : (s.checkin_note || '执行完成，打卡确认')
          } : s)
        }));
      };

      const toggleArchive = () => {
        setCurData(prev => ({
          ...prev,
          objectives: prev.objectives.map(o => o.id === curO.id ? { ...o, is_archived: !o.is_archived } : o),
          key_points: prev.key_points.map(k => k.objective_id === curO.id ? { ...k, is_archived: !curO.is_archived } : k)
        }));
      };

      const handleAiSend = (textInput) => {
        const text = textInput || aiQuery.trim();
        if (!text) return;
        const newLogs = [...aiLogs, { sender: 'user', text }];
        setAiLogs(newLogs);
        if (!textInput) setAiQuery('');

        setTimeout(() => {
          let reply = `已收到指令：“${text}”。已自动为您更新上下文与日程状态。`;
          if (text.includes('Duolingo') || text.includes('打卡')) {
            setCurData(prev => ({
              ...prev,
              schedules: prev.schedules.map(s => s.id === 'SCH_REC_duolingo' ? { ...s, status: 'completed', checkin_note: 'AI 自动打卡完成' } : s)
            }));
            reply = '✅ 已为您自动完成今日 Duolingo 打卡，更新了英语目标的活跃度！';
          } else if (text.includes('灵感') || text.includes('WASM')) {
            const newIns = { id: 'INS_' + Date.now(), objective_id: curO.id, date: '2026-10-25', text };
            setCurData(prev => ({ ...prev, inspirations: [newIns, ...prev.inspirations] }));
            reply = '💡 灵感已成功沉淀并归纳至目标草稿箱！';
          }
          setAiLogs([...newLogs, { sender: 'ai', text: reply }]);
        }, 500);
      };

      // -------------------------------------------------------------
      // 视角 1: 整合日历 (含飞书同款 24h 周视图与红线)
      // -------------------------------------------------------------
      const renderCalendarView = () => {
        const filtered = curData.schedules.filter(s => oFilterList.includes(s.objective_id));

        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px', flex: '1 1 auto' } },
          // 控制栏
          h('div', { className: 'glass-card', style: { padding: '12px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '16px' } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
                h('h2', { style: { margin: 0, fontSize: '18px', fontWeight: 700, color: '#ffffff' } }, '2026年 10月'),
                h('div', { style: { display: 'flex', alignItems: 'center', background: '#1e293b', borderRadius: '6px', padding: '2px', border: '1px solid rgba(255, 255, 255, 0.08)' } },
                  h('button', { style: { width: '24px', height: '22px', color: '#94a3b8', background: 'transparent' } }, '◀'),
                  h('button', { style: { padding: '0 8px', height: '22px', fontSize: '11px', color: '#cbd5e1', background: 'transparent', fontWeight: 500 } }, '今天'),
                  h('button', { style: { width: '24px', height: '22px', color: '#94a3b8', background: 'transparent' } }, '▶')
                )
              ),

              // 多选 O 筛选器 Popover
              h('div', { style: { position: 'relative' } },
                h('button', {
                  className: 'okr-btn',
                  onClick: () => setShowFilterPopover(!showFilterPopover)
                }, `🎯 目标筛选 (${oFilterList.length}/${curData.objectives.length}) ▼`),

                showFilterPopover && h('div', {
                  style: { position: 'absolute', top: 'calc(100% + 8px)', left: 0, width: '280px', background: '#0f172a', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '12px', padding: '12px', zIndex: 50, boxShadow: '0 12px 32px rgba(0,0,0,0.6)' }
                },
                  h('div', { style: { display: 'flex', justifyContent: 'space-between', paddingBottom: '8px', borderBottom: '1px solid rgba(255,255,255,0.08)', marginBottom: '8px', fontSize: '11px' } },
                    h('span', { style: { fontWeight: 700, color: '#94a3b8' } }, '多选展示目标'),
                    h('div', { style: { display: 'flex', gap: '8px' } },
                      h('button', { style: { background: 'none', color: '#38bdf8', fontSize: '11px' }, onClick: () => setOFilterList(curData.objectives.map(o => o.id)) }, '全选'),
                      h('button', { style: { background: 'none', color: '#94a3b8', fontSize: '11px' }, onClick: () => setOFilterList([]) }, '清空')
                    )
                  ),
                  curData.objectives.map(o => {
                    const isChecked = oFilterList.includes(o.id);
                    return h('label', {
                      key: o.id,
                      style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: 'pointer', color: isChecked ? '#FFF' : '#64748b', padding: '4px 0' }
                    },
                      h('input', {
                        type: 'checkbox',
                        checked: isChecked,
                        onChange: () => setOFilterList(prev => isChecked ? prev.filter(x => x !== o.id) : [...prev, o.id])
                      }),
                      h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: o.color } }),
                      h('span', null, o.title.split(' ')[0]),
                      o.is_archived && h('span', { style: { fontSize: '10px', color: '#a855f7' } }, '(归档)')
                    );
                  })
                )
              ),

              // 快捷操作提示
              h('div', { style: { display: 'flex', gap: '6px', fontSize: '11px', color: '#64748b' } },
                h('span', { style: { padding: '2px 8px', borderRadius: '9999px', background: 'rgba(255,255,255,0.05)', color: '#94a3b8' } }, '↑/↓ 切换尺度'),
                h('span', { style: { padding: '2px 8px', borderRadius: '9999px', background: 'rgba(255,255,255,0.05)', color: '#94a3b8' } }, '←/→ 翻页'),
                h('span', { style: { padding: '2px 8px', borderRadius: '9999px', background: 'rgba(255,255,255,0.05)', color: '#94a3b8' } }, 'T 今天')
              )
            ),

            // 尺度切换
            h('div', { style: { display: 'flex', alignItems: 'center', background: '#1e293b', padding: '3px', borderRadius: '8px', border: '1px solid rgba(255, 255, 255, 0.08)' } },
              h('button', { className: `dim-pill-btn ${curDim === 'month' ? 'active' : ''}`, onClick: () => setCurDim('month') }, '月视图'),
              h('button', { className: `dim-pill-btn ${curDim === 'week' ? 'active' : ''}`, onClick: () => setCurDim('week') }, '周视图 (24h)'),
              h('button', { className: `dim-pill-btn ${curDim === 'day' ? 'active' : ''}`, onClick: () => setCurDim('day') }, '今日聚焦 (日)')
            )
          ),

          // 月视图网格
          curDim === 'month' && h('div', { className: 'glass-card', style: { padding: '16px', display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: '580px' } },
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '8px', marginBottom: '8px', textAlign: 'center', fontSize: '11px', fontWeight: 600, color: '#64748b' } },
              ['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map(w => h('div', { key: w, style: w.includes('周六') || w.includes('周日') ? { color: '#60a5fa' } : null }, w))
            ),
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gridAutoRows: '1fr', gap: '8px', flex: '1 1 auto' } },
              Array.from({ length: 31 }, (_, i) => i + 1).map(day => {
                const isToday = (day === 25);
                const dateStr = `2026-10-${String(day).padStart(2, '0')}`;
                const daySchs = filtered.filter(s => s.date === dateStr);

                return h('div', {
                  key: day,
                  onDoubleClick: () => setCurDim('day'),
                  style: {
                    backgroundColor: isToday ? '#172554' : '#1e293b',
                    border: isToday ? '1.5px solid #2563eb' : '1px solid rgba(255,255,255,0.06)',
                    borderRadius: '10px',
                    padding: '8px',
                    minHeight: '96px',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    cursor: 'pointer'
                  }
                },
                  h('div', null,
                    h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px' } },
                      h('span', { style: { fontWeight: 700, color: isToday ? '#38bdf8' : '#94a3b8' } }, day),
                      daySchs.length > 0 && h('span', { style: { fontSize: '10px', color: '#64748b' } }, `${daySchs.length}项`)
                    ),
                    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '4px' } },
                      daySchs.map(s => {
                        const obj = curData.objectives.find(o => o.id === s.objective_id) || {};
                        const isDone = (s.status === 'completed');
                        return h('div', {
                          key: s.id,
                          onClick: (e) => { e.stopPropagation(); setEditScheduleTarget(s); },
                          title: '点击编辑日程',
                          style: {
                            backgroundColor: '#0f172a',
                            border: `1px solid ${obj.color}`,
                            color: obj.color,
                            padding: '3px 6px',
                            borderRadius: '5px',
                            fontSize: '10px',
                            fontWeight: 500,
                            display: 'flex',
                            justifyContent: 'space-between',
                            textDecoration: isDone ? 'line-through' : 'none',
                            opacity: isDone ? 0.75 : 1
                          }
                        },
                          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `${s.start_time || ''} ${s.title}`),
                          isDone && h('span', { style: { color: '#34d399' } }, '✓')
                        );
                      })
                    )
                  ),
                  h('div', { style: { textAlign: 'right', fontSize: '9px', color: '#475569' } }, isToday ? '今天' : '')
                );
              })
            )
          ),

          // 优化点 2: 飞书同款 24 小时排期周视图
          curDim === 'week' && h('div', { className: 'glass-card', style: { padding: '16px', display: 'flex', flexDirection: 'column', flex: '1 1 auto' } },
            // 表头
            h('div', { style: { display: 'grid', gridTemplateColumns: '60px repeat(7, 1fr)', textAlign: 'center', fontSize: '12px', fontWeight: 600, paddingBottom: '12px', borderBottom: '1px solid rgba(255, 255, 255, 0.08)' } },
              h('div', { style: { color: '#64748b', fontSize: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center' } }, 'GMT+8'),
              [
                { name: '周日', date: '25', isToday: true, banner: '冲刺日', bannerColor: '#f87171' },
                { name: '周一', date: '26', banner: 'Core评审', bannerColor: '#fbbf24' },
                { name: '周二', date: '27' },
                { name: '周三', date: '28', banner: 'Activity Day', bannerColor: '#c084fc' },
                { name: '周四', date: '29' },
                { name: '周五', date: '30' },
                { name: '周六', date: '31' }
              ].map(d => h('div', { key: d.date, style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' } },
                h('span', { style: { fontSize: '11px', color: d.isToday ? '#60a5fa' : '#94a3b8' } }, d.name),
                d.isToday ? h('span', { style: { width: '26px', height: '26px', borderRadius: '50%', background: '#2563eb', color: '#ffffff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, margin: '0 auto' } }, d.date)
                          : h('span', { style: { fontSize: '14px', fontWeight: 700, color: '#f8fafc', height: '26px', display: 'flex', alignItems: 'center', justifyContent: 'center' } }, d.date),
                d.banner && h('span', { style: { fontSize: '10px', padding: '1px 6px', borderRadius: '4px', background: `${d.bannerColor}20`, color: d.bannerColor, border: `1px solid ${d.bannerColor}40`, margin: '2px auto 0 auto' } }, d.banner)
              ))
            ),

            // 24小时滚动网格 (00:00 - 24:00)
            h('div', { ref: scrollRef, className: 'week-24h-container', style: { marginTop: '10px' } },
              // 实时时间红线 (14:58 处)
              h('div', { className: 'current-time-line', style: { top: '898px' } },
                h('div', { className: 'current-time-tag' },
                  h('span', null, '●'),
                  h('span', null, '14:58')
                )
              ),

              // 24 小时行
              Array.from({ length: 24 }, (_, hour) => {
                const hourStr = String(hour).padStart(2, '0') + ':00';
                return h('div', { key: hour, className: 'hour-row' },
                  h('div', { className: 'hour-label' }, hourStr),
                  ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31'].map(dateStr => h('div', {
                    key: dateStr,
                    className: 'grid-day-col',
                    onClick: () => {
                      const start = String(hour).padStart(2, '0') + ':00';
                      const end = String(hour + 1).padStart(2, '0') + ':00';
                      setEditScheduleTarget({ id: '', title: '', date: dateStr, start_time: start, end_time: end, objective_id: curOId, status: 'pending' });
                    }
                  }))
                );
              }),

              // 绘制日程卡片
              filtered.map(s => {
                const weekDates = ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31'];
                const dayIdx = weekDates.indexOf(s.date);
                if (dayIdx === -1) return null;

                const startParts = (s.start_time || '10:00').split(':');
                const startMin = parseInt(startParts[0], 10) * 60 + parseInt(startParts[1] || '0', 10);

                let durationMin = 60;
                if (s.end_time) {
                  const endParts = s.end_time.split(':');
                  const endMin = parseInt(endParts[0], 10) * 60 + parseInt(endParts[1] || '0', 10);
                  durationMin = Math.max(30, endMin - startMin);
                }

                const topPx = startMin;
                const heightPx = durationMin;
                const colWidthPct = 100 / 7;
                const leftPct = (dayIdx * colWidthPct);

                const obj = curData.objectives.find(o => o.id === s.objective_id) || {};
                const isDone = (s.status === 'completed');
                const isInProgress = (s.status === 'in_progress');

                return h('div', {
                  key: s.id,
                  onClick: (e) => { e.stopPropagation(); setEditScheduleTarget(s); },
                  className: `week-event-card ${isInProgress ? 'week-event-in-progress' : ''}`,
                  style: {
                    top: `${topPx}px`,
                    height: `${heightPx}px`,
                    left: `calc(60px + ${leftPct}% + 4px)`,
                    width: `calc(${colWidthPct}% - 8px)`,
                    background: `${obj.color}18`,
                    border: `1.5px solid ${obj.color}`,
                    color: '#ffffff'
                  }
                },
                  h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '10px', fontWeight: 700, color: obj.color } },
                    h('span', null, `${s.start_time} - ${s.end_time || ''}`),
                    h('span', null, isDone ? '✓已完成' : isInProgress ? '●进行中' : '')
                  ),
                  h('div', { style: { fontWeight: 600, marginTop: '2px', textDecoration: isDone ? 'line-through' : 'none' } }, s.title),
                  h('div', { style: { fontSize: '9.5px', color: '#94a3b8', marginTop: '2px' } }, obj.title.split(' ')[0])
                );
              })
            )
          ),

          // 日视图
          curDim === 'day' && h('div', { style: { display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '16px' } },
            h('div', { className: 'glass-card', style: { padding: '18px', display: 'flex', flexDirection: 'column', gap: '12px' } },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255, 255, 255, 0.08)', paddingBottom: '10px' } },
                h('h4', { style: { margin: '0', fontSize: '15px', fontWeight: 700, color: '#ffffff' } }, '今日聚焦待办日程 (2026-10-25)'),
                h('button', {
                  className: 'okr-btn okr-btn-primary',
                  onClick: () => setEditScheduleTarget({ id: '', title: '', date: '2026-10-25', start_time: '18:00', end_time: '19:00', objective_id: curOId, status: 'pending' })
                }, '+ 添加今日日程')
              ),
              filtered.filter(s => s.date === '2026-10-25').map(s => {
                const obj = curData.objectives.find(o => o.id === s.objective_id) || {};
                const isDone = (s.status === 'completed');
                return h('div', {
                  key: s.id,
                  style: { background: '#1e293b', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }
                },
                  h('div', { style: { display: 'flex', gap: '10px' } },
                    h('input', { type: 'checkbox', checked: isDone, onChange: () => toggleSchedule(s.id), style: { cursor: 'pointer', marginTop: '3px' } }),
                    h('div', null,
                      h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
                        h('span', {
                          onClick: () => navigateTo({ view: 'workspace', oId: s.objective_id }),
                          style: { padding: '2px 7px', borderRadius: '9999px', background: `${obj.color}20`, color: obj.color, fontSize: '10px', cursor: 'pointer' }
                        }, `${obj.title.split(' ')[0]} ➔`),
                        h('span', { style: { fontSize: '11px', color: '#94a3b8' } }, `${s.start_time} - ${s.end_time || ''}`)
                      ),
                      h('div', {
                        onClick: () => setEditScheduleTarget(s),
                        style: { fontSize: '13px', fontWeight: 600, color: isDone ? '#94a3b8' : '#FFF', textDecoration: isDone ? 'line-through' : 'none', marginTop: '4px', cursor: 'pointer' }
                      }, `${s.title} ✏️`),
                      s.checkin_note && h('div', { style: { fontSize: '11px', color: '#10b981', marginTop: '4px' } }, `💭 心得: ${s.checkin_note}`)
                    )
                  ),
                  h('button', {
                    onClick: () => setEditScheduleTarget(s),
                    className: 'okr-btn',
                    style: { padding: '4px 8px', fontSize: '11px' }
                  }, '编辑')
                );
              })
            ),

            h('div', { className: 'glass-card', style: { padding: '18px', display: 'flex', flexDirection: 'column', gap: '12px' } },
              h('h4', { style: { margin: 0, fontSize: '14px', fontWeight: 700, color: '#ffffff' } }, '📝 每日反思与收获便签'),
              h('p', { style: { margin: 0, fontSize: '11.5px', color: '#94a3b8', lineHeight: 1.5 } }, '随手记下今日感悟，AI 将自动结构化分流至 ~/.dsh_okr 对应目标中。'),
              h('textarea', {
                value: dailyNote,
                onChange: (e) => setDailyNote(e.target.value),
                rows: 8,
                placeholder: '记录今日在各目标上的感悟与灵感...',
                style: { width: '100%', background: '#090d16', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px', padding: '12px', color: '#f8fafc', fontSize: '12px', lineHeight: 1.6, resize: 'none' }
              }),
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                h('button', {
                  onClick: () => { setShowAiDrawer(true); handleAiSend(`请帮我把这段心得归集到目标复盘中：${dailyNote}`); },
                  style: { background: 'none', color: '#c084fc', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }
                }, '✨ 让 AI 提炼分流'),
                h('button', {
                  className: 'okr-btn okr-btn-primary',
                  onClick: () => { alert('已保存为本地 Markdown 反思便签！'); setDailyNote(''); }
                }, '保存便签')
              )
            )
          )
        );
      };

      // -------------------------------------------------------------
      // 视角 2: 甘特与看板
      // -------------------------------------------------------------
      const renderGanttView = () => {
        const kps = curData.key_points.filter(k => k.objective_id === curO.id);
        const kpIds = kps.map(k => k.id);
        const schs = curData.schedules.filter(s => kpIds.includes(s.key_point_id));

        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
          // 控制栏
          h('div', { className: 'glass-card', style: { padding: '12px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
              h('span', { style: { fontSize: '12px', color: '#94a3b8' } }, '聚焦目标 (O):'),
              h('select', {
                value: curOId,
                onChange: (e) => setCurOId(e.target.value),
                style: { background: '#1e293b', border: '1px solid rgba(255, 255, 255, 0.15)', color: '#ffffff', fontSize: '12px', fontWeight: 600, padding: '6px 12px', borderRadius: '8px', cursor: 'pointer' }
              }, curData.objectives.map(o => h('option', { key: o.id, value: o.id }, `${o.icon} ${o.title} ${o.is_archived ? '(已归档)' : ''}`))),
              h('span', {
                style: {
                  fontSize: '11px', padding: '2px 8px', borderRadius: '9999px',
                  background: curO.is_archived ? 'rgba(139,92,246,0.2)' : 'rgba(16, 185, 129, 0.15)',
                  color: curO.is_archived ? '#c084fc' : '#34d399',
                  border: curO.is_archived ? '1px solid rgba(139,92,246,0.4)' : '1px solid rgba(16, 185, 129, 0.3)'
                }
              }, curO.is_archived ? '🔒 已归档封存 (仅 R 可更新)' : '🟢 正常推进中'),
              h('button', { className: 'okr-btn', onClick: toggleArchive }, curO.is_archived ? '解封此目标' : '模拟归档封存'),
              h('button', {
                className: 'okr-btn',
                style: { color: '#38bdf8', borderColor: 'rgba(56, 189, 248, 0.3)' },
                onClick: () => navigateTo({ view: 'workspace', oId: curO.id })
              }, '🎯 浏览专属网页 ↗')
            ),

            h('div', { style: { display: 'flex', alignItems: 'center', gap: '14px' } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: '#94a3b8' } },
                h('span', null, `支撑点: ${kps.length}个`),
                h('span', null, `关联日程: ${schs.length}项`),
                h('span', null, '完成度:'),
                h('div', { style: { width: '80px', height: '6px', background: 'rgba(255, 255, 255, 0.1)', borderRadius: '3px', overflow: 'hidden' } },
                  h('div', { style: { width: `${curO.progress}%`, height: '100%', background: '#2563eb' } })
                ),
                h('span', { style: { fontWeight: 700, color: '#ffffff' } }, `${curO.progress}%`)
              ),

              h('div', { style: { display: 'flex', alignItems: 'center', background: '#1e293b', padding: '3px', borderRadius: '8px', border: '1px solid rgba(255, 255, 255, 0.08)' } },
                h('button', { className: `dim-pill-btn ${ganttMode === 'timeline' ? 'active' : ''}`, onClick: () => setGanttMode('timeline') }, '甘特时间轴'),
                h('button', { className: `dim-pill-btn ${ganttMode === 'board' ? 'active' : ''}`, onClick: () => setGanttMode('board') }, '状态泳道看板')
              ),

              h('button', {
                className: 'okr-btn okr-btn-primary',
                onClick: () => { setShowAiDrawer(true); handleAiSend(`请帮我在【${curO.title}】下智能拆解下周的具体日程`); }
              }, '✨ AI 智能拆解日程')
            )
          ),

          // 甘特时间轴
          ganttMode === 'timeline' && h('div', { className: 'glass-card', style: { padding: '18px', display: 'flex', flexDirection: 'column', gap: '14px' } },
            h('div', { style: { display: 'grid', gridTemplateColumns: '320px repeat(4, 1fr)', gap: '10px', fontSize: '12px', fontWeight: 600, color: '#94a3b8', borderBottom: '1px solid rgba(255, 255, 255, 0.08)', paddingBottom: '10px' } },
              h('div', null, '核心支撑点 (Key Point) 与下属敏捷日程 (Schedule)'),
              h('div', { style: { textAlign: 'center' } }, '10月第1周 (10.01~10.07)'),
              h('div', { style: { textAlign: 'center' } }, '10月第2周 (10.08~10.14)'),
              h('div', { style: { textAlign: 'center', background: 'rgba(37,99,235,0.2)', color: '#38bdf8', padding: '2px', borderRadius: '6px' } }, '10月第3周 (本周)'),
              h('div', { style: { textAlign: 'center' } }, '10月第4周 (10.22~10.31)')
            ),

            kps.map(kp => {
              const related = curData.schedules.filter(s => s.key_point_id === kp.id);
              return h('div', {
                key: kp.id,
                style: { background: '#1e293b', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '12px', padding: '14px' }
              },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                    h('span', null, '🔑'),
                    h('span', {
                      onClick: () => setEditKeypointTarget(kp),
                      style: { fontSize: '13px', fontWeight: 700, color: '#ffffff', cursor: 'pointer' }
                    }, `${kp.title} ✏️`),
                    h('span', { style: { fontSize: '11px', padding: '1px 7px', borderRadius: '9999px', background: 'rgba(255,255,255,0.06)', color: '#94a3b8' } }, kp.target_window)
                  ),
                  h('span', { style: { fontSize: '12px', fontWeight: 700, color: '#38bdf8' } }, `${kp.progress}%`)
                ),

                h('div', { style: { marginTop: '8px' } },
                  related.map(s => {
                    const isDone = (s.status === 'completed');
                    return h('div', {
                      key: s.id,
                      style: { display: 'grid', gridTemplateColumns: '320px 1fr', gap: '10px', alignItems: 'center', padding: '6px 0', borderTop: '1px solid rgba(255,255,255,0.04)' }
                    },
                      h('div', {
                        onClick: () => setEditScheduleTarget(s),
                        style: { fontSize: '12px', color: '#cbd5e1', paddingLeft: '20px', cursor: 'pointer' }
                      }, `${s.title} ✏️`),
                      h('div', {
                        onClick: () => navigateTo({ view: 'calendar', dim: 'day' }),
                        title: '点击跳转至日历对应日期',
                        style: {
                          background: isDone ? 'linear-gradient(90deg, #059669, #10B981)' : 'linear-gradient(90deg, #2563EB, #3B82F6)',
                          color: '#FFF',
                          borderRadius: '6px',
                          padding: '5px 12px',
                          fontSize: '11px',
                          fontWeight: 600,
                          cursor: 'pointer',
                          display: 'flex',
                          justifyContent: 'space-between',
                          maxWidth: '75%'
                        }
                      },
                        h('span', null, `${s.date.slice(5)} ${s.start_time}`),
                        h('span', null, isDone ? '已完成' : '进行中')
                      )
                    );
                  })
                )
              );
            })
          ),

          // 看板模式
          ganttMode === 'board' && h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' } },
            ['pending', 'in_progress', 'completed'].map((st, idx) => {
              const colTitle = idx === 0 ? '待开始 (To Do)' : idx === 1 ? '进行中 (In Progress)' : '已完成 (Done)';
              const colColor = idx === 0 ? '#e2e8f0' : idx === 1 ? '#38bdf8' : '#34d399';
              const items = schs.filter(s => s.status === st);
              return h('div', { key: st, className: 'glass-card', style: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' } },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13px', fontWeight: 700, color: colColor } },
                  h('span', null, colTitle),
                  h('span', { style: { fontSize: '11px', padding: '1px 7px', borderRadius: '9999px', background: 'rgba(255,255,255,0.1)' } }, items.length)
                ),
                items.map(s => h('div', {
                  key: s.id,
                  style: { background: '#1e293b', padding: '12px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.08)' }
                },
                  h('div', {
                    onClick: () => setEditScheduleTarget(s),
                    style: { fontSize: '12px', fontWeight: 600, color: '#FFF', cursor: 'pointer' }
                  }, `${s.title} ✏️`),
                  h('div', { style: { fontSize: '11px', color: '#94a3b8', marginTop: '4px' } }, `${s.date} ${s.start_time || ''}`),
                  h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '8px', gap: '6px' } },
                    h('button', {
                      className: 'okr-btn',
                      style: { padding: '3px 8px', fontSize: '10px' },
                      onClick: () => setEditScheduleTarget(s)
                    }, '编辑'),
                    h('button', {
                      className: 'okr-btn',
                      style: { padding: '3px 8px', fontSize: '10px' },
                      onClick: () => toggleSchedule(s.id)
                    }, s.status === 'completed' ? '撤销' : '完成')
                  )
                ))
              );
            })
          )
        );
      };

      // -------------------------------------------------------------
      // 视角 3: O 专属空间
      // -------------------------------------------------------------
      const renderWorkspaceView = () => {
        const kps = curData.key_points.filter(k => k.objective_id === curO.id);
        const results = curData.results.filter(r => r.target_id === curO.id);
        const inss = curData.inspirations.filter(i => i.objective_id === curO.id);

        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } },
          // 愿景 Hero 卡片
          h('div', {
            className: 'glass-card',
            style: { padding: '24px 28px', background: 'linear-gradient(135deg, rgba(30,58,138,0.25), rgba(15, 23, 42, 0.95))', border: '1px solid rgba(59, 130, 246, 0.35)' }
          },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' } },
              h('div', { style: { display: 'flex', gap: '20px', alignItems: 'center' } },
                h('div', { style: { fontSize: '40px', padding: '12px 16px', borderRadius: '16px', background: '#1e293b', border: '1px solid rgba(255, 255, 255, 0.12)' } }, curO.icon),
                h('div', null,
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
                    h('h2', { style: { margin: 0, fontSize: '22px', fontWeight: 800, color: '#ffffff' } }, curO.title),
                    h('span', { style: { fontSize: '11px', fontWeight: 600, padding: '2px 9px', borderRadius: '9999px', background: 'rgba(59, 130, 246, 0.18)', color: '#60a5fa' } }, curO.category),
                    h('span', { style: { fontSize: '11px', fontWeight: 600, padding: '2px 9px', borderRadius: '9999px', background: curO.is_archived ? 'rgba(139,92,246,0.2)' : 'rgba(16, 185, 129, 0.15)', color: curO.is_archived ? '#c084fc' : '#34d399' } }, curO.is_archived ? '🔒 已归档' : '🟢 正常推进中'),
                    h('button', {
                      className: 'okr-btn',
                      style: { padding: '2px 8px', fontSize: '11px', marginLeft: '6px' },
                      onClick: () => setEditObjectiveTarget(curO)
                    }, '✏️ 编辑目标')
                  ),
                  h('p', { style: { margin: '8px 0 0 0', fontSize: '13.5px', color: '#e2e8f0', lineHeight: 1.65, maxWidth: '900px' } }, curO.vision)
                )
              ),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
                h('select', {
                  value: curOId,
                  onChange: (e) => setCurOId(e.target.value),
                  style: { background: '#1e293b', border: '1px solid rgba(255, 255, 255, 0.15)', color: '#ffffff', fontSize: '12px', fontWeight: 600, padding: '6px 12px', borderRadius: '8px', cursor: 'pointer' }
                }, curData.objectives.map(o => h('option', { key: o.id, value: o.id }, `${o.icon} ${o.title}`))),
                h('button', { className: 'okr-btn', onClick: toggleArchive }, curO.is_archived ? '解封' : '模拟归档封存'),
                h('button', {
                  className: 'okr-btn okr-btn-primary',
                  onClick: () => setEditObjectiveTarget({ id: '', title: '', icon: '🎯', category: '个人成长', color: '#3B82F6', vision: '' })
                }, '+ 新建大目标')
              )
            ),

            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '20px', paddingTop: '16px', borderTop: '1px solid rgba(255, 255, 255, 0.08)', fontSize: '12px', color: '#94a3b8' } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '14px' } },
                h('span', null, '总体推进完成度:'),
                h('div', { style: { width: '280px', height: '8px', background: 'rgba(255, 255, 255, 0.1)', borderRadius: '9999px', overflow: 'hidden' } },
                  h('div', { style: { width: `${curO.progress}%`, height: '100%', background: 'linear-gradient(90deg, #3b82f6, #6366f1)', borderRadius: '9999px' } })
                ),
                h('span', { style: { fontSize: '13px', fontWeight: 700, color: '#ffffff' } }, `${curO.progress}%`)
              ),
              h('div', { style: { display: 'flex', gap: '20px' } },
                h('span', null, `Key Points: ${kps.length}个`),
                h('span', null, `执行日程: 3项`),
                h('span', null, `成果复盘 (R): ${results.length}篇`)
              )
            )
          ),

          // 四宫格
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '18px' } },
            // K 态势
            h('div', { className: 'glass-card', style: { padding: '18px', display: 'flex', flexDirection: 'column', gap: '12px' } },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                h('h4', { style: { margin: 0, fontSize: '14px', fontWeight: 700, color: '#ffffff' } }, '🔑 核心支撑点 (Key Points) 态势'),
                h('button', {
                  className: 'okr-btn',
                  style: { padding: '2px 8px', fontSize: '11px' },
                  onClick: () => setEditKeypointTarget({ id: '', title: '', target_window: '11月第1周 ~ 11月第4周', progress: 0, doc_path: 'keypoints/K_new.md' })
                }, '+ 新建支撑点 (K)')
              ),
              kps.map(kp => h('div', {
                key: kp.id,
                style: { background: '#1e293b', padding: '12px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.06)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }
              },
                h('div', { style: { flex: 1 } },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                    h('span', { style: { fontSize: '13px', fontWeight: 600, color: '#FFF' } }, kp.title),
                    h('span', { style: { fontSize: '11px', color: '#38bdf8' } }, `${kp.progress}%`)
                  ),
                  h('div', { style: { fontSize: '11px', color: '#94a3b8', marginTop: '4px' } }, `排期: ${kp.target_window} · ${kp.doc_path}`)
                ),
                h('div', { style: { display: 'flex', gap: '6px' } },
                  h('button', {
                    className: 'okr-btn',
                    style: { padding: '2px 6px', fontSize: '10px' },
                    onClick: () => setEditKeypointTarget(kp)
                  }, '编辑'),
                  h('button', {
                    className: 'okr-btn',
                    style: { padding: '2px 6px', fontSize: '10px', color: '#38bdf8' },
                    onClick: () => navigateTo({ view: 'gantt', oId: curO.id })
                  }, '看板 ➔')
                )
              ))
            ),

            // 灵感箱
            h('div', { className: 'glass-card', style: { padding: '18px', display: 'flex', flexDirection: 'column', gap: '12px' } },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                h('h4', { style: { margin: 0, fontSize: '14px', fontWeight: 700, color: '#ffffff' } }, '💡 灵感与想法草稿箱'),
                h('span', { style: { fontSize: '11px', color: '#c084fc' } }, '支持跨会话继承与转化')
              ),
              h('div', { style: { display: 'flex', gap: '8px' } },
                h('input', {
                  placeholder: '输入一条突发奇想的架构灵感/思考，点击添加...',
                  onKeyDown: (e) => {
                    if (e.key === 'Enter' && e.target.value.trim()) {
                      handleAiSend(`灵感记录：${e.target.value.trim()}`);
                      e.target.value = '';
                    }
                  },
                  style: { flex: 1, background: '#090d16', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '8px 12px', color: '#ffffff', fontSize: '12px' }
                }),
                h('button', { className: 'okr-btn okr-btn-primary' }, '添加灵感')
              ),
              inss.map(ins => h('div', {
                key: ins.id,
                style: { background: '#1e293b', padding: '10px', borderRadius: '8px', fontSize: '12px', color: '#cbd5e1', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }
              },
                h('span', null, `• ${ins.text}`),
                h('button', {
                  onClick: () => setEditScheduleTarget({ id: '', title: ins.text, date: '2026-10-25', start_time: '14:00', end_time: '15:00', objective_id: curOId, status: 'pending' }),
                  style: { background: 'none', border: 'none', color: '#38bdf8', fontSize: '11px', cursor: 'pointer', whiteSpace: 'nowrap' }
                }, '排入日程 ➔')
              ))
            ),

            // 资料库
            h('div', { className: 'glass-card', style: { padding: '18px', display: 'flex', flexDirection: 'column', gap: '12px' } },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                h('h4', { style: { margin: 0, fontSize: '14px', fontWeight: 700, color: '#ffffff' } }, '📚 关联技术资料与文档库'),
                h('span', { style: { fontSize: '11px', color: '#64748b' } }, '双向绑定本地 Markdown 与代码')
              ),
              [
                { name: "Agent状态机设计说明书.md", path: "AI/Agent/StateMachine.md" },
                { name: "Sandbox多层级安全规范.md", path: "AI/Agent/Sandbox_Security.md" },
                { name: "ToolSchema反射协议.ts", path: "AI/Agent/ToolSchema.ts" }
              ].map(doc => h('div', {
                key: doc.name,
                style: { background: '#1e293b', padding: '10px 14px', borderRadius: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px' }
              },
                h('span', { style: { color: '#ffffff', fontWeight: 500 } }, `📄 ${doc.name}`),
                h('span', { style: { color: '#64748b', fontFamily: 'monospace' } }, doc.path)
              ))
            ),

            // R 复盘
            h('div', { className: 'glass-card', style: { padding: '18px', display: 'flex', flexDirection: 'column', gap: '12px' } },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                h('h4', { style: { margin: 0, fontSize: '14px', fontWeight: 700, color: '#ffffff' } }, '🏆 阶段成果与复盘 (Results)'),
                h('button', {
                  className: 'okr-btn',
                  style: { color: '#34d399', borderColor: 'rgba(52, 211, 153, 0.3)', fontSize: '11px' },
                  onClick: () => {
                    const text = prompt('追加阶段成果评价 (即便目标归档，R 依然终身开放追加):');
                    if (text) {
                      setCurData(prev => ({
                        ...prev,
                        results: [{ id: 'R_' + Date.now(), target_id: curO.id, title: '阶段复盘', score_or_verdict: '达成预期 (95分)', summary: text }, ...prev.results]
                      }));
                    }
                  }
                }, '+ 追加 R 复盘 (归档后仍可用)')
              ),
              results.map(r => h('div', {
                key: r.id,
                style: { background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)', padding: '12px', borderRadius: '10px' }
              },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                  h('span', { style: { fontSize: '13px', fontWeight: 700, color: '#34d399' } }, r.title),
                  h('span', { style: { fontSize: '11px', padding: '2px 8px', borderRadius: '9999px', background: 'rgba(16,185,129,0.2)', color: '#34d399' } }, r.score_or_verdict)
                ),
                h('p', { style: { margin: '6px 0 0 0', fontSize: '12px', color: '#e2e8f0', lineHeight: 1.5 } }, r.summary)
              ))
            )
          )
        );
      };

      // -------------------------------------------------------------
      // 主装配
      // -------------------------------------------------------------
      return h('div', { className: 'okr-v22-root' },
        h('style', null, stylesCss),

        // 顶部全局导航栏 (增加 padding-left: 96px 彻底避让 macOS 红黄绿交通灯)
        h('header', { style: { flex: '0 0 60px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px 0 96px', background: '#0f172a', borderBottom: '1px solid rgba(255, 255, 255, 0.08)', zIndex: 30 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '14px' } },
            h('div', { style: { width: '36px', height: '36px', borderRadius: '10px', background: 'linear-gradient(135deg, #2563eb 0%, #4f46e5 50%, #06b6d4 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 14px rgba(37, 99, 235, 0.35)', fontSize: '18px' } }, '🧭'),
            h('div', null,
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                h('span', { style: { fontSize: '15px', fontWeight: 700, color: '#f8fafc', letterSpacing: '-0.01em' } }, '目标日程罗盘'),
                h('span', { style: { fontSize: '11px', fontWeight: 600, padding: '1px 7px', borderRadius: '9999px', background: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa', border: '1px solid rgba(59, 130, 246, 0.3)' } }, 'OKR+GTD Hybrid'),
                h('span', { style: { fontSize: '11px', fontWeight: 600, padding: '1px 7px', borderRadius: '9999px', background: 'rgba(168, 85, 247, 0.15)', color: '#c084fc', border: '1px solid rgba(168, 85, 247, 0.3)' } }, 'DSH 原生插件')
              ),
              h('p', { style: { margin: '2px 0 0 0', fontSize: '11px', color: '#94a3b8' } }, '大目标长期牵引 · 小日程敏捷落地 · AI 全程协同与复盘')
            ),

            // 避开交通灯后的返回按钮
            h('button', {
              onClick: exitToDsh,
              className: 'okr-btn',
              style: { background: 'rgba(255, 255, 255, 0.08)', color: '#e2e8f0', fontWeight: 600, padding: '5px 12px', borderColor: 'rgba(255,255,255,0.15)' },
              title: '返回 DSH 会话工作台'
            }, '◀ 返回会话')
          ),

          // 主 Tab
          h('nav', { style: { display: 'flex', alignItems: 'center', background: 'rgba(30, 41, 59, 0.7)', padding: '3px', borderRadius: '10px', border: '1px solid rgba(255, 255, 255, 0.08)' } },
            h('button', { className: `nav-tab-btn ${curView === 'calendar' ? 'active' : ''}`, onClick: () => setCurView('calendar') }, '📅 整合日历'),
            h('button', { className: `nav-tab-btn ${curView === 'gantt' ? 'active' : ''}`, onClick: () => setCurView('gantt') }, '📊 甘特与看板'),
            h('button', { className: `nav-tab-btn ${curView === 'workspace' ? 'active' : ''}`, onClick: () => setCurView('workspace') }, '🎯 O 专属空间')
          ),

          // 右侧动作区 (新增显眼的退出按钮)
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
            h('button', {
              onClick: () => setShowCheckinModal(true),
              style: { position: 'relative', display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 12px', borderRadius: '8px', background: 'rgba(245, 158, 11, 0.12)', color: '#fbbf24', border: '1px solid rgba(245, 158, 11, 0.3)', fontSize: '12px', fontWeight: 500 }
            },
              h('span', { style: { width: '7px', height: '7px', borderRadius: '9999px', background: '#fbbf24', position: 'absolute', top: '-2px', right: '-2px', boxShadow: '0 0 6px #fbbf24' } }),
              h('span', null, '今日打卡')
            ),
            h('button', {
              onClick: () => setShowAiDrawer(true),
              style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 14px', borderRadius: '8px', background: 'linear-gradient(135deg, #2563eb, #6366f1)', color: '#ffffff', fontSize: '12px', fontWeight: 600, boxShadow: '0 2px 10px rgba(37, 99, 235, 0.35)' }
            }, '✨ AI Copilot'),
            h('button', {
              onClick: () => setEditScheduleTarget({ id: '', title: '', date: '2026-10-25', start_time: '14:00', end_time: '15:00', objective_id: curOId, status: 'pending' }),
              className: 'okr-btn',
              style: { width: '32px', height: '32px', padding: 0, justifyContent: 'center' }
            }, '+'),
            // 右侧无遮挡退出按钮
            h('button', {
              onClick: exitToDsh,
              className: 'okr-btn',
              style: { background: 'rgba(239, 68, 68, 0.1)', color: '#f87171', borderColor: 'rgba(239, 68, 68, 0.25)', fontWeight: 600, padding: '6px 12px' },
              title: '退出目标日程，返回 DSH 会话'
            }, '✕ 退出到会话')
          )
        ),

        // 主体视口
        h('main', { style: { flex: '1 1 auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', overflowY: 'auto', background: '#0b0f19' } },
          curView === 'calendar' && renderCalendarView(),
          curView === 'gantt' && renderGanttView(),
          curView === 'workspace' && renderWorkspaceView()
        ),

        // 优化点 1: 日程编辑/新建弹窗
        editScheduleTarget && h('div', {
          style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }
        },
          h('div', { className: 'glass-card', style: { width: '480px', background: '#0f172a', border: '1px solid rgba(255, 255, 255, 0.15)', padding: '24px', boxShadow: '0 16px 40px rgba(0,0,0,0.6)' } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' } },
              h('h3', { style: { margin: 0, fontSize: '16px', fontWeight: 700, color: '#ffffff' } }, editScheduleTarget.id ? '编辑日程' : '新建日程'),
              h('button', { onClick: () => setEditScheduleTarget(null), style: { background: 'none', color: '#94a3b8', fontSize: '18px' } }, '✕')
            ),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '12px' } },
              h('div', null,
                h('label', { style: { color: '#94a3b8', display: 'block', marginBottom: '4px' } }, '日程标题'),
                h('input', {
                  value: editScheduleTarget.title,
                  onChange: (e) => setEditScheduleTarget({ ...editScheduleTarget, title: e.target.value }),
                  style: { width: '100%', background: '#090d16', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '8px 10px', color: '#ffffff' }
                })
              ),
              h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } },
                h('div', null,
                  h('label', { style: { color: '#94a3b8', display: 'block', marginBottom: '4px' } }, '所属目标 (O)'),
                  h('select', {
                    value: editScheduleTarget.objective_id,
                    onChange: (e) => setEditScheduleTarget({ ...editScheduleTarget, objective_id: e.target.value }),
                    style: { width: '100%', background: '#090d16', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '8px 10px', color: '#ffffff' }
                  }, curData.objectives.map(o => h('option', { key: o.id, value: o.id }, o.title)))
                ),
                h('div', null,
                  h('label', { style: { color: '#94a3b8', display: 'block', marginBottom: '4px' } }, '所属支撑点 (K)'),
                  h('select', {
                    value: editScheduleTarget.key_point_id || '',
                    onChange: (e) => setEditScheduleTarget({ ...editScheduleTarget, key_point_id: e.target.value }),
                    style: { width: '100%', background: '#090d16', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '8px 10px', color: '#ffffff' }
                  }, curData.key_points.filter(k => k.objective_id === editScheduleTarget.objective_id).map(k => h('option', { key: k.id, value: k.id }, k.title)))
                )
              ),
              h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' } },
                h('div', null,
                  h('label', { style: { color: '#94a3b8', display: 'block', marginBottom: '4px' } }, '日期'),
                  h('input', {
                    type: 'date',
                    value: editScheduleTarget.date,
                    onChange: (e) => setEditScheduleTarget({ ...editScheduleTarget, date: e.target.value }),
                    style: { width: '100%', background: '#090d16', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '8px 10px', color: '#ffffff' }
                  })
                ),
                h('div', null,
                  h('label', { style: { color: '#94a3b8', display: 'block', marginBottom: '4px' } }, '开始时间'),
                  h('input', {
                    type: 'time',
                    value: editScheduleTarget.start_time || '10:00',
                    onChange: (e) => setEditScheduleTarget({ ...editScheduleTarget, start_time: e.target.value }),
                    style: { width: '100%', background: '#090d16', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '8px 10px', color: '#ffffff' }
                  })
                ),
                h('div', null,
                  h('label', { style: { color: '#94a3b8', display: 'block', marginBottom: '4px' } }, '结束时间'),
                  h('input', {
                    type: 'time',
                    value: editScheduleTarget.end_time || '11:00',
                    onChange: (e) => setEditScheduleTarget({ ...editScheduleTarget, end_time: e.target.value }),
                    style: { width: '100%', background: '#090d16', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '8px 10px', color: '#ffffff' }
                  })
                )
              ),
              h('div', null,
                h('label', { style: { color: '#94a3b8', display: 'block', marginBottom: '4px' } }, '执行状态'),
                h('select', {
                  value: editScheduleTarget.status || 'pending',
                  onChange: (e) => setEditScheduleTarget({ ...editScheduleTarget, status: e.target.value }),
                  style: { width: '100%', background: '#090d16', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '8px 10px', color: '#ffffff' }
                },
                  h('option', { value: 'pending' }, '待开始 (To Do)'),
                  h('option', { value: 'in_progress' }, '进行中 (In Progress)'),
                  h('option', { value: 'completed' }, '已完成 (Done)'),
                  h('option', { value: 'skipped' }, '已跳过 (Skipped)')
                )
              ),
              h('div', null,
                h('label', { style: { color: '#94a3b8', display: 'block', marginBottom: '4px' } }, '执行心得 / 反思随记'),
                h('textarea', {
                  value: editScheduleTarget.checkin_note || '',
                  onChange: (e) => setEditScheduleTarget({ ...editScheduleTarget, checkin_note: e.target.value }),
                  rows: 3,
                  placeholder: '记录本次执行的实际体会、心得或灵感...',
                  style: { width: '100%', background: '#090d16', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '8px 10px', color: '#ffffff', resize: 'none' }
                })
              )
            ),
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid rgba(255, 255, 255, 0.08)', paddingTop: '16px', marginTop: '16px' } },
              editScheduleTarget.id ? h('button', {
                className: 'okr-btn okr-btn-danger',
                onClick: () => {
                  if (confirm('确定删除此日程吗？')) {
                    setCurData(prev => ({ ...prev, schedules: prev.schedules.filter(s => s.id !== editScheduleTarget.id) }));
                    setEditScheduleTarget(null);
                  }
                }
              }, '删除日程') : h('div', null),
              h('div', { style: { display: 'flex', gap: '8px' } },
                h('button', { className: 'okr-btn', onClick: () => setEditScheduleTarget(null) }, '取消'),
                h('button', {
                  className: 'okr-btn okr-btn-primary',
                  onClick: () => {
                    if (!editScheduleTarget.title) return alert('请输入标题');
                    if (editScheduleTarget.id) {
                      setCurData(prev => ({
                        ...prev,
                        schedules: prev.schedules.map(s => s.id === editScheduleTarget.id ? editScheduleTarget : s)
                      }));
                    } else {
                      setCurData(prev => ({
                        ...prev,
                        schedules: [...prev.schedules, { ...editScheduleTarget, id: 'SCH_' + Date.now() }]
                      }));
                    }
                    setEditScheduleTarget(null);
                  }
                }, '保存修改')
              )
            )
          )
        ),

        // 优化点 1: 大目标 O 编辑/新建弹窗
        editObjectiveTarget && h('div', {
          style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }
        },
          h('div', { className: 'glass-card', style: { width: '480px', background: '#0f172a', border: '1px solid rgba(255, 255, 255, 0.15)', padding: '24px', boxShadow: '0 16px 40px rgba(0,0,0,0.6)' } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' } },
              h('h3', { style: { margin: 0, fontSize: '16px', fontWeight: 700, color: '#ffffff' } }, editObjectiveTarget.id ? '编辑大目标 (Objective)' : '新建大目标 (Objective)'),
              h('button', { onClick: () => setEditObjectiveTarget(null), style: { background: 'none', color: '#94a3b8', fontSize: '18px' } }, '✕')
            ),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '12px' } },
              h('div', { style: { display: 'grid', gridTemplateColumns: '80px 1fr', gap: '10px' } },
                h('div', null,
                  h('label', { style: { color: '#94a3b8', display: 'block', marginBottom: '4px' } }, '图标 Emoji'),
                  h('input', {
                    value: editObjectiveTarget.icon,
                    onChange: (e) => setEditObjectiveTarget({ ...editObjectiveTarget, icon: e.target.value }),
                    style: { width: '100%', background: '#090d16', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '8px 10px', color: '#ffffff', textAlign: 'center', fontSize: '18px' }
                  })
                ),
                h('div', null,
                  h('label', { style: { color: '#94a3b8', display: 'block', marginBottom: '4px' } }, '目标标题'),
                  h('input', {
                    value: editObjectiveTarget.title,
                    onChange: (e) => setEditObjectiveTarget({ ...editObjectiveTarget, title: e.target.value }),
                    style: { width: '100%', background: '#090d16', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '8px 10px', color: '#ffffff' }
                  })
                )
              ),
              h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } },
                h('div', null,
                  h('label', { style: { color: '#94a3b8', display: 'block', marginBottom: '4px' } }, '分类标签'),
                  h('input', {
                    value: editObjectiveTarget.category,
                    onChange: (e) => setEditObjectiveTarget({ ...editObjectiveTarget, category: e.target.value }),
                    style: { width: '100%', background: '#090d16', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '8px 10px', color: '#ffffff' }
                  })
                ),
                h('div', null,
                  h('label', { style: { color: '#94a3b8', display: 'block', marginBottom: '4px' } }, '主题色标'),
                  h('input', {
                    type: 'color',
                    value: editObjectiveTarget.color,
                    onChange: (e) => setEditObjectiveTarget({ ...editObjectiveTarget, color: e.target.value }),
                    style: { width: '100%', height: '35px', background: '#090d16', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', cursor: 'pointer' }
                  })
                )
              ),
              h('div', null,
                h('label', { style: { color: '#94a3b8', display: 'block', marginBottom: '4px' } }, '核心愿景描述 (Vision)'),
                h('textarea', {
                  value: editObjectiveTarget.vision,
                  onChange: (e) => setEditObjectiveTarget({ ...editObjectiveTarget, vision: e.target.value }),
                  rows: 3,
                  style: { width: '100%', background: '#090d16', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '8px 10px', color: '#ffffff', resize: 'none' }
                })
              )
            ),
            h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', borderTop: '1px solid rgba(255, 255, 255, 0.08)', paddingTop: '16px', marginTop: '16px' } },
              h('button', { className: 'okr-btn', onClick: () => setEditObjectiveTarget(null) }, '取消'),
              h('button', {
                className: 'okr-btn okr-btn-primary',
                onClick: () => {
                  if (!editObjectiveTarget.title) return alert('请输入目标标题');
                  if (editObjectiveTarget.id) {
                    setCurData(prev => ({
                      ...prev,
                      objectives: prev.objectives.map(o => o.id === editObjectiveTarget.id ? editObjectiveTarget : o)
                    }));
                  } else {
                    const newId = 'O_' + Date.now();
                    setCurData(prev => ({
                      ...prev,
                      objectives: [...prev.objectives, { ...editObjectiveTarget, id: newId, progress: 0, is_archived: false }]
                    }));
                    setCurOId(newId);
                  }
                  setEditObjectiveTarget(null);
                }
              }, '保存目标')
            )
          )
        ),

        // 优化点 1: 支撑点 K 编辑/新建弹窗
        editKeypointTarget && h('div', {
          style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }
        },
          h('div', { className: 'glass-card', style: { width: '480px', background: '#0f172a', border: '1px solid rgba(255, 255, 255, 0.15)', padding: '24px', boxShadow: '0 16px 40px rgba(0,0,0,0.6)' } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' } },
              h('h3', { style: { margin: 0, fontSize: '16px', fontWeight: 700, color: '#ffffff' } }, editKeypointTarget.id ? '编辑核心支撑点 (Key Point)' : '新建核心支撑点 (Key Point)'),
              h('button', { onClick: () => setEditKeypointTarget(null), style: { background: 'none', color: '#94a3b8', fontSize: '18px' } }, '✕')
            ),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '12px' } },
              h('div', null,
                h('label', { style: { color: '#94a3b8', display: 'block', marginBottom: '4px' } }, '支撑点标题'),
                h('input', {
                  value: editKeypointTarget.title,
                  onChange: (e) => setEditKeypointTarget({ ...editKeypointTarget, title: e.target.value }),
                  style: { width: '100%', background: '#090d16', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '8px 10px', color: '#ffffff' }
                })
              ),
              h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } },
                h('div', null,
                  h('label', { style: { color: '#94a3b8', display: 'block', marginBottom: '4px' } }, '排期时间窗口'),
                  h('input', {
                    value: editKeypointTarget.target_window,
                    onChange: (e) => setEditKeypointTarget({ ...editKeypointTarget, target_window: e.target.value }),
                    style: { width: '100%', background: '#090d16', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '8px 10px', color: '#ffffff' }
                  })
                ),
                h('div', null,
                  h('label', { style: { color: '#94a3b8', display: 'block', marginBottom: '4px' } }, '完成度百分比 (%)'),
                  h('input', {
                    type: 'number',
                    min: 0,
                    max: 100,
                    value: editKeypointTarget.progress,
                    onChange: (e) => setEditKeypointTarget({ ...editKeypointTarget, progress: parseInt(e.target.value || '0', 10) }),
                    style: { width: '100%', background: '#090d16', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '8px 10px', color: '#ffffff' }
                  })
                )
              ),
              h('div', null,
                h('label', { style: { color: '#94a3b8', display: 'block', marginBottom: '4px' } }, '关联文档路径'),
                h('input', {
                  value: editKeypointTarget.doc_path || '',
                  onChange: (e) => setEditKeypointTarget({ ...editKeypointTarget, doc_path: e.target.value }),
                  style: { width: '100%', background: '#090d16', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '8px 10px', color: '#ffffff' }
                })
              )
            ),
            h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', borderTop: '1px solid rgba(255, 255, 255, 0.08)', paddingTop: '16px', marginTop: '16px' } },
              h('button', { className: 'okr-btn', onClick: () => setEditKeypointTarget(null) }, '取消'),
              h('button', {
                className: 'okr-btn okr-btn-primary',
                onClick: () => {
                  if (!editKeypointTarget.title) return alert('请输入支撑点标题');
                  if (editKeypointTarget.id) {
                    setCurData(prev => ({
                      ...prev,
                      key_points: prev.key_points.map(k => k.id === editKeypointTarget.id ? editKeypointTarget : k)
                    }));
                  } else {
                    setCurData(prev => ({
                      ...prev,
                      key_points: [...prev.key_points, { ...editKeypointTarget, id: 'K_' + Date.now(), objective_id: curOId }]
                    }));
                  }
                  setEditKeypointTarget(null);
                }
              }, '保存支撑点')
            )
          )
        ),

        // 打卡弹窗
        showCheckinModal && h('div', {
          style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }
        },
          h('div', { className: 'glass-card', style: { width: '480px', background: '#0f172a', border: '1px solid rgba(255, 255, 255, 0.15)', padding: '24px', boxShadow: '0 16px 40px rgba(0,0,0,0.6)' } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px' } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
                h('span', { style: { fontSize: '22px' } }, '🔔'),
                h('div', null,
                  h('h3', { style: { margin: 0, fontSize: '16px', fontWeight: 700, color: '#ffffff' } }, '今日日程执行打卡'),
                  h('span', { style: { fontSize: '11px', color: '#94a3b8' } }, '每天养成打卡习惯，记录点滴收获')
                )
              ),
              h('span', { style: { fontSize: '11px', padding: '2px 8px', borderRadius: '9999px', background: 'rgba(255,255,255,0.08)', color: '#94a3b8' } }, '4 项日程')
            ),

            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '280px', overflowY: 'auto', marginBottom: '20px' } },
              curData.schedules.filter(s => s.date === '2026-10-25').map(s => {
                const isDone = (s.status === 'completed');
                return h('div', {
                  key: s.id,
                  style: { background: '#111827', padding: '12px', borderRadius: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }
                },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
                    h('input', { type: 'checkbox', checked: isDone, onChange: () => toggleSchedule(s.id), style: { cursor: 'pointer' } }),
                    h('div', null,
                      h('div', { style: { fontSize: '13px', fontWeight: 600, color: isDone ? '#94a3b8' : '#FFF', textDecoration: isDone ? 'line-through' : 'none' } }, s.title),
                      h('div', { style: { fontSize: '11px', color: '#64748b' } }, `${s.start_time || ''} · ${s.objective_id}`)
                    )
                  ),
                  h('button', {
                    onClick: () => toggleSchedule(s.id),
                    className: 'okr-btn',
                    style: { padding: '4px 10px', fontSize: '11px', color: isDone ? '#34d399' : '#94a3b8', background: isDone ? 'rgba(16,185,129,0.2)' : '#1e293b' }
                  }, isDone ? '已打卡 ✓' : '待打卡')
                );
              })
            ),

            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid rgba(255, 255, 255, 0.08)', paddingTop: '16px' } },
              h('span', { style: { fontSize: '11px', color: '#64748b' } }, '数据自动落盘至 ~/.dsh_okr 并同步至各视图'),
              h('button', { className: 'okr-btn okr-btn-primary', onClick: () => setShowCheckinModal(false) }, '完成打卡')
            )
          )
        ),

        // AI 抽屉
        showAiDrawer && h('div', {
          style: { position: 'fixed', top: 0, right: 0, width: '360px', height: '100%', background: '#0f172a', borderLeft: '1px solid rgba(255, 255, 255, 0.1)', boxShadow: '-10px 0 32px rgba(0,0,0,0.6)', zIndex: 110, display: 'flex', flexDirection: 'column' }
        },
          h('div', { style: { padding: '16px', borderBottom: '1px solid rgba(255, 255, 255, 0.08)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              h('span', { style: { fontSize: '20px' } }, '🤖'),
              h('div', null,
                h('div', { style: { fontSize: '14px', fontWeight: 700, color: '#ffffff' } }, 'AI 日程管家'),
                h('div', { style: { fontSize: '10px', color: '#34d399' } }, '● 已加载全量 OKR 上下文与本地文档')
              )
            ),
            h('button', { style: { background: 'none', color: '#94a3b8', fontSize: '18px', cursor: 'pointer' }, onClick: () => setShowAiDrawer(false) }, '✕')
          ),

          h('div', { style: { padding: '12px', background: '#090d16', borderBottom: '1px solid rgba(255, 255, 255, 0.06)' } },
            h('div', { style: { fontSize: '11px', color: '#64748b', marginBottom: '8px' } }, '快捷指令触发:'),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
              h('button', { className: 'okr-btn', style: { padding: '4px 8px', fontSize: '11px' }, onClick: () => handleAiSend('帮我将今天 Duolingo 学习标记为完成') }, '✅ 标记 Duolingo 完成'),
              h('button', { className: 'okr-btn', style: { padding: '4px 8px', fontSize: '11px' }, onClick: () => handleAiSend('我突然有个灵感：Super Agent 可以用 WebAssembly 隔离运行工具，以实现极低开销的跨平台安全沙箱。') }, '💡 记录 WASM 灵感'),
              h('button', { className: 'okr-btn', style: { padding: '4px 8px', fontSize: '11px' }, onClick: () => handleAiSend('帮我拆解明天的卧推热身动作清单') }, '🏋️ 拆解卧推热身')
            )
          ),

          h('div', { style: { flex: 1, padding: '16px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px' } },
            aiLogs.map((log, idx) => h('div', {
              key: idx,
              style: {
                alignSelf: log.sender === 'user' ? 'flex-end' : 'flex-start',
                background: log.sender === 'user' ? '#2563eb' : '#1e293b',
                color: '#f8fafc',
                padding: '10px 14px',
                borderRadius: '12px',
                fontSize: '12px',
                lineHeight: 1.5,
                maxWidth: '88%'
              }
            }, log.text))
          ),

          h('div', { style: { padding: '14px', borderTop: '1px solid rgba(255, 255, 255, 0.08)', display: 'flex', gap: '8px' } },
            h('input', {
              value: aiQuery,
              onChange: (e) => setAiQuery(e.target.value),
              onKeyDown: (e) => e.key === 'Enter' && handleAiSend(),
              placeholder: '输入指令，如：今天跟读了BBC新闻并打卡...',
              style: { flex: 1, background: '#090d16', border: '1px solid rgba(255, 255, 255, 0.12)', borderRadius: '8px', padding: '8px 12px', color: '#ffffff', fontSize: '12px' }
            }),
            h('button', { className: 'okr-btn okr-btn-primary', onClick: () => handleAiSend() }, '发送')
          )
        )
      );
    }

    // 侧边栏常驻入口
    function SidebarPanelIcon() {
      return h('div', {
        title: '目标日程罗盘',
        style: { width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px', cursor: 'pointer' }
      }, '🧭');
    }

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        pluginCtx = ctx;
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'okr-schedule',
          order: 12,
          label: '目标日程'
        }, SidebarPanelIcon));

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'okr-schedule'
        }, OkrScheduleApp));
      }
    };
  }
});
