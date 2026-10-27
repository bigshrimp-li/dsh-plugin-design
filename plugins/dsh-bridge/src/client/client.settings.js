/** Production settings: one target, one draft, one atomic activation. */
window.__ModuleLoader__.load({
  id: "@super-agent/dsh-bridge", chunk: "client.settings.js",
  factory() {
    const SECTIONS = [["connection", "连接与环境"], ["models", "模型"], ["skills", "Skill"], ["workspace", "工作区与同步"], ["context", "项目上下文"], ["tools", "工具与审批"], ["runtime", "云端运行验证"]];
    const TOOL_NAMES = { read: "读取文件", read_attachment: "按授权范围读取附件", ls: "列出目录", find: "查找文件", grep: "搜索内容", write: "写入文件", edit: "编辑文件", bash: "Shell", ask_user: "向用户提问" };
    const copy = value => JSON.parse(JSON.stringify(value));
    function prepareProviderEdit(value, credentials) {
      const noAuth = value.driver === "compatible" && value.authScheme === "none";
      const credentialRef = value.credentialRef || (noAuth ? `${value.id}-none` : "");
      if (!credentialRef) throw new Error("请先暂存密钥或选择已有凭据引用");
      const common = { id: value.id, driver: value.driver, credentialRef, protocolOptions: copy(value.protocolOptions || {}) };
      if (value.driver === "pi_builtin") return { entry: { ...common, nativeProvider: value.nativeProvider }, credential: null };
      const url = new URL(value.baseUrl), loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || url.protocol === "http:" && loopback && value.allowLoopbackHttp === true)) throw new Error("提供方须使用不带凭据和查询参数的 HTTPS 地址；本机 HTTP 需明确开启例外");
      if (noAuth && !loopback) throw new Error("无认证仅适用于本机回环地址");
      if (value.authScheme === "x-api-key" && value.protocol !== "anthropic-messages") throw new Error("x-api-key 仅适用于 anthropic-messages");
      const existing = credentials.find(row => row.id === credentialRef);
      if (noAuth && existing && existing.kind !== "none") throw new Error("该引用已用于密钥；请为无认证方式使用新的凭据引用");
      return { entry: { ...common, protocol: value.protocol, baseUrl: value.baseUrl, authScheme: value.authScheme, allowLoopbackHttp: value.allowLoopbackHttp === true }, credential: noAuth && !existing ? { id: credentialRef, kind: "none" } : null };
    }
    function changesBetween(before, after, prefix = "") {
      if (JSON.stringify(before) === JSON.stringify(after)) return [];
      if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
        return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(key => changesBetween(before[key], after[key], prefix ? `${prefix}.${key}` : key));
      }
      return [{ field: prefix, before, after }];
    }
    function mergeDraft(base, server, mine) {
      const merged = copy(server), conflicts = [];
      for (const change of changesBetween(base, mine)) {
        const keys = change.field.split(".");
        const get = object => keys.reduce((value, key) => value?.[key], object);
        if (JSON.stringify(get(server)) !== JSON.stringify(change.before) && JSON.stringify(get(server)) !== JSON.stringify(change.after)) conflicts.push({ ...change, server: get(server) });
        let owner = merged; for (const key of keys.slice(0, -1)) owner = owner[key] ||= {};
        if (change.after === undefined) delete owner[keys.at(-1)]; else owner[keys.at(-1)] = copy(change.after);
      }
      return { merged, conflicts };
    }
    function createSettingsController({ transport, onTargetChanged, onTargetForgotten, fetchImpl = globalThis.fetch, storage = globalThis.localStorage }) {
      let state = { section: "connection", targets: [], selectedId: null, compatibilityUds: true, baseline: null, draft: null, version: null, instanceId: null,
        changes: [], unconfirmedOperation: false, busy: false, error: "", note: "", operation: null, conflict: null, catalog: [], loaded: false, resources: {}, mcpChecks: {} };
      const listeners = new Set(); let epoch = 0, pendingApply = null;
      const storageKey = (target = state.selectedId, instance = state.instanceId) => `super-agent.settings-draft.v1.${target || "uds"}.${instance || "unknown"}`;
      const persistDraft = () => { try { if (!state.instanceId) return; if (state.changes.length || pendingApply) storage?.setItem(storageKey(), JSON.stringify({ baseline: state.baseline, draft: state.draft, version: state.version, operation: state.operation, pendingApply })); else storage?.removeItem(storageKey()); } catch {} };
      const hasUnconfirmedOperation = () => !!pendingApply || !!(state.operation && !["succeeded", "failed"].includes(state.operation.status));
      const set = patch => { state = { ...state, ...patch }; state.unconfirmedOperation = hasUnconfirmedOperation(); state.changes = changesBetween(state.baseline, state.draft); persistDraft(); for (const listener of listeners) listener(); };
      const call = async (action, payload = {}) => {
        if (hasUnconfirmedOperation() && (action === "targets.select" || ["targets.save", "targets.logout", "targets.remove"].includes(action) && payload.targetId === state.selectedId)) throw new Error("原配置操作尚未确认；请先查询原操作，再修改、注销、移除或切换目标");
        if (hasUnconfirmedOperation() && action === "targets.pair" && payload.targetId === state.selectedId) payload = { ...payload, expectedInstanceId: state.instanceId };
        const response = await fetchImpl("/super-agent/action", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, payload: { ...payload, ...(!action.startsWith("targets.") && (Object.hasOwn(payload, "targetId") ? payload.targetId : state.selectedId) ? { targetId: Object.hasOwn(payload, "targetId") ? payload.targetId : state.selectedId } : {}) } }) });
        const body = await response.json();
        if (!response.ok) { const error = new Error(body?.error?.message || `HTTP ${response.status}`); error.code = body?.error?.code; throw error; }
        return body.result;
      };
      const id = action => transport.nextRequestId(action);
      const load = async ({ preserve = false } = {}) => {
        const at = ++epoch; set({ busy: true, error: "" });
        try {
          const targets = await call("targets.list"); if (at !== epoch) return;
          set({ ...targets, loaded: true });
          const [settings, models] = await Promise.allSettled([call("settings.get"), call("models.list")]); if (at !== epoch) return;
          if (models.status === "fulfilled") set({ catalog: Array.isArray(models.value) ? models.value : models.value?.items || [] });
          if (settings.status === "fulfilled" && settings.value?.configuration) {
            if (preserve && state.draft && state.baseline) {
              const result = mergeDraft(state.baseline, settings.value.configuration, state.draft);
              set({ conflict: { server: settings.value, mine: copy(state.draft), base: copy(state.baseline), ...result } });
            } else {
              let restored;
              if (!state.baseline && !state.draft) { try { restored = JSON.parse(storage?.getItem(storageKey(state.selectedId, settings.value.instanceId)) || "null"); } catch {} }
              if (restored?.baseline && restored?.draft) {
                const merged = mergeDraft(restored.baseline, settings.value.configuration, restored.draft);
                pendingApply = restored.pendingApply || null;
                set({ baseline: copy(settings.value.configuration), draft: merged.merged, version: settings.value.version, instanceId: settings.value.instanceId,
                  operation: restored.operation || null, conflict: merged.conflicts.length ? { server: settings.value, mine: restored.draft, base: restored.baseline, ...merged } : null,
                  note: pendingApply ? "已恢复原配置操作；请先查询原操作。" : "已恢复此目标的未应用草稿；请核对临时凭据有效期后重新审阅。" });
              } else set({ baseline: copy(settings.value.configuration), draft: copy(settings.value.configuration), version: settings.value.version, instanceId: settings.value.instanceId, conflict: null });
            }
          } else set({ error: settings.reason?.message || "当前目标未提供设置合同", baseline: null, draft: null, version: null });
        } catch (error) { if (at === epoch) set({ error: error.message, loaded: true }); }
        finally { if (at === epoch) set({ busy: false }); }
      };
      const action = async (name, payload = {}) => {
        set({ busy: true, error: "", note: "" });
        try { const result = await call(name, payload); return result; }
        catch (error) { set({ error: error.message }); throw error; }
        finally { set({ busy: false }); }
      };
      const controller = {
        getSnapshot: () => state, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
        load, call, action, nextRequestId: id,
        setSection: section => set({ section }),
        report: error => set({ error: error?.message || String(error || "") }),
        note: note => set({ note }),
        async checkMcp(server) {
          const targetId = state.selectedId, instanceId = state.instanceId, at = epoch;
          const result = await action("mcp.check", { server });
          if (epoch === at && state.selectedId === targetId && state.instanceId === instanceId) set({ mcpChecks: { ...state.mcpChecks, [server.id]: { server: copy(server), result: copy(result) } } });
          return result;
        },
        edit(update) { if (hasUnconfirmedOperation()) throw new Error("原配置操作尚未确认；请先查询原操作再编辑草稿"); if (!state.draft) return; const draft = copy(state.draft); update(draft); set({ draft }); },
        async abandon() {
          if (hasUnconfirmedOperation()) throw new Error("原配置操作尚未确认；请先查询原操作，不能放弃草稿或释放凭据引用");
          for (const reference of state.draft?.modelConfiguration?.credentials || []) {
            if (reference.source?.type === "credential_store" && !state.baseline?.modelConfiguration?.credentials?.some(item => item.source?.ref === reference.source.ref)) {
              await call("credentials.release", { credentialRef: reference.source.ref }).catch(() => {});
            }
          }
          for (const server of state.draft?.mcpServers || []) if (server.credentialRef && !state.baseline?.mcpServers?.some(previous => previous.credentialRef === server.credentialRef)) await call("credentials.release", { credentialRef: server.credentialRef }).catch(() => {});
          pendingApply = null; set({ draft: state.baseline ? copy(state.baseline) : null, conflict: null, error: "", note: "已放弃未应用的配置草稿；已发布的文件版本保留。" });
        },
        async targetAction(name, payload = {}) {
          if (name === "select" && hasUnconfirmedOperation()) throw new Error("原目标配置操作尚未确认；请先查询原操作，再切换目标。");
          const oldKey = storageKey();
          const result = await action(`targets.${name}`, payload);
          if (["logout", "remove"].includes(name)) { onTargetForgotten?.(payload.targetId); if (payload.targetId === state.selectedId) { try { storage?.removeItem(oldKey); } catch {} } }
          if (name === "select" || (["logout", "remove"].includes(name) && payload.targetId === state.selectedId)) {
            epoch++; pendingApply = null; set({ baseline: null, draft: null, operation: null, conflict: null, mcpChecks: {} });
            onTargetChanged?.(name === "select" || name === "logout" ? payload.targetId : null, { forget: name !== "select" });
          }
          await load({ preserve: hasUnconfirmedOperation() }); if (name === "logout") set({ note: result.remoteRevocation === "confirmed" ? "本机登录引用已清理，远程注销已确认。" : "本机登录引用和敏感缓存已清理；远程撤销结果未知，重新连接后需要核对。" }); return result;
        },
        async stageSecret(secret) { if (hasUnconfirmedOperation()) throw new Error("原配置操作尚未确认；请先查询原操作，再暂存新凭据"); return action("credentials.stage", { requestId: id("credentials.stage"), secret }); },
        async apply() {
          if (!state.draft || !state.changes.length || state.conflict) return;
          if (!pendingApply) pendingApply = { requestId: id("settings.apply"), expectedVersion: state.version, configuration: copy(state.draft), targetId: state.selectedId };
          set({ busy: true, error: "", note: "正在提交配置，接收回执不表示激活成功。" });
          try {
            const operation = await call("settings.apply", pendingApply); set({ operation });
            if (operation.status === "succeeded") { pendingApply = null; set({ baseline: null, draft: null }); await load(); set({ note: `完整配置已激活，版本 ${operation.version}。已接收任务保留冻结配置。` }); }
            else if (operation.status === "failed") { pendingApply = null; set({ error: `配置未激活：${operation.errorCode || "校验失败"}` }); }
            else set({ note: `配置操作 ${operation.operationId}：${operation.status}。请查询原操作。` });
          } catch (error) {
            if (["VERSION_CONFLICT", "CAS_MISMATCH", "REVISION_CONFLICT"].includes(error.code)) { pendingApply = null; await load({ preserve: true }); }
            else set({ error: `${error.message}。草稿保留；先查询原操作，不要创建新请求。`, operation: { operationId: pendingApply.requestId, status: "unknown" } });
          } finally { set({ busy: false }); }
        },
        async queryOperation() {
          const operationId = state.operation?.operationId || pendingApply?.requestId; if (!operationId) return;
          const operation = await action("settings.operation", { operationId }); set({ operation });
          if (operation.status === "succeeded") { pendingApply = null; set({ baseline: null, draft: null }); await load(); set({ note: `配置已激活，版本 ${operation.version}` }); }
          else if (operation.status === "failed") { pendingApply = null; set({ error: `配置未激活：${operation.errorCode}` }); }
        },
        resolveConflict(choices = {}) {
          const conflict = state.conflict; if (!conflict) return;
          const draft = copy(conflict.merged);
          for (const item of conflict.conflicts) {
            if (!choices[item.field]) throw new Error(`请为 ${item.field} 选择服务端值或我的修改`);
            const value = choices[item.field] === "server" ? item.server : item.after, keys = item.field.split(".");
            let owner = draft; for (const key of keys.slice(0, -1)) owner = owner[key] ||= {};
            if (value === undefined) delete owner[keys.at(-1)]; else owner[keys.at(-1)] = copy(value);
          }
          set({ baseline: copy(conflict.server.configuration), version: conflict.server.version, draft, conflict: null, note: "冲突已合并，请重新审阅后应用。" });
        },
      };
      return controller;
    }

    const CSS = `
.sa-skill-settings{min-width:0}.sa-skill-settings button,.sa-skill-settings-editor button,[role="dialog"]:has(.sa-skill-settings-editor) button{min-width:44px;min-height:44px}.sa-skill-settings .sa-settings-check,.sa-skill-settings-editor .sa-settings-check,.sa-skill-settings summary,.sa-skill-settings-editor summary,.sa-skill-settings input:not([type=checkbox]),.sa-skill-settings select,.sa-skill-settings-editor input:not([type=checkbox]),.sa-skill-settings-editor select{min-height:44px}
.sa-settings{height:100%;min-height:0;min-width:0;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);font:14px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;container-type:inline-size}
.sa-settings *{box-sizing:border-box}.sa-settings h2{font-size:20px;line-height:28px;font-weight:600;margin:0}.sa-settings h3{font-size:15px;margin:0}.sa-settings p{margin:4px 0 12px}.sa-settings-head{display:flex;gap:12px;justify-content:space-between;align-items:center;padding:4px 0 18px;flex-wrap:wrap}.sa-settings-nav{display:flex;gap:4px;overflow-x:auto;flex:none;border-bottom:.5px solid var(--dsw-alias-border-l3);padding-bottom:8px}.sa-settings-nav button{flex:none;white-space:nowrap;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);padding:7px 10px;font:inherit;cursor:pointer}.sa-settings-nav button[aria-selected=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:500}.sa-settings-body{flex:1;min-height:0;overflow:auto;padding:20px 2px 24px}.sa-settings-card{border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;padding:14px 16px;margin:12px 0;min-width:0}.sa-settings-row{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.sa-settings-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.sa-settings label{display:flex;flex-direction:column;gap:5px;color:var(--dsw-alias-label-secondary);font-size:13px;min-width:0}.sa-settings input:not([type=checkbox]),.sa-settings select,.sa-settings textarea{border:.5px solid var(--dsw-alias-border-l3);border-radius:7px;min-width:0;width:100%;height:34px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:6px 10px;font:inherit}.sa-settings textarea{height:100px;resize:vertical}.sa-settings input:focus-visible,.sa-settings select:focus-visible,.sa-settings textarea:focus-visible,.sa-settings button:focus-visible{outline:2px solid var(--dsw-focus-ring-color,#3478f6);outline-offset:1px}.sa-settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.sa-settings-grid .full{grid-column:1/-1}.sa-settings .sa-settings-check{display:flex;flex-direction:row;align-items:center;gap:8px}.sa-settings-muted{color:var(--dsw-alias-label-tertiary);font-size:12px;overflow-wrap:anywhere}.sa-settings-error{color:var(--dsw-alias-state-error-primary);padding:10px 12px;background:var(--dsw-alias-interactive-bg-hover-danger);border-radius:8px;overflow-wrap:anywhere}.sa-settings-notice{padding:10px 12px;background:var(--dsw-alias-interactive-bg-hover);border-radius:8px;margin:10px 0;overflow-wrap:anywhere}.sa-settings-footer{flex:none;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;border-top:.5px solid var(--dsw-alias-border-l3);padding:12px 0 0}.sa-settings pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 var(--dsh-font-family-code,monospace);margin:8px 0}.sa-settings-editor{max-height:65vh;overflow:auto;padding:3px;min-width:min(560px,70vw)}.sa-settings-search{max-width:360px}.sa-settings-diff{display:grid;grid-template-columns:minmax(100px,1fr) minmax(0,2fr);gap:8px;border-bottom:.5px solid var(--dsw-alias-border-l3);padding:10px 0}.sa-settings-diff strong,.sa-settings-diff span{overflow-wrap:anywhere}.sa-settings [role=status]{overflow-wrap:anywhere}.sa-settings-tag{border:.5px solid var(--dsw-alias-border-l3);border-radius:5px;padding:2px 6px;font-size:11px;white-space:nowrap}
@container(max-width:560px){.sa-settings-grid{grid-template-columns:minmax(0,1fr)}.sa-settings-editor{min-width:0;width:100%;max-height:68vh}.sa-settings-head{align-items:flex-start}.sa-settings-diff{grid-template-columns:minmax(0,1fr)}.sa-settings-footer{padding-bottom:10px}.sa-settings-card{padding:12px}.sa-settings-head h2{font-size:18px}}
@media(max-width:600px){
[role=dialog]:has([data-super-agent-settings]){width:calc(100vw - 16px)!important;height:calc(100dvh - 16px)!important;max-height:calc(100dvh - 16px)!important;display:flex!important;flex-direction:column!important;overflow:hidden}
[role=dialog]:has([data-super-agent-settings])>nav{width:100%!important;flex:0 0 auto!important;padding:8px 12px 0!important;min-height:0}
[role=dialog]:has([data-super-agent-settings])>nav>:first-child{display:none}
[role=dialog]:has([data-super-agent-settings])>nav>:last-child{display:flex!important;flex-direction:row!important;overflow-x:auto;gap:4px;padding:0 0 6px}
[role=dialog]:has([data-super-agent-settings])>nav button{flex:none;white-space:nowrap;width:auto!important;padding:7px 9px!important}
[role=dialog]:has([data-super-agent-settings])>div:has([data-super-agent-settings]){width:100%!important;flex:1!important;min-height:0;display:flex;flex-direction:column}
[role=dialog]:has([data-super-agent-settings])>div>div:has([data-super-agent-settings]){padding:0 12px 12px!important;flex:1;min-height:0;overflow:hidden}
}`;

    function createSettings({ kernel, transport, primitives, space, Panel, content }) {
      const { React, h } = kernel, { Button, Modal } = primitives;
      const controller = createSettingsController({ transport, onTargetChanged: (id, options) => space.controller.targetChanged(id, options), onTargetForgotten: id => space.controller.clearTargetCache(id) });
      const useSettings = () => React.useSyncExternalStore(controller.subscribe, controller.getSnapshot);
      const run = fn => Promise.resolve().then(fn).catch(controller.report);
      const button = (label, onClick, options = {}) => h(Button, { variant: "outline", onClick: () => void run(onClick), ...options }, label);
      const notice = text => h("div", { className: "sa-settings-notice" }, text);
      const json = value => value === undefined ? "（未设置）" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
      const checkProviderCredential = async provider => {
        if (!provider.id || !provider.credentialRef) throw new Error("请先填写提供方 ID 并暂存或选择凭据引用");
        const configuration = copy(controller.getSnapshot().draft.modelConfiguration);
        configuration.providers = [...configuration.providers.filter(item => item.id !== provider.id), provider];
        const credential = configuration.credentials.find(item => item.id === provider.credentialRef);
        const ref = credential?.source?.type === "credential_store" ? credential.source.ref : provider.credentialRef;
        const result = await controller.action("credentials.check", { requestId: controller.nextRequestId("credentials.check"), providerId: provider.id, credentialRef: ref, modelConfiguration: configuration });
        controller.note(`凭据检测：${({ endpoint_accepted: "目录请求成功", rejected: "认证拒绝", unsupported: "不支持独立检测", unreachable: "连接失败" })[result.status] || result.status} · ${result.scope === "endpoint_only" ? "未配置认证，仅检查地址" : "已发送认证目录请求"} · ${result.httpStatus ?? result.errorCode ?? "无 HTTP 状态"}。未发起模型生成；特定模型权限与实际用量请另行真实试运行。`);
      };
      const field = (label, value, onChange, options = {}) => h("label", { className: options.full ? "full" : undefined }, label, h("input", { value: value ?? "", onChange: e => onChange(e.target.value), ...options }));
      function TargetEditor({ target, close }) {
        const [value, setValue] = React.useState(target || { name: "", baseUrl: "https://localhost:7443", ca: "" }), [pairingCode, setCode] = React.useState(""), [actorId, setActor] = React.useState(""), [savedId, setSavedId] = React.useState(target?.id || null), s = useSettings();
        const update = (key, next) => setValue(previous => ({ ...previous, [key]: next }));
        const save = async () => { const result = await controller.action("targets.save", { ...value, ...(savedId ? { targetId: savedId } : {}) }); setSavedId(result.id); await controller.load(); };
        return h(Modal, { open: true, title: target ? "编辑 Core 入口" : "添加 Core 入口", onClose: () => { setCode(""); close(); }, closeLabel: "取消",
          footer: h("div", { className: "sa-settings-actions" }, button("取消", close), button("保存入口", save, { disabled: s.busy || s.unconfirmedOperation && savedId === s.selectedId }), button("配对", async () => { await controller.targetAction("pair", { targetId: savedId, pairingCode, actorId }); setCode(""); close(); }, { disabled: s.busy || !savedId || !pairingCode.trim() || !actorId.trim(), variant: "primary" })) },
          h("div", { className: "sa-settings sa-settings-editor" }, h("style", null, CSS), h("div", { className: "sa-settings-grid" },
            field("环境名称", value.name, next => update("name", next), { full: true }), field("Core HTTPS 地址", value.baseUrl, next => update("baseUrl", next), { full: true, placeholder: "https://localhost:7443" }),
            h("label", { className: "full" }, "自定义 CA（PEM，可选）", h("textarea", { value: value.ca || "", placeholder: "仅适用于自签发 CA；仍校验地址和证书有效期", onChange: e => update("ca", e.target.value) })),
            field("操作者标识", actorId, setActor, { full: true, autoComplete: "username" }), field("初始配对码（只写）", pairingCode, setCode, { full: true, type: "password", autoComplete: "new-password" })),
            notice("先保存入口，再配对。认证令牌仅保存在 DSH 宿主，本页不读取令牌。不同 Core 实例须重新配对。"), s.error && h("div", { role: "alert", className: "sa-settings-error" }, s.error)));
      }
      function Connections({ s, setDialog }) {
        return h(React.Fragment, null, h("div", { className: "sa-settings-row" }, h("div", null, h("h3", null, "连接与环境"), h("p", { className: "sa-settings-muted" }, "本地和远程使用相同的 HTTPS 校验与认证。所有连接用户均可配置和运行。")), button("添加连接", () => setDialog({ type: "target" }))),
          !s.targets.length && notice("尚未添加 HTTPS Core。先添加入口并配对；空模型目录不影响打开设置。"),
          s.compatibilityUds && notice("运行区当前使用兼容 UDS 通道。正式配置和密钥管理请添加并选择 HTTPS 目标。"),
          ...s.targets.map(target => h("div", { className: "sa-settings-card", key: target.id }, h("div", { className: "sa-settings-row" }, h("strong", null, target.name), h("span", { className: "sa-settings-tag" }, s.selectedId === target.id ? "当前目标" : target.authenticated ? "已配对" : "未配对")),
            h("p", { className: "sa-settings-muted" }, target.baseUrl), h("p", { className: "sa-settings-muted" }, `实例 ${target.instanceId || "尚未检测"} · 身份 ${target.actorId || "未登录"} · ${target.authenticationState === "expired" ? "登录已过期，请重新配对 · " : ""}${target.customCa ? "自定义 CA" : "系统信任 CA"} · 最近检测 ${target.checkedAt || "尚未检测"}`),
            h("div", { className: "sa-settings-actions" }, button(s.unconfirmedOperation && target.id === s.selectedId ? "重新认证原实例以查询操作" : "编辑／重新配对", () => setDialog({ type: "target", target })), button("检测连接", async () => { const report = await controller.action("targets.test", { targetId: target.id }); controller.note(`检测成功：实例 ${report.instanceId}，协议 ${report.protocolVersion}；证书校验通过。`); }),
              button("选择", () => s.changes.length ? setDialog({ type: "switch", target }) : controller.targetAction("select", { targetId: target.id }), { disabled: !target.authenticated || s.selectedId === target.id || s.busy || s.unconfirmedOperation }),
              button("注销", () => controller.targetAction("logout", { targetId: target.id }), { disabled: !target.authenticated && target.authenticationState !== "expired" || s.busy || s.unconfirmedOperation && target.id === s.selectedId }), button("移除入口", () => setDialog({ type: "remove", target }), { disabled: s.unconfirmedOperation && target.id === s.selectedId })))));
      }
      function ModelEditor({ kind, item, close }) {
        const s = useSettings(), provider = kind === "provider";
        const [value, setValue] = React.useState(copy(item || (provider ? { id: "", driver: "compatible", protocol: "openai-completions", baseUrl: "https://", authScheme: "bearer", credentialRef: "", allowLoopbackHttp: false, protocolOptions: {} } : { id: "", providerRef: s.draft?.modelConfiguration?.providers?.[0]?.id || "", modelId: "", definition: { source: "builtin" }, generation: { maxOutputTokens: 8192, reasoning: { mode: "provider_default" } } }))), [secret, setSecret] = React.useState(""), [advanced, setAdvanced] = React.useState(() => JSON.stringify(item?.definition || { source: "builtin" }, null, 2));
        const update = (key, next) => setValue(previous => ({ ...previous, [key]: next }));
        const save = () => {
          if (!value.id.trim() || (!provider && (!value.modelId.trim() || !value.providerRef))) throw new Error("请填写 ID、提供方和模型 ID");
          const prepared = provider ? prepareProviderEdit(value, s.draft.modelConfiguration.credentials) : null;
          const entry = provider ? prepared.entry : { ...value, definition: JSON.parse(advanced) };
          controller.edit(draft => { const key = provider ? "providers" : "models", items = draft.modelConfiguration[key]; if (!item && items.some(row => row.id === entry.id)) throw new Error("ID 已存在"); draft.modelConfiguration[key] = [...items.filter(row => row.id !== item?.id), entry]; if (prepared?.credential) draft.modelConfiguration.credentials.push(prepared.credential); }); close();
        };
        return h(Modal, { open: true, title: `${item ? "编辑" : "添加"}${provider ? "提供方" : "模型"}`, onClose: () => { setSecret(""); close(); }, closeLabel: "取消",
          footer: h("div", { className: "sa-settings-actions" }, button("取消", close), button("保存到草稿", save, { variant: "primary", disabled: s.busy })) },
          h("div", { className: "sa-settings sa-settings-editor" }, h("style", null, CSS), h("div", { className: "sa-settings-grid" }, field("逻辑 ID", value.id, next => update("id", next), { full: true, disabled: !!item }),
            provider ? h(React.Fragment, null,
              h("label", null, "驱动", h("select", { value: value.driver, onChange: e => setValue({ ...value, driver: e.target.value, ...(e.target.value === "pi_builtin" ? { nativeProvider: "openai" } : { protocol: "openai-completions", baseUrl: "https://", authScheme: "bearer", allowLoopbackHttp: false }) }) }, h("option", { value: "compatible" }, "兼容协议"), h("option", { value: "pi_builtin" }, "Pi 官方提供方"))),
              value.driver === "pi_builtin" ? h("label", null, "官方提供方", h("select", { value: value.nativeProvider || "openai", onChange: e => update("nativeProvider", e.target.value) }, ...["openai", "anthropic", "openrouter", "opencode", "opencode-go"].map(id => h("option", { key: id, value: id }, id)))) : h(React.Fragment, null,
                h("label", null, "协议", h("select", { value: value.protocol, onChange: e => setValue(previous => ({ ...previous, protocol: e.target.value, protocolOptions: e.target.value === "openai-completions" ? previous.protocolOptions : {} })) }, ...["openai-completions", "openai-responses", "anthropic-messages"].map(id => h("option", { key: id, value: id }, id)))), field("API 地址", value.baseUrl, next => update("baseUrl", next), { full: true }),
                h("label", null, "认证方式", h("select", { value: value.authScheme, onChange: e => { setSecret(""); update("authScheme", e.target.value); } }, h("option", { value: "bearer" }, "Bearer API 密钥"), h("option", { value: "x-api-key" }, "x-api-key（仅 Messages）"), h("option", { value: "none" }, "无认证（仅本机回环）"))),
                h("label", { className: "sa-settings-check" }, h("input", { type: "checkbox", checked: !!value.allowLoopbackHttp, onChange: e => update("allowLoopbackHttp", e.target.checked) }), "明确允许提供方使用本机回环 HTTP")),
              (value.driver === "pi_builtin" || value.protocol === "openai-completions") && h("label", null, "输出上限字段", h("select", { value: value.protocolOptions?.maxTokensField || "", onChange: e => update("protocolOptions", e.target.value ? { maxTokensField: e.target.value } : {}) }, h("option", { value: "" }, "协议默认"), h("option", { value: "max_tokens" }, "max_tokens"), h("option", { value: "max_completion_tokens" }, "max_completion_tokens"))),
              field("凭据引用", value.credentialRef, next => update("credentialRef", next), { full: true }), field("API 密钥（只写）", secret, setSecret, { full: true, type: "password", autoComplete: "new-password" }), button("检测当前凭据（不生成）", () => checkProviderCredential(value), { disabled: s.busy || !value.id || !value.credentialRef }),
              h("div", { className: "full sa-settings-actions" }, button("HTTPS 暂存密钥", async () => { const staged = await controller.stageSecret(secret); setSecret(""); const credentialId = `${value.id || "provider"}-key-${Date.now().toString(36)}`; controller.edit(draft => draft.modelConfiguration.credentials.push({ id: credentialId, kind: "api_key", source: { type: "credential_store", ref: staged.credentialRef } })); update("credentialRef", credentialId); controller.note(`密钥已暂存，输入已清空；有效期至 ${new Date(staged.expiresAt).toLocaleString()}。整页激活成功后绑定。`); }, { disabled: s.busy || !secret.trim() || !s.selectedId || value.driver === "compatible" && value.authScheme === "none" }))) : h(React.Fragment, null,
              h("label", null, "提供方", h("select", { value: value.providerRef, onChange: e => update("providerRef", e.target.value) }, ...(s.draft?.modelConfiguration?.providers || []).map(row => h("option", { key: row.id, value: row.id }, row.id)))), field("上游模型 ID", value.modelId, next => update("modelId", next)),
              field("输出上限", value.generation.maxOutputTokens, next => update("generation", { ...value.generation, maxOutputTokens: Number(next) }), { type: "number", min: 1 }),
              h("label", null, "默认思考选择", h("select", { value: value.generation.reasoning.mode === "level" ? value.generation.reasoning.level : value.generation.reasoning.mode, onChange: e => update("generation", { ...value.generation, reasoning: ["provider_default", "off"].includes(e.target.value) ? { mode: e.target.value } : { mode: "level", level: e.target.value } }) }, h("option", { value: "provider_default" }, "Default · 提供方默认"), h("option", { value: "off" }, "Off · 关闭"), ...(s.catalog.find(entry => entry.id === value.modelId && entry.provider === value.providerRef)?.supportedThinkingLevels || []).filter(level => level !== "off").map(level => h("option", { key: level, value: level }, level)))),
              h("label", { className: "full" }, "模型定义（Pi 内置目录或经核实的显式合同 JSON）", h("textarea", { value: advanced, rows: 8, onChange: e => setAdvanced(e.target.value) })),
              h("p", { className: "full sa-settings-muted" }, "内置目录使用 {\"source\":\"builtin\"}。显式能力和思考映射由服务校验；界面不制造模型能力。"))),
            s.error && h("div", { className: "full sa-settings-error", role: "alert" }, s.error)));
      }
      function Models({ s, setDialog }) {
        const [query, setQuery] = React.useState(""), [filter, setFilter] = React.useState("all"), config = s.draft?.modelConfiguration;
        if (!config) return notice("请先连接并配对 HTTPS Core，再读取模型配置。现有任务仍可在运行区查看。");
        const availability = s.draft.modelAvailability || { disabledProviders: [], disabledModels: [] };
        const disabled = model => availability.disabledModels.includes(model.id) || availability.disabledProviders.includes(model.providerRef);
        const toggle = (kind, id) => controller.edit(draft => {
          draft.modelAvailability ||= { disabledProviders: [], disabledModels: [] };
          const key = kind === "provider" ? "disabledProviders" : "disabledModels", rows = draft.modelAvailability[key];
          const turningOff = !rows.includes(id), defaultModel = draft.modelConfiguration.models.find(item => item.id === draft.defaultModelConfigId);
          if (turningOff && defaultModel && (kind === "provider" ? defaultModel.providerRef === id : defaultModel.id === id)) throw new Error("请先在同一草稿替换或清除默认模型，再停用资源");
          draft.modelAvailability[key] = rows.includes(id) ? rows.filter(value => value !== id) : [...rows, id];
        });
        const models = (config.models || []).filter(model => `${model.id} ${model.modelId} ${model.providerRef}`.toLowerCase().includes(query.toLowerCase()) && (filter === "all" || (filter === "disabled") === disabled(model)));
        return h(React.Fragment, null, h("div", { className: "sa-settings-row" }, h("h3", null, `模型 · ${config.models.length}`), h("div", { className: "sa-settings-actions" }, button("引用与历史", async () => { const [history, credentials] = await Promise.all([controller.call("models.history"), controller.call("credentials.list")]); setDialog({ type: "history", history, credentials: credentials.items || [] }); }), button("添加提供方", () => setDialog({ type: "editor", kind: "provider" })), button("添加模型", () => setDialog({ type: "editor", kind: "model" }), { disabled: !config.providers.length }))),
          h("p", { className: "sa-settings-muted" }, "草稿跨分区保留。整页激活后新任务采用新版本，已有任务保持冻结绑定。真实试运行会产生模型用量。"),
          h("input", { className: "sa-settings-search", type: "search", "aria-label": "搜索模型", placeholder: "搜索模型 ID、提供方", value: query, onChange: e => setQuery(e.target.value) }),
          button("清除搜索", () => { setQuery(""); setFilter("all"); }, { disabled: !query && filter === "all" }),
          h("label", null, "模型状态筛选", h("select", { "aria-label": "模型状态筛选", value: filter, onChange: event => setFilter(event.target.value) }, h("option", { value: "all" }, "全部"), h("option", { value: "enabled" }, "草稿启用"), h("option", { value: "disabled" }, "草稿停用"))),
          h("p", { className: "sa-settings-muted" }, `草稿启用 ${config.models.filter(model => !disabled(model)).length} · 停用 ${config.models.filter(disabled).length}；审阅激活后才影响新任务。旧任务和队列保留冻结绑定。`),
          ...config.providers.map(provider => h("div", { className: "sa-settings-card", key: provider.id }, h("div", { className: "sa-settings-row" }, h("strong", null, provider.id), button("编辑／轮换凭据", () => setDialog({ type: "editor", kind: "provider", item: provider })), button("检测凭据（不生成）", () => checkProviderCredential(provider)), button(availability.disabledProviders.includes(provider.id) ? "启用提供方（草稿）" : "停用提供方（草稿）", () => toggle("provider", provider.id)), button("移除提供方", () => controller.edit(draft => { if (draft.modelConfiguration.models.some(model => model.providerRef === provider.id)) throw new Error("请先在同一草稿将引用模型改用其他提供方或移除模型"); draft.modelConfiguration.providers = draft.modelConfiguration.providers.filter(item => item.id !== provider.id); if (draft.modelAvailability) draft.modelAvailability.disabledProviders = draft.modelAvailability.disabledProviders.filter(id => id !== provider.id); }))), h("p", { className: "sa-settings-muted" }, `${provider.protocol || provider.nativeProvider} · ${provider.baseUrl || "Pi 官方地址"}`), h("p", { className: "sa-settings-muted" }, `凭据引用：${provider.credentialRef}`))),
          !config.providers.length && notice("没有提供方。先添加提供方并暂存密钥，再添加首个模型。"),
          h("label", null, "服务默认模型（仅影响新对话）", h("select", { "aria-label": "服务默认模型（仅影响新对话）", value: s.draft.defaultModelConfigId || "", onChange: e => controller.edit(draft => { draft.defaultModelConfigId = e.target.value || null; }) }, h("option", { value: "" }, "无默认模型"), ...config.models.map(model => h("option", { key: model.id, value: model.id, disabled: disabled(model) }, `${model.providerRef} / ${model.modelId}`)))),
          ...models.map(model => h("div", { className: "sa-settings-card", key: model.id }, h("div", { className: "sa-settings-row" }, h("strong", null, `${model.providerRef} / ${model.modelId}`), h("div", { className: "sa-settings-actions" }, button("编辑", () => setDialog({ type: "editor", kind: "model", item: model })), button(availability.disabledModels.includes(model.id) ? "启用模型（草稿）" : "停用模型（草稿）", () => toggle("model", model.id)), button("真实试运行", async () => { if (s.changes.length) throw new Error("请先审阅并激活模型配置，再试运行"); space.controller.newConversation(""); await space.controller.setModel(model.modelId); space.controller.setDraft("请回复一段简短中文，说明此次真实模型调用已返回。不要调用工具。"); await space.controller.send(); }, { disabled: !!s.changes.length || disabled(model) }))),
            h("p", { className: "sa-settings-muted" }, `${model.providerRef} / ${model.modelId} · 草稿${disabled(model) ? "停用" : "启用"} · 当前目录${s.catalog.find(entry => entry.id === model.modelId && entry.provider === model.providerRef)?.selectable === false ? "不可选" : "以当前激活版本为准"} · 输出上限 ${model.generation.maxOutputTokens} · 思考 ${model.generation.reasoning.mode === "provider_default" ? "Default（提供方默认）" : model.generation.reasoning.mode === "off" ? "Off（关闭）" : model.generation.reasoning.level} · 能力来源 ${s.catalog.find(entry => entry.id === model.modelId)?.capabilitySource || (model.definition.source === "builtin" ? "Pi 1.3.0 官方目录" : "operator_declared（声明合同）")}`),
            h("div", { className: "sa-settings-actions" }, button("设为默认", () => controller.edit(draft => { draft.defaultModelConfigId = model.id; }), { disabled: s.draft.defaultModelConfigId === model.id || disabled(model) }), button("移除模型", () => controller.edit(draft => { if (draft.defaultModelConfigId === model.id) throw new Error("请先在同一草稿替换或清除默认模型"); draft.modelConfiguration.models = draft.modelConfiguration.models.filter(item => item.id !== model.id); if (draft.modelAvailability) draft.modelAvailability.disabledModels = draft.modelAvailability.disabledModels.filter(id => id !== model.id); }))))),
          !models.length && notice(query ? "没有匹配模型，可清除搜索。" : "没有模型。添加模型后审阅并应用。"));
      }
      function Context({ s }) {
        const [runId, setRunId] = React.useState(""), [actual, setActual] = React.useState(undefined), [read, setRead] = React.useState(false);
        if (!s.draft) return notice("请先连接 Core。"); const config = s.draft.context;
        const edit = (key, value) => controller.edit(draft => { draft.context[key] = value; });
        return h(React.Fragment, null, h("h3", null, "项目上下文"), h("p", { className: "sa-settings-muted" }, "配置用于后续任务。可选说明读取失败时跳过并记录诊断，不阻断无关问题。"),
          h("label", { className: "sa-settings-check" }, h("input", { type: "checkbox", checked: config.autoInstructions, onChange: e => edit("autoInstructions", e.target.checked) }), "按执行目录自动读取项目说明"),
          h("div", { className: "sa-settings-grid" }, field("单文件上限（KiB）", config.maxFileBytes / 1024, value => edit("maxFileBytes", Number(value) * 1024), { type: "number", min: 1 }), field("总正文上限（KiB）", config.maxTotalBytes / 1024, value => edit("maxTotalBytes", Number(value) * 1024), { type: "number", min: 1 }), field("读取预算（秒）", config.timeoutMs / 1000, value => edit("timeoutMs", Number(value) * 1000), { type: "number", min: 0.1, step: 0.1 })),
          notice("默认预算为 64 KiB / 文件、256 KiB 总正文、2 秒。修改设置不会改写已冻结请求。"),
          h("div", { className: "sa-settings-card" }, h("h3", null, "核对实际任务上下文"), field("Run ID", runId, setRunId, { placeholder: "run_…" }), button("读取实际冻结请求诊断", async () => { const result = await controller.call("run.get", { runId }); setActual(result.projectContext); setRead(true); }, { disabled: !runId.trim() || s.busy }),
            read && (actual ? h(React.Fragment, null, notice(`实际策略：自动说明 ${actual.policy.autoInstructions ? "开启" : "关闭"} · ${actual.policy.maxFileBytes} B / 文件 · ${actual.policy.maxTotalBytes} B 总量 · ${actual.policy.timeoutMs} ms；已加载 ${actual.loadedBytes} B。`),
              ...(actual.sources || []).map((source, index) => h("div", { className: "sa-settings-card", key: `${source.path}:${index}` }, h("strong", null, `${source.status} · ${source.path}`), h("p", { className: "sa-settings-muted" }, `适用目录 ${source.scope} · hash ${source.hash || "未知"} · ${source.bytes ?? "未知"} B`))), !actual.sources?.length && notice("该实际请求没有项目说明来源；纯文本任务或无说明文件时属于正常状态。")) : notice("该任务尚无可读取的已冻结项目上下文事实。没有用设置草稿替代实际请求。"))));
      }
      function McpEditor({ item, close }) {
        const s = useSettings(), [value, setValue] = React.useState(copy(item || { id: "", url: "https://", enabled: true, credentialRef: null, timeoutMs: 30000 })), [secret, setSecret] = React.useState("");
        const update = (key, next) => setValue(previous => ({ ...previous, [key]: next }));
        const save = () => {
          const url = new URL(value.url), loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
          if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.id) || value.id.includes("__")) throw new Error("MCP ID须为1–64位字母、数字、下划线或连字符，不能包含双下划线");
          if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || url.protocol === "http:" && loopback && value.allowLoopbackHttp === true)) throw new Error("MCP须使用不带凭据和查询参数的HTTPS地址；本机HTTP需明确开启例外");
          controller.edit(draft => { const servers = draft.mcpServers || []; if (!item && servers.some(server => server.id === value.id)) throw new Error("MCP ID已存在"); draft.mcpServers = [...servers.filter(server => server.id !== item?.id), value]; }); close();
        };
        return h(Modal, { open: true, title: `${item ? "编辑" : "添加"} MCP 服务`, onClose: () => { setSecret(""); close(); }, closeLabel: "取消", footer: h("div", { className: "sa-settings-actions" }, button("取消", close), button("保存到整页草稿", save, { variant: "primary", disabled: s.busy })) }, h("div", { className: "sa-settings sa-settings-editor" }, h("style", null, CSS),
          notice("使用Streamable HTTP / 2025-03-26。保存不代表连接成功；检测握手和工具目录后，仍须整页激活。调用沿用相同审批与账本。"),
          h("div", { className: "sa-settings-grid" }, field("MCP ID", value.id, next => update("id", next), { disabled: !!item }), field("请求超时（毫秒）", value.timeoutMs, next => update("timeoutMs", Number(next)), { type: "number", min: 100, max: 120000 }), field("MCP HTTPS 地址", value.url, next => update("url", next), { full: true }), field("凭据引用（可选）", value.credentialRef || "", next => update("credentialRef", next || null), { full: true }), field("MCP 密钥（只写，可选）", secret, setSecret, { full: true, type: "password", autoComplete: "new-password" })),
          button("HTTPS 暂存 MCP 密钥", async () => { const result = await controller.stageSecret(secret); setSecret(""); update("credentialRef", result.credentialRef); }, { disabled: !secret.trim() || !s.selectedId || s.busy }),
          h("label", { className: "sa-settings-check" }, h("input", { type: "checkbox", checked: !!value.allowLoopbackHttp, onChange: e => update("allowLoopbackHttp", e.target.checked) }), "明确允许本机回环 HTTP（仅本机测试）"),
          button("检测当前表单连接", async () => { const result = await controller.checkMcp(value); controller.note(`MCP ${value.id} 检测：${result.status} · ${result.protocol || result.errorCode || "未知"} · 工具 ${result.tools?.length ?? "未知"}。草稿尚未激活。`); }, { disabled: s.busy }), s.error && h("div", { className: "sa-settings-error", role: "alert" }, s.error)));
      }
      function Tools({ s, setDialog }) {
        const [statuses, setStatuses] = React.useState([]);
        React.useEffect(() => { let alive = true; controller.call("mcp.status").then(result => { if (alive) setStatuses(result.items || []); }).catch(controller.report); return () => { alive = false; }; }, [s.selectedId, s.version]);
        if (!s.draft) return notice("请先连接 Core。"); const tools = s.draft.tools;
        return h(React.Fragment, null, h("h3", null, "工具与审批"), h("label", null, "默认审批模式", h("select", { value: tools.approval, onChange: e => controller.edit(draft => { draft.tools.approval = e.target.value; }) }, h("option", { value: "workspace_auto" }, "工作区范围明确动作自动通过，其他动作审批"), h("option", { value: "approve_all" }, "每个动作审批"), h("option", { value: "approve_none" }, "配置能力内免人工审批"))),
          ...Object.entries(TOOL_NAMES).map(([id, name]) => h("div", { className: "sa-settings-card", key: id }, h("label", { className: "sa-settings-check" }, h("input", { type: "checkbox", checked: tools.enabled.includes(id), onChange: e => controller.edit(draft => { draft.tools.enabled = e.target.checked ? [...new Set([...draft.tools.enabled, id])] : draft.tools.enabled.filter(tool => tool !== id); }) }), h("strong", null, id), name), h("p", { className: "sa-settings-muted" }, id === "ask_user" ? "问题答案与动作审批分别持久化。" : "文件及 Shell 需要任务执行工作区；以实际装配和范围检查结果为准。"))),
          notice("配置启用不代表当前环境可执行。动作仍检查认证、执行范围和操作系统访问。"),
          h("div", { className: "sa-settings-row" }, h("h3", null, `MCP · ${s.draft.mcpServers?.length || 0}`), button("添加 MCP", () => setDialog({ type: "mcp" }))),
          ...(s.draft.mcpServers || []).map(server => { const actual = statuses.find(status => status.id === server.id), checked = s.mcpChecks?.[server.id], latestCheck = checked && json(checked.server) === json(server) ? checked.result : null; return h("div", { className: "sa-settings-card", key: server.id }, h("div", { className: "sa-settings-row" }, h("strong", null, server.id), h("span", { className: "sa-settings-tag" }, `已激活目录快照：${actual?.status || (s.baseline?.mcpServers?.some(item => item.id === server.id) ? "未知" : "无")} · ${actual?.tools?.length ?? "未知"} 个工具`)), h("p", { className: "sa-settings-muted" }, server.url), h("p", { className: "sa-settings-muted", role: "status" }, latestCheck ? `最近检测：${latestCheck.status} · ${latestCheck.protocol || latestCheck.errorCode || "未知"} · 工具 ${latestCheck.tools?.length ?? "未知"}` : "最近检测：尚未检测当前草稿"), h("div", { className: "sa-settings-actions" }, button("编辑", () => setDialog({ type: "mcp", item: server })), button(server.enabled ? "停用（草稿）" : "启用（草稿）", () => controller.edit(draft => { draft.mcpServers.find(item => item.id === server.id).enabled = !server.enabled; })), button("检测连接", async () => { const result = await controller.checkMcp(server); controller.note(`MCP ${server.id}：${result.status} · ${result.protocol || result.errorCode || "未知"} · 工具 ${result.tools?.length ?? "未知"}。检测不代表草稿已激活。`); }), button("移除（草稿）", () => controller.edit(draft => { draft.mcpServers = draft.mcpServers.filter(item => item.id !== server.id); }))), actual?.tools?.length ? h("details", null, h("summary", null, "查看实际工具目录"), h("pre", null, actual.tools.map(tool => `${tool.name} · ${tool.description}`).join("\n"))) : null); }));
      }
      function RuntimeValidation({ state: s }) {
        const runtime = React.useSyncExternalStore(space.controller.subscribe, space.controller.getSnapshot);
        const [root, setRoot] = React.useState(runtime.root || ""), [modelId, setModel] = React.useState(runtime.modelId || ""), [snapshots, setSnapshots] = React.useState([]), [snapshotId, setSnapshot] = React.useState(""), [keyword, setKeyword] = React.useState("DSH_REGRESSION_BASELINE"), [caps, setCaps] = React.useState(null), [busy, setBusy] = React.useState(false), [error, setError] = React.useState("");
        const effective = s.baseline, required = Object.keys(TOOL_NAMES), missingTools = required.filter(name => !effective?.tools?.enabled?.includes(name));
        const RuntimeSpace = space.registrations?.find(entry => entry.slot === "main")?.component;
        const refreshVersions = async () => { setBusy(true); setError(""); try {
          const lookup = await controller.call("workspace.find", { root });
          if (!lookup?.workspaceId) throw new Error("请先在工作区与同步中注册项目并发布不可变快照");
          const [versions, capabilities] = await Promise.all([controller.call("files.snapshots", { workspaceId: lookup.workspaceId }), controller.call("files.capabilities")]); setSnapshots(versions.items || []); setCaps(capabilities);
        } catch (failure) { setError(failure.message); } finally { setBusy(false); } };
        const start = async () => { setBusy(true); setError(""); try {
          if (s.changes.length) throw new Error("请先审阅并激活设置草稿；验证采用有效配置");
          const snapshot = snapshots.find(item => item.snapshotId === snapshotId);
          if (!root || !modelId || !snapshot || missingTools.length) throw new Error("请确认已连接模型、工作区、不可变快照和八工具");
          space.controller.newConversation(root); space.controller.useFileSnapshot(snapshot, root); await space.controller.setModel(modelId);
          space.controller.setDraft(`请执行一次真实八工具回归，只操作本任务独立执行根内的测试文件，不访问项目外，不联网，不安装依赖。严格完成并分别保留证据：1. 调用 ls 查看执行目录；2. 调用 find 查找已有文本文件；3. 调用 grep 搜索关键字 ${JSON.stringify(keyword)}，若无匹配如实报告并继续；4. 调用 read 读取一个已存在的文本文件；5. 调用 ask_user，问题为“是否继续生成八工具回归产物？”，等待我的真实回答，不把普通输入当审批；6. 在回答允许继续后，用 write 创建 DSH_REGRESSION.md，包含唯一标记 DSH_REGRESSION_CREATED；7. 用 edit 将该唯一标记替换成 DSH_REGRESSION_EDITED；8. 用 bash 在显示的实际工作目录运行 Node 校验脚本，读取 DSH_REGRESSION.md 并验证包含 DSH_REGRESSION_EDITED，失败必须使用非零退出码。文件和Shell动作按实际审批策略等待，禁止绕过审批。最后报告八个工具的真实结果、实际执行根、退出码和产物路径，不编造成功。`);
          const receipt = await space.controller.send();
          if (!receipt) throw new Error(`真实任务接收尚未确认：${space.controller.getSnapshot().error || "请在下方保留原输入重试，并核对原请求"}`);
          controller.note("真实任务已提交；接收不代表完成。下方沿用同一任务处理问题、审批与轨迹；产物需读取实际结果版本。");
        } catch (failure) { setError(failure.message); } finally { setBusy(false); } };
        return h(React.Fragment, null, h("h3", null, "八工具真实运行验证"), notice(`目标 ${s.targets.find(item => item.id === s.selectedId)?.name || "未选择"} · 实例 ${s.instanceId || "未知"} · 有效配置 ${s.version ?? "未知"}。此操作会调用真实模型并产生用量、审批及测试产物。`),
          h("div", { className: "sa-settings-grid" },
            h("label", null, "验证模型", h("select", { "aria-label": "验证模型", value: modelId, onChange: event => setModel(event.target.value) }, h("option", { value: "" }, "选择可用模型"), ...(runtime.models || []).map(model => h("option", { key: `${model.provider}:${model.id}`, value: model.id, disabled: model.selectable === false }, `${model.provider}/${model.id}`)))),
            h("label", null, "验证工作区", h("input", { "aria-label": "验证工作区", list: "sa-validation-workspaces", placeholder: "已注册测试项目的绝对路径", value: root, onChange: event => { setRoot(event.target.value); setSnapshots([]); setSnapshot(""); setCaps(null); } }), h("datalist", { id: "sa-validation-workspaces" }, ...(runtime.directories || []).map(item => h("option", { key: item.root, value: item.root })))),
            h("label", { className: "full" }, "验证文件版本", h("select", { "aria-label": "验证文件版本", value: snapshotId, onChange: event => setSnapshot(event.target.value) }, h("option", { value: "" }, "先查询项目不可变版本"), ...snapshots.map(item => h("option", { key: item.snapshotId, value: item.snapshotId }, `${item.snapshotId} · ${item.rootHash}`)))), field("grep 验证关键字", keyword, setKeyword)),
          button("查询真实版本与环境能力", refreshVersions, { disabled: busy || !root }),
          notice(`有效配置启用工具：${effective?.tools?.enabled?.join("、") || "未知"}；缺少必需工具：${missingTools.join("、") || "无"}。审批默认 ${effective?.tools?.approval || "未知"}。Skill 与目录以任务冻结请求为准，可在下方实际上下文及轨迹核对。`),
          caps && notice(`已读取真实环境能力。操作系统沙箱：${caps.operatingSystemSandbox ? "有独立沙箱" : "未声明独立沙箱"}；文件范围仍由任务目录与权限检查控制。输入采用固定快照，将创建独立验证分支。`),
          h("div", { className: "sa-settings-actions" }, button("开始八工具真实回归", start, { variant: "primary", disabled: busy || !snapshotId || !root || !modelId || !!missingTools.length || !!s.changes.length }), button("审阅当前任务真实产物", () => controller.setSection("workspace"), { disabled: !runtime.contextView?.latestRunId }), button("打开独立运行区", () => { if (runtime.selected) void space.controller.selectThread(runtime.selected.threadId, runtime.selected.conversationId); else space.controller.newConversation(root); })),
          error && h("p", { role: "alert", className: "sa-settings-error" }, error),
          RuntimeSpace && h("div", { style: { height: "min(720px,75vh)", minHeight: 420, border: "1px solid var(--dsw-alias-border-l3)", borderRadius: 10, marginTop: 16, overflow: "hidden" } }, h(RuntimeBoundary || React.Fragment, { key: `run:${s.selectedId}` }, h(RuntimeSpace))),
          h("details", null, h("summary", null, "服务与观测详情"), h(RuntimeBoundary || React.Fragment, { key: `detail:${s.selectedId}` }, h(Panel))));
      }
      let RuntimeBoundary;
      if (React.Component) RuntimeBoundary = class extends React.Component {
        constructor(props) { super(props); this.state = { error: null }; }
        static getDerivedStateFromError(error) { return { error }; }
        componentDidCatch(error) { console.error("[super-agent] isolated runtime panel failure", error); }
        render() { return this.state.error ? h("div", { className: "sa-settings-error", role: "alert" }, `运行详情读取失败：${this.state.error.message}`, button("重试运行详情", () => { this.setState({ error: null }); void space.controller.refresh(); })) : this.props.children; }
      };
      function Settings() {
        const s = useSettings(), [dialog, setDialog] = React.useState(null), [choices, setChoices] = React.useState({});
        React.useEffect(() => { if (!controller.getSnapshot().loaded) void controller.load(); }, []);
        const close = () => setDialog(null), editable = !!s.draft;
        const panel = s.section === "connection" ? h(Connections, { s, setDialog }) : s.section === "models" ? h(Models, { s, setDialog }) : s.section === "context" ? h(Context, { s }) : s.section === "tools" ? h(Tools, { s, setDialog }) : s.section === "runtime" ? h(RuntimeValidation, { key: s.selectedId || "uds", state: s }) : content?.[s.section] ? h(content[s.section], { settings: controller, state: s }) : notice(s.section === "skills" ? "Skill 本机／云端内容入口由当前服务能力决定。宿主公开接口没有完整依赖包导出，自动导入不可用；请使用明确选择的目录包。" : "请选择已注册工作区，文件版本与同步入口加载后显示。纯文本聊天无需工作区。");
        return h("section", { className: "sa-settings", "data-super-agent-settings": true, "aria-busy": s.busy }, h("style", null, CSS),
          h("header", { className: "sa-settings-head" }, h("div", null, h("h2", null, "Super Agent"), h("p", { className: "sa-settings-muted" }, `${s.targets.find(target => target.id === s.selectedId)?.name || (s.instanceId ? "本地 Core" : "未连接")} · 配置版本 ${s.version ?? "未知"}`)), button("刷新", () => s.changes.length ? controller.load({ preserve: true }) : controller.load(), { disabled: s.busy })),
          h("nav", { className: "sa-settings-nav", role: "tablist", "aria-label": "Super Agent 配置分区" }, ...SECTIONS.map(([id, label]) => h("button", { key: id, type: "button", role: "tab", "aria-selected": s.section === id, onClick: () => controller.setSection(id) }, label))),
          h("main", { className: "sa-settings-body", role: "tabpanel" }, s.error && h("div", { className: "sa-settings-error", role: "alert" }, s.error), s.note && h("div", { className: "sa-settings-notice", role: "status" }, s.note), !s.loaded ? notice("正在读取本机入口…") : panel,
            s.operation && notice(`配置操作 ${s.operation.operationId}：${s.operation.status}`), s.unconfirmedOperation && notice("原操作结果尚未确认。请先查询原操作；当前保留原请求、完整草稿和凭据引用，不能放弃或切换目标。"), s.operation && button("查询原操作", controller.queryOperation),
            s.conflict && h("div", { className: "sa-settings-card" }, h("h3", null, `服务器版本已更新为 ${s.conflict.server.version}，草稿已保留`),
              ...s.conflict.conflicts.map(item => h("div", { className: "sa-settings-card", key: item.field }, h("strong", null, item.field), h("pre", null, `基于：${json(item.before)}\n服务端：${json(item.server)}\n我的修改：${json(item.after)}`), h("select", { "aria-label": `${item.field} 冲突选择`, value: choices[item.field] || "", onChange: e => setChoices(previous => ({ ...previous, [item.field]: e.target.value })) }, h("option", { value: "" }, "请选择"), h("option", { value: "server" }, "采用服务端"), h("option", { value: "mine" }, "采用我的修改")))), button("合并并重新审阅", () => { controller.resolveConflict(choices); setDialog({ type: "review" }); }))),
          h("footer", { className: "sa-settings-footer" }, h("span", { className: "sa-settings-muted" }, s.changes.length ? `${s.changes.length} 项未应用更改 · 基于版本 ${s.version}` : "所有分区共享一个配置草稿"), h("div", { className: "sa-settings-actions" }, button("放弃草稿", () => setDialog({ type: "discard" }), { disabled: !s.changes.length || s.busy || s.unconfirmedOperation }), button("审阅并应用", () => setDialog({ type: "review" }), { disabled: !editable || !s.changes.length || s.busy || !!s.conflict || !!(s.operation && !["succeeded", "failed"].includes(s.operation.status)), variant: "primary" }))),
          dialog?.type === "mcp" && h(McpEditor, { item: dialog.item, close }),
          dialog?.type === "history" && h(Modal, { open: true, title: "模型引用、历史与凭据", onClose: close, closeLabel: "关闭", footer: button("关闭", close) }, h("div", { className: "sa-settings sa-settings-editor" }, h("style", null, CSS), notice("普通轮换创建新凭据身份，旧任务保留旧绑定。紧急吊销立即阻止引用身份的后续动作，不能自动更换模型。"), ...dialog.credentials.map(credential => h("div", { className: "sa-settings-card", key: credential.credentialRef }, h("strong", null, credential.credentialRef), h("p", { className: "sa-settings-muted" }, `${credential.status} · ${credential.expiresAt ? new Date(credential.expiresAt).toLocaleString() : "期限未知"}`), button("审阅并紧急吊销", () => setDialog({ type: "revoke", credential, history: dialog.history }), { disabled: credential.status === "revoked" || credential.status === "expired" }))), h("details", null, h("summary", null, "真实模型版本与会话绑定"), h("pre", null, JSON.stringify(dialog.history, null, 2))))),
          dialog?.type === "revoke" && h(Modal, { open: true, title: "紧急吊销模型凭据？", onClose: close, closeLabel: "取消", footer: h("div", { className: "sa-settings-actions" }, button("取消", close), button("确认紧急吊销", async () => { const result = await controller.action("credentials.revoke", { requestId: controller.nextRequestId("credentials.revoke"), credentialRef: dialog.credential.credentialRef }); controller.note(`凭据 ${result.credentialRef} 已吊销，操作者 ${result.actorId}。引用旧身份的后续调用会被拒绝，任务不会自动换模型。`); close(); }, { variant: "primary", disabled: s.busy })) }, h("div", { className: "sa-settings sa-settings-editor" }, h("style", null, CSS), notice(`目标实例 ${s.instanceId}；凭据 ${dialog.credential.credentialRef}。吊销会影响所有引用该身份的运行、队列与待生效选择。请先核对下列实际绑定；本页不会猜测未知关联。`), h("pre", null, JSON.stringify(dialog.history, null, 2)))),
          dialog?.type === "target" && h(TargetEditor, { target: dialog.target, close }), dialog?.type === "editor" && h(ModelEditor, { kind: dialog.kind, item: dialog.item, close }),
          ["review", "discard", "switch", "remove"].includes(dialog?.type) && h(Modal, { open: true, title: { review: "审阅完整配置", discard: "放弃未应用更改？", switch: "切换 Core 目标？", remove: "移除本机入口？" }[dialog.type], onClose: s.busy ? () => {} : close, closeLabel: "取消",
            footer: h("div", { className: "sa-settings-actions" }, button("继续编辑", close, { disabled: s.busy }), button(dialog.type === "review" ? "应用完整配置" : dialog.type === "remove" ? "移除入口" : dialog.type === "switch" ? "放弃草稿并切换" : "放弃草稿", async () => { if (dialog.type === "review") await controller.apply(); else if (dialog.type === "remove") await controller.targetAction("remove", { targetId: dialog.target.id }); else { await controller.abandon(); if (dialog.type === "switch") await controller.targetAction("select", { targetId: dialog.target.id }); } close(); }, { variant: "primary", disabled: s.busy || (dialog.type === "review" && !!s.conflict) })) },
            h("div", { className: "sa-settings sa-settings-editor" }, h("style", null, CSS), dialog.type === "review" ? h(React.Fragment, null, notice(`目标 ${s.targets.find(target => target.id === s.selectedId)?.name || "UDS 兼容目标"} · 实例 ${s.instanceId} · 基于版本 ${s.version}。成功激活后影响后续任务，当前运行和已接收队列保持原版本。`), ...s.changes.map(change => h("div", { className: "sa-settings-diff", key: change.field }, h("strong", null, change.field), h("pre", null, `${json(change.before)}\n→ ${json(change.after)}`)))) : notice(dialog.type === "remove" ? "只移除本机入口和登录引用。云端任务继续，云端配置、历史和文件不会删除。" : `将放弃 ${s.changes.length} 项未应用配置修改。已发布的普通内容版本继续保留。`))));
      }
      return { Settings, controller, registrations: [{ slot: "settings.section", label: "Super Agent settings", options: { name: "settings.section", id: "super-agent", order: 20, label: "Super Agent" }, component: Settings }] };
    }
    return { SECTIONS, TOOL_NAMES, CSS, changesBetween, mergeDraft, prepareProviderEdit, createSettingsController, createSettings };
  },
});
