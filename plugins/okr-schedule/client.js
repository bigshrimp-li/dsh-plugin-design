window.__ModuleLoader__.load({
  id: "@local/okr-schedule",
  factory(require2) {
    const React = require2("react"), h = React.createElement, { useState, useEffect, useRef } = React;
    let pluginCtx, workbenchSnapshot = null, removeTraceReturn = null;
    const workbenchViews = new Set(["records", "actions", "calendar", "pending", "planning", "scheme", "history", "memory"]);
    const validSpaceId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
    const css = `
    .okr-app{position:absolute;inset:0;display:flex;flex-direction:column;background:#0b0f19;color:#e5eaf4;font:14px/1.5\
5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;overflow:hidden}.okr-app *{box-sizing:border-box}.okr-app bu\
tton,.okr-app input,.okr-app select,.okr-app textarea{font:inherit;color:inherit}.okr-app button{white-space:nowrap;curs\
or:pointer;border:1px solid #303c53;background:#182237;border-radius:8px;padding:7px 12px}.okr-app button:hover{backgrou\
nd:#24334d}.okr-app button:disabled{opacity:.45;cursor:default}.okr-app .primary{background:#2563eb;border-color:#3878ff\
;color:white}.okr-app input,.okr-app select,.okr-app textarea{background:#0c1424;border:1px solid #334155;border-radius:\
7px;padding:9px;width:100%}.okr-app textarea{min-height:96px;resize:vertical}.okr-app input[type=checkbox]{width:auto}.o\
kr-app label{display:block;margin:10px 0 5px;color:#aab8d0}.okr-app h1,.okr-app h2,.okr-app h3,.okr-app p{margin:0}.okr-\
app h1{font-size:21px}.okr-app h2{font-size:17px;margin-bottom:12px}.okr-app h3{font-size:14px;margin-bottom:7px}.okr-ap\
p header{display:flex;align-items:center;gap:16px;padding:16px 24px;border-bottom:1px solid #233047}.okr-app header sele\
ct{width:230px}.okr-app nav{display:flex;gap:5px;padding:10px 24px;border-bottom:1px solid #233047;overflow:auto}.okr-ap\
p nav button{white-space:nowrap;background:transparent;border-color:transparent;color:#96a7c2}.okr-app nav .active{color\
:#fff;background:#1b315a}.okr-layout{flex:1;display:grid;grid-template-columns:minmax(0,1fr) 340px;min-height:0}.okr-mai\
n{padding:24px;overflow:auto}.okr-card{border:1px solid #26334b;background:#111a2b;border-radius:12px;padding:18px;margi\
n-bottom:15px}.okr-muted{color:#92a3be;font-size:12px}.okr-row{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.o\
kr-between{display:flex;align-items:center;justify-content:space-between;gap:14px}.okr-grid{display:grid;grid-template-c\
olumns:repeat(auto-fit,minmax(220px,1fr));gap:14px}.okr-notice{padding:10px 24px;background:#142b2c;color:#9ee2c5;border\
-bottom:1px solid #24423f}.okr-error{background:#351e29;color:#ffbdc7}.okr-app table{display:block;overflow-x:auto;width\
:100%;border-collapse:collapse;font-size:13px}.okr-app th,.okr-app td{text-align:left;padding:12px 9px;border-bottom:1px\
 solid #253147;vertical-align:top}.okr-app th{white-space:nowrap;color:#91a3c0;font-weight:500}.okr-chat{border-left:1px\
 solid #26334b;display:flex;flex-direction:column;min-height:0;background:#0e1625}.okr-chat-title{padding:16px;border-bo\
ttom:1px solid #26334b}.okr-messages{flex:1;overflow:auto;padding:14px}.okr-message{white-space:pre-wrap;overflow-wrap:a\
nywhere;background:#172238;border:1px solid #2c3b54;border-radius:10px;padding:12px;margin:10px 0}.okr-message.user{back\
ground:#142b4e;margin-left:26px}.okr-composer{padding:14px;border-top:1px solid #26334b}.okr-tag{font-size:11px;padding:\
2px 7px;border-radius:5px;background:#1d3150;color:#a8c8ff}.okr-empty{padding:50px 16px;text-align:center;color:#a0b0cb}\
.okr-app details{margin-top:12px}.okr-app summary{cursor:pointer;color:#9cb6dc}.okr-app pre{white-space:pre-wrap;overflo\
w-wrap:anywhere;font-size:12px;max-height:400px;overflow:auto}.okr-week{display:grid;grid-template-columns:repeat(7,minm\
ax(90px,1fr));gap:7px;min-width:680px}.okr-day{min-height:110px;border:1px solid #26334b;border-radius:8px;padding:9px}.\
okr-day button{display:block;font-size:11px;text-align:left;margin-top:6px;width:100%}.okr-work{padding:9px 0;border-bot\
tom:1px solid #253147}.okr-app :focus-visible{outline:2px solid #71a8ff;outline-offset:3px}@media(max-width:1000px){.okr\
-layout{grid-template-columns:1fr}.okr-chat{min-height:360px;border-top:1px solid #26334b}.okr-layout{overflow:auto}.okr\
-main{overflow:visible}.okr-app header{flex-wrap:wrap;padding:12px}.okr-app nav{padding:8px}.okr-main{padding:14px}}`;
    const phase = { queued: "等待处理", running: "处理中", waiting_user: "等待补充", waiting_confirmation: "等\
待确认", waiting_external: "等待结果", delivered: "已交付，可继续", closed: "已结案", cancelled: "已取消",
    failed: "需要处理" };
    const actionPhase = { pending: "待开始", in_progress: "进行中", completed: "已完成", skipped: "已跳过", cancelled: "已取消" };
    function programAccess(program) {
      let readOnly = Array.isArray(program) && program.length > 0, queries = 0, recordTypeId = null;
      function walk(nodes) {
        if (!Array.isArray(nodes)) { readOnly = false; return; }
        for (const node of nodes) {
          if (node?.op === "query") queries++;
          else if (node?.op === "if") { walk(node.then || []); walk(node.else || []); }
          else if (node?.op !== "output") { readOnly = false; if (["save", "update"].includes(node?.op) && node.typeId) recordTypeId ||= node.typeId; }
        }
      }
      walk(program);
      return { readOnly: readOnly && queries > 0, recordTypeId };
    }
    function workErrorMessage(error) {
      if (/TIMEOUT/iu.test(error.code || "") || /timed?\s*out|timeout|超时/iu.test(error.message || "")) return "本次工作处理超时，原工作已保留。";
      if (/UNAVAILABLE|DISABLED/iu.test(error.code || "")) return "模型暂不可用，原工作已保留。";
      return `本次工作未能继续${error.message ? `：${error.message}` : "，请稍后重试原工作。"}`;
    }
    const requestId = () => `web_${crypto.randomUUID()}`;
    const dialogCss = `
      .okr-dialog-backdrop{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;background:#050914cc}
      .okr-input-dialog{width:min(100%,480px);max-height:calc(100dvh - 40px);overflow:auto;padding:24px;border:1px solid #40516e;border-radius:14px;background:#111a2b;box-shadow:0 24px 80px #0009}
      .okr-input-dialog h2{margin-bottom:16px}.okr-input-dialog label{margin-bottom:8px}.okr-input-dialog .okr-dialog-help{margin-top:9px;color:#92a3be;font-size:12px}.okr-input-dialog .okr-dialog-buttons{display:flex;justify-content:flex-end;gap:10px;margin-top:22px}
    `;
    function InputDialog({ request, onClose }) {
      const [value, setValue] = useState(request.initialValue), input = useRef(null), panel = useRef(null);
      const inputId = `okr-dialog-input-${request.id}`, titleId = `okr-dialog-title-${request.id}`, helpId = `okr-dialog-help-${request.id}`;
      useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
      function onKeyDown(event) {
        if (event.key === "Enter" && (event.nativeEvent?.isComposing || event.keyCode === 229)) { event.preventDefault(); return; }
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(null); }
        if (event.key === "Tab") {
          const elements = panel.current?.querySelectorAll("input,button");
          const first = elements?.[0], last = elements?.[elements.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }
      return h("div", { className: "okr-dialog-backdrop", onMouseDown: event => { if (event.target === event.currentTarget) { event.preventDefault(); input.current?.focus(); } } },
        h("form", { className: "okr-input-dialog", role: "dialog", "aria-modal": true, "aria-labelledby": titleId, ref: panel, onKeyDown,
          onSubmit: event => { event.preventDefault(); onClose(value); } },
          h("h2", { id: titleId }, "填写内容"), h("label", { htmlFor: inputId }, request.label),
          h("input", { id: inputId, ref: input, value, "aria-describedby": helpId, onChange: event => setValue(event.target.value) }),
          h("p", { id: helpId, className: "okr-dialog-help" }, "按 Enter 确定，按 Esc 取消。"),
          h("div", { className: "okr-dialog-buttons" }, h("button", { type: "button", onClick: () => onClose(null) }, "取消"), h("button", { type: "submit", className: "primary" }, "确定"))));
    }
    function App({ onCalendar }) {
      const resumed = useRef(workbenchSnapshot), mainPanel = useRef(null), restorePosition = useRef(workbenchSnapshot);
      const [spaces, setSpaces] = useState([]), [selected, setSelected] = useState(workbenchSnapshot?.selected || ""), [view, setView] = useState(workbenchSnapshot?.view || "records"), [data, setData] = useState(null), [chat, setChat] = useState({ messages: [], answers: [], tasks: [] }), [notice, setNotice] = useState(
      null), [busy, setBusy] = useState(false), [caps, setCaps] = useState({}), [text, setText] = useState(""), [reply, setReply] = useState(
      null), [form, setForm] = useState(null), [fields, setFields] = useState({}), [title, setTitle] = useState(""), [body,
      setBody] = useState(""), [mainKId, setMainKId] = useState(""), [typeId, setTypeId] = useState(""), [designText, setDesignText] = useState(
      ""), [planningText, setPlanningText] = useState(""), [scheme, setScheme] = useState(null), [trials, setTrials] = useState(
      []), [chosen, setChosen] = useState([]), [history, setHistory] = useState([]), [memories, setMemories] = useState(
      []), [plan, setPlan] = useState(null), [planChosen, setPlanChosen] = useState([]), [selectedItems, setSelectedItems] = useState(
      []), [widgetResults, setWidgetResults] = useState({}), [calendarData, setCalendarData] = useState({ occurrences: [] }),
      [groupTargets, setGroupTargets] = useState([]), [query, setQuery] = useState(""), [stats, setStats] = useState(null),
      [month, setMonth] = useState((/* @__PURE__ */ new Date()).toISOString().slice(0, 7));
      const tokens = useRef(/* @__PURE__ */ new Map()), last = useRef(null), current = useRef(selected);
      const [inputDialog, setInputDialog] = useState(null), dialogQueue = useRef([]), activeDialog = useRef(null), dialogSequence = useRef(0), dialogReturnFocus = useRef(null);
      const seenAnswerIds = useRef(new Map()), publicationRefreshes = useRef(new Map()), workspaceSequence = useRef(0), appActive = useRef(true);
      current.current = selected;
      useEffect(() => {
        const saved = resumed.current;
        if (!saved || saved.selected !== selected) return;
        setText(saved.text || ""); setReply(saved.reply || null); setForm(saved.form || null); setFields(saved.fields || {});
        setTitle(saved.title || ""); setBody(saved.body || ""); setMainKId(saved.mainKId || ""); setTypeId(saved.typeId || "");
        setDesignText(saved.designText || ""); setPlanningText(saved.planningText || ""); setScheme(saved.scheme || null);
        setTrials(saved.trials || []); setChosen(saved.chosen || []); setHistory(saved.history || []); setMemories(saved.memories || []);
        setPlan(saved.plan || null); setPlanChosen(saved.planChosen || []); setSelectedItems(saved.selectedItems || []);
        setQuery(saved.query || ""); setGroupTargets(saved.groupTargets || []); if (saved.month) setMonth(saved.month);
        workbenchSnapshot = null;
      }, []);
      useEffect(() => {
        const saved = restorePosition.current;
        if (!saved || !data) return;
        if (mainPanel.current) mainPanel.current.scrollTop = saved.scrollTop || 0;
        if (saved.messageId) {
          const target = document.getElementById(`message-${saved.messageId}`);
          if (!target) return;
          target.scrollIntoView({ block: "nearest" });
        }
        restorePosition.current = null;
      }, [data, chat]);
      function openTrace(target = {}) {
        const source = target.source || (selected ? "private" : "diagnostic");
        if (!["private", "group", "diagnostic"].includes(source)) return;
        const objectiveId = target.objectiveId || selected || null;
        const returnTarget = { objectiveId: selected || null, view, ...(target.messageId ? { messageId: target.messageId } : {}), ...(target.taskId ? { taskId: target.taskId } : {}) };
        workbenchSnapshot = { selected, view, text, reply, form, fields, title, body, mainKId, typeId, designText, planningText, scheme,
          trials, chosen, history, memories, plan, planChosen, selectedItems, query, groupTargets, month,
          scrollTop: mainPanel.current?.scrollTop || 0, messageId: target.messageId || null };
        const detail = { v: 1, source, objectiveId, returnTarget, ...(target.taskId ? { taskId: target.taskId } : {}),
          ...(target.groupMessageId ? { groupMessageId: target.groupMessageId } : {}), ...(target.focus ? { focus: target.focus } : {}) };
        const accepted = !window.dispatchEvent(new CustomEvent("asv-open-bot-trace", { detail, cancelable: true }));
        if (!accepted) setNotice({ text: "会话可视化插件尚未接入 Bot Trace，请安装并重新加载该插件。", error: true });
      }
      function showNextDialog() {
        if (activeDialog.current || !dialogQueue.current.length) return;
        activeDialog.current = dialogQueue.current.shift();
        setInputDialog(activeDialog.current);
      }
      function askInput(label, initialValue = "") {
        if (!activeDialog.current && !dialogReturnFocus.current) dialogReturnFocus.current = document.activeElement;
        return new Promise(resolve => { dialogQueue.current.push({ id: ++dialogSequence.current, label, initialValue: String(initialValue ?? ""), resolve }); showNextDialog(); });
      }
      function closeInputDialog(value, dialogId) {
        const request = activeDialog.current;
        if (!request || dialogId !== request.id) return;
        activeDialog.current = null;
        setInputDialog(null);
        request.resolve(value);
        showNextDialog();
        queueMicrotask(() => { if (!activeDialog.current && !dialogQueue.current.length) { if (dialogReturnFocus.current?.isConnected) dialogReturnFocus.current.focus(); dialogReturnFocus.current = null; } });
      }
      useEffect(() => { appActive.current = true; return () => { appActive.current = false; activeDialog.current?.resolve(null); for (const request of dialogQueue.current) request.resolve(null); activeDialog.current = null; dialogQueue.current = []; }; }, []);
      async function readResponse(response) {
        try { return await response.json(); }
        catch { throw new Error("个人助手服务未就绪，请重新启用插件或重启DSH"); }
      }
      async function raw(command, input = {}, space = selected, canRetry = true) {
        const key = space || "global";
        let token = tokens.current.get(key);
        if (!token) {
          const r = await fetch(`/okr-space/api/bootstrap${space ? `?objectiveId=${encodeURIComponent(space)}` : ""}`, {
          headers: { "x-okr-client": "workbench" } });
          const v = await readResponse(r);
          if (!r.ok) throw new Error(v.error?.message || "无法连接Host");
          token = v.token;
          tokens.current.set(key, token);
        }
        const response = await fetch("/okr-space/api/action", { method: "POST", headers: { "Content-Type": "application/\
json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ command, input }) });
        const result = await readResponse(response);
        if (response.status === 403 || result.error?.code === "BUNDLE_CONFLICT") tokens.current.delete(key);
        if (result.error?.code === "BUNDLE_CONFLICT" && canRetry && ["workspace.state", "items.query", "calendar.query",
        "chat.history", "chat.status", "scheme.get", "scheme.history", "trial.list", "memory.list"].includes(command)) return raw(
        command, input, space, false);
        if (!response.ok || ["failed", "error", "rejected", "conflict", "disabled"].includes(result.kind)) throw Object.
        assign(new Error(result.error?.message || result.data?.reason || "操作未完成"), { result });
        if (result.kind === "saved" && ["scheme.confirm", "space.migrate"].includes(command)) tokens.current.delete(key);
        return result;
      }
      async function run(command, input = {}, options = {}) {
        const target = options.space === void 0 ? selected : options.space, args = { ...input, requestId: input.requestId ||
        requestId() };
        last.current = { command, input: args, space: target };
        setBusy(true);
        try {
          const result = await raw(command, args, target);
          setNotice({ text: { saved: "已保存", pending: "已保留待整理，请补充信息", unsupported: "当前空间不支持\
此内容，未记录", trial: "试用材料已暂存", accepted: "已接收，正在处理" }[result.kind] || "已更新",
          kind: result.kind });
          if (options.refresh !== false) await refresh(target);
          return result;
        } catch (error) {
          setNotice({ text: error.message, error: true });
          return null;
        } finally {
          setBusy(false);
        }
      }
      async function refresh(space = selected) {
        const list = await raw("spaces.list", {}, "");
        setSpaces(list.data.spaces || []);
        if (!space) {
          const result2 = await raw("group.state", {}, "");
          if (!current.current) setData(result2.data);
          return;
        }
        await readWorkspace(space);
      }
      async function readWorkspace(space) {
        if (!appActive.current || current.current !== space) return;
        const sequence = ++workspaceSequence.current;
        try {
          const result = await raw("workspace.state", {}, space);
          if (appActive.current && current.current === space && sequence === workspaceSequence.current) setData(result.data);
        } catch (error) {
          if (appActive.current && current.current === space && sequence === workspaceSequence.current) throw error;
        }
      }
      function refreshAfterPublication(space, enqueue = true) {
        let entry = publicationRefreshes.current.get(space);
        if (!entry) { entry = { requested: 0, completed: 0, promise: null }; publicationRefreshes.current.set(space, entry); }
        if (enqueue) entry.requested++;
        if (entry.promise) return entry.promise;
        let failed = false;
        entry.promise = (async () => {
          while (appActive.current && current.current === space && entry.completed < entry.requested) {
            const requested = entry.requested;
            await readWorkspace(space);
            entry.completed = requested;
          }
          if (appActive.current && current.current === space) setNotice(previous => previous?.refreshSpace === space ? null : previous);
        })().catch(error => {
          failed = true;
          if (appActive.current && current.current === space) setNotice({ text: `Bot 已回复，但记录刷新未完成：${error.message}`, error: true, refreshSpace: space });
        }).finally(() => { entry.promise = null; if (!failed && appActive.current && current.current === space && entry.completed < entry.requested) void refreshAfterPublication(space, false); });
        return entry.promise;
      }
      function receiveChat(space, next) {
        if (!appActive.current || current.current !== space) return;
        setChat(next);
        let seen = seenAnswerIds.current.get(space);
        if (!seen) { seen = new Set(); seenAnswerIds.current.set(space, seen); }
        let changed = false;
        for (const answer of next.answers || []) {
          const answerId = answer.answerId || answer.id;
          if (answerId && !seen.has(answerId)) { seen.add(answerId); changed = true; }
        }
        if (changed) void refreshAfterPublication(space);
      }
      useEffect(() => {
        let live = true;
        raw("capabilities", {}, "").then((r) => live && setCaps(r.data)).catch((e) => setNotice({ text: e.message, error: true }));
        refresh("").catch((e) => setNotice({ text: e.message, error: true }));
        return () => {
          live = false;
        };
      }, []);
      useEffect(() => {
        setData(null);
        setNotice(previous => previous?.refreshSpace ? null : previous);
        setChat({ messages: [], answers: [], tasks: [], errors: [], pending: 0, retryable: false, running: false });
        if (resumed.current?.selected === selected) resumed.current = null;
        else { setForm(null); setReply(null); setScheme(null); setPlan(null); }
        refresh(selected).catch((e) => setNotice({ text: e.message, error: true }));
      }, [selected]);
      useEffect(() => {
        let live = true;
        async function update() {
          try {
            const result = await raw(selected ? "chat.history" : "group.state", {}, selected);
            if (live) {
              setCaps((previous) => ({ ...previous, bot: !!result.data.available }));
              if (selected) receiveChat(selected, result.data);
              else setData(result.data);
            }
          } catch {
          }
        }
        if (!selected || data?.migrated) {
          update();
          const timer = setInterval(update, 1800);
          return () => {
            live = false;
            clearInterval(timer);
          };
        }
        return () => {
          live = false;
        };
      }, [selected, data?.migrated]);
      useEffect(() => {
        let live = true;
        if (view === "calendar") {
          const lastDay = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
          raw("calendar.query", { from: month + "-01", to: month + "-" + String(lastDay).padStart(2, "0") }).then((r) => live &&
          setCalendarData(r.data)).catch((e) => setNotice({ text: e.message, error: true }));
        }
        return () => {
          live = false;
        };
      }, [view, month, selected, data?.actions]);
      async function send(value = text) {
        if (!value.trim()) return;
        const result = await run(selected ? "chat.send" : "group.send", { text: value, messageId: requestId(), ...reply ?
        { replyTo: reply } : {} }, { refresh: false });
        if (result) {
          setText("");
          setReply(null);
        }
      }
      async function recoverWork(deliveryId) {
        const target = selected;
        const result = await run("runtime.recover", { deliveryId }, { space: target, refresh: false });
        if (result && current.current === target) {
          const status = await raw("chat.status", {}, target).catch(() => null);
          if (status && current.current === target) receiveChat(target, status.data);
        }
      }
      function edit(item = null, material = false) {
        setForm({ item, material });
        setTypeId(item?.typeId || data?.types?.[0]?.id || "");
        setTitle(item?.title || "");
        setBody(item?.body || "");
        setMainKId(item?.mainKId || "");
        setFields(item?.fields || {});
      }
      async function save() {
        if (form?.trial) {
          const draft = scheme.draft.value;
          const tool = draft.bundle.tools.find((t) => Object.values(t.commands).some((c) => c.program.some((n) => n.op ===
          "save" && n.typeId === typeId)));
          if (!tool) {
            setNotice({ text: "当前草稿没有此类型的试用记录工具", error: true });
            return;
          }
          const command = Object.keys(tool.commands).find((key) => tool.commands[key].program.some((n) => n.op === "save" &&
          n.typeId === typeId));
          const result = await run("scheme.trial", { toolId: tool.id, command, input: { title, body, fields }, requestId: requestId() });
          if (result) {
            setForm(null);
            await loadScheme();
          }
          return;
        }
        const input = { typeId, title, body, fields, mainKId: mainKId || null, ...form?.item ? form.material ? { materialId: form.
        item.id, expectedRevision: form.item.revision } : { itemId: form.item.id, expectedRevision: form.item.revision } :
        {} };
        const r = await run(form?.material ? "material.complete" : form?.item ? "item.update" : "item.save", input);
        if (r && r.kind === "saved") setForm(null);
      }
      async function loadScheme() {
        const r = await raw("scheme.get");
        setScheme(r.data);
        if (r.data.draft?.value) {
          const t = await raw("trial.list", { draftId: r.data.draft.value.id });
          setTrials(t.data.trials || t.data.records || []);
        } else setTrials([]);
      }
      async function openTab(tab) {
        if (tab === "trace") { openTrace(); return; }
        setView(tab);
        try {
          if (tab === "scheme") await loadScheme();
          if (tab === "history") setHistory((await raw("scheme.history")).data.states || []);
          if (tab === "memory") setMemories((await raw("memory.list")).data.items || []);
        } catch (e) {
          setNotice({ text: e.message, error: true });
        }
      }
      const button = (label, onClick, primary = false, disabled = busy) => h("button", { type: "button", onClick, className: primary ?
      "primary" : "", disabled }, label);
      const detail = (label, value) => h("details", null, h("summary", null, label), h("pre", null, JSON.stringify(value,
      null, 2)));
      const card = (title2, ...children) => h("section", { className: "okr-card" }, h("h2", null, title2), ...children);
      const formTypes = form?.trial ? scheme?.draft?.value?.bundle?.types || [] : data?.types || [];
      const type = formTypes.find((t) => t.id === typeId), items = (data?.items || []).filter((i) => !query || `${i.title}\
 ${i.body}`.includes(query));
      function recordForm() {
        return card(form?.material ? "补充待整理" : form?.item ? "修改记录" : "添加记录", h("label", null, "\
记录类型"), h("select", { value: typeId, onChange: (e) => {
          setTypeId(e.target.value);
          setFields({});
        } }, ...formTypes.map((t) => h("option", { key: t.id, value: t.id }, t.title || t.name || t.id))), h("label", null,
        "标题"), h("input", { value: title, onChange: (e) => setTitle(e.target.value) }), ...(type?.fields || []).map(
        (f) => h("label", { key: f.id }, `${f.title || f.name || f.id}${f.required ? " *" : ""}${f.unit ? ` · ${f.unit}` :
        ""}`, f.kind === "category" || f.kind === "reference" ? h("select", { value: fields[f.id] || "", onChange: (e) => setFields(
        { ...fields, [f.id]: e.target.value }) }, h("option", { value: "" }, "未选择"), ...(f.kind === "category" ? (data?.
        categories || []).filter((c) => c.tableId === f.categoryTableId) : data?.items || []).map((v) => h("option", { key: v.
        id, value: v.id }, v.name || v.title || v.id))) : f.kind === "boolean" ? h("input", { type: "checkbox", checked: !!fields[f.
        id], onChange: (e) => setFields({ ...fields, [f.id]: e.target.checked }) }) : h("input", { type: f.kind === "dat\
e" ? "date" : "text", value: fields[f.id] ?? "", onChange: (e) => setFields({ ...fields, [f.id]: f.kind === "integer" &&
        e.target.value !== "" ? Number(e.target.value) : e.target.value }) }))), h("label", null, "关注维度（可选）"),
        h("select", { value: mainKId, onChange: (e) => setMainKId(e.target.value) }, h("option", { value: "" }, "不关联维度"),
        ...(data?.dimensions || []).map((k) => h("option", { key: k.id, value: k.id }, k.title || k.name || k.id))), h("\
label", null, "正文"), h("textarea", { value: body, onChange: (e) => setBody(e.target.value) }), h("div", { className: "\
okr-row" }, button("保存", save, true), button("取消", () => setForm(null))));
      }
      function pageWidgets() {
        return (data?.bundle?.page || []).map((widget, n) => {
          const rows = (data.items || []).filter((item) => !widget.typeId || item.typeId === widget.typeId);
          const tool = data.bundle.tools.find((tool2) => tool2.id === widget.toolId), declaration = tool?.commands[widget.command];
          const access = programAccess(declaration?.program);
          const openForm = () => { edit(); const targetType = widget.typeId || access.recordTypeId; if (targetType) setTypeId(targetType); };
          let content2;
          if (widget.kind === "markdown") content2 = h("p", { style: { whiteSpace: "pre-wrap" } }, widget.content || "");
          else if (widget.kind === "summary") content2 = h("p", null, `${rows.length} 条正式记录`);
          else if (widget.kind === "form") content2 = button("添加内容", openForm);
          else if (widget.kind === "actions") content2 = h("p", null, `${(data.actions || []).length} 项行动`, button(
          "查看行动", () => setView("actions")));
          else if (["table", "list"].includes(widget.kind)) content2 = h("ul", null, ...rows.slice(0, 20).map((item) => h(
          "li", { key: item.id }, item.title)));
          else content2 = h("p", { className: "okr-muted" }, "运行查询后展示真实结果与统计口径。");
          return React.cloneElement(card(widget.title || ({ summary: "摘要", table: "记录", list: "内容", form: "记\
录入口", actions: "行动", trend: "趋势", categories: "分类统计" }[widget.kind] || "空间内容"), content2, declaration && access.readOnly &&
          button("运行查询", async () => {
            const r = await run("tool.run", { toolId: tool.id, command: widget.command, input: widget.input || {}, requestId: requestId() },
            { refresh: false });
            if (r) setWidgetResults({ ...widgetResults, [n]: r.data });
          }), declaration && !access.readOnly && access.recordTypeId && widget.kind !== "form" && button("填写内容", openForm), widgetResults[n] && detail("结果与口径", widgetResults[n])), { key: `widget-${n}` });
        });
      }
      function dimensions() {
        return card("关注维度", h("div", { className: "okr-row" }, ...(data?.dimensions || []).map((k) => h("div", {
        className: "okr-card", key: k.id }, h("strong", null, k.title || k.name || k.id), h("span", { className: "okr-mu\
ted" }, k.archivedAt ? " · 已归档" : ""), button(k.archivedAt ? "恢复维度" : "归档维度", () => run(k.archivedAt ?
        "dimension.restore" : "dimension.archive", { id: k.id, expectedRevision: k.revision })))), button("添加关注维度",
        async () => {
          const title2 = await askInput("持续关注的子方向是什么？");
          if (title2) run("dimension.save", { title: title2 });
        })));
      }
      function recordTrace(item) {
        const task = (chat.tasks || []).find(task => task.operationLinks?.some(link => link.itemId === item.id));
        const link = task?.operationLinks.find(link => link.itemId === item.id);
        return button(task ? "查看轨迹" : "无轨迹关联", () => openTrace({ taskId: task.id, focus: { operationId: link.operationId } }), false, !task);
      }
      function records() {
        return h(React.Fragment, null, dimensions(), card("记录", h("div", { className: "okr-between" }, h("input", { value: query,
        placeholder: "搜索标题和正文", onChange: (e) => setQuery(e.target.value), style: { maxWidth: 360 } }), button(
        "添加记录", () => edit(), true, busy || !data?.types?.length)), items.length ? h("table", null, h("thead", null,
        h("tr", null, ...["选择", "内容", "类型", "操作"].map((v) => h("th", { key: v }, v)))), h("tbody", null,
        ...items.map((item) => h("tr", { key: item.id }, h("td", null, h("input", { type: "checkbox", "aria-label": `选择${item.
        title}`, checked: selectedItems.includes(item.id), onChange: (e) => setSelectedItems(e.target.checked ? [...selectedItems,
        item.id] : selectedItems.filter((id) => id !== item.id)) })), h("td", null, h("strong", null, item.title || "未命名"),
        h("p", { className: "okr-muted" }, item.body?.slice(0, 180)), detail("记录详情", item.fields)), h("td", null,
        data.types?.find((t) => t.id === item.typeId)?.title || item.typeId), h("td", null, h("div", { className: "okr-r\
ow" }, button("修改", () => edit(item)), button("加入行动", () => run("action.save", { itemId: item.id })), recordTrace(item))))))) :
        h("p", { className: "okr-empty" }, "暂无正式记录。保存后会在这里显示。")), form && recordForm(),
        pageWidgets(), card("查询与统计", h("div", { className: "okr-row" }, h("select", { value: typeId, onChange: (e) => setTypeId(
        e.target.value), style: { width: 200 } }, h("option", { value: "" }, "全部类型"), ...(data?.types || []).map(
        (t) => h("option", { key: t.id, value: t.id }, t.title || t.id))), button("查询", async () => {
          const r = await run("items.query", { typeId: typeId || void 0 }, { refresh: false });
          if (r) setStats(r.data);
        }), button("统计", async () => {
          const dateField = await askInput("采用哪个业务日期字段？留空表示不按日期筛选。");
          if (dateField === null) return;
          const field = await askInput("需要汇总哪个数字字段？留空表示计数。");
          if (field === null) return;
          const r = await run("items.query", { typeId: typeId || void 0, dateField: dateField || void 0, aggregate: { operation: field ?
          "sum" : "count", field: field || void 0 } }, { refresh: false });
          if (r) setStats(r.data);
        })), stats && detail(`结果 ${stats.total} 条，未纳入 ${stats.excludedCount} 条`, stats)));
      }
      function actions() {
        const list = data?.actions || [];
        return card("行动与执行", ...list.map((action) => {
          const item = data.items.find((i) => i.id === action.itemId);
          return h("article", { className: "okr-card", key: action.itemId }, h("div", { className: "okr-between" }, h("s\
trong", null, item?.title || action.itemId), h("span", { className: "okr-tag" }, actionPhase[action.state] || action.state)), h("p", { className: "ok\
r-muted" }, action.schedule?.enabled === false ? "排期已停用" : action.schedule?.start || action.schedule?.date || "\
尚未排期"), h("div", { className: "okr-row" }, button("安排日期", async () => {
            const date = await askInput("计划日期（YYYY-MM-DD）");
            if (date) run("action.save", { itemId: action.itemId, expectedRevision: action.revision, schedule: { date, enabled: true } });
          }), button("安排时段", async () => {
            const start = await askInput("开始时间（含时区，例如2026-10-27T10:00:00+08:00）");
            if (!start) return;
            const end = await askInput("结束时间（含时区）");
            if (end) run("action.save", { itemId: action.itemId, expectedRevision: action.revision, schedule: { start, end,
            enabled: true } });
          }), button("设置周期", async () => {
            const date = await askInput("首次日期（YYYY-MM-DD）");
            if (!date) return;
            const recurrence = await askInput("周期规则（例如daily或weekly）");
            if (recurrence) run("action.save", { itemId: action.itemId, expectedRevision: action.revision, schedule: { date,
            recurrence, enabled: true } });
          }), button("打卡", async () => {
            const occurrenceKey = action.schedule?.recurrence ? await askInput("本次执行日期（YYYY-MM-DD）") : void 0;
            if (occurrenceKey === null) return;
            const note = await askInput("执行心得（可空）");
            if (note !== null) run("execution.save", { itemId: action.itemId, occurrenceKey, note });
          }), button("取消排期", () => run("action.save", { itemId: action.itemId, expectedRevision: action.revision,
          schedule: { ...action.schedule, enabled: false } }))));
        }), !list.length && h("p", { className: "okr-empty" }, "从记录中选择“加入行动”，再明确安排时间。"),
        detail("执行记录", data?.executions || []));
      }
      function calendar() {
        const start = /* @__PURE__ */ new Date(month + "-01T00:00:00"), count = new Date(start.getFullYear(), start.getMonth() +
        1, 0).getDate();
        return card("日历", calendarData.hasMore ? h("p", { className: "okr-muted" }, `本页显示${calendarData.occurrences.
        length}/${calendarData.total}次排期，请缩小范围`) : null, calendarData.unsupported?.length ? detail("未投\
影的排期", calendarData.unsupported) : null, h("input", { type: "month", value: month, onChange: (e) => setMonth(e.target.
        value), style: { width: 180, marginBottom: 16 } }), h("div", { style: { overflow: "auto" } }, h("div", { className: "\
okr-week" }, ...Array.from({ length: count }, (_, n) => {
          const date = `${month}-${String(n + 1).padStart(2, "0")}`;
          return h("div", { key: date, className: "okr-day" }, h("span", { className: "okr-muted" }, n + 1), ...(calendarData.
          occurrences || []).filter((a) => a.date === date).map((a) => h("button", { key: `${a.objectiveId || selected}:${a.
          itemId}:${a.occurrenceKey}`, onClick: () => {
            if (a.objectiveId) setSelected(a.objectiveId);
            setView("actions");
          } }, a.title)));
        }))));
      }
      function schemeView() {
        const draft = scheme?.draft?.value;
        return h(React.Fragment, null, card(draft ? "方案草稿" : "空间能力", h("p", { className: "okr-muted" }, "\
通过对话描述页面、记录规则或工具的调整。确认前正式方案继续可用。"), h("textarea", { value: designText,
        onChange: (e) => setDesignText(e.target.value), placeholder: "例如：维护学习资料，支持资料收藏、笔记和按周回顾" }),
        h("div", { className: "okr-row" }, button("生成或调整草稿", async () => {
          const r = await run("scheme.generate", { purpose: data?.space?.purpose, instruction: designText });
          if (r) await loadScheme();
        }, true, !caps.bot || busy), button("刷新审查", loadScheme)), draft && h(React.Fragment, null, h("h3", null,
        draft.bundle.title || "待启用方案"), h("p", null, draft.bundle.description), ...draft.bundle.types.map((t) => h(
        "div", { className: "okr-card", key: t.id }, h("strong", null, t.title || t.id), h("p", { className: "okr-muted" },
        t.fields.map((f) => `${f.title || f.id}${f.required ? "（必填）" : ""}`).join("、")))), button("运行试用检查",
        async () => {
          await run("scheme.review");
          await loadScheme();
        }), draft.review && h("p", null, draft.review.passed ? "实际样例检查通过" : "检查未通过，请调整草稿"),
        detail("工具、CLI 与使用 Skill", draft.bundle.tools), detail("检查结果", draft.review), draft.compatibility &&
        detail(`历史影响：${draft.compatibility.affectedItems}条事项保持原值`, draft.compatibility), button(
        "添加真实试用记录", () => {
          setForm({ trial: true });
          setTitle("");
          setBody("");
          setFields({});
          setTypeId(draft.bundle.types[0]?.id || "");
        }), form?.trial && recordForm(), ...trials.filter((t) => t.provenance === "real").map((t) => h("label", { key: t.
        id }, h("input", { type: "checkbox", checked: chosen.includes(t.id), onChange: (e) => setChosen(e.target.checked ?
        [...chosen, t.id] : chosen.filter((id) => id !== t.id)) }), t.title || t.value?.title || t.id)), button("确认启用当前方\
案", async () => {
          const r = await run("scheme.confirm", { expectedRevision: scheme.draft.revision, hash: draft.hash, selectedTrialIds: chosen });
          if (r) {
            await loadScheme();
            const saved = r.data.transfers.filter((t) => t.result.kind === "saved").length;
            setNotice({ text: `方案已启用，已转入 ${saved} 条记录，其余真实材料可在待整理中继续。` });
          }
        }, true, busy || !draft.review?.passed))), !draft && data?.bundle && detail("当前能力与使用说明", data.
        bundle));
      }
      function planView() {
        return card("规划与阶段复盘", h("textarea", { value: planningText, onChange: (e) => setPlanningText(e.target.
        value), placeholder: "描述希望推进的目标、时间范围与约束" }), h("div", { className: "okr-row" },
        button("生成行动建议", async () => {
          const r = await run("plan.generate", { goal: planningText }, { refresh: false });
          if (r) {
            setPlan(r.data.value || r.data);
            setPlanChosen([]);
          }
        }, true, !caps.bot || busy), button("生成复盘草稿", async () => {
          const r = await run("review.generate", { question: planningText }, { refresh: false });
          if (r) setPlan(r.data.value || r.data);
        }, false, !caps.bot || busy)), plan && h("div", { className: "okr-card" }, h("h3", null, plan.title), h("p", null,
        plan.summary || ""), ...(plan.suggestions || []).map((s, n) => h("label", { key: n }, h("input", { type: "checkb\
ox", checked: planChosen.includes(n), onChange: (e) => setPlanChosen(e.target.checked ? [...planChosen, n] : planChosen.
        filter((i) => i !== n)) }), s.title, h("p", { className: "okr-muted" }, s.reason))), plan.kind === "review" ? button(
        "核对后保存复盘", () => run("review.save", { id: plan.id, hash: plan.hash }), true) : button("仅将选中建议加入行动",
        () => run("plan.adopt", { id: plan.id, hash: plan.hash, selected: planChosen }), true, !planChosen.length || busy),
        detail("依据与假设", plan)), ...(data?.results || []).map((r) => h(React.Fragment, { key: r.id }, card(r.title,
        h("p", null, r.body || r.summary), detail("评价依据", r.evidence || []), button("补充评价", async () => {
          const body2 = await askInput("补充阶段评价", r.body || r.summary || "");
          if (body2 !== null) run("result.save", { id: r.id, targetId: r.targetId, title: r.title, body: body2, evidence: r.
          evidence || [], expectedRevision: r.revision });
        })))));
      }
      function content() {
        if (!data) return h("div", { className: "okr-empty" }, "正在读取空间…");
        if (!selected && view === "calendar") return h(React.Fragment, null, button("返回综合群聊", () => setView(
        "records")), calendar(), calendarData.errors?.length ? detail("未纳入的空间", calendarData.errors) : null);
        if (!selected) return card("综合空间", h("p", null, "向协调 Bot 提出多空间需求，或明确 @ 成员。结果和补充会留在原群。"),
        h("div", { className: "okr-row" }, button("全局日历", () => setView("calendar")), button("查询选中空间",
        () => run("group.query", { objectiveIds: groupTargets, text: text || "查询这些空间的相关记录", messageId: requestId() }),
        false, busy || !caps.bot || !groupTargets.length), button("规划选中空间", () => run("group.plan", { objectiveIds: groupTargets,
        text: text || "根据这些空间的事实提出行动建议", messageId: requestId() }), false, busy || !caps.bot ||
        !groupTargets.length)), h("div", { className: "okr-grid" }, ...spaces.map((s) => h("article", { className: "okr-\
card", key: s.id }, h("h3", null, s.title), h("label", null, h("input", { type: "checkbox", checked: groupTargets.includes(
        s.id), onChange: (e) => setGroupTargets(e.target.checked ? [...groupTargets, s.id] : groupTargets.filter((id) => id !==
        s.id)) }), "纳入查询或规划"), h("p", { className: "okr-muted" }, s.purpose || ""), button("打开空间",
        () => setSelected(s.id)), button("调整空间", async () => {
          const instruction = await askInput("希望怎样调整这个空间？");
          if (!instruction) return;
          const r = await run("group.scheme", { action: "generate", objectiveId: s.id, instruction });
          if (r) {
            setSelected(s.id);
            setView("scheme");
          }
        }, false, !caps.bot || busy)))), detail("协作进展", data.parts || data.tasks || []));
        if (!data.migrated) return card("升级此空间", h("p", null, "先检查并备份，再明确执行迁移。旧文件保持保留，升级不会补造历史执行。"),
        h("div", { className: "okr-row" }, button("检查升级条件", async () => {
          const r = await run("space.inspect", {}, { refresh: false });
          if (r) setStats(r.data);
        }), button("备份旧文件", () => run("space.backup", {}, { refresh: false })), button("迁移此空间", () => stats?.
        inspectionHash ? run("space.migrate", { confirmed: true, inspectionHash: stats.inspectionHash }) : setNotice({ text: "\
请先检查升级条件", error: true }), true)), stats && detail("检查报告", stats), detail("当前目标与日程",
        data));
        if (view === "records") return records();
        if (view === "actions") return actions();
        if (view === "calendar") return calendar();
        if (view === "scheme") return schemeView();
        if (view === "planning") return planView();
        if (view === "pending") return card("待整理", ...(data.pending_materials || []).map((m) => h("article", { className: "\
okr-card", key: m.id }, h("h3", null, m.title || "待补充材料"), h("p", { className: "okr-muted" }, m.reason === "ar\
chived" ? "空间已归档，请先恢复" : m.reason === "trial_not_selected" ? "真实试用尚未选择转入，可继续保存" :
        m.reason === "transfer_incomplete" ? "试用转入未完成，可继续处理" : `缺少：${(m.missing || []).join(
        "、")}`), button("补充内容", () => edit(m, true)))), form && recordForm(), !(data.pending_materials || []).
        length && h("p", { className: "okr-empty" }, "暂无待整理材料。"));
        if (view === "history") return card("方案历史", ...history.map((s) => h("article", { className: "okr-card", key: s.
        key }, h("h3", null, s.value.title || s.key), button("生成恢复草稿", async () => {
          const r = await run("scheme.restore", { bundleId: s.key });
          if (r) {
            await loadScheme();
            setView("scheme");
          }
        }))), button("恢复未完成的试用转入", () => run("scheme.resumeTransfers")), h("h3", { style: { marginTop: 20 } },
        "批量历史变更"), button("预览修改选定记录", async () => {
          if (!selectedItems.length) {
            setNotice({ text: "请先在记录列表选择需要修改的内容", error: true });
            return;
          }
          const title2 = await askInput("统一改成的标题");
          if (title2 === null) return;
          const r = await run("batch.preview", { changes: selectedItems.map((itemId) => ({ itemId, title: title2 })) }, {
          refresh: false });
          if (r) setPlan(r.data.value || r.data);
        }), plan?.changes && h(React.Fragment, null, detail(`影响${plan.changes.length}条记录`, plan.changes), button(
        "确认此批变更", () => run("batch.confirm", { planId: plan.id, hash: plan.hash }), true)));
        if (view === "memory") return card("空间记忆", ...memories.map((m) => h("article", { className: "okr-card", key: m.
        id }, h("p", null, m.text), detail("来源", m.sourceRefs), h("div", { className: "okr-row" }, button("修改", async () => {
          const text2 = await askInput("修改偏好", m.text);
          if (text2) {
            await run("memory.update", { id: m.id, expectedRevision: m.revision, text: text2 });
            await openTab("memory");
          }
        }), button("删除", async () => {
          await run("memory.delete", { id: m.id, expectedRevision: m.revision });
          await openTab("memory");
        })))), !memories.length && h("p", { className: "okr-empty" }, "有依据的长期偏好会显示在这里，可随时修改或删除。"));
      }
      const messages = selected ? [...chat.messages || [], ...(chat.answers || []).map((a) => ({ ...a, role: "assistant" }))].
      sort((a, b) => (a.seq || 0) - (b.seq || 0)) : data?.messages || [];
      const workErrors = selected ? chat.errors || [] : [];
      return h("div", { className: "okr-app" }, h("style", null, css + dialogCss), inputDialog && h(InputDialog, { key: inputDialog.id, request: inputDialog, onClose: value => closeInputDialog(value, inputDialog.id) }), h("header", null, h("h1", null, "🧭 个人日常助手"),
      h("select", { "aria-label": "选择空间", value: selected, onChange: (e) => {
        setSelected(e.target.value);
        setView("records");
        setStats(null);
      } }, h("option", { value: "" }, "综合空间 · 群聊"), ...spaces.map((s) => h("option", { key: s.id, value: s.
      id }, s.title))), button("新建空间", async () => {
        const title2 = await askInput("空间名称");
        if (!title2) return;
        const purpose = await askInput("希望记录什么、怎样查看和使用？");
        if (purpose === null) return;
        const r = await run("scheme.create", { title: title2, purpose }, { space: "", refresh: false });
        if (r) {
          setSelected(r.data.objectiveId);
          setView("scheme");
        }
      }), h("span", { className: "okr-muted" }, caps.bot ? "Bot 已连接" : "Bot 未配置 · 可使用已有工具"), !selected && button("Bot 诊断总览", () => openTrace()), button(
      "返回 DSH", () => pluginCtx?.layout?.selectPanel(null)), button("日程总览", onCalendar)), notice && h("div", { className: `okr-notice${notice.error ?
      " okr-error" : ""}`, role: "status" }, notice.text, notice.error && (notice.refreshSpace ? button("刷新记录", () => refreshAfterPublication(notice.refreshSpace)) : last.current && button("重试原请求", () => run(
      last.current.command, last.current.input, { space: last.current.space })))), selected && h("nav", null, ...[["recor\
ds", "记录"], ["actions", "行动与执行"], ["calendar", "日历"], ["pending", "待整理"], ["planning", "规划与复盘"],
      ["trace", "执行轨迹"], ["scheme", "内容与能力审查"], ["history", "方案历史"], ["memory", "空间记忆"]].map(([key, label]) => h(
      "button", { key, className: view === key ? "active" : "", onClick: () => openTab(key) }, label))), h("div", { className: "\
okr-layout" }, h("main", { className: "okr-main", ref: mainPanel }, selected && data?.space && h("div", { className: "okr-between", style: {
      marginBottom: 20 } }, h("div", null, h("h1", null, data.space.title), h("p", { className: "okr-muted" }, data.space.
      purpose || "")), data.migrated && button(data.space.archivedAt ? "恢复空间" : "归档空间", () => run(data.space.
      archivedAt ? "space.restore" : "space.archive", { expectedRevision: data.space.revision }))), content()), h("aside",
      { className: "okr-chat" }, h("div", { className: "okr-chat-title" }, h("strong", null, selected ? "空间 Bot" : "\
综合空间群聊"), selected && button("查看 Bot 轨迹", () => openTrace()), h("p", { className: "okr-muted" }, "记录、查询和继续讨论")), h("div", { className: "okr-\
messages" }, ...messages.map((m, n) => h("article", { className: `okr-message ${m.role === "user" ? "user" : ""}`, key: m.
      id || n, id: `message-${m.id}` }, h("p", null, m.text || m.content || ""), button("回复", () => setReply(m.answerId ||
      m.id)), button("查看轨迹", () => openTrace(selected ? {
        taskId: m.taskId || (chat.tasks || []).find(task => (task.inputRefs || []).includes(`message:${m.id}`))?.id,
        messageId: m.id, focus: { messageId: m.id, ...(m.answerId ? { answerId: m.answerId } : {}) }
      } : { source: "group", objectiveId: m.objectiveId || null, taskId: m.taskId,
        groupMessageId: m.role === "user" ? m.id : m.replyTo || m.id, messageId: m.id,
        focus: { messageId: m.id, ...(m.botAnswerId ? { answerId: m.botAnswerId } : {}) } })))), !messages.length && h("p", { className: "okr-muted" }, "暂无对话。输入需求后开始处理。"),
      ...workErrors.map(error => h("section", { className: "okr-message okr-error", role: "alert", key: error.deliveryId || error.code },
        h("strong", null, "工作需要处理"), h("p", null, workErrorMessage(error)),
        button("查看失败轨迹", () => openTrace({ taskId: (chat.tasks || []).find(task => task.runId === `run:${error.deliveryId}`)?.id, focus: { deliveryId: error.deliveryId } }), false, false),
        error.retryable && button("重试原工作", () => recoverWork(error.deliveryId), false, busy || !caps.bot))),
      selected && h("details", { open: true }, h("summary", null, "当前工作与工作记录"), ...(chat.tasks || []).
      map((t) => h("div", { className: "okr-work", key: t.id }, h("strong", null, t.title), h("p", { className: "okr-mut\
ed" }, phase[t.phase] || t.phase), button("继续", () => {
        setReply(t.lastAnswerRef?.replace("answer:", ""));
        setText(`继续：${t.title}`);
      }), button("查看轨迹", () => openTrace({ taskId: t.id })), button("取消", () => run("task.control", { taskId: t.id, expectedRevision: t.revision, action: "cancel" })))))),
      h("div", { className: "okr-composer" }, reply && h("p", { className: "okr-muted" }, "正在回复选定消息 ", button(
      "取消引用", () => setReply(null))), h("textarea", { "aria-label": "发送给Bot", value: text, onChange: (e) => setText(
      e.target.value), placeholder: selected ? "向本空间 Bot 提问或补充信息" : "输入多空间需求，或 @ 成员" }),
      h("div", { className: "okr-between", style: { marginTop: 8 } }, h("span", { className: "okr-muted" }, chat.pending ?
      (workErrors.length ? chat.running ? "有工作正在处理" : "有工作需要处理" : "后台处理中") : workErrors.length ? "有工作需要处理" : "文字输入"), button("发送", () => send(), true, busy || !caps.bot || !!selected && !data?.
      migrated))))));
    }
    let resumeTrace = false;
    function CalendarPanel() {
      const [legacy, setLegacy] = useState(() => resumeTrace);
      const frame = useRef(null);
      useEffect(() => {
        resumeTrace = false;
        const navigate = event => {
          if (!frame.current || event.source !== frame.current.contentWindow || event.origin !== location.origin) return;
          if (event.data?.type === 'okr-return-to-dsh') pluginCtx.layout.selectPanel(null);
          if (event.data?.type === 'okr-open-workbench') {
            if (validSpaceId(event.data.oid)) workbenchSnapshot = { selected: event.data.oid, view: 'records' };
            setLegacy(true);
          }
        };
        window.addEventListener('message', navigate);
        return () => window.removeEventListener('message', navigate);
      }, []);
      if (legacy) return h(App, { onCalendar: () => setLegacy(false) });
      return h('iframe', { ref: frame, title: '目标日程工作区', src: '/okr-space/ui/index.html',
        style: { width: '100%', height: '100%', position: 'absolute', inset: 0, border: 0, background: '#f8fafc' } });
    }
    return { inject: ["slots", "layout"], apply(ctx) {
      pluginCtx = ctx;
      removeTraceReturn?.();
      const returnFromTrace = event => {
        const target = event.detail;
        if (!target || typeof target !== "object" || target.objectiveId != null && !validSpaceId(target.objectiveId)) return;
        const nextView = workbenchViews.has(target.view) ? target.view : "records";
        workbenchSnapshot = { ...(workbenchSnapshot || {}), selected: target.objectiveId || "", view: nextView,
          messageId: typeof target.messageId === "string" && target.messageId.length < 512 ? target.messageId : null };
        resumeTrace = true;
        ctx.layout?.selectPanel("okr-schedule");
      };
      window.addEventListener("asv-return-bot-trace", returnFromTrace);
      removeTraceReturn = () => window.removeEventListener("asv-return-bot-trace", returnFromTrace);
      ctx.effect?.(() => removeTraceReturn);
      ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({ name: "sidebar.panellist", id: "okr-schedule", order: 12,
      label: "目标日程" }, () => h("span", { title: "个人日常助手" }, "🧭")));
      ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: "okr-schedule" }, CalendarPanel));
    } };
  }
});
