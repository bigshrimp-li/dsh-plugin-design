window.__ModuleLoader__.load({
  id: '@local/agent-session-visualizer',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    const DEFAULT_SERVER_URL = 'http://127.0.0.1:3789';
    let currentCtx = null;

    const PROVIDERS = [
      { id: 'codex', label: 'Codex', icon: '🤖' },
      { id: 'claude', label: 'Claude Code', icon: '⚡' },
      { id: 'grok', label: 'Grok Build', icon: '🧠' },
      { id: 'noval', label: 'Noval', icon: '📖' },
    ];

    /**
     * 返回 DSH 会话主页面
     */
    function navigateBackToMain() {
      try {
        if (currentCtx && currentCtx.layout && typeof currentCtx.layout.selectPanel === 'function') {
          currentCtx.layout.selectPanel('conversation');
          return;
        }
      } catch (err) {
        console.warn('[ASV] Failed to navigate using layout.selectPanel:', err);
      }

      // 回退方案 1: 寻找并点击侧边栏会话项
      const sessionRow = document.querySelector('[data-session-id], .sidebar-session-row, [role="button"][aria-label*="会话"]');
      if (sessionRow) {
        sessionRow.click();
        return;
      }

      // 回退方案 2: 全局 postMessage
      window.postMessage({ type: 'dsh-navigate-view', view: 'conversation' }, '*');
    }

    // 侧边栏图标组件 (带分支时序节点图形)
    function SidebarPanelIcon(props) {
      const active = Boolean(props && props.active);
      const strokeColor = active ? '#60a5fa' : '#94a3b8';
      const nodeColor = active ? '#38bdf8' : '#64748b';

      return h('div', {
        title: '会话轨迹透视 (Session Trace Visualizer)',
        style: {
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
        }
      }, h('svg', {
        viewBox: '0 0 24 24',
        width: 20,
        height: 20,
        fill: 'none',
        stroke: strokeColor,
        strokeWidth: '1.75',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      },
        h('circle', { cx: 5, cy: 6, r: 2.5, fill: nodeColor }),
        h('circle', { cx: 12, cy: 18, r: 2.5, fill: nodeColor }),
        h('circle', { cx: 19, cy: 8, r: 2.5, fill: nodeColor }),
        h('path', { d: 'M5 8.5v4a3 3 0 0 0 3 3h4' }),
        h('path', { d: 'M12 15.5v-2a3 3 0 0 1 3-3h4' }),
        h('path', { d: 'M14 6h5' })
      ));
    }

    // 主面板组件：全功能外层控制台与 Trace 展示大盘
    function SessionVisualizerMainPanel(props) {
      const [loading, setLoading] = useState(true);
      const [online, setOnline] = useState(true);
      const [refreshKey, setRefreshKey] = useState(0);
      const [currentProvider, setCurrentProvider] = useState('codex');
      const [currentSessionId, setCurrentSessionId] = useState('');
      const [sessions, setSessions] = useState([]);
      const [providerCounts, setProviderCounts] = useState({});
      const iframeRef = useRef(null);

      const serverUrl = DEFAULT_SERVER_URL;

      // 1. 获取指定 provider 的 sessions 列表
      const fetchSessionsForProvider = useCallback(async (provider) => {
        try {
          const res = await fetch(`${serverUrl}/api/providers/${provider}/sessions`, { cache: 'no-store' });
          if (res.ok) {
            const data = await res.json();
            const list = data.sessions || [];
            setSessions(list);
            setProviderCounts((prev) => ({
              ...prev,
              [provider]: data.metrics?.total ?? list.length,
            }));
            return list;
          }
        } catch (_) {}
        return [];
      }, [serverUrl]);

      // 2. 初始健康检查与并发拉取各 Provider 的计数
      useEffect(() => {
        let isMounted = true;
        async function initData() {
          try {
            const healthRes = await fetch(`${serverUrl}/api/health`, { cache: 'no-store' });
            if (isMounted) setOnline(healthRes.ok);
          } catch (_) {
            if (isMounted) setOnline(false);
          }

          // 初始拉取默认 provider
          const initialList = await fetchSessionsForProvider(currentProvider);
          if (isMounted && initialList.length > 0 && !currentSessionId) {
            setCurrentSessionId(initialList[0].id);
          }

          // 探测所有 provider 的数量
          for (const p of PROVIDERS) {
            if (p.id === currentProvider) continue;
            fetch(`${serverUrl}/api/providers/${p.id}/sessions`, { cache: 'no-store' })
              .then((r) => (r.ok ? r.json() : null))
              .then((data) => {
                if (data && isMounted) {
                  setProviderCounts((prev) => ({
                    ...prev,
                    [p.id]: data.metrics?.total ?? (data.sessions || []).length,
                  }));
                }
              })
              .catch(() => {});
          }
        }

        initData();
        const interval = setInterval(() => {
          fetch(`${serverUrl}/api/health`, { cache: 'no-store' })
            .then((r) => isMounted && setOnline(r.ok))
            .catch(() => isMounted && setOnline(false));
        }, 5000);

        return () => {
          isMounted = false;
          clearInterval(interval);
        };
      }, [serverUrl, fetchSessionsForProvider]);

      // 3. 监听来自 iframe 内部的状态同步
      useEffect(() => {
        const handleMessage = (event) => {
          if (!event.data || typeof event.data !== 'object') return;
          const { type, provider, currentSessionId: sid, sessions: sList, providerCounts: counts } = event.data;
          if (type === 'asv-state-sync') {
            if (provider) setCurrentProvider(provider);
            if (sid) setCurrentSessionId(sid);
            if (Array.isArray(sList) && sList.length > 0) setSessions(sList);
            if (counts) setProviderCounts((prev) => ({ ...prev, ...counts }));
          }
        };

        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
      }, []);

      // 4. 切换 Provider 处理
      const handleSwitchProvider = async (providerId) => {
        if (providerId === currentProvider) return;
        setCurrentProvider(providerId);

        // 发送给 iframe
        if (iframeRef.current && iframeRef.current.contentWindow) {
          iframeRef.current.contentWindow.postMessage({
            type: 'asv-switch-provider',
            provider: providerId,
          }, '*');
        }

        // 刷新外层 session 列表
        const list = await fetchSessionsForProvider(providerId);
        if (list.length > 0) {
          setCurrentSessionId(list[0].id);
        } else {
          setCurrentSessionId('');
        }
      };

      // 5. 切换具体 Session Trace
      const handleSelectSession = (sid) => {
        if (!sid || sid === currentSessionId) return;
        setCurrentSessionId(sid);
        if (iframeRef.current && iframeRef.current.contentWindow) {
          iframeRef.current.contentWindow.postMessage({
            type: 'asv-switch-session',
            provider: currentProvider,
            sessionId: sid,
          }, '*');
        }
      };

      // 6. 打开完整会话目录库弹窗
      const handleOpenSessionBrowser = () => {
        if (iframeRef.current && iframeRef.current.contentWindow) {
          iframeRef.current.contentWindow.postMessage({ type: 'asv-open-browser' }, '*');
        }
      };

      const handleReload = () => {
        setLoading(true);
        setRefreshKey((k) => k + 1);
        fetchSessionsForProvider(currentProvider);
      };

      const handleOpenExternal = () => {
        const query = currentSessionId ? `?provider=${currentProvider}&session=${encodeURIComponent(currentSessionId)}` : `?provider=${currentProvider}`;
        window.open(`${serverUrl}/${query}`, '_blank', 'noopener,noreferrer');
      };

      return h('div', {
        style: {
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: '#0a0d14',
          color: '#e2e8f0',
          overflow: 'hidden',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif',
        }
      },
        // 顶部集成控制台 (48px 高度，集成 Provider 药丸组与 Trace 下拉菜单)
        h('div', {
          style: {
            height: '48px',
            background: 'linear-gradient(180deg, #131826 0%, #0d121e 100%)',
            borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 16px',
            flexShrink: 0,
            zIndex: 10,
            gap: '12px',
          }
        },
          // 左侧：返回按钮 + Provider 胶囊选择器
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 } },
            // 返回主页面
            h('button', {
              onClick: navigateBackToMain,
              title: '返回 DSH 会话主页面',
              style: {
                background: 'rgba(59, 130, 246, 0.16)',
                border: '1px solid rgba(59, 130, 246, 0.45)',
                color: '#60a5fa',
                padding: '5px 12px',
                borderRadius: '6px',
                fontSize: '12px',
                fontWeight: 600,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                transition: 'all 0.15s ease',
              },
            },
              h('span', { style: { fontSize: '13px', lineHeight: 1 } }, '←'),
              h('span', null, '返回主页面')
            ),

            h('div', { style: { width: '1px', height: '18px', background: 'rgba(255, 255, 255, 0.12)' } }),

            // Agent / Provider 药丸切换组
            h('div', {
              style: {
                display: 'inline-flex',
                background: 'rgba(0, 0, 0, 0.35)',
                padding: '2px',
                borderRadius: '8px',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                gap: '2px',
              }
            },
              PROVIDERS.map((p) => {
                const isActive = p.id === currentProvider;
                const count = providerCounts[p.id];
                return h('button', {
                  key: p.id,
                  onClick: () => handleSwitchProvider(p.id),
                  title: `切换到 ${p.label} 的会话轨迹`,
                  style: {
                    background: isActive ? '#2563eb' : 'transparent',
                    color: isActive ? '#ffffff' : '#94a3b8',
                    border: 'none',
                    padding: '4px 10px',
                    borderRadius: '6px',
                    fontSize: '12px',
                    fontWeight: isActive ? 600 : 500,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '5px',
                    transition: 'all 0.15s ease',
                    boxShadow: isActive ? '0 1px 6px rgba(37, 99, 235, 0.4)' : 'none',
                  }
                },
                  h('span', { style: { fontSize: '12px' } }, p.icon),
                  h('span', null, p.label),
                  h('span', {
                    style: {
                      fontSize: '10px',
                      padding: '1px 5px',
                      borderRadius: '10px',
                      background: isActive ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.06)',
                      color: isActive ? '#ffffff' : '#64748b',
                    }
                  }, count != null ? count : '·')
                );
              })
            )
          ),

          // 中间：当前 Agent 的具体 Trace 会话选择下拉框
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flex: 1, maxWidth: '520px', minWidth: '220px' } },
            h('span', { style: { fontSize: '11px', color: '#64748b', flexShrink: 0 } }, 'Trace:'),
            h('select', {
              value: currentSessionId,
              onChange: (e) => handleSelectSession(e.target.value),
              title: '选择具体的会话 Trace 进行观察',
              style: {
                flex: 1,
                background: '#090d16',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                borderRadius: '6px',
                color: '#f8fafc',
                padding: '5px 10px',
                fontSize: '12px',
                outline: 'none',
                cursor: 'pointer',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
              }
            },
              sessions.length === 0 && h('option', { value: '' }, '暂无会话记录'),
              sessions.map((s) => {
                const titlePreview = (s.title || s.latestPrompt || s.id).slice(0, 38);
                const shortId = s.shortId || s.id.slice(0, 8);
                const dateStr = s.updatedAt ? new Date(s.updatedAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
                return h('option', {
                  key: s.id,
                  value: s.id,
                }, `[${shortId}] ${titlePreview} ${dateStr ? `(${dateStr})` : ''}`);
              })
            ),

            // 打开全部会话目录库弹窗
            h('button', {
              onClick: handleOpenSessionBrowser,
              title: '打开完整的 Session 目录浏览器与检索面板',
              style: {
                background: 'rgba(255, 255, 255, 0.08)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                color: '#cbd5e1',
                padding: '5px 10px',
                borderRadius: '6px',
                fontSize: '12px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                flexShrink: 0,
              }
            }, '📂 会话库')
          ),

          // 右侧：刷新、新窗口、退出
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 } },
            h('div', {
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                padding: '3px 8px',
                borderRadius: '12px',
                fontSize: '11px',
                background: online ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                color: online ? '#34d399' : '#f87171',
                border: `1px solid ${online ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
              }
            },
              h('span', {
                style: {
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  backgroundColor: online ? '#10b981' : '#ef4444',
                  boxShadow: online ? '0 0 6px #10b981' : 'none',
                }
              }),
              online ? ':3789' : '未连接'
            ),

            h('button', {
              onClick: handleReload,
              title: '重新载入当前视图',
              style: {
                background: 'rgba(255, 255, 255, 0.06)',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                color: '#cbd5e1',
                padding: '5px 10px',
                borderRadius: '6px',
                fontSize: '12px',
                cursor: 'pointer',
              }
            }, '↻ 刷新'),

            h('button', {
              onClick: handleOpenExternal,
              title: '在独立浏览器标签页打开',
              style: {
                background: 'rgba(37, 99, 235, 0.15)',
                border: '1px solid rgba(59, 130, 246, 0.3)',
                color: '#60a5fa',
                padding: '5px 10px',
                borderRadius: '6px',
                fontSize: '12px',
                cursor: 'pointer',
              }
            }, '↗ 弹窗'),

            h('button', {
              onClick: navigateBackToMain,
              title: '退出插件，返回 DSH 对话页面',
              style: {
                background: 'rgba(255, 255, 255, 0.08)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                color: '#cbd5e1',
                padding: '5px 10px',
                borderRadius: '6px',
                fontSize: '12px',
                cursor: 'pointer',
              }
            }, '✕ 退出')
          )
        ),

        // 主体嵌入 iframe 区域
        h('div', {
          style: {
            flex: 1,
            position: 'relative',
            width: '100%',
            height: 'calc(100% - 48px)',
            backgroundColor: '#07090e',
          }
        },
          loading && h('div', {
            style: {
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '12px',
              background: '#07090e',
              zIndex: 5,
              color: '#94a3b8',
              fontSize: '13px',
            }
          },
            h('div', {
              style: {
                width: '28px',
                height: '28px',
                border: '3px solid rgba(59, 130, 246, 0.2)',
                borderTopColor: '#3b82f6',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite',
              }
            }),
            h('span', null, '正在加载会话执行轨迹拓扑...')
          ),
          h('iframe', {
            key: refreshKey,
            ref: iframeRef,
            src: serverUrl,
            onLoad: () => setLoading(false),
            style: {
              width: '100%',
              height: '100%',
              border: 'none',
              display: 'block',
              background: '#07090e',
            },
            allow: 'clipboard-read; clipboard-write',
          })
        )
      );
    }

    // 会话详情页内置 Trace 视图选项卡 (conversation.view)
    function ConversationTraceInlineView(props) {
      const sessionId = props && props.sessionId ? props.sessionId : '';
      const targetUrl = sessionId
        ? `${DEFAULT_SERVER_URL}/?session=${encodeURIComponent(sessionId)}`
        : DEFAULT_SERVER_URL;

      return h('div', {
        style: {
          width: '100%',
          height: '100%',
          position: 'relative',
          backgroundColor: '#07090e',
        }
      },
        h('iframe', {
          src: targetUrl,
          style: {
            width: '100%',
            height: '100%',
            border: 'none',
            display: 'block',
          },
          allow: 'clipboard-read; clipboard-write',
        })
      );
    }

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        currentCtx = ctx;

        // 监听来自 iframe 内部的返回主页 postMessage
        if (typeof window !== 'undefined') {
          window.addEventListener('message', (event) => {
            if (event.data && (event.data.type === 'asv-navigate-dsh' || event.data.type === 'dsh-navigate-view')) {
              navigateBackToMain();
            }
          });
        }

        // 1. 侧边栏常驻入口
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'agent-session-visualizer',
          order: 14,
          label: '会话可视化',
        }, SidebarPanelIcon));

        // 2. 主面板 Central Panel
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'agent-session-visualizer',
        }, SessionVisualizerMainPanel));

        // 3. Conversation 详情页中的 Trace 视图切换卡
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: 'trace',
          order: 15,
          label: 'Trace',
        }, ConversationTraceInlineView));
      },
    };
  },
});
