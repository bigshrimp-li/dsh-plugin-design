/** Harness-themed presentation. All data and commands belong to the independent Core controller. */
window.__ModuleLoader__.load({
  id: "@super-agent/dsh-bridge", chunk: "client.space-view.js",
  factory() {
    function attachmentRangeLabel(range) {
      if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end)) return "范围未知";
      const partial = Object.hasOwn(range, "offset") || Object.hasOwn(range, "endOffset");
      return `${range.start}–${range.end}${partial ? ` · 部分范围（起始字符偏移 ${range.offset ?? 0}${range.endOffset === undefined ? "" : `，结束字符偏移 ${range.endOffset}`}）` : ""}`;
    }
    function currentAttachmentState(material, currentAttachments) {
      const unknownReason = reason => ({ material_block_mapping_unavailable: "无法可靠核对原消息与当前内容的对应关系。", not_in_committed_history: "该附件尚未进入已确认的对话历史。", context_inspection_unavailable: "当前服务暂时无法核对原内容是否仍在上下文中。" }[reason] || "服务未提供可核实的当前保留状态。");
      const unknown = { label: "当前上下文：未核实", evidence: [], reason: unknownReason(currentAttachments?.reason) };
      if (currentAttachments?.status !== "available") return unknown;
      const item = (currentAttachments.items || []).find(candidate => candidate.attachmentId === material.attachmentId
        && (!material.representationId || candidate.representationId === material.representationId)
        && (!material.contentHash || candidate.contentHash === material.contentHash));
      if (!item || item.status === "unknown") return { ...unknown, reason: item?.reason ? unknownReason(item.reason) : unknown.reason };
      if (item.status === "reference_only") return { label: "当前上下文：仅保留附件引用，未保留原内容", evidence: [], reason: "原内容仍可按需读取；版本摘要不代表正文仍在上下文中。" };
      if (item.status !== "content_retained") return unknown;
      const formats = (item.retainedFormats || []).filter(format => ["image", "text"].includes(format));
      if (!formats.length) return unknown;
      return { label: `当前上下文：该附件仍保留部分${formats.map(format => format === "image" ? "图片" : "文字").join("和")}`,
        evidence: (item.evidence || []).map(entry => `${entry.source === "tool_result" ? "工具返回" : "用户输入"} · ${(entry.formats || []).map(format => format === "image" ? "图片" : "文字").join("和")} · ${attachmentRangeLabel(entry.range)}`),
        reason: "仅表示所列内容和范围仍在当前上下文中，不代表原选区、整份文件或全文已保留。" };
    }
    function compactionStatusLabel(operation) {
      if (!operation) return "";
      if (operation.reason === "no_effective_cut") return "历史不足以形成有效压缩范围，原内容保持。";
      return { running: "正在压缩，是否保留原内容以完成后的状态为准。", committed: "压缩已提交。附件当前保留状态请查看原消息详情。",
        below_threshold: "无需压缩，原内容保持。", aborted: "压缩未完成，原内容保持。", failed: "压缩失败，原内容保持。", unknown: "压缩结果尚未确认，请只读刷新状态。" }[operation.status] || "压缩结果尚未核实。";
    }
    const skillSourceId = skill => skill.sourceId || skill.primarySourceId || skill.sourceIds?.[0] || "";
    function skillCatalogRowKey(skill) {
      return JSON.stringify([skill.skillId, skill.workspaceId || skill.scope || "global", [...(skill.sourceIds || [skillSourceId(skill)])].sort(), skill.path, skill.version || skill.snapshotId]);
    }
    function skillChoiceState(skill, state) {
      const enabled = ["available", "enabled"].includes(skill.status), wanted = (state.selectedSkillIds || []).includes(skill.skillId);
      const frozen = (state.selectedSkills || []).find(item => item.skillId === skill.skillId);
      const changed = frozen ? skillSourceId(frozen) !== skillSourceId(skill) || (frozen.version || frozen.snapshotId) !== (skill.version || skill.snapshotId) || frozen.sourceRevision !== skill.sourceRevision || frozen.policyRevision !== skill.policyRevision : state.attachmentCapabilities?.legacy !== true;
      return { checked: enabled && wanted && !changed, needsConfirmation: enabled && wanted && changed };
    }
    function diffLayout(available, preferred = 480, expanded = false) {
      const size = Number.isFinite(available) && available > 0 ? available : 1000;
      const full = expanded || size < 800, max = Math.min(960, Math.max(360, size - 420));
      return { width: full ? size : Math.max(360, Math.min(max, Number.isFinite(preferred) ? preferred : 480)), min: 360, max, full };
    }
    function diffSections(rows, context = 3) {
      if (!rows.length) return [];
      const ranges = [];
      rows.forEach((row, index) => {
        if (row.kind === "same") return;
        const start = Math.max(0, index - context), end = Math.min(rows.length, index + context + 1), previous = ranges.at(-1);
        if (previous && start <= previous.end) previous.end = end;
        else ranges.push({ start, end });
      });
      if (!ranges.length) ranges.push({ start: 0, end: rows.length });
      const result = [];
      let cursor = 0;
      for (const range of ranges) {
        if (range.start > cursor) result.push({ type: "gap", start: cursor, end: range.start });
        const old = rows.slice(range.start, range.end).filter(row => row.oldLine != null), next = rows.slice(range.start, range.end).filter(row => row.newLine != null);
        result.push({ type: "hunk", ...range, heading: `@@ -${old[0]?.oldLine ?? 0},${old.length} +${next[0]?.newLine ?? 0},${next.length} @@` });
        cursor = range.end;
      }
      if (cursor < rows.length) result.push({ type: "gap", start: cursor, end: rows.length });
      return result;
    }
    function codeTokens(text, path) {
      if (text.length > 20000 || !/\.(?:[cm]?[jt]sx?|json|py|go|rs|java|[ch](?:pp)?|css|sh|bash|ya?ml)$/i.test(path)) return [{ kind: "plain", text }];
      const pattern = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*.*?\*\/|\/\/.*|#[^\n]*|\b(?:async|await|break|case|catch|class|const|continue|def|else|export|false|fn|for|from|func|function|if|import|in|interface|let|new|nil|null|package|pub|return|self|static|struct|switch|throw|true|try|type|undefined|var|void|while)\b|\b\d+(?:\.\d+)?\b/g;
      const tokens = [];
      let cursor = 0;
      for (const match of text.matchAll(pattern)) {
        if (match.index > cursor) tokens.push({ kind: "plain", text: text.slice(cursor, match.index) });
        const value = match[0], hashComment = value.startsWith("#") && /\.(?:py|sh|bash|ya?ml)$/i.test(path);
        tokens.push({ kind: /^["'`]/.test(value) ? "string" : value.startsWith("//") || value.startsWith("/*") || hashComment ? "comment" : value.startsWith("#") ? "plain" : /^\d/.test(value) ? "number" : "keyword", text: value });
        cursor = match.index + value.length;
      }
      if (cursor < text.length) tokens.push({ kind: "plain", text: text.slice(cursor) });
      return tokens;
    }
    const COMPOSER_CSS = `.sa-attachment-dialog,.sa-attachment-dialog *{box-sizing:border-box}
[role="dialog"]:has(.sa-attachment-dialog) button{min-width:44px;min-height:44px}
.sa-composer{min-width:0;container-type:inline-size}.sa-composer[data-dragging=true]{outline:2px solid #4176e6;outline-offset:3px;background:#f8faff}
.sa-composer-bar{padding:4px 8px 8px;gap:4px}.sa-composer-attach,.sa-composer-skill,.sa-composer .sa-send,.sa-composer .sa-permission-chip,.sa-composer .sa-chip{min-height:44px}.sa-composer-attach,.sa-composer .sa-send{width:44px;height:44px;flex:none}.sa-composer-skill{min-width:44px;display:inline-flex;align-items:center;gap:4px;flex:none;padding:0 8px;border:0;border-radius:8px;background:transparent;color:#61666b;font-size:12px}.sa-composer-skill:hover{background:#f1f3f5}.sa-composer button:focus-visible,.sa-attachment-dialog button:focus-visible,.sa-attachment-dialog input:focus-visible,.sa-attachment-dialog select:focus-visible{outline:2px solid #4176e6;outline-offset:2px}
.sa-draft-materials{display:flex;flex-wrap:wrap;gap:8px;padding:12px 12px 0;min-width:0;max-height:260px;overflow-y:auto;overflow-x:hidden}.sa-attachment-card{display:flex;position:relative;flex:1 1 200px;max-width:100%;min-width:0;flex-wrap:wrap;border:1px solid #e1e5ee;border-radius:10px;background:#fafbfc}.sa-attachment-card[data-state=failed],.sa-attachment-card[data-state=duplicate]{border-color:#e9aaaa;background:#fffafa}.sa-attachment-card-open{display:flex;align-items:center;gap:8px;flex:1;min-width:0;padding:8px;background:transparent;border:0;text-align:left;color:inherit;cursor:pointer}.sa-attachment-card-open:disabled{opacity:1;cursor:default}.sa-attachment-thumb,.sa-attachment-file-icon{width:44px;height:44px;object-fit:contain;flex:none;border-radius:6px;background:#eef1f6}.sa-attachment-file-icon{display:grid;place-items:center;font-size:24px;color:#67768b}.sa-attachment-card-copy{display:flex;flex-direction:column;gap:3px;min-width:0}.sa-attachment-card-copy strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:500}.sa-attachment-card-copy small{font-size:11px;color:#727b88}.sa-attachment-remove{align-self:flex-start;flex:none;min-width:44px;min-height:44px;border:0;background:transparent;color:#727b88;font-size:20px;border-radius:8px}.sa-attachment-card-error{width:100%;padding:0 10px 8px;color:#b33a3a;font-size:12px;overflow-wrap:anywhere}.sa-attachment-action{min-height:44px;padding:0 10px;border:0;border-radius:6px;background:transparent;color:#3466bc;font-size:12px}.sa-attachment-card-error .sa-attachment-action{padding-block:0}.sa-attachment-error{margin:0;padding:8px 10px;border-radius:8px;background:#fef2f2;color:#b33a3a;overflow-wrap:anywhere;font-size:12px}.sa-attachment-summary{display:flex;gap:4px;align-items:center;flex-wrap:wrap;padding:4px 10px;color:#81858c;font-size:11.5px}.sa-attachment-summary button{min-height:44px;border:0;background:transparent;color:#3466bc;font:inherit;padding:0 4px}.sa-attachment-summary span{min-width:0;overflow-wrap:anywhere}.sa-skill-tag{display:inline-flex;align-items:center;min-width:0;max-width:100%;border:1px solid #dce5f4;border-radius:8px;background:#f4f7fc;font-size:12px;color:#42608a}.sa-skill-tag>span{padding-left:10px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sa-skill-tag>button{min-width:44px;min-height:44px;background:transparent;border:0;color:inherit;font-size:18px}
.sa-dialog-body.sa-attachment-dialog{width:100%;min-width:0;max-width:100%;max-height:min(65vh,600px);padding:8px 16px 16px;overflow-x:hidden;overflow-y:auto;overflow-wrap:anywhere;font-size:13px}.sa-attachment-dialog p{margin:0;line-height:1.7}.sa-attachment-dialog label{min-width:0;display:flex;flex-direction:column;gap:5px}.sa-attachment-dialog select,.sa-attachment-dialog input{min-width:0;max-width:100%;font:inherit}.sa-attachment-dialog .sa-skill-option{display:flex;flex-direction:row;align-items:flex-start;gap:10px;min-height:44px;padding:10px;border:1px solid #e1e5ee;border-radius:8px}.sa-skill-option>input{margin-top:4px;flex:none}.sa-skill-option>span{display:flex;flex-direction:column;gap:4px;min-width:0}.sa-skill-option small{line-height:1.6}.sa-project-file{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0;border-bottom:1px solid #edf0f4;padding:6px 0}.sa-project-file>span{min-width:0;overflow-wrap:anywhere}.sa-project-file small{display:block}.sa-attachment-preview-image{display:block;max-width:100%;height:auto;object-fit:contain}.sa-attachment-preview-text{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.7 ui-monospace,monospace}.sa-context-item{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid #e1e5ee;border-radius:8px;min-width:0}.sa-range-controls{display:flex;gap:8px;flex-wrap:wrap}.sa-range-controls label{flex:1 1 80px}.sa-range-controls button{min-height:44px}.sa-attachment-dialog .sa-dialog-input{min-height:44px}.sa-composer-target{padding:6px 14px 0;font-size:11px;color:#81858c;overflow-wrap:anywhere}.sa-selected-text-action{min-height:44px;margin:0 12px;text-align:left;border:0;background:transparent;color:#3466bc;font-size:12px}.sa-composer-target-select{display:flex;gap:8px;align-items:center;min-width:0}.sa-composer-target-select select{min-width:0;max-width:100%;min-height:44px;font:inherit}.sa-composer-warning{margin:0;padding:8px 12px;font-size:12px;color:#946321;overflow-wrap:anywhere}
.sa-history-materials:empty{display:none}.sa-history-materials{display:flex;flex-direction:column;gap:8px;max-width:100%;margin-top:8px}.sa-history-material{min-width:0;border:1px solid #dce2ed;border-radius:9px;background:#f7f9fc;color:#202633;font-size:12px}.sa-history-material>summary{display:flex;min-height:44px;flex-wrap:wrap;gap:4px 12px;align-items:center;padding:8px 10px;cursor:pointer;overflow-wrap:anywhere}.sa-history-material>summary small,.sa-history-material .sa-muted{color:#526173}.sa-history-material-detail{padding:0 10px 10px;min-width:0;overflow-wrap:anywhere}.sa-history-material-detail p{margin:6px 0;white-space:normal}.sa-history-material-detail figure{margin:8px 0}.sa-history-material-detail .sa-attachment-preview-image{max-height:480px}
@container(max-width:550px){.sa-composer-bar>.sa-model-slot{order:3;flex:1 1 calc(100% - 100px);max-width:calc(100% - 100px)}.sa-composer-bar>.sa-send{order:4;margin-left:0}.sa-composer-bar>.sa-send-stop{order:5}.sa-composer-bar>.sa-model-slot .sa-model-menu{width:100%;height:auto;min-height:44px;padding-inline:8px}.sa-composer-bar>.sa-model-slot .sa-chip{min-width:0;white-space:normal;text-align:left}.sa-draft-materials{padding:8px 8px 0}.sa-attachment-card{flex-basis:100%}.sa-attachment-summary{padding-inline:8px}}
@container(max-width:360px){.sa-composer-bar>.sa-model-slot{flex-basis:100%;max-width:100%;order:3}.sa-composer-bar>.sa-send{order:2;margin-left:auto}.sa-composer-bar>.sa-send-stop{order:2}.sa-composer-bar>.sa-permission-chip{padding-inline:6px}.sa-composer-attach,.sa-composer .sa-send{width:44px}.sa-composer-skill{padding-inline:5px}}
`;
    const CSS = `.sa-workspaces,.sa-space{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei','Helvetica Neue',Helvetica,Arial,sans-serif;font-size:13px;color:#0f1115}
.sa-workspaces *,.sa-space *{box-sizing:border-box}
.sa-workspaces button,.sa-space button,.sa-space textarea{font-family:inherit;cursor:pointer}
div:has(> [data-slot="sidebar.footer.action"] > .sa-workspaces){flex-direction:column!important;align-items:stretch!important;gap:0!important}
[data-slot="sidebar.footer.action"]:has(> .sa-workspaces)>*{flex-shrink:0!important}
.sa-workspaces{flex:none;width:100%;min-width:0;padding:2px 0 8px;max-height:42vh;overflow:auto}
.sa-section-head{height:36px;min-height:36px;display:flex;align-items:center;gap:4px;padding-left:4px;margin:2px -4px 4px 0;color:var(--dsw-alias-label-tertiary,#81858c)}
.sa-section-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:20px}
.sa-section-toggle{display:flex;align-items:center;gap:4px;flex:1;min-width:0;border:0;padding:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.sa-section-toggle svg{width:10px;height:10px;flex:none}
.sa-icon-button{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:4px;border:0;border-radius:6px;background:transparent;color:#81858c;cursor:pointer}
.sa-icon-button:hover,.sa-row:hover,.sa-row[data-selected=true],.sa-chip:hover:not(:disabled){background:#f1f3f5;color:#0f1115}
.sa-icon-button:focus-visible,.sa-row:focus-visible,.sa-chip:focus-visible{outline:2px solid #4176e6;outline-offset:-2px}
.sa-icon-button:disabled,.sa-chip:disabled{cursor:default;opacity:.5}
.sa-icon-button svg,.sa-row svg{width:16px;height:16px;flex:none}
.sa-row{display:flex;align-items:center;gap:6px;width:100%;height:34px;padding:0 8px;border-radius:8px;cursor:pointer;user-select:none;color:#0f1115;outline:none}
.sa-row-title{flex:1;min-width:0;text-overflow:ellipsis;overflow:hidden;white-space:nowrap;font-size:13px;line-height:20px}
.sa-row-actions{display:flex;align-items:center;gap:4px;opacity:0}
.sa-row:hover .sa-row-actions,.sa-row:focus-within .sa-row-actions{opacity:1}
.sa-row-actions .sa-icon-button{width:22px;height:24px;padding:2px}
.sa-session-row{height:32px;padding-left:32px;gap:0}
.sa-session-row .sa-row-title{margin:0 6px 0 4px}
.sa-folder-glyph{color:#81858c;width:16px;height:20px;display:flex;align-items:center}
.sa-folder-glyph[data-selected=true]{color:#4176e6}
.sa-search{margin:2px 8px 6px;width:calc(100% - 16px);height:28px;border:1px solid #e1e5ee;border-radius:6px;padding:0 8px;background:transparent;color:inherit;font:inherit;outline:none}
.sa-muted{color:#81858c;font-size:12px;line-height:18px}
.sa-directory-empty{padding:8px 12px}
.sa-space{height:100%;min-height:0;display:flex;flex-direction:column;background:#ffffff;position:relative;container-type:inline-size;overflow:hidden}
.sa-space[data-diff-open=true]:not([data-diff-expanded=true]){padding-right:var(--sa-diff-width,480px)}
.sa-space[data-diff-expanded=true]>.sa-space-header,.sa-space[data-diff-expanded=true]>.sa-scroll,.sa-space[data-diff-expanded=true]>.sa-composer-seat{visibility:hidden;pointer-events:none}
.sa-space-header{flex:0 0 52px;height:52px;min-height:52px;padding:0 20px;display:flex;align-items:center;gap:10px;border-bottom:1px solid #e1e5ee;background:#ffffff}
.sa-space-header[data-blank=true]{border-bottom:none}
.sa-header-title{flex:1;min-width:0;font-size:13px;font-weight:600;color:#0f1115;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sa-crumb{color:#81858c;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px}
.sa-crumb-current{color:#0f1115;font-weight:600}
.sa-header-actions{flex:none;margin-left:auto;display:flex;align-items:center;gap:8px}
.sa-header-btn{flex:none;white-space:nowrap;height:28px;padding:0 10px;border:1px solid #e1e5ee;border-radius:7px;background:#ffffff;color:#61666b;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.sa-header-btn:hover{background:#f9fafb;color:#0f1115}
.sa-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;scrollbar-gutter:stable;display:flex;flex-direction:column;container-type:inline-size}
.sa-scroll[data-hero=true]{justify-content:center;padding-bottom:32px}
.sa-hero{display:flex;justify-content:center;align-items:center;gap:12px;margin:0 24px 22px;font-size:26px;line-height:32px;font-weight:500}
.sa-hero-logo{width:34px;height:auto;flex:none}
.sa-badge{border:.5px solid #e1e5ee;background:#edf3fe;color:#4176e6;border-radius:999px;padding:1px 7px 0;font-size:12px;line-height:18px;font-weight:500;align-self:center;white-space:nowrap}
.sa-message-list{width:720px;max-width:100%;margin:0 auto;padding:24px 24px 8px;flex:1 1 auto;display:flex;flex-direction:column;gap:24px}
.sa-message-user-wrap{display:flex;justify-content:flex-end;width:100%;margin:0}
.sa-message{font-size:13px;line-height:1.75;margin:0;overflow-wrap:anywhere}
.sa-message[data-role=user]{background:#0f1115!important;color:#ffffff!important;border-radius:14px 14px 4px 14px!important;padding:10px 14px!important;max-width:440px!important;line-height:1.65!important;font-size:13px!important;overflow-wrap:anywhere}
@keyframes ds-spin{to{transform:rotate(360deg)}}
.ds-spin{animation:ds-spin 1.1s linear infinite;transform-origin:8px 8px}
.sa-turn-block{width:100%;box-sizing:border-box;background:#ffffff}
.sa-turn-head{display:flex;align-items:center;gap:8px;padding:2px 0 10px;cursor:pointer;user-select:none;list-style:none}
.sa-turn-head::-webkit-details-marker{display:none}
.sa-turn-pill{display:inline-flex;align-items:center;gap:7px;height:26px;padding:0 9px 0 7px;border:1px solid #e1e5ee;border-radius:7px;background:#f9fafb;color:#61666b;font-size:12px}
.sa-turn-pill svg{transition:transform .15s ease}
.sa-turn-block[open] .sa-turn-pill svg,.sa-turn-pill[data-open=true] svg{transform:rotate(180deg)}
.sa-turn-meta{font-size:11.5px;color:#979da6}
.sa-turn-running-meta{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:#61666b}
.sa-turn-steps{display:flex;flex-direction:column;gap:6px;padding:0 0 14px;margin:0 0 12px;border-bottom:1px solid #e1e5ee;list-style:none}
.sa-turn-step{display:flex;gap:9px;align-items:flex-start;font-size:12.5px}
.sa-turn-step-icon{flex:0 0 18px;width:18px;height:18px;border-radius:5px;margin-top:1px;display:grid;place-items:center}
.sa-turn-step-icon[data-kind=thinking]{background:#edf3fe;color:#4176e6}
.sa-turn-step-icon[data-kind=tool]{background:#f1f3f5;color:#61666b}
.sa-turn-step-icon[data-tool-error=true]{background:#fef2f2;color:#ef4444}
.sa-turn-step-title{font-size:12.5px;color:#0f1115}
.sa-turn-step-detail{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:#61666b;background:#f9fafb;border:1px solid #e1e5ee;border-radius:5px;padding:1px 5px;max-width:480px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sa-turn-step-meta{margin-left:auto;font-size:11px;color:#979da6;font-variant-numeric:tabular-nums}
.sa-turn-body{font-size:13.5px;line-height:1.75;color:#0f1115;margin-top:2px;overflow-wrap:anywhere}
.sa-actions-bar{display:flex;align-items:center;gap:2px;padding-top:8px}
.sa-actions-bar .sa-icon-button{width:28px;height:28px;padding:5px;border-radius:6px;color:#81858c}
.sa-actions-bar .sa-icon-button:hover{background:#f1f3f5;color:#0f1115}
.sa-actions-bar .sa-chip{height:28px;padding:0 8px;font-size:12px;color:#61666b;border:0;background:none}
.sa-actions-bar .sa-chip:hover{background:#f1f3f5;color:#0f1115}
.sa-actions-usage{margin-left:auto;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 9px;border:0;border-radius:6px;background:none;color:#81858c;font-size:11.5px;font-variant-numeric:tabular-nums;cursor:pointer}
.sa-actions-time{font-size:11.5px;color:#979da6;font-variant-numeric:tabular-nums;margin-left:8px}
.sa-changes-card{border:1px solid #e1e5ee;border-radius:12px;background:#ffffff;overflow:hidden;margin-top:12px}
.sa-changes-head{display:flex;align-items:center;gap:11px;padding:13px 14px}
.sa-changes-icon{flex:0 0 32px;width:32px;height:32px;border-radius:9px;background:#f1f3f5;display:grid;place-items:center;color:#61666b}
.sa-changes-info{flex:1 1 auto;min-width:0}
.sa-changes-title{font-size:13px;font-weight:600;color:#0f1115}
.sa-changes-count{display:flex;align-items:center;gap:6px;margin-top:3px;font-size:11.5px;font-variant-numeric:tabular-nums}
.sa-changes-add{color:#22c55e;font-weight:600}
.sa-changes-del{color:#ef4444;font-weight:600}
.sa-changes-actions{margin-left:auto;display:flex;align-items:center;gap:8px}
.sa-changes-btn{display:flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid #e1e5ee;border-radius:7px;background:#ffffff;color:#0f1115;font-size:12px;cursor:pointer}
.sa-changes-btn:hover{background:#f9fafb}
.sa-changes-files{border-top:1px solid #e1e5ee}
.sa-changes-file{display:flex;align-items:center;gap:10px;padding:9px 14px;border-bottom:1px solid #e1e5ee}
.sa-changes-file:last-child{border-bottom:none}
.sa-changes-path{flex:1 1 auto;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#0f1115;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sa-composer-seat{width:720px;max-width:100%;margin:0 auto;padding:0 24px 18px;flex:0 0 auto}
.sa-scroll[data-hero=true] .sa-composer-seat{padding-bottom:0}
.sa-workspace-picker{display:flex;align-items:center;gap:2px;margin:4px 0 8px;padding-left:8px}
.sa-chip{max-width:100%;height:28px;min-width:0;display:inline-flex;align-items:center;gap:4px;padding:0 8px;background:transparent;border:0;border-radius:6px;color:#61666b;font-size:13px;line-height:20px;cursor:pointer;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
.sa-chip svg{width:16px;height:16px;flex:none}
.sa-workspace-picker .sa-chip{font-weight:500;color:#0f1115}
.sa-composer{border:1px solid #e1e5ee;border-radius:16px;background:#ffffff;box-shadow:0 1px 2px rgba(15,17,21,.05),0 8px 24px rgba(15,17,21,.06);display:flex;flex-direction:column;overflow:hidden}
.sa-composer-notice{padding:6px 14px;font-size:12px;border-bottom:1px solid #f1f3f5}
.sa-input{display:block;width:100%;resize:none;min-height:48px;max-height:240px;overflow-y:auto;background:transparent;border:0;outline:none;padding:14px 16px 6px;color:inherit;font-size:13.5px;line-height:1.6}
.sa-input::placeholder{color:#979da6}
.sa-composer-bar{display:flex;align-items:center;gap:8px;padding:6px 12px 12px 16px}
.sa-composer-bar>:has(>.sa-model-menu){min-width:0;max-width:100%}
.sa-composer-attach{width:30px;height:30px;display:grid;place-items:center;border:0;border-radius:8px;background:#f1f3f5;color:#61666b;cursor:pointer;font-size:18px;font-weight:400;line-height:1}
.sa-composer-attach:hover:not(:disabled){background:#e5e7eb}
.sa-model-button{margin-left:auto;min-width:0;max-width:100%}
.sa-model-menu{display:inline-flex;align-items:center;min-width:0;max-width:100%;height:30px;padding:0 11px;border-radius:8px;background:#edf3fe;color:#283142;font-size:12.5px}
.sa-model-menu .sa-chip{height:auto;padding:0;color:inherit;font-size:inherit}
.sa-model-separator{color:#adb2b8;padding:0 4px}
.sa-send{width:32px;height:32px;display:grid;place-items:center;border:0;border-radius:9999px;background:#4176e6;color:#ffffff;cursor:pointer;flex:none}
.sa-send:hover:not(:disabled){background:#3562c4}
.sa-send:disabled{opacity:.4;cursor:default}
.sa-send-stop{background:#4176e6}
.sa-reply-group{position:relative;margin:0 0 16px;display:flex;flex-direction:column;gap:12px}
.sa-goal-card label{display:block;margin:12px 0 6px}.sa-goal-card input,.sa-goal-card textarea{display:block;box-sizing:border-box;width:100%;max-width:440px;margin:6px 0;border:1px solid #cfd5df;border-radius:6px;padding:8px;font:inherit}.sa-goal-card textarea{min-height:72px;resize:vertical}
.sa-run-card{border:.5px solid #e1e5ee;border-radius:8px;padding:10px 12px;margin-bottom:8px;overflow-wrap:anywhere}
.sa-message-table{overflow:auto;max-width:100%}
.sa-message table{border-collapse:collapse;white-space:normal;width:100%}
.sa-message th,.sa-message td{padding:6px 10px;border:1px solid #e1e5ee;text-align:left}
.sa-message h1,.sa-message h2,.sa-message h3{line-height:1.4;margin:14px 0 8px}
.sa-message pre{white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:#f9fafb;padding:8px 10px;border-radius:6px;border:1px solid #e1e5ee}
.sa-thinking{color:#81858c;border-left:2px solid #e1e5ee;padding-left:14px}
.sa-latest{position:sticky;bottom:12px;align-self:center;z-index:2;margin-top:-44px;border:1px solid #e1e5ee;border-radius:999px;padding:6px 12px;background:#ffffff;color:#0f1115;box-shadow:0 2px 8px rgba(0,0,0,.08);cursor:pointer}
.sa-streaming[data-role=assistant]{border-left:2px solid #4176e6;padding-left:12px}
.sa-error{display:flex;gap:8px;align-items:center;margin:4px 24px;padding:8px 12px;border-radius:8px;color:#ef4444;background:#fef2f2;font-size:13px}
.sa-dialog-body{display:flex;flex-direction:column;gap:12px;min-width:min(420px,60vw);max-height:70vh;overflow:auto}
.sa-dialog-input{height:36px;border:1px solid #e1e5ee;border-radius:8px;padding:0 10px;font:inherit;background:transparent;color:#0f1115;width:100%}
.sa-dialog-footer{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px}
.sa-directory-toolbar{display:flex;gap:4px;align-items:center}
.sa-directory-path{flex:1;min-width:0}
.sa-directory-browser{height:260px;overflow:auto;border-block:.5px solid #e1e5ee;padding-block:4px}
.sa-directory-browser .sa-row{border:0;background:transparent;font:inherit;text-align:left}
.sa-directory-browser .sa-row:hover,.sa-directory-browser .sa-row[data-selected=true]{background:#f1f3f5}
.sa-dialog-body.sa-workspace-dialog-body{box-sizing:border-box;width:100%;min-width:0;max-width:100%;padding:8px 20px 16px;gap:10px;max-height:min(64vh,560px);overflow-x:hidden}
.sa-workspace-dialog-body p{margin:0;min-width:0;overflow-wrap:anywhere}
.sa-workspace-dialog-body label{display:flex;flex-direction:column;gap:6px;min-width:0}
.sa-workspace-dialog-body code{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
.sa-workspace-dialog-body .sa-directory-toolbar{flex-wrap:wrap;min-width:0}
.sa-workspace-dialog-body .sa-directory-browser{height:clamp(110px,22vh,190px);min-height:110px;flex:0 1 auto}
.sa-workspace-dialog-footer{box-sizing:border-box;max-width:100%}
.sa-folder-create{display:flex;gap:8px;align-items:center}
.sa-observation-dialog{width:min(860px,75vw);max-width:100%;height:min(620px,72vh);overflow:auto}
.sa-diff-panel{--sa-review-border:#e3e7ed;--sa-review-muted:#586472;position:absolute;z-index:20;inset:0 0 0 auto;width:var(--sa-diff-width,480px);min-width:0;display:flex;flex-direction:column;background:#ffffff;border-left:1px solid var(--sa-review-border);outline:none}
.sa-diff-resize{position:absolute;left:-5px;top:0;bottom:0;width:10px;z-index:3;cursor:col-resize;touch-action:none;outline:none}
.sa-diff-resize:after{content:"";position:absolute;left:4px;top:0;bottom:0;width:2px;background:transparent}
.sa-diff-resize:hover:after,.sa-diff-resize:focus-visible:after,.sa-diff-resize[data-dragging=true]:after{background:#4176e6}
.sa-diff-head{display:flex;align-items:center;gap:8px;min-height:64px;padding:10px 16px;border-bottom:1px solid var(--sa-review-border);background:#ffffff}
.sa-diff-heading{flex:1;min-width:0}.sa-diff-title{margin:0;font-size:14px;font-weight:600;color:#0f1115;line-height:22px}
.sa-diff-caption{font-size:11.5px;line-height:18px;color:var(--sa-review-muted)}
.sa-diff-panel button:focus-visible,.sa-diff-panel select:focus-visible,.sa-diff-panel summary:focus-visible{outline:2px solid #4176e6;outline-offset:2px}
.sa-diff-panel .sa-icon-button{width:32px;height:32px;color:#586472}
.sa-diff-tool{flex:none;min-height:32px;padding:0 9px;display:inline-flex;align-items:center;justify-content:center;gap:5px;border:1px solid var(--sa-review-border);border-radius:6px;background:#ffffff;color:#344151;font:inherit;font-size:12px;white-space:nowrap}
.sa-diff-tool:hover:not(:disabled),.sa-diff-tool[aria-pressed=true]{background:#eef3fc;border-color:#c9d6ed;color:#2454a3}.sa-diff-tool:disabled{opacity:.45;cursor:default}
.sa-diff-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid var(--sa-review-border);background:#f8fafc}
.sa-diff-round{min-width:0;max-width:100%;min-height:32px;flex:1;border:1px solid var(--sa-review-border);border-radius:6px;background:#ffffff;padding:0 8px;color:#344151;font:inherit;font-size:12px}
.sa-diff-counts{display:inline-flex;gap:8px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums;white-space:nowrap}
.sa-diff-files{padding:8px 12px;max-height:156px;overflow:auto;border-bottom:1px solid var(--sa-review-border);background:#ffffff}
.sa-diff-file{display:flex;align-items:center;gap:12px;width:100%;min-height:42px;border:1px solid transparent;border-radius:6px;background:transparent;color:#344151;text-align:left;padding:5px 8px;cursor:pointer}
.sa-diff-file:hover{background:#f7f9fc}.sa-diff-file[data-selected=true]{background:#eef3fc;border-color:#d5e0f2}
.sa-diff-file-name{flex:1;min-width:0;display:flex;flex-direction:column}.sa-diff-file-name strong{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sa-diff-file-name small{font-size:11px;color:var(--sa-review-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sa-diff-code-head{display:flex;align-items:center;gap:5px;padding:8px 16px;min-height:48px;border-bottom:1px solid var(--sa-review-border);background:#ffffff}
.sa-diff-code-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#344151}
.sa-diff-body{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;background:#ffffff}
.sa-diff-notice{padding:12px 16px;margin:0;color:var(--sa-review-muted);font-size:12px;line-height:1.7}.sa-diff-notice[role=alert]{color:#a12828;background:#fff7f7}
.sa-diff-lines{min-height:100%;font:13px/22px ui-monospace,SFMono-Regular,Menlo,monospace;tab-size:2;background:#ffffff}
.sa-diff-line{display:grid;grid-template-columns:34px 34px 18px minmax(0,1fr);min-width:0;white-space:pre}
.sa-diff-line>span{padding:0 4px}.sa-diff-code{white-space:pre-wrap;overflow-wrap:anywhere;min-width:0;padding-right:16px!important}
.sa-diff-lines[data-wrap=false]{min-width:max-content}.sa-diff-lines[data-wrap=false] .sa-diff-line{grid-template-columns:34px 34px 18px minmax(max-content,1fr)}.sa-diff-lines[data-wrap=false] .sa-diff-code{white-space:pre;overflow-wrap:normal}
.sa-diff-line[data-kind=add]{background:#edf8ef;border-left:2px solid #258044}.sa-diff-line[data-kind=remove]{background:#fff0f0;border-left:2px solid #b63838}.sa-diff-line[data-kind=same]{border-left:2px solid transparent}
.sa-diff-line-number{text-align:right;color:#647181;user-select:none;font-size:11px}.sa-diff-line-marker{user-select:none;color:#246c3b}.sa-diff-line[data-kind=remove] .sa-diff-line-marker{color:#a12828}
.sa-diff-hunk{padding:6px 16px;background:#f1f5fa;border-block:1px solid #e5eaf0;color:#53677e;font-size:11.5px;line-height:20px}
.sa-diff-gap{width:100%;display:block;min-height:32px;padding:5px 16px;border:0;border-block:1px solid #edf0f4;background:#f8fafc;color:#466382;text-align:left;font-size:12px}
.sa-syntax-keyword{color:#185a9d;font-weight:500}.sa-syntax-string{color:#80501c}.sa-syntax-comment{color:#607069;font-style:italic}.sa-syntax-number{color:#8b3266}
.sa-diff-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 16px;border-top:1px solid var(--sa-review-border);background:#f8fafc;font-size:11.5px;color:var(--sa-review-muted)}
.sa-diff-foot details{min-width:0}.sa-diff-foot summary{cursor:pointer}.sa-diff-foot p{max-width:440px;margin:6px 0 0;line-height:1.7}
.sa-diff-result{padding:12px 16px;background:#f4f8ff;font-size:12px;line-height:1.7;border-bottom:1px solid var(--sa-review-border)}
.sa-dialog-body.sa-diff-confirm{box-sizing:border-box;min-width:0;width:100%;max-width:100%;overflow-x:hidden}.sa-diff-confirm p{margin:0;line-height:1.7;overflow-wrap:anywhere}.sa-diff-confirm label{display:flex;align-items:flex-start;gap:8px;line-height:1.7}.sa-diff-confirm input{flex:none;margin:4px 0 0}
.sa-diff-confirm-files{display:flex;flex-direction:column;gap:10px;max-height:220px;overflow:auto}.sa-diff-confirm-file{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;min-width:0;font-size:12px}.sa-diff-confirm-file code{flex:1;min-width:0;overflow-wrap:anywhere}.sa-diff-confirm-file span{flex:none;color:#586472}
@container(max-width:520px){.sa-diff-head,.sa-diff-toolbar,.sa-diff-code-head{padding-inline:12px}.sa-diff-files{max-height:120px}.sa-diff-line{grid-template-columns:28px 28px 16px minmax(0,1fr)}.sa-diff-lines[data-wrap=false] .sa-diff-line{grid-template-columns:28px 28px 16px minmax(max-content,1fr)}}
.sa-branch-list{margin:0 0 8px}
.sa-branch-row{display:flex;align-items:center;gap:8px;padding:6px 0}
.sa-branch-row code{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media(max-width:760px){.sa-model-menu{width:100%}.sa-model-menu .sa-chip{max-width:calc(50% - 8px);flex:1}}
@media(max-width:680px){.sa-hero{font-size:22px;gap:8px}.sa-composer-seat{padding-left:16px;padding-right:16px}.sa-message-list{padding-left:20px;padding-right:20px}.sa-crumb{max-width:130px}}.sa-conversation-stats-bar{display:flex;align-items:center;justify-content:center;gap:16px;padding:3px 14px;margin:8px auto 0;flex-wrap:wrap;row-gap:4px;font-size:11.5px;color:#81858c;background:#ffffff;width:fit-content;max-width:100%}.sa-conversation-stats-bar .sa-stats-item{display:inline-flex;align-items:center;white-space:nowrap}.sa-permission-chip{display:inline-flex;align-items:center;font-size:12px;color:#61666b;background:#f1f3f5;border:0;border-radius:6px;padding:4px 8px;cursor:pointer}.sa-permission-chip:hover:not(:disabled){background:#e5e7eb;color:#0f1115}.sa-permission-chip svg{width:14px;height:14px;flex:none}.sa-composer-bar{flex-wrap:wrap}.sa-model-menu{min-width:0;max-width:100%}@container(max-width:550px){.sa-space-header{padding-inline:12px}.sa-composer-bar>:has(>.sa-model-menu){order:3;flex:1 1 calc(100% - 40px);max-width:calc(100% - 40px)}.sa-composer-bar>.sa-send{order:4}.sa-model-menu{width:100%}.sa-model-menu .sa-chip{min-width:0}.sa-composer-bar>.sa-send,.sa-composer-bar>button.sa-send{margin-left:auto}.sa-conversation-stats-bar{gap:8px;font-size:11px}}
${COMPOSER_CSS}`;
    function createSpaceView({ kernel, controller, services, ctx, Panel, SPACE_ID, primitives, directoryBrowser, ConversationTrace }) {
      const { React, h } = kernel;
      const { Button, Menu, Modal, Tooltip } = primitives;
      const PROCESS_KINDS = new Set(["thinking", "tool_call", "tool_result", "core", "compaction", "system"]);
      function groupChatRuns(messages, live = []) {
        const groups = [], byKey = new Map();
        const all = [...messages, ...live];
        for (const item of all) {
          if (!item || typeof item !== "object") continue;
          const runId = typeof item.runId === "string" ? item.runId : typeof item.input?.runId === "string" ? item.input.runId : null;
          const key = runId ? `run:${runId}` : `message:${item.messageId}`;
          let group = byKey.get(key);
          if (!group) {
            group = { key, runId, items: [], users: [], process: [], bodies: [], hasFinal: false };
            byKey.set(key, group);
            groups.push(group);
          }
          group.items.push(item);
          if (item.isFinal === true) group.hasFinal = true;
        }
        for (const group of groups) {
          const hasProcess = group.items.some(item => PROCESS_KINDS.has(item.kind));
          for (const item of group.items) {
            if (item.role === "user" || item.kind === "user") { group.users.push(item); continue; }
            if (PROCESS_KINDS.has(item.kind)) { group.process.push(item); continue; }
            if (item.role !== "assistant" && item.kind !== "assistant") { group.process.push(item); continue; }
            const text = typeof item.text === "string" ? item.text : (item.fragments || []).filter(fragment => fragment?.type === "text").map(fragment => fragment.text).join("");
            const asBody = item.live === true || item.isFinal === true || (!group.hasFinal && !hasProcess);
            const fragments = item.fragments || [];
            if (asBody) {
              for (const [index, fragment] of fragments.entries()) {
                if (fragment?.type !== "thinking" || typeof fragment.text !== "string" || !fragment.text) continue;
                group.process.push({ ...item, messageId: `${item.messageId}:thinking:${index}`, sourceMessageId: item.messageId,
                  kind: "thinking", role: "assistant", text: fragment.text, fragments: undefined, live: item.live === true });
              }
              if (text || item.isFinal === true || item.live === true) group.bodies.push(item);
              continue;
            }
            if (!fragments.length) {
              group.process.push({ ...item, processLabel: "思考与准备" });
              continue;
            }
            for (const [index, fragment] of fragments.entries()) {
              if ((fragment?.type !== "text" && fragment?.type !== "thinking") || typeof fragment.text !== "string" || !fragment.text) continue;
              group.process.push({ ...item, messageId: `${item.messageId}:${fragment.type}:${index}`, sourceMessageId: item.messageId,
                kind: fragment.type === "text" ? "assistant" : fragment.type, role: "assistant", text: fragment.text, fragments: undefined, live: item.live === true,
                ...(fragment.type === "text" ? { processLabel: "思考与准备" } : {}) });
            }
          }
        }
        return groups;
      }
      function latestModelAttempts(facts = []) {
        const phaseOrder = { requested: 0, started: 1, complete: 2, failed: 2, cancelled: 2, unknown: 2 };
        const rows = new Map();
        for (const fact of facts) {
          if (fact?.type !== "model_attempt") continue;
          const key = fact.attemptId || fact.factId;
          if (!key) continue;
          const group = rows.get(key) || [];
          group.push(fact);
          rows.set(key, group);
        }
        return [...rows.values()].map(group => [...group].sort((left, right) =>
          String(left.sourceRevision || "").localeCompare(String(right.sourceRevision || ""), undefined, { numeric: true }) ||
          String(left.occurredAt || "").localeCompare(String(right.occurredAt || "")) ||
          (phaseOrder[left.payload?.status] ?? -1) - (phaseOrder[right.payload?.status] ?? -1) ||
          String(left.factId || "").localeCompare(String(right.factId || ""))).at(-1)).filter(Boolean);
      }
      function composerMenuItems(page, { modelId, modelLabel, thinkingValue, model, running }) {
        if (page === "root") return [
          { id: "model", label: `模型 · ${modelLabel}` },
          { id: "thinking", label: `推理等级 · ${thinkingValue === "provider_default" ? "提供方默认" : thinkingValue}` },
        ];
        if (page === "model") {
          const items = [{ id: "__back__", label: "返回" }, { id: "__service_default__", label: "恢复当前默认值" }];
          for (const item of model?.items || []) items.push({ id: item.id, label: item.name || item.id, disabled: item.selectable === false });
          return items;
        }
        return [
          { id: "__back__", label: "返回" },
          { id: "provider_default", label: "提供方默认" },
          ...(model?.supportedThinkingLevels || []).map(level => ({ id: level, label: level === "off" ? "关闭" : level })),
          ...(running ? [{ id: "__pending_note__", label: "修改在当前任务终态后生效", disabled: true }] : []),
        ];
      }
      const useSpace = () => React.useSyncExternalStore(controller.subscribe, controller.getSnapshot);
      const deleted = s => s.thread?.deletedAt != null || s.threads.some(thread => thread.threadId === s.selected?.threadId && thread.deletedAt != null);
      const inline = text => String(text || "").split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g).map((part, index) => {
        if (part.startsWith("`") && part.endsWith("`")) return h("code", { key: index }, part.slice(1, -1));
        if (part.startsWith("**") && part.endsWith("**")) return h("strong", { key: index }, part.slice(2, -2));
        const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (link) { let safe = false; try { safe = ["http:", "https:", "mailto:"].includes(new URL(link[2]).protocol); } catch {} return safe ? h("a", { key: index, href: link[2], target: "_blank", rel: "noopener noreferrer" }, link[1]) : part; }
        return part;
      });
      function renderMarkdown(value) {
        const lines = String(value || "").split("\n"), blocks = [];
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index], fence = line.match(/^\s*```(.*)$/);
          if (fence) { const code = []; while (++index < lines.length && !/^\s*```/.test(lines[index])) code.push(lines[index]); blocks.push(h("pre", { key: blocks.length }, h("code", { "data-language": fence[1].trim() }, code.join("\n")))); continue; }
          if (line.includes("|") && /^\s*\|?\s*:?-+/.test(lines[index + 1] || "")) {
            const cells = text => text.trim().replace(/^\||\|$/g, "").split("|").map(cell => cell.trim());
            const headings = cells(line), rows = []; index++;
            while (index + 1 < lines.length && lines[index + 1].includes("|")) rows.push(cells(lines[++index]));
            blocks.push(h("div", { className: "sa-message-table", key: blocks.length }, h("table", null, h("thead", null, h("tr", null, ...headings.map((cell, i) => h("th", { key: i }, inline(cell))))), h("tbody", null, ...rows.map((row, i) => h("tr", { key: i }, ...row.map((cell, j) => h("td", { key: j }, inline(cell))))))))); continue;
          }
          const heading = line.match(/^(#{1,6})\s+(.+)$/);
          blocks.push(heading ? h(`h${heading[1].length}`, { key: blocks.length }, inline(heading[2])) : h("div", { key: blocks.length, style: { minHeight: line ? undefined : ".7em" } }, inline(line)));
        }
        return blocks;
      }
      const runStatusLabel = (task, thread) => {
        if (task?.status === "cancelling") return "停止处理中";
        if (task && ["completed", "failed", "cancelled"].includes(task.status)) return ({ completed: "已完成", failed: "失败", cancelled: "已取消" })[task.status];
        if (thread?.status === "paused_by_user" && task && !["completed", "failed", "cancelled"].includes(task.status)) return "已暂停";
        if (task?.status === "waiting" && ["permission", "file_input", "user"].includes(task.waitingFor)) return ({ permission: "等待审批", file_input: "等待补件", user: "等待回答" })[task.waitingFor];
        const reason = thread?.blockingReasons?.find(item => item.kind === "unknown_executions");
        if (reason) return "结果未知";
        return ({
          queued: "排队中",
          starting: "正在启动",
          running: "运行中",
          waiting: task?.waitingFor === "permission" ? "等待审批" : task?.waitingFor === "file_input" ? "等待补件" : task?.waitingFor === "user" ? "等待回答" : "等待用户",
          cancelling: "停止处理中",
          completed: "已完成",
          failed: "失败",
          cancelled: "已取消",
          unknown: "结果未知",
        })[task?.status] || (task ? "状态未知" : "尚未读取任务状态");
      };
      const messageText = message => typeof message.text === "string" && message.text.length
        ? message.text
        : (message.fragments || []).filter(item => item?.type === "text").map(item => item.text).join("");
      function toolDisplayName(name) {
        if (!name) return "工具调用";
        if (name === "read") return "读取文件";
        if (name === "write") return "写入文件";
        if (name === "edit") return "编辑文件";
        if (name === "bash") return "执行命令";
        if (name === "ls") return "列出文件";
        if (name === "find") return "查找文件";
        if (name === "grep") return "搜索内容";
        return name;
      }
      function toolDetail(toolCall) {
        if (!toolCall) return "";
        let args = toolCall.arguments;
        if (typeof args === "string") {
          try { args = JSON.parse(args); } catch {}
        }
        if (args && typeof args === "object") {
          return args.path || args.command || args.pattern || (typeof args === "string" ? args : "");
        }
        return typeof args === "string" ? args.slice(0, 80) : "";
      }
      function ProcessItem({ message }) {
        const content = messageText(message);
        if (message.kind === "thinking") {
          return h("li", { className: "sa-turn-step", "data-process-kind": "thinking" },
            h("span", { className: "sa-turn-step-icon", "data-kind": "thinking" },
              h("svg", { viewBox: "0 0 16 16", width: 11, height: 11, fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
                h("path", { d: "M8 1.8l1.5 3.6 3.7 1.7-3.7 1.7L8 12.4 6.5 8.8 2.8 7.1l3.7-1.7z" }))),
            h("div", { style: { flex: "1 1 auto", minWidth: 0 } },
              h("span", { className: "sa-turn-step-title" }, "思考"),
              content ? h("div", { className: "sa-thinking", style: { marginTop: 4 } }, renderMarkdown(content)) : null));
        }
        if (message.kind === "assistant") {
          return h("li", { className: "sa-turn-step", "data-process-kind": "assistant", "data-source-message-id": message.sourceMessageId || message.messageId },
            h("span", { className: "sa-turn-step-icon", "data-kind": "thinking" },
              h("svg", { viewBox: "0 0 16 16", width: 11, height: 11, fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
                h("path", { d: "M8 1.8l1.5 3.6 3.7 1.7-3.7 1.7L8 12.4 6.5 8.8 2.8 7.1l3.7-1.7z" }))),
            h("div", { style: { flex: "1 1 auto", minWidth: 0 } },
              h("span", { className: "sa-turn-step-title" }, message.processLabel || "中间说明"),
              content ? h("div", { style: { marginTop: 4 } }, renderMarkdown(content)) : null));
        }
        if (message.kind === "tool_call" || message.toolCall) {
          const detail = toolDetail(message.toolCall);
          return h("li", { className: "sa-turn-step", "data-process-kind": "tool_call" },
            h("span", { className: "sa-turn-step-icon", "data-kind": "tool" },
              h("svg", { viewBox: "0 0 16 16", width: 11, height: 11, fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
                h("path", { d: "M3 5.5l2.2 2.2L8 4.9M9 11.1l2.2 2.2 1.8-1.8" }))),
            h("div", { style: { flex: "1 1 auto", minWidth: 0, display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" } },
              h("span", { className: "sa-turn-step-title" }, toolDisplayName(message.toolCall?.name || message.toolName)),
              detail ? h("code", { className: "sa-turn-step-detail" }, detail) : null));
        }
        if (message.kind === "tool_result") {
          const isError = message.toolResult?.isError === true;
          return h("li", { className: "sa-turn-step", "data-process-kind": "tool_result", "data-tool-error": isError },
            h("span", { className: "sa-turn-step-icon", "data-kind": isError ? "error" : "tool" },
              h("svg", { viewBox: "0 0 16 16", width: 11, height: 11, fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
                isError ? h("path", { d: "M4 4l8 8M12 4l-8 8" }) : h("path", { d: "M3 5.5l2.2 2.2L8 4.9M9 11.1l2.2 2.2 1.8-1.8" }))),
            h("div", { style: { flex: "1 1 auto", minWidth: 0, display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" } },
              h("span", { className: "sa-turn-step-title", style: { color: isError ? "#ef4444" : "#0f1115", fontWeight: isError ? 600 : 400 } },
                isError ? "工具执行失败" : "工具结果"),
              content ? h("details", { className: "sa-tool-result" },
                h("summary", null, h("code", { className: "sa-turn-step-detail" }, content.split("\n")[0].replace(/版本[:：]\s*[a-f0-9]{16,}[;；]?\s*/gi, "").slice(0, 160))),
                h("pre", { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } }, content)) : null));
        }
        return h("li", { className: "sa-turn-step", "data-process-kind": message.kind || "message" },
          h("div", null, renderMarkdown(content)));
      }
      function TurnBlock({ status, processLabel, processMeta, steps = [], open, onToggle }) {
        const hasProcess = steps.length > 0;
        const running = status === "running";
        return h("div", { className: "sa-turn-block" },
          hasProcess && h("details", { open: Boolean(open), onToggle: e => onToggle(e.currentTarget.open) },
            h("summary", { className: "sa-turn-head" },
              h("span", { className: "sa-turn-pill", "data-open": Boolean(open) },
                h("svg", { viewBox: "0 0 16 16", width: 12, height: 12, fill: "none", stroke: "#81858c", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
                  h("path", { d: "M4 6.4L8 10.4l4-4" })),
                processLabel),
              running ? h("span", { className: "sa-turn-running-meta" },
                h("svg", { className: "ds-spin", viewBox: "0 0 16 16", width: 12, height: 12, fill: "none", stroke: "#81858c", strokeWidth: 1.8, strokeLinecap: "round", "aria-hidden": true },
                  h("path", { d: "M8 1.8a6.2 6.2 0 106.2 6.2" })),
                processMeta) : h("span", { className: "sa-turn-meta" }, processMeta)),
            h("ul", { className: "sa-turn-steps" },
              ...steps.map(message => h(ProcessItem, { key: message.messageId, message })))));
      }
      function ChangesCard({ s, runId, task, onOpenDiff }) {
        const [state, setState] = React.useState({ loading: false, data: null, error: "" });
        React.useEffect(() => {
          if (!task?.fileBinding || task?.status !== "completed") return undefined;
          let alive = true;
          setState({ loading: true, data: null, error: "" });
          void controller.loadRunDiff(runId).then(data => { if (alive) setState({ loading: false, data, error: "" }); })
            .catch(error => { if (alive) setState({ loading: false, data: null, error: error.message }); });
          return () => { alive = false; };
        }, [runId, task?.status, task?.fileBinding?.inputSnapshotId]);
        if (!task?.fileBinding || task?.status !== "completed") return null;
        if (state.error) return h("p", { className: "sa-muted", role: "alert" }, "文件改动读取失败", h("button", { className: "sa-chip", onClick: () => onOpenDiff(runId) }, "重试"));
        if (state.loading) return null;
        const files = state.data?.files || [];
        if (!files.length) return null;
        const additions = files.length && files.every(file => Number.isSafeInteger(file.additions)) ? files.reduce((sum, file) => sum + file.additions, 0) : null;
        const deletions = files.length && files.every(file => Number.isSafeInteger(file.deletions)) ? files.reduce((sum, file) => sum + file.deletions, 0) : null;
        return h("div", { className: "sa-changes-card", "aria-label": "任务文件改动" },
          h("div", { className: "sa-changes-head" },
            h("span", { className: "sa-changes-icon" },
              h("svg", { viewBox: "0 0 16 16", width: 16, height: 16, fill: "none", stroke: "#61666b", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
                h("path", { d: "M8 3.4v9.2M3.4 8h9.2" }))),
            h("div", { className: "sa-changes-info" },
              h("div", { className: "sa-changes-title" }, `已编辑 ${files.length} 个文件`),
              h("div", { className: "sa-changes-count" },
                h("span", { className: "sa-changes-add" }, additions == null ? "+?" : `+${additions}`),
                h("span", { className: "sa-changes-del" }, deletions == null ? "−?" : `−${deletions}`))),
            h("div", { className: "sa-changes-actions" },
              h("button", { type: "button", className: "sa-changes-btn", "aria-label": "查看文件改动", disabled: s.busy || deleted(s), onClick: () => onOpenDiff(runId) },
                h("svg", { viewBox: "0 0 16 16", width: 13, height: 13, fill: "none", stroke: "#81858c", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
                  h("path", { d: "M6.2 2.8L3.4 5.6a1.6 1.6 0 000 2.3l4.7 4.7a1.6 1.6 0 002.3 0l2.8-2.8a1.6 1.6 0 000-2.3L8.5 2.8a1.6 1.6 0 00-2.3 0z" })),
                "查看变更"))),
          files.length > 0 && h("div", { className: "sa-changes-files" },
            ...files.map(file => h("div", { className: "sa-changes-file", key: file.path },
              h("code", { className: "sa-changes-path" }, file.path),
              h("span", { className: "sa-changes-add" }, file.additions == null ? "+?" : `+${file.additions}`),
              h("span", { className: "sa-changes-del" }, file.deletions == null ? "−?" : `−${file.deletions}`))))
        );
      }
      function DiffPanel({ s, layout, expanded, onResize, onExpand }) {
        const selection = s.diffSelection, runId = selection.runId;
        const [state, setState] = React.useState({ loading: true, data: null, error: "", rollback: null, busy: false });
        const [confirming, setConfirming] = React.useState(false), [confirmed, setConfirmed] = React.useState(false);
        const [scope, setScope] = React.useState({ items: [], error: "", loading: true });
        const [wrap, setWrap] = React.useState(true), [gaps, setGaps] = React.useState({}), [menu, setMenu] = React.useState(false);
        const [dragging, setDragging] = React.useState(false), drag = React.useRef(null), panel = React.useRef(null);
        const task = (s.runDetails || []).find(run => run.runId === runId);
        const taskIndex = (s.thread?.runs || s.runDetails || []).filter(run => run.conversationId === s.selected?.conversationId).findIndex(run => run.runId === runId);
        const round = scope.items.find(item => item.runId === runId)?.round ?? (taskIndex < 0 ? null : taskIndex + 1);
        React.useEffect(() => {
          const previous = typeof document === "undefined" ? null : document.activeElement;
          panel.current?.focus();
          return () => { if (previous?.isConnected) previous.focus(); };
        }, []);
        const scopeResult = items => ({ items, error: items.some(item => item.error) ? "部分轮次的变更信息暂不可用" : "", loading: false });
        const readScope = () => controller.listDiffRuns().then(items => setScope(scopeResult(items)));
        React.useEffect(() => {
          let alive = true;
          void controller.listDiffRuns().then(items => { if (alive) setScope(scopeResult(items)); })
            .catch(error => { if (alive) setScope(current => ({ ...current, error: error.message, loading: false })); });
          return () => { alive = false; };
        }, [runId, s.targetId, s.selected?.conversationId]);
        React.useEffect(() => {
          let alive = true;
          setState(current => ({ ...current, loading: true, error: "", rollback: null, busy: false }));
          void controller.loadRunDiff(runId).then(data => { if (alive) setState({ loading: false, data, error: "", rollback: null, busy: false }); })
            .catch(error => { if (alive) setState({ loading: false, data: null, error: error.message, rollback: null, busy: false }); });
          return () => { alive = false; };
        }, [runId, task?.status]);
        const files = state.data?.files || [];
        const selected = files.find(file => file.path === selection.filePath) || files[0] || null;
        const selectedIndex = selected ? files.indexOf(selected) : -1;
        const additions = files.length && files.every(file => Number.isSafeInteger(file.additions)) ? files.reduce((sum, file) => sum + file.additions, 0) : null;
        const deletions = files.length && files.every(file => Number.isSafeInteger(file.deletions)) ? files.reduce((sum, file) => sum + file.deletions, 0) : null;
        const statusLabel = { available: "可查看", partial: "部分结果", binary: "二进制", expired: "内容过期", error: "读取失败" };
        const counts = (add, remove) => h("span", { className: "sa-diff-counts" }, h("span", { style: { color: "#246c3b" } }, add == null ? "+?" : `+${add}`), h("span", { style: { color: "#a12828" } }, remove == null ? "−?" : `−${remove}`));
        const rows = selected?.rows || [];
        const rowView = (row, index) => h("div", { role: "row", className: "sa-diff-line", "data-kind": row.kind, key: index },
          h("span", { role: "cell", className: "sa-diff-line-number" }, row.oldLine ?? ""),
          h("span", { role: "cell", className: "sa-diff-line-number" }, row.newLine ?? ""),
          h("span", { role: "cell", className: "sa-diff-line-marker" }, row.kind === "add" ? "+" : row.kind === "remove" ? "−" : " "),
          h("span", { role: "cell", className: "sa-diff-code" }, ...codeTokens(row.text, selected.path).map((token, at) => h("span", { key: at, className: `sa-syntax-${token.kind}` }, token.text))));
        const sections = diffSections(rows);
        const endDrag = event => {
          if (!drag.current || drag.current.pointerId !== event.pointerId) return;
          drag.current = null; setDragging(false);
          if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        };
        const rollback = async () => {
          if (!confirmed || state.busy) return;
          setState(current => ({ ...current, busy: true, error: "", rollback: null }));
          try {
            const result = await controller.rollbackRun(runId);
            const data = await controller.loadRunDiff(runId, { force: true });
            setState({ loading: false, data, error: "", rollback: result, busy: false });
            setConfirming(false); setConfirmed(false);
          } catch (error) { setState(current => ({ ...current, error: error.message, busy: false })); }
        };
        return h("section", { ref: panel, className: "sa-diff-panel", tabIndex: -1, "aria-label": "任务文件改动", "aria-busy": state.loading,
          onKeyDown: event => { if (event.key !== "Escape" || event.defaultPrevented || confirming || menu) return; event.preventDefault(); event.stopPropagation(); if (expanded) onExpand(); else controller.closeDiff(); } },
          !layout.full && h("div", { className: "sa-diff-resize", role: "separator", tabIndex: 0, "aria-label": "调整变更面板宽度", "aria-orientation": "vertical", "aria-valuemin": layout.min, "aria-valuemax": layout.max, "aria-valuenow": layout.width, "aria-valuetext": `${layout.width} 像素`, "data-dragging": dragging,
            onPointerDown: event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { pointerId: event.pointerId, x: event.clientX, width: layout.width }; setDragging(true); },
            onPointerMove: event => { if (drag.current?.pointerId === event.pointerId) onResize(Math.max(layout.min, Math.min(layout.max, drag.current.width + drag.current.x - event.clientX))); },
            onPointerUp: endDrag, onPointerCancel: endDrag, onLostPointerCapture: () => { drag.current = null; setDragging(false); },
            onKeyDown: event => { const width = { ArrowLeft: layout.width + 24, ArrowRight: layout.width - 24, Home: layout.min, End: layout.max }[event.key]; if (width == null) return; event.preventDefault(); onResize(Math.max(layout.min, Math.min(layout.max, width))); } }),
          h("header", { className: "sa-diff-head" },
            h("div", { className: "sa-diff-heading" }, h("h2", { className: "sa-diff-title" }, round == null ? "文件变更" : `第 ${round} 轮变更`), h("div", { className: "sa-diff-caption" }, "只读 · 本轮快照")),
            layout.max >= 380 && h("button", { type: "button", className: "sa-diff-tool", "aria-label": expanded ? "收起审阅" : "展开审阅", onClick: onExpand }, expanded ? "收起审阅" : "展开审阅"),
            h(Menu, { open: menu, onClose: () => setMenu(false), portal: true, align: "end", items: [{ id: "rollback", label: "撤销本轮全部改动", disabled: state.busy || deleted(s) || !files.length || files.every(file => ["error", "expired"].includes(file.status)) }],
              onSelect: id => { setMenu(false); if (id === "rollback") { setConfirmed(false); setConfirming(true); } },
              anchor: h("button", { type: "button", className: "sa-icon-button", "aria-label": "变更更多操作", "aria-haspopup": "menu", "aria-expanded": menu, onClick: () => setMenu(!menu) }, icon("IconEllipsisOutlineRegular")) }),
            h("button", { type: "button", className: "sa-icon-button", "aria-label": "关闭文件改动", onClick: () => controller.closeDiff() }, icon("IconCloseOutlineRegular"))),
          h("div", { className: "sa-diff-toolbar" },
            h("select", { className: "sa-diff-round", "aria-label": "变更轮次", value: runId, disabled: state.busy || scope.loading, onChange: event => { const next = event.target.value; void run(() => controller.openDiff(next)); } },
              !scope.items.some(item => item.runId === runId) && h("option", { value: runId }, round == null ? "当前任务" : `第 ${round} 轮`),
              ...scope.items.map(item => h("option", { value: item.runId, key: item.runId, disabled: Boolean(item.error) }, `${item.round == null ? "轮次未知" : `第 ${item.round} 轮`} · ${item.error ? "读取失败" : `${item.fileCount} 个文件`}`))),
            files.length > 0 && counts(additions, deletions),
            h("button", { type: "button", className: "sa-diff-tool", "aria-label": "自动换行", "aria-pressed": wrap, onClick: () => setWrap(!wrap) }, "自动换行")),
          scope.error && h("p", { className: "sa-diff-notice", role: "alert" }, "其他轮次读取失败：", scope.error, " ", h("button", { type: "button", className: "sa-diff-tool", onClick: () => void readScope().catch(error => setScope(current => ({ ...current, error: error.message }))) }, "重试")),
          files.length > 0 && h("nav", { className: "sa-diff-files", "aria-label": "改动文件" },
            ...files.map(file => h("button", { type: "button", className: "sa-diff-file", "data-selected": selected?.path === file.path, "aria-current": selected?.path === file.path ? "true" : undefined, title: file.path, disabled: state.busy,
              key: file.path, onClick: () => controller.selectDiffFile(file.path) },
              h("span", { className: "sa-diff-file-name" }, h("strong", null, basename(file.path)), file.path.includes("/") && h("small", null, file.path.slice(0, file.path.lastIndexOf("/")))),
              file.additions != null || file.deletions != null ? counts(file.additions, file.deletions) : h("span", { className: "sa-diff-caption" }, statusLabel[file.status] || "未知")))),
          selected && h("div", { className: "sa-diff-code-head" }, h("code", { className: "sa-diff-code-path", title: selected.path }, selected.path),
            h("span", { className: "sa-diff-caption" }, `${selectedIndex + 1} / ${files.length}`),
            h("button", { type: "button", className: "sa-diff-tool", "aria-label": "上一个文件", disabled: state.busy || selectedIndex <= 0, onClick: () => controller.selectDiffFile(files[selectedIndex - 1].path) }, "上一项"),
            h("button", { type: "button", className: "sa-diff-tool", "aria-label": "下一个文件", disabled: state.busy || selectedIndex >= files.length - 1, onClick: () => controller.selectDiffFile(files[selectedIndex + 1].path) }, "下一项")),
          h("div", { className: "sa-diff-body", key: selected?.path || "empty" },
            state.loading && h("p", { className: "sa-diff-notice", role: "status" }, "读取文件变更…"),
            state.error && h("p", { className: "sa-diff-notice", role: "alert" }, state.error, " ", h("button", { type: "button", className: "sa-diff-tool", onClick: () => void controller.loadRunDiff(runId, { force: true }).then(data => setState(current => ({ ...current, data, error: "", loading: false }))).catch(error => setState(current => ({ ...current, error: error.message }))) }, "重试读取")),
            !state.loading && !files.length && !state.error && h("p", { className: "sa-diff-notice", role: "status" }, "本轮没有文件变更。可切换到其他有变更的轮次。"),
            state.rollback && h("section", { className: "sa-diff-result", role: "status" }, h("strong", null, "撤销结果"),
              h("div", null, `成功 ${state.rollback.restoredCount} 个 · 冲突 ${state.rollback.conflictCount} 个 · 已恢复 ${state.rollback.alreadyRestoredCount} 个`),
              ...state.rollback.items.map(item => h("div", { key: item.path }, `${item.path} · ${{ restored: "已撤销", conflict: "版本冲突，保持现状", already_restored: "已恢复", failed: "失败" }[item.status] || "未知"}`))),
            selected?.error && h("p", { className: "sa-diff-notice", role: "alert" }, selected.error),
            selected?.binary && h("p", { className: "sa-diff-notice", role: "status" }, "二进制文件，无法展示文本差异。"),
            selected?.status === "partial" && h("p", { className: "sa-diff-notice", role: "status" }, "这里只展示已发布的部分结果，不代表任务成功。"),
            selected?.limited && h("p", { className: "sa-diff-notice", role: "status" }, "文件较大，仅展示部分内容，增删行数未知。"),
            selected && !selected.error && !selected.binary && !rows.length && h("p", { className: "sa-diff-notice" }, "此文件没有可展示的文本差异。"),
            selected && !selected.error && !selected.binary && rows.length > 0 && h("div", { className: "sa-diff-lines", role: "table", "aria-label": `${selected.path} 差异`, "data-wrap": wrap },
              ...sections.map(section => {
                const key = `${selected.path}:${section.start}`, open = gaps[key] === true;
                return h(React.Fragment, { key }, section.type === "hunk" ? h("div", { className: "sa-diff-hunk" }, section.heading)
                  : h("button", { type: "button", className: "sa-diff-gap", "aria-expanded": open, onClick: () => setGaps(current => ({ ...current, [key]: !open })) }, `${open ? "收起" : "展开"} ${section.end - section.start} 行未改动内容`),
                (section.type === "hunk" || open) && rows.slice(section.start, section.end).map((row, at) => rowView(row, section.start + at)));
              }))),
          h("footer", { className: "sa-diff-foot" }, h("details", null, h("summary", null, "快照说明"), h("p", null, "显示本轮修改前后的历史快照，不是文件当前内容。查看、切换和展开不会写入文件。")), h("span", null, "只读审阅")),
          confirming && h(Modal, { open: true, title: "撤销本轮全部改动", onClose: () => { if (!state.busy) setConfirming(false); }, closeLabel: "取消",
            footer: h("div", { className: "sa-dialog-footer" },
              h("button", { type: "button", className: "sa-chip", disabled: state.busy, onClick: () => setConfirming(false) }, "取消"),
              h("button", { type: "button", className: "sa-chip", disabled: !confirmed || state.busy, onClick: () => void rollback() }, state.busy ? "正在撤销…" : "确认撤销")) },
            h("div", { className: "sa-dialog-body sa-diff-confirm" },
              h("p", null, `将撤销${round == null ? "本轮" : `第 ${round} 轮`}对以下 ${files.length} 个文件的改动，不只是当前查看的文件。`),
              h("div", { className: "sa-diff-confirm-files" }, ...files.map(file => h("div", { key: file.path, className: "sa-diff-confirm-file" }, h("code", null, file.path), h("span", null, file.kind === "added" ? "移除本轮新增" : "恢复修改前版本")))),
              h("label", null, h("input", { type: "checkbox", checked: confirmed, onChange: event => setConfirmed(event.target.checked) }), h("span", null, "我确认撤销整轮改动；版本冲突的文件保持现状。")),
              h("p", null, "撤销会生成新的文件版本，不删除对话历史，也不会重新执行模型或工具。"))));
      }
      function BranchList({ s, onOpen, onLoad }) {
        const branches = s.branches || [];
        if (s.branchesLoaded && !branches.length && !s.branchError) return null;
        return h("details", { className: "sa-run-card sa-branch-list", "aria-label": "对话分支",
          onToggle: event => { if (event.currentTarget.open && !s.branchesLoaded && !s.branchLoading) onLoad(); } },
          h("summary", null, s.branchesLoaded ? `对话分支 · ${branches.length}` : s.branchLoading ? "读取对话分支…" : "对话分支 · 查找空分支"),
          s.branchError && h("p", { role: "alert", className: "sa-error" }, `分支读取失败：${s.branchError}`, h("button", { type: "button", className: "sa-chip", onClick: onLoad }, "重试")),
          s.branchesLoaded && !branches.length && !s.branchError && h("p", null, "当前 Thread 没有其他分支"),
          ...branches.map(branch => h("div", { className: "sa-branch-row", key: branch.conversationId },
            h("code", null, s.titles[branch.conversationId] || `分支 ${branch.conversationId.slice(-8)}`),
            branch.forkedFromConversationId && h("span", { className: "sa-muted" }, `来源 ${branch.forkedFromConversationId.slice(-8)}`),
            h("button", { type: "button", className: "sa-chip", "aria-label": `打开分支 ${branch.conversationId}`, onClick: () => onOpen(branch.conversationId) }, "打开"))),
          h("p", { className: "sa-muted" }, "消息分支只复制对话历史，不自动回滚文件。文件回滚需在对应 Run 的改动侧栏确认。"));
      }
      function MessageActions({ s, message, task, text, onEvent, onOpenDiff }) {
        const [copied, setCopied] = React.useState(false);
        const copy = async () => {
          try {
            if (primitives.writeClipboard) await primitives.writeClipboard(text || "");
            else await navigator.clipboard.writeText(text || "");
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch (e) { controller.reportError(`复制失败：${e.message}`); }
        };
        const tokens = s.runMetrics?.[task?.runId]?.tokens;
        const formatDuration = (ms) => {
          if (!Number.isFinite(ms) || ms < 0) return "";
          const totalSeconds = Math.floor(ms / 1000);
          const minutes = Math.floor(totalSeconds / 60);
          const seconds = totalSeconds % 60;
          return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
        };
        const timeStr = formatDuration(task?.elapsedMs) || "时间未知";
        const formatTokens = (tok) => {
          if (!Number.isFinite(tok) || tok < 0) return "未知";
          if (tok >= 1000000) return `${(tok / 1000000).toFixed(1)}M tok`;
          if (tok >= 1000) return `${(tok / 1000).toFixed(0)}K tok`;
          return `${tok} tok`;
        };
        const tokenStr = formatTokens(tokens);
        return h("div", { className: "sa-actions-bar" },
          h("button", { type: "button", className: "sa-icon-button", "aria-label": "复制回复正文", title: copied ? "已复制正文" : "复制回复正文", onClick: copy },
            h("svg", { viewBox: "0 0 16 16", width: 15, height: 15, fill: "none", stroke: "#81858c", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
              h("rect", { x: 5.4, y: 5.4, width: 7.4, height: 7.4, rx: 1.6 }),
              h("path", { d: "M10.6 5.4V4.2A1.2 1.2 0 009.4 3H4.2A1.2 1.2 0 003 4.2v5.2A1.2 1.2 0 004.2 10.6h1.2" }))),
          copied && h("span", { className: "sa-muted", role: "status" }, "已复制正文"),
          h("button", { type: "button", className: "sa-icon-button", "aria-label": "从此分支", disabled: s.busy || deleted(s) || !Number.isInteger(message?.entryId) || message?.live === true, title: "从此分支", onClick: () => void run(() => controller.fork(message)) },
            h("svg", { viewBox: "0 0 16 16", width: 15, height: 15, fill: "none", stroke: "#81858c", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
              h("circle", { cx: 4.6, cy: 3.6, r: 1.9 }), h("circle", { cx: 4.6, cy: 12.4, r: 1.9 }), h("circle", { cx: 11.4, cy: 8, r: 1.9 }),
              h("path", { d: "M4.6 5.5v5M6.4 8h3.1" }))),
          message?.runId && h("button", { type: "button", className: "sa-icon-button", "aria-label": "事件", title: "查看 Trace 事件", onClick: () => onEvent(message) },
            h("svg", { viewBox: "0 0 16 16", width: 15, height: 15, fill: "none", stroke: "#81858c", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
              h("path", { d: "M2.6 4.4h10.8M2.6 8h7.4M2.6 11.6h10.8" }))),
          h("span", { style: { flex: "1 1 auto" } }),
          tokenStr ? h("span", { className: "sa-actions-usage", "aria-label": "用量", style: { display: "inline-flex", alignItems: "center", color: "#81858c", fontSize: 13 } },
            h("svg", { viewBox: "0 0 16 16", width: 14, height: 14, fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", style: { marginRight: 4 }, "aria-hidden": true },
              h("ellipse", { cx: 8, cy: 3.9, rx: 5.4, ry: 2.3 }),
              h("path", { d: "M2.6 3.9v8.2c0 1.27 2.42 2.3 5.4 2.3s5.4-1.03 5.4-2.3V3.9" }),
              h("path", { d: "M2.6 8c0 1.27 2.42 2.3 5.4 2.3s5.4-1.03 5.4-2.3" })),
            `用量 ${tokenStr}`) : null,
          timeStr && h("span", { className: "sa-actions-time", style: { marginLeft: 12, color: "#81858c", fontSize: 13 } }, timeStr)
        );
      }
      function HistoryMaterials({ message, s }) {
        const [details, setDetails] = React.useState({});
        const load = async (material, key, preview = false, range) => {
          setDetails(current => ({ ...current, [key]: { ...current[key], loading: true, error: "" } }));
          try { const result = await controller.historyMaterialDetails(message, material, { preview, ...(range ? { range } : {}) }); setDetails(current => ({ ...current, [key]: { ...result, loading: false } })); }
          catch (error) { setDetails(current => ({ ...current, [key]: { loading: false, error: error.message } })); }
        };
        return h("div", { className: "sa-history-materials" },
          ...(message.materials || []).map((material, index) => {
            const key = `${material.attachmentId || material.snapshotId}:${material.path}:${index}`, detail = details[key];
            const current = material.kind === "skill" ? null : currentAttachmentState(material, s.contextError ? null : s.contextView?.currentAttachments);
            return h("details", { className: "sa-history-material", key, onToggle: event => { if (event.currentTarget.open && !details[key]) void load(material, key); } },
              h("summary", null, h("span", null, material.path || material.name || `附件 ${index + 1}`), h("small", null, material.kind === "skill" ? "本次 Skill · 已接收固定包" : `${attachmentModeLabel(material.mode || (material.kind === "image" ? "image" : "inline"))} · 已接收`)),
              h("div", { className: "sa-history-material-detail" },
                h("p", { className: "sa-muted" }, "原消息的固定内容。加入模型请求与实际读取范围以请求和 Trace 记录为准。"),
                h("p", null, `版本摘要：${material.contentHash || "历史记录缺少摘要"}`),
                current && h("section", { "aria-label": "附件当前上下文状态" }, h("p", { role: "status" }, current.label),
                  h("p", { className: "sa-muted" }, current.reason),
                  ...current.evidence.map((entry, at) => h("p", { key: at }, entry)),
                  s.contextView?.currentAttachments?.status === "available" && h("details", null, h("summary", null, "保留状态核对依据"),
                    h("p", null, `核对时间：${s.contextView.currentAttachments.asOf || "未知"}`),
                    h("p", null, `上下文版本：${s.contextView.currentAttachments.contextRevision || "未知"}`),
                    h("p", null, `压缩检查点：${s.contextView.currentAttachments.checkpointId || "无"}`))),
                material.range && h("p", null, `本次选定范围：${attachmentRangeLabel(material.range)}`),
                detail?.loading && h("p", { role: "status" }, "正在读取详情…"),
                detail?.evidence && h("div", null, h("p", null, `这次任务保留 ${detail.evidence.length} 条读取记录（不代表当前上下文仍包含原内容；部分范围不能视为整页或全文）`), ...detail.evidence.map((entry, at) => h("p", { key: entry.evidenceId || at }, `${entry.format === "image" ? "页面图片" : "文字"} · ${attachmentRangeLabel(entry.range)}`))),
                (detail?.error || detail?.contentError || detail?.evidenceError) && h("p", { className: "sa-attachment-error", role: "alert" }, detail.error || detail.contentError || detail.evidenceError),
                h("button", { type: "button", className: "sa-attachment-action", disabled: detail?.loading, onClick: () => void load(material, key, true) }, "预览原内容"),
                detail?.preview?.imageUrl && h("img", { className: "sa-attachment-preview-image", src: detail.preview.imageUrl, alt: material.path }),
                typeof detail?.preview?.text === "string" && h("pre", { className: "sa-attachment-preview-text" }, detail.preview.text),
                detail?.preview?.range && h("p", null, `本次预览返回：${attachmentRangeLabel(detail.preview.range)}`),
                detail?.preview?.next && h("div", null, h("p", { className: "sa-muted" }, `尚有内容未预览；继续范围：${attachmentRangeLabel(detail.preview.next)}`), h("button", { type: "button", className: "sa-attachment-action", disabled: detail.loading, onClick: () => void load(material, key, true, detail.preview.next) }, "继续预览")),
                ...(detail?.preview?.images || []).map(image => h("figure", { key: image.page }, h("img", { className: "sa-attachment-preview-image", src: `data:${image.mediaType};base64,${image.data}`, alt: `第 ${image.page} 页` }), h("figcaption", null, `第 ${image.page} 页`)))));
          }),
          !(message.materials || []).some(item => item.kind === "skill") && (message.selectedSkillIds || []).length > 0 && h("p", { className: "sa-muted" }, `本次已选 Skill：${message.selectedSkillIds.map(id => id.split("@")[0]).join("、")}；固定版本见任务详情。`));
      }
      function ChatRunGroup({ s, group, processOpen, onProcessToggle, onEvent, onOpenDiff }) {
        const detailed = s.runDetails?.find(item => item.runId === group.runId);
        const task = detailed || s.thread?.runs?.find(item => item.runId === group.runId);
        const active = task?.status && ["queued", "starting", "running", "waiting", "cancelling"].includes(task.status);
        const hasFinal = group.bodies.some(m => m.isFinal === true);
        const status = active ? "running" : settled(task) ? "done" : "unknown";
        const processLabel = active ? runStatusLabel(task, s.thread) : task?.status === "failed" ? "任务失败 · 查看过程" : task?.status === "cancelled" ? "已停止 · 查看过程" : "查看过程";
        const processMeta = active && !hasFinal
          ? `已处理 ${group.process.length} 步`
          : `${group.process.length} 个步骤${task?.elapsedMs ? ` · ${(task.elapsedMs / 1000).toFixed(1)} 秒` : ""}`;

        return h("section", { className: "sa-reply-group", "data-run-id": group.runId || "unattributed", "aria-label": group.runId ? `任务 ${group.runId} 回复组` : "未归属消息" },
          ...group.users.map(message => h("div", { className: "sa-message-user-wrap", key: message.messageId },
            h("article", { className: "sa-message", "data-role": "user" },
              renderMarkdown(messageText(message)), h(HistoryMaterials, { message, s })))),
          group.process.length > 0 && h(TurnBlock, {
            status,
            processLabel,
            processMeta,
            steps: group.process,
            open: processOpen,
            onToggle: onProcessToggle,
          }),
          group.process.length === 0 && (active || ["failed", "cancelled"].includes(task?.status)) &&
            h("p", { className: "sa-muted", role: "status" }, task?.status === "cancelled" ? "已停止" : runStatusLabel(task, s.thread)),
          group.bodies.map(message => h("article", { className: `sa-message ${message.live ? "sa-streaming" : ""}`, "data-role": message.role || "assistant", "data-final": message.isFinal === true, key: message.messageId },
            renderMarkdown(messageText(message)),
            !message.live && h(MessageActions, { s, message, task, text: messageText(message), onEvent, onOpenDiff }))),
          !active && task?.status === "completed" && detailed && h(ChangesCard, { s, runId: group.runId, task: detailed, onOpenDiff }));
      }

      const basename = root => root.split("/").filter(Boolean).pop() || root;
      const title = (s, thread) => thread.title || s.titles[thread.mainConversationId] || "未命名会话";
      const icon = name => h(primitives[name], { "aria-hidden": true });
      const run = fn => Promise.resolve().then(fn).catch(controller.reportError);
      const iconButton = (name, label, onClick, extra = {}) => h(Tooltip, { label, delayMs: 500, portal: true },
        h("button", { type: "button", className: "sa-icon-button", "aria-label": label, onClick, ...extra }, icon(name)));
      function Choice({ label, value, items, onSelect, children, disabled, className = "", side = "bottom" }) {
        const [open, setOpen] = React.useState(false);
        return h(Menu, { open, onClose: () => setOpen(false), items, selectedId: value, portal: true, side, align: "start",
          onSelect: id => { setOpen(false); void run(() => onSelect(id)); },
          anchor: h("button", { type: "button", className: `sa-chip ${className}`, "aria-label": label, "aria-haspopup": "menu", "aria-expanded": open,
            disabled, onClick: () => setOpen(!open) }, children, icon("IconChevronDownOutlineRegular")) });
      }
      function WorkspaceDialog() {
        const s = useSpace(), [path, setPath] = React.useState(""), [error, setError] = React.useState("");
        const [selected, setSelected] = React.useState(null), generation = React.useRef(0);
        const location = s.managedWorkspaceLocation, busy = s.workspaceLoading || s.workspaceOpening;
        const pending = s.workspaceRequest, locked = Boolean(pending);
        const valid = Boolean(path.trim()) && !path.startsWith("/") && !path.startsWith("~") && !/^[A-Za-z]:/.test(path) && !path.includes("\\") && !path.includes("\0") && path.split("/").every(part => part && !part.startsWith("."));
        const browse = async destination => {
          const at = generation.current; setError("");
          try {
            const result = await controller.browseManagedWorkspace(destination);
            if (at === generation.current && result) { setPath(result.relativePath); setSelected(null); }
          } catch (failure) { if (at === generation.current) setError(failure.message); }
        };
        React.useEffect(() => {
          generation.current++;
          if (s.workspaceForm) {
            setError(""); setSelected(null); setPath(s.workspaceRequest?.relativePath || "");
            const at = generation.current;
            void controller.browseManagedWorkspace("").catch(failure => { if (at === generation.current) setError(failure.message); });
          }
          return () => { generation.current++; };
        }, [s.workspaceForm, s.targetId]);
        const close = () => { if (!s.workspaceOpening) controller.setWorkspaceForm(false); };
        const submit = async () => {
          const at = generation.current; setError("");
          try { await controller.openManagedWorkspace(path); }
          catch (failure) { if (at === generation.current) setError(failure.message); }
        };
        const preview = location && valid ? `${location.baseRoot.replace(/\/$/, "")}/${path}` : location?.baseRoot;
        const parent = location?.relativePath?.split("/").slice(0, -1).join("/") || "";
        return h(Modal, { open: s.workspaceForm, onClose: close, closeLabel: "取消", title: "当前 Core 工作区",
          footer: h("div", { className: "sa-dialog-footer sa-workspace-dialog-footer" }, h(Button, { variant: "outline", disabled: s.workspaceOpening, onClick: close }, "取消"),
            h(Button, { variant: "primary", disabled: busy || !valid || !location, onClick: () => void submit() }, s.workspaceOpening ? "正在创建／打开…" : locked ? "重试确认原请求" : "创建／打开")) },
          h("form", { className: "sa-dialog-body sa-workspace-dialog-body", onSubmit: e => { e.preventDefault(); if (!busy && !locked) void browse(path); } },
            h("p", { className: "sa-muted" }, `Core 目标：${s.coreTargetLabel || s.targetId || "当前 Core"} · 实例 ${location?.instanceId || s.coreInstanceId || (location?.connectionKind === "uds" ? "UDS 兼容连接（未提供实例标识）" : "正在读取")}`),
            h("p", { className: "sa-muted", style: { overflowWrap: "anywhere" } }, "工作区根目录：", h("code", null, location?.baseRoot || "正在读取当前 Core 的工作区根目录…")),
            h("label", null, "相对目录", h("input", { id: "sa-workspace-path", className: "sa-dialog-input", "aria-label": "Core 工作区相对目录", placeholder: "项目名 或 team/project", autoFocus: true,
              value: path, disabled: busy || locked, onChange: e => { setPath(e.target.value); setSelected(null); setError(""); },
              onKeyDown: e => { if (e.key === "Enter" && !e.nativeEvent?.isComposing) { e.preventDefault(); if (!busy && !locked) void browse(path); } } })),
            h("p", { className: "sa-muted", style: { overflowWrap: "anywhere" } }, "Core 中的目录：", h("code", null, valid ? preview || "等待 Core 返回根目录" : "请输入有效的相对目录")),
            h("div", { className: "sa-directory-toolbar" }, iconButton("IconChevronUpOutlineRegular", "上一级", () => void browse(parent), { disabled: busy || locked || !location?.relativePath }),
              h("button", { type: "button", className: "sa-chip", disabled: busy || locked, onClick: () => void browse("") }, "工作区根目录"),
              h("button", { type: "button", className: "sa-chip", disabled: busy || locked, onClick: () => void browse(path) }, "浏览相对目录")),
            h("div", { className: "sa-directory-browser", "aria-label": "当前 Core 目录列表" }, s.workspaceLoading ? h("p", { className: "sa-muted" }, "正在读取 Core 目录…") :
              (location?.directories || []).map(entry => h("button", { key: entry.relativePath, type: "button", className: "sa-row", "data-selected": selected === entry.relativePath, disabled: busy || locked,
                onClick: () => { setSelected(entry.relativePath); setPath(entry.relativePath); }, onDoubleClick: () => void browse(entry.relativePath), onKeyDown: e => { if (e.key === "ArrowRight") void browse(entry.relativePath); } },
                icon("IconFolderCloseRegular"), h("span", { className: "sa-row-title" }, entry.name), entry.workspaceId && h("span", { className: "sa-muted" }, "已注册")))),
            location?.truncated && h("p", { className: "sa-muted" }, `目录较多，仅显示前 ${location.directories.length} 项，请输入相对目录继续浏览。`),
            h("p", { className: "sa-muted" }, locked ? `原请求 ${pending.requestId} 的结果尚未确认。重试沿用原目录和原请求；取消不会撤销 Core 已完成的创建。` : "浏览和取消不会创建目录。点击“创建／打开”后，当前 Core 创建缺失目录并注册工作区；成功后才选中。"),
            (error || s.workspaceError) && h("div", { role: "alert", className: "sa-muted" }, error || s.workspaceError)));
      }
      function DeleteThreadDialog({ s, thread, open, close }) {
        const [busy, setBusy] = React.useState(false), [error, setError] = React.useState("");
        return h(Modal, { open, title: "删除对话", closeLabel: "取消", onClose: () => { if (!busy) close(); },
          description: "删除此会话及其全部分支后无法恢复。请先结束运行、等待或排队中的任务。",
          footer: h("div", { className: "sa-dialog-footer" }, h(Button, { variant: "outline", disabled: busy, onClick: close }, "取消"),
            h(Button, { variant: "primary", disabled: busy || s.busy, onClick: async () => { setBusy(true); setError(""); try { await controller.deleteThread(thread.threadId); close(); } catch (failure) { setError(failure.message); } finally { setBusy(false); } } }, busy ? "删除中…" : "删除")) },
          h("p", { className: "sa-muted" }, "不会删除本机项目文件。"),
          error && h("p", { role: "alert" }, error));
      }
      function ThreadRow({ s, thread }) {
        const [menu, setMenu] = React.useState(false), [rename, setRename] = React.useState(false), [name, setName] = React.useState(title(s, thread)), [renameRevision, setRenameRevision] = React.useState(undefined);
        const [removing, setRemoving] = React.useState(false);
        const select = () => void run(() => controller.selectThread(thread.threadId, thread.mainConversationId));
        const save = () => void run(async () => { await controller.renameThread({ ...thread, ...(renameRevision === undefined ? {} : { controlRevision: renameRevision }) }, name); setRename(false); });
        return h(React.Fragment, null,
          h("div", { className: "sa-row sa-session-row", role: "button", tabIndex: 0, "aria-label": title(s, thread), "data-selected": s.selected?.threadId === thread.threadId,
            draggable: true, onDragStart: e => e.dataTransfer.setData("application/x-super-agent-thread", thread.threadId),
            onDragOver: e => { if ([...e.dataTransfer.types].includes("application/x-super-agent-thread")) e.preventDefault(); },
            onDrop: e => { const from = e.dataTransfer.getData("application/x-super-agent-thread"); if (!from || from === thread.threadId || !s.threads.some(t => t.threadId === from)) return;
              e.preventDefault(); const order = s.threads.slice().sort((a, b) => a.manualOrder - b.manualOrder).map(t => t.threadId).filter(id => id !== from);
              order.splice(order.indexOf(thread.threadId), 0, from); controller.setManualThreadOrder(order); controller.setViewOptions({ threadOrder: "manual" }); },
            onClick: select, onKeyDown: e => { if (e.target === e.currentTarget && ["Enter", " "].includes(e.key)) { e.preventDefault(); select(); } } },
            thread.pinned && icon("IconPinFillRegular"), h("span", { className: "sa-row-title" }, title(s, thread)),
            h("span", { className: "sa-row-actions", onClick: e => e.stopPropagation() },
              h(Menu, { open: menu, onClose: () => setMenu(false), portal: true, align: "end", items: [
                { id: "pin", label: thread.pinned ? "取消置顶" : "置顶", icon: icon("IconPinOutlineRegular") },
                { id: "rename", label: "重命名", icon: icon("IconEditOutlineRegular") },
                { id: "delete", label: "删除" }],
                onSelect: id => { setMenu(false); if (id === "rename") { void run(async () => { const current = await controller.getThread(thread.threadId); setName(current.title || title(s, thread)); setRenameRevision(current.controlRevision); setRename(true); }); }
                  else if (id === "pin") void run(() => controller.pinThread(thread.threadId, !thread.pinned));
                  else if (id === "delete") setRemoving(true); },
                anchor: iconButton("IconEllipsisOutlineRegular", "会话菜单", () => setMenu(!menu)) }))),
          h(Modal, { open: rename, onClose: () => setRename(false), closeLabel: "取消", title: "重命名会话",
            footer: h("div", { className: "sa-dialog-footer" }, h(Button, { variant: "outline", onClick: () => setRename(false) }, "取消"), h(Button, { variant: "primary", disabled: !name.trim(), onClick: save }, "保存")) },
            h("input", { className: "sa-dialog-input", value: name, "aria-label": "会话名称", autoFocus: true, onChange: e => setName(e.target.value), onKeyDown: e => { if (e.key === "Enter" && name.trim() && !e.nativeEvent?.isComposing) save(); } })),
          h(DeleteThreadDialog, { s, thread, open: removing, close: () => setRemoving(false) }));
      }
      function FolderRow({ d, collapsed, onToggle, busy, selected }) {
        const [menu, setMenu] = React.useState(false), [dialog, setDialog] = React.useState(null), [name, setName] = React.useState(d.title || basename(d.root)), [error, setError] = React.useState("");
        const label = d.title || basename(d.root);
        const apply = async () => { try { if (dialog === "rename") controller.renameWorkspace(d.root, name); else await controller.removeWorkspace(d.root); setDialog(null); } catch (e) { setError(e.message); } };
        return h(React.Fragment, null,
          h("div", { className: "sa-row", role: "button", tabIndex: 0, "aria-label": label, "aria-expanded": !collapsed, title: d.root,
            onClick: onToggle, onKeyDown: e => { if (e.target === e.currentTarget && ["Enter", " "].includes(e.key)) { e.preventDefault(); onToggle(); } } },
            h("span", { className: "sa-folder-glyph", "data-selected": selected }, icon(collapsed ? "IconFolderCloseRegular" : "IconFolderOpenRegular")), h("span", { className: "sa-row-title" }, label),
            h("span", { className: "sa-row-actions", onClick: e => e.stopPropagation() },
              iconButton("IconNewChatOutlineRegular", `在 ${label} 新建会话`, () => controller.newConversation(d.root), { disabled: busy }),
              h(Menu, { open: menu, onClose: () => setMenu(false), portal: true, align: "end", items: [
                { id: "new", label: "新建会话", icon: icon("IconNewChatOutlineRegular") }, { id: "rename", label: "重命名工作区" }, { id: "remove", label: "删除工作区" }],
                onSelect: id => { setMenu(false); if (id === "new") controller.newConversation(d.root); else { setName(label); setError(""); setDialog(id); } },
                anchor: iconButton("IconEllipsisOutlineRegular", `工作区 ${label} 的操作`, () => setMenu(!menu)) }))),
          h(Modal, { open: !!dialog, onClose: () => setDialog(null), closeLabel: "取消", title: dialog === "rename" ? "重命名工作区" : "删除工作区",
            description: dialog === "remove" ? `将把“${label}”从工作区列表中移除。文件夹与会话记录会保留，其会话将显示在“未分组”下。` : undefined,
            footer: h("div", { className: "sa-dialog-footer" }, h(Button, { variant: "outline", onClick: () => setDialog(null) }, "取消"),
              h(Button, { variant: "primary", disabled: dialog === "rename" && !name.trim(), onClick: apply }, dialog === "rename" ? "保存" : "删除工作区")) },
            dialog === "rename" && h("input", { className: "sa-dialog-input", "aria-label": "工作区名称", value: name, autoFocus: true, onChange: e => setName(e.target.value), onKeyDown: e => { if (e.key === "Enter" && !e.nativeEvent?.isComposing) apply(); } }),
            error && h("p", { className: "sa-muted", role: "alert" }, error)));
      }
      function DirectorySection() {
        const s = useSpace(), [collapsed, setCollapsed] = React.useState({}), [search, setSearch] = React.useState(false), [query, setQuery] = React.useState("");
        const [folded, setFolded] = React.useState(false), [optionsOpen, setOptionsOpen] = React.useState(false);
        const options = s.viewOptions || { grouping: "group", threadOrder: "updated", archiveFilter: "hide" };
        const threads = s.threads.filter(t => t.deletedAt == null && title(s, t).toLowerCase().includes(query.toLowerCase()))
          .slice().sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (options.threadOrder === "updated" ? String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")) : (a.manualOrder || 0) - (b.manualOrder || 0)));
        const ungrouped = threads.filter(t => !s.directories.some(d => d.root === t.conversation?.config?.cwd));
        return h("section", { className: "sa-workspaces", "aria-label": "Super Agent 工作区", "data-super-agent-workspaces": true }, h("style", null, CSS),
          h("div", { className: "sa-section-head" }, h("button", { type: "button", className: "sa-section-toggle", "aria-label": `${folded ? "展开" : "收起"} Super Agent 工作区`, "aria-expanded": !folded, onClick: () => setFolded(!folded) },
            icon(folded ? "IconChevronRightOutlineRegular" : "IconChevronDownOutlineRegular"), h("span", { className: "sa-section-label" }, "Super Agent 工作区")),
            iconButton("IconSearchOutlineRegular", "搜索 Super Agent 会话", () => { setSearch(!search); setQuery(""); }),
            h(Menu, { open: optionsOpen, onClose: () => setOptionsOpen(false), portal: true, align: "end", items: [
              { id: "group", label: "按工作区", checked: options.grouping === "group" }, { id: "flat", label: "单列表", checked: options.grouping === "flat" },
              { id: "updated", label: "最近更新", checked: options.threadOrder === "updated" }, { id: "manual", label: "手动排序", checked: options.threadOrder === "manual" }],
              onSelect: id => { setOptionsOpen(false); controller.setViewOptions(["group", "flat"].includes(id) ? { grouping: id } : { threadOrder: id }); },
              anchor: iconButton("IconSlidersTwoOutlineRegular", "Super Agent 视图选项", () => setOptionsOpen(!optionsOpen)) }),
            iconButton("IconProjectAddOutlineRegular", "添加 Super Agent 目录", () => controller.setWorkspaceForm(true))),
          !folded && h("div", { className: "sa-workspace-list" },
          search && h("input", { className: "sa-search", type: "search", "aria-label": "搜索 Super Agent 会话", placeholder: "搜索会话", autoFocus: true, value: query, onChange: e => setQuery(e.target.value) }),
          options.grouping === "flat" ? threads.map(t => h(ThreadRow, { key: t.threadId, s, thread: t })) : s.directories.map(d => h("div", { key: d.root },
            h(FolderRow, { d, selected: d.root === s.root, collapsed: collapsed[d.root], onToggle: () => setCollapsed({ ...collapsed, [d.root]: !collapsed[d.root] }), busy: s.busy }),
            !collapsed[d.root] && !s.selected && s.root === d.root && !query && h("div", { className: "sa-row sa-session-row", role: "button", tabIndex: 0, "data-selected": true,
              onClick: () => ctx.layout.selectPanel(SPACE_ID), onKeyDown: e => { if (e.key === "Enter") ctx.layout.selectPanel(SPACE_ID); } }, h("span", { className: "sa-row-title" }, "新会话")),
            !collapsed[d.root] && threads.filter(t => t.conversation?.config?.cwd === d.root).map(t => h(ThreadRow, { key: t.threadId, s, thread: t })))),
          options.grouping !== "flat" && ungrouped.length > 0 && h("div", null, h("div", { className: "sa-row" }, icon("IconFolderCloseRegular"), "未分组"), ...ungrouped.map(t => h(ThreadRow, { key: t.threadId, s, thread: t }))),
          !s.directories.length && h("div", { className: "sa-directory-empty sa-muted" }, "可直接纯文本聊天，也可添加工作区使用文件工具")), h(WorkspaceDialog));
      }
      const attachmentModeLabel = mode => ({ inline: "全文加入", range: "所选范围加入", on_demand: "按需读取", image: "图片交给模型查看", auto: "发送前由服务预检" })[mode] || "准备中";
      const attachmentStatusLabel = status => ({ preparing: "准备中", uploading: "上传中", parsing: "解析中", ready: "可发送", failed: "准备失败", duplicate: "重复内容", expired: "已过期" })[status] || "结果待确认";
      const formatBytes = size => Number.isFinite(size) ? size < 1024 ? `${size} B` : size < 1048576 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1048576).toFixed(1)} MiB` : "大小未知";
      function ProjectFilePicker({ s, close }) {
        const [snapshots, setSnapshots] = React.useState([]), [snapshot, setSnapshot] = React.useState(null), [projectFiles, setProjectFiles] = React.useState(null), [query, setQuery] = React.useState(""), [busy, setBusy] = React.useState(true), [error, setError] = React.useState("");
        const choose = async value => { setBusy(true); setError(""); try { setSnapshot(await controller.resource("files.snapshot", { snapshotId: value })); } catch (failure) { setError(failure.message); } finally { setBusy(false); } };
        React.useEffect(() => { let alive = true; void (async () => {
          try {
            const capabilities = await controller.loadAttachmentCapabilities();
            if (capabilities.projectFiles) {
              const listed = await controller.resource("attachments.projectFiles", { root: s.root });
              if (!Array.isArray(listed?.items)) throw new Error("项目文件目录暂不可用，请重试");
              if (alive) { setProjectFiles(listed.items.map(file => ({ ...file, projectPath: true }))); if (listed.truncated) setError("项目文件较多，当前显示部分文件；请缩小搜索范围。"); }
              return;
            }
            const workspace = s.fileSelection?.workspaceId ? { workspaceId: s.fileSelection.workspaceId } : await controller.resource("workspace.find", { root: s.root });
            if (!workspace?.workspaceId) throw new Error("当前项目尚未提供文件选择能力。请从本机添加所需文件；执行分支保持原样。");
            const versions = await controller.resource("files.snapshots", { workspaceId: workspace.workspaceId });
            if (!alive) return; setSnapshots(versions.items || []);
            const first = (versions.items || [])[0];
            if (first) await choose(first.snapshotId);
            else setError("当前项目尚无可引用内容。请从本机选择所需文件，系统会自动准备附件。");
          } catch (failure) { if (alive) setError(failure.message); }
          finally { if (alive) setBusy(false); }
        })(); return () => { alive = false; }; }, [s.targetId, s.root]);
        const add = async file => { setBusy(true); setError(""); try { await controller.addProjectFile(snapshot, file); } catch (failure) { setError(failure.message); } finally { setBusy(false); } };
        return h(Modal, { open: true, title: "引用项目文件", onClose: close, closeLabel: "关闭", footer: h(Button, { onClick: close }, "完成") },
          h("div", { className: "sa-dialog-body sa-attachment-dialog" },
            h("p", { className: "sa-muted" }, `项目：${basename(s.root)} · 引用不会更改执行分支`),
            snapshots.length > 1 && h("label", null, "项目版本", h("select", { className: "sa-dialog-input", value: snapshot?.snapshotId || "", onChange: event => void choose(event.target.value) }, ...snapshots.map((item, index) => h("option", { key: item.snapshotId, value: item.snapshotId }, index === 0 ? "最近可用内容" : `历史内容 ${index + 1}`)))),
            h("input", { className: "sa-dialog-input", "aria-label": "搜索项目文件", placeholder: "搜索文件名", value: query, onChange: event => setQuery(event.target.value) }),
            busy && h("p", { role: "status", className: "sa-muted" }, "正在读取项目内容…"),
            ...(projectFiles || snapshot?.manifest?.files || []).filter(file => file.path.toLowerCase().includes(query.toLowerCase())).map(file => h("div", { key: file.path, className: "sa-project-file" }, h("span", { title: file.path }, file.path, h("small", { className: "sa-muted" }, formatBytes(file.size))), h(Button, { disabled: busy, onClick: () => void add(file), "aria-label": `引用 ${file.path}` }, "添加"))),
            error && h("p", { role: "alert", className: "sa-attachment-error" }, error)));
      }
      function SkillPicker({ s, close }) {
        const [busy, setBusy] = React.useState(true), [query, setQuery] = React.useState("");
        React.useEffect(() => { let alive = true; void controller.loadSkillCatalog().catch(() => {}).finally(() => { if (alive) setBusy(false); }); return () => { alive = false; }; }, [s.targetId, s.root, s.selected?.conversationId]);
        const items = (s.skillCatalog || []).filter(item => `${item.name} ${item.description || ""}`.toLowerCase().includes(query.toLowerCase()));
        return h(Modal, { open: true, title: "选择本次任务使用的 Skill", onClose: close, closeLabel: "关闭", footer: h(Button, { onClick: close }, "完成选择") },
          h("div", { className: "sa-dialog-body sa-attachment-dialog" },
            h("input", { className: "sa-dialog-input", "aria-label": "搜索可用 Skill", placeholder: "按名称或用途搜索", value: query, onChange: event => setQuery(event.target.value) }),
            h("p", { className: "sa-muted" }, `本次已选 ${(s.selectedSkillIds || []).length} 个 · 仅选择已导入的 Skill`),
            busy && h("p", { role: "status" }, "正在读取可用目录…"),
            !busy && !s.skillCatalogError && !(s.skillCatalog || []).length && h("p", { className: "sa-muted" }, "尚无可用 Skill。请在设置 → Skill 中导入。"),
            ...items.map(skill => h("div", { key: skillCatalogRowKey(skill) }, h("label", { className: "sa-skill-option" },
              h("input", { type: "checkbox", "aria-label": `本次使用 ${skill.name}`, checked: skillChoiceState(skill, s).checked, disabled: !["available", "enabled"].includes(skill.status), onChange: event => controller.selectSkill(skill, event.target.checked) }),
              h("span", null, h("strong", null, skill.name), h("small", null, skill.description || "暂无用途说明"), h("small", { className: "sa-muted" }, `${skill.scope === "workspace" ? "Workspace" : "全局"}${skill.overridesSourceIds?.length ? ` · 覆盖 ${skill.overridesSourceIds.length} 个全局来源` : ""}${skill.status !== "available" && skill.status !== "enabled" ? ` · ${skill.reason || "当前不可用"}` : ""}`))),
              h("details", null, h("summary", { style: { minHeight: "44px", display: "flex", alignItems: "center", cursor: "pointer" } }, `${skill.name} 来源与本次版本`),
                h("p", null, `采用目录：${skill.path || "当前服务未提供目录"}`),
                h("p", null, `完整包摘要：${skill.packageHash || skill.hash || "当前服务未提供摘要"}`),
                h("p", null, `采用版本：${skill.version || skill.snapshotId || "由服务校验"}`),
                h("p", { className: "sa-muted" }, "目录可用不表示本次已选；仅勾选后，发送时才加入本次任务。")),
              skillChoiceState(skill, s).needsConfirmation && h("div", null, h("p", { role: "alert", className: "sa-attachment-error" }, "已选版本或作用范围已变化。原选择已保留，请确认采用此版本或移除原标签。"), h(Button, { onClick: () => controller.selectSkill(skill, true) }, `确认改用此版本 ${skill.name}`)))),
            s.skillCatalogError && h("p", { className: "sa-attachment-error", role: "alert" }, s.skillCatalogError)));
      }
      function AttachmentPreview({ card, close }) {
        const [result, setResult] = React.useState(null), [error, setError] = React.useState("");
        React.useEffect(() => { let alive = true; void controller.attachmentPreview(card.id).then(value => { if (alive) setResult(value); }, failure => { if (alive) setError(failure.message); }); return () => { alive = false; }; }, [card.id]);
        return h(Modal, { open: true, title: card.name, onClose: close, closeLabel: "关闭", footer: h(Button, { onClick: close }, "返回草稿") },
          h("div", { className: "sa-dialog-body sa-attachment-dialog" },
            !result && !error && h("p", { role: "status" }, "正在读取附件…"),
            result?.imageUrl && h("img", { className: "sa-attachment-preview-image", src: result.imageUrl, alt: card.name }),
            (typeof result?.text === "string" || typeof result?.content === "string") && h("pre", { className: "sa-attachment-preview-text" }, result.text ?? result.content),
            (result?.images || []).map(image => h("figure", { key: image.page }, h("img", { className: "sa-attachment-preview-image", src: `data:${image.mediaType};base64,${image.data}`, alt: `第 ${image.page} 页` }), h("figcaption", null, `第 ${image.page} 页`))),
            ...(result?.warnings || []).map((warning, index) => h("p", { key: index, className: "sa-muted" }, warning)),
            error && h("p", { className: "sa-attachment-error", role: "alert" }, error)));
      }
      function DraftAttachments({ s }) {
        const [expanded, setExpanded] = React.useState(false), [preview, setPreview] = React.useState(null), retryFile = React.useRef(null), retryId = React.useRef(null);
        const cards = s.attachments || [], skills = s.selectedSkills || [], visible = expanded ? cards : cards.slice(0, 4);
        const retry = async card => { const result = await controller.retryAttachment(card.id); if (result?.needsFile) { retryId.current = card.id; retryFile.current?.click(); } };
        return h(React.Fragment, null,
          h("input", { ref: retryFile, type: "file", hidden: true, "aria-label": "重新选择原附件", onChange: event => { const file = event.target.files?.[0]; if (file && retryId.current) void run(() => controller.retryAttachment(retryId.current, file)); event.target.value = ""; } }),
          (cards.length > 0 || (s.materials || []).length > 0 || (s.selectedSkillIds || []).length > 0) && h("div", { className: "sa-draft-materials", "aria-label": "本次附件与 Skill", "aria-live": "polite" },
            ...visible.map((card, index) => h("div", { key: card.id, className: "sa-attachment-card", "data-state": card.status, role: "group", "aria-label": `附件 ${card.name}`, "aria-describedby": card.error ? `attachment-error-${card.id}` : undefined },
              h("button", { type: "button", className: "sa-attachment-card-open", disabled: card.status !== "ready", onClick: () => setPreview(card), "aria-label": `预览 ${card.name}`, title: card.name },
                card.thumbnailUrl ? h("img", { src: card.thumbnailUrl, alt: "", className: "sa-attachment-thumb" }) : h("span", { className: "sa-attachment-file-icon", "aria-hidden": true }, card.kind === "image" ? "▧" : "▤"),
                h("span", { className: "sa-attachment-card-copy" }, h("strong", null, card.name, cards.some(item => item.id !== card.id && item.name === card.name) && ` (${index + 1})`), h("small", null, `${formatBytes(card.size)} · ${attachmentStatusLabel(card.status)}`), card.status === "ready" && h("small", { className: "sa-muted" }, attachmentModeLabel(card.mode)))),
              h("button", { type: "button", className: "sa-attachment-remove", "aria-label": `移除 ${card.name}`, onClick: () => void run(() => controller.removeAttachment(card.id)) }, "×"),
              card.mediaType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" && h("p", { className: "sa-muted", style: { width: "100%", margin: 0, padding: "0 10px 8px" } }, "仅文字与表格；内嵌图片和版式未读取"),
              card.error && h("div", { className: "sa-attachment-card-error", role: "alert", id: `attachment-error-${card.id}` }, card.error, card.status !== "duplicate" && h("button", { type: "button", className: "sa-attachment-action", onClick: () => void run(() => retry(card)) }, "重试")))),
            cards.length > 4 && h("button", { type: "button", className: "sa-attachment-action", "aria-expanded": expanded, onClick: () => setExpanded(!expanded) }, expanded ? "收起附件" : `另有 ${cards.length - 4} 项`),
            ...(s.materials || []).map((item, index) => h("div", { className: "sa-skill-tag", key: `legacy:${index}`, title: item.path }, h("span", null, item.path), h("button", { type: "button", "aria-label": `移除 ${item.path}`, onClick: () => controller.setMaterials(s.materials.filter((_, at) => at !== index)) }, "×"))),
            ...(s.selectedSkillIds || []).map(id => h("div", { className: "sa-skill-tag", key: id }, h("span", null, skills.find(skill => skill.skillId === id)?.name || id.split("@")[0]), h("button", { type: "button", "aria-label": `取消选择 ${skills.find(skill => skill.skillId === id)?.name || id}`, onClick: () => controller.selectSkill(skills.find(skill => skill.skillId === id) || { skillId: id }, false) }, "×")))),
          preview && h(AttachmentPreview, { card: preview, close: () => setPreview(null) }));
      }
      function ContextPreview({ s, close }) {
        const [error, setError] = React.useState(""), [ranges, setRanges] = React.useState({});
        const recheck = async (action = () => controller.previewInput()) => { setError(""); try { await action(); } catch (failure) { if (failure.code !== "PREVIEW_SUPERSEDED") setError(failure.message); } };
        React.useEffect(() => { void recheck(); }, [s.targetId, s.selected?.conversationId]);
        const plan = s.inputPreview;
        const updateMode = (card, mode) => void recheck(() => controller.updateAttachmentMode(card.id, { mode }));
        return h(Modal, { open: true, title: "本次上下文", onClose: close, closeLabel: "关闭", footer: h(Button, { disabled: s.previewLoading, onClick: () => void recheck() }, "重新检查") },
          h("div", { className: "sa-dialog-body sa-attachment-dialog" },
            h("p", { className: "sa-muted" }, `${s.coreTargetLabel || "当前 Core"} · ${s.delivery === "next_turn" ? "补充指定任务" : "新任务 / 排队任务"}`),
            s.previewLoading && h("p", { role: "status" }, "正在重新计算上下文…"),
            !plan && !s.previewLoading && h("p", { role: "status" }, "草稿或配置已变化，请重新检查后发送。"),
            plan && h("p", null, `实际目标模型：${plan.targetModel || plan.modelId || "由服务确定"}`),
            plan?.notice && h("p", { className: "sa-muted" }, plan.notice),
            Number.isFinite(plan?.estimatedTokens) && h("p", null, `整体预计占用 ${plan.estimatedTokens} token（估算，不是计费用量）`),
            plan?.estimatorSource && h("p", { className: "sa-muted" }, `估算依据：${plan.estimatorSource}`),
            ...(s.attachments || []).map(card => h("div", { key: card.id, className: "sa-context-item" }, h("strong", null, card.name), h("span", { className: "sa-muted" }, `${attachmentModeLabel(plan?.items?.find(item => item.attachmentId === card.attachmentId)?.mode || card.mode)}${card.pageCount ? ` · ${card.pageCount} 页` : ""}`),
              card.ref && h("label", null, "加入方式", h("select", { className: "sa-dialog-input", "aria-label": `${card.name} 加入方式`, value: card.mode, onChange: event => updateMode(card, event.target.value) }, h("option", { value: "auto", disabled: true }, "由服务选择默认方式"), ...((card.kind === "image" ? [["image", "图片交给模型查看"]] : [["inline", "全文加入"], ["on_demand", "按需读取"], ["range", "所选范围加入"]])).map(([value, label]) => h("option", { key: value, value }, label)))),
              card.ref && card.mediaType === "application/pdf" && h("label", null, "读取格式", h("select", { className: "sa-dialog-input", "aria-label": `${card.name} 读取格式`, value: card.ref.format || "default", onChange: event => { const format = event.target.value; const representation = card.representations?.find(item => item.format === format && item.status === "available"); if (!representation) { setError("当前格式不可用，请选择另一格式或更换模型"); return; } void recheck(() => controller.updateAttachmentMode(card.id, { mode: card.ref.mode || "on_demand", format, representationId: representation.representationId })); } }, h("option", { value: "default", disabled: true }, "按目标模型预检"), h("option", { value: "image", disabled: !card.representations?.some(item => item.format === "image" && item.status === "available") }, "页面图片（需要视觉模型）"), h("option", { value: "text", disabled: !card.representations?.some(item => item.format === "text" && item.status === "available") }, "提取文字（不含图表/扫描内容）"))),
              card.ref && card.mode === "range" && h("p", { className: "sa-muted" }, card.mediaType === "application/pdf" ? "位置单位：页码" : card.kind === "document" ? "位置单位：段落或表格；不使用 Word 页码" : "位置单位：行号"),
              card.ref && card.mode === "range" && h("div", { className: "sa-range-controls" }, h("label", null, "起始位置", h("input", { type: "number", min: 1, className: "sa-dialog-input", value: ranges[card.id]?.start ?? card.ref?.range?.start ?? "", onChange: event => setRanges(current => ({ ...current, [card.id]: { ...current[card.id], start: event.target.value } })) })), h("label", null, "结束位置", h("input", { type: "number", min: 1, className: "sa-dialog-input", value: ranges[card.id]?.end ?? card.ref?.range?.end ?? "", onChange: event => setRanges(current => ({ ...current, [card.id]: { ...current[card.id], end: event.target.value } })) })), h(Button, { onClick: () => { const start = Number(ranges[card.id]?.start ?? card.ref?.range?.start), end = Number(ranges[card.id]?.end ?? card.ref?.range?.end); if (!Number.isInteger(start) || start < 1 || !Number.isInteger(end) || end < start) { setError("请输入有效的起止范围"); return; } void recheck(() => controller.updateAttachmentMode(card.id, { mode: "range", range: { start, end } })); } }, "检查范围")),
              ...(card.warnings || []).map((warning, index) => h("p", { key: index, className: "sa-muted" }, typeof warning === "string" ? warning : warning.message)))),
            ...(plan?.items || []).map((item, index) => h("p", { key: `plan:${index}`, className: item.error ? "sa-attachment-error" : "sa-muted" }, `${item.name || item.attachmentId || `附件 ${index + 1}`} · ${attachmentModeLabel(item.mode)}${item.range ? ` · 范围 ${attachmentRangeLabel(item.range)}` : ""}${Number.isFinite(item.estimatedTokens) ? ` · 预计 ${item.estimatedTokens} token` : ""}${item.error ? ` · ${item.error.message || item.error}` : ""}`)),
            ...(s.selectedSkills || []).filter(skill => (s.selectedSkillIds || []).includes(skill.skillId)).map(skill => h("p", { key: skill.skillId, className: "sa-muted" }, `Skill：${skill.name} · ${skill.scope === "workspace" ? "Workspace" : "全局"} · 本次所选版本 ${(skill.packageHash || skill.hash)?.slice(0, 10) || "由服务校验"}`)),
            ...(plan?.issues || []).map((issue, index) => h("p", { key: `issue:${index}`, role: "alert", className: "sa-attachment-error" }, issue.message || String(issue))),
            (error || s.previewError) && h("p", { role: "alert", className: "sa-attachment-error" }, error || s.previewError)));
      }
      function ComposerMenu({ s, modelId, model, thinkingValue, running, disabled }) {
        const [open, setOpen] = React.useState(false), [page, setPage] = React.useState("root"), [localError, setLocalError] = React.useState("");
        const items = composerMenuItems(page, { modelId, modelLabel: model?.name || modelId || "选择模型", thinkingValue, model: { items: s.models, supportedThinkingLevels: model?.supportedThinkingLevels }, running });
        const close = () => { setOpen(false); setPage("root"); setLocalError(""); };
        const select = async id => {
          if (id === "__back__") { setPage("root"); return; }
          if (page === "root" && (id === "model" || id === "thinking")) { setPage(id); return; }
          if (id === "__pending_note__") return;
          setLocalError("");
          try {
            if (id === "__service_default__") await controller.restoreServiceDefaults();
            else if (page === "model") await controller.setModel(id);
            else await controller.setThinking(id);
            close();
          } catch (error) { setLocalError(error.message); }
        };
        return h(React.Fragment, null,
          h(Menu, { open, onClose: close, items, selectedId: page === "root" ? null : modelId, portal: true, side: "top", align: "end",
            onSelect: id => void select(id),
            anchor: h("span", { className: "sa-model-menu", role: "group", "aria-label": "Super Agent 模型与推理等级" },
              h("button", { type: "button", className: "sa-chip", "aria-label": "Super Agent 模型", "aria-haspopup": "menu", "aria-expanded": open,
                disabled, onClick: () => { if (open) close(); else { setPage("root"); setOpen(true); } } }, model?.name || modelId || "选择模型", icon("IconChevronDownOutlineRegular")),
              h("span", { className: "sa-model-separator", "aria-hidden": true }, "·"),
              h("button", { type: "button", className: "sa-chip", "aria-label": "Super Agent 思考等级", "aria-haspopup": "menu", "aria-expanded": open,
                disabled: disabled || !modelId, onClick: () => { if (open) close(); else { setPage("root"); setOpen(true); } } }, thinkingValue === "provider_default" ? "提供方默认" : thinkingValue, icon("IconChevronDownOutlineRegular"))) }),
          localError && h("span", { className: "sa-muted", role: "alert" }, localError));
      }
      function PermissionMenu({ s, disabled }) {
        const [open, setOpen] = React.useState(false);
        const cfg = s.conversation?.pendingConfig?.config || s.conversation?.config;
        const currentMode = cfg?.permissionSource === "service_default" ? "service_default" : cfg?.permissionMode || s.permissionMode || "service_default";
        const items = [
          { id: "approve_none", label: "完全权限" },
          { id: "workspace_auto", label: "工作区自动" },
          { id: "approve_all", label: "逐项审批" },
          { id: "service_default", label: "继承服务默认" },
        ];
        const modeLabels = {
          approve_none: "完全权限",
          workspace_auto: "工作区自动",
          approve_all: "逐项审批",
          service_default: "继承默认",
        };
        return h(Menu, {
          open,
          onClose: () => setOpen(false),
          items,
          selectedId: currentMode,
          portal: true,
          side: "top",
          align: "start",
          onSelect: id => {
            setOpen(false);
            void run(() => controller.setPermissionMode(id));
          },
          anchor: h("button", {
            type: "button",
            className: "sa-permission-chip",
            "aria-label": "对话审批覆盖",
            "aria-haspopup": "menu",
            "aria-expanded": open,
            disabled,
            onClick: () => setOpen(!open),
          },
            h("svg", { viewBox: "0 0 16 16", width: 13, height: 13, fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", style: { marginRight: 4, verticalAlign: "middle" }, "aria-hidden": true },
              h("path", { d: "M8 1.8l5 2v4.5c0 3.7-2.7 6.1-5 6.7-2.3-.6-5-3-5-6.7V3.8l5-2z" })),
            modeLabels[currentMode] || "完全权限",
            h("span", { style: { marginLeft: 4, display: "inline-flex" } }, icon("IconChevronDownOutlineRegular"))
          ),
        });
      }
      const settled = task => ["completed", "failed", "cancelled"].includes(task?.status);
      function metricsFromTrace(trace) {
        const attempts = latestModelAttempts(trace?.facts);
        const sum = field => attempts.length > 0 && attempts.every(f => Number.isFinite(f.payload?.usage?.[field]))
          ? attempts.reduce((n, f) => n + f.payload.usage[field], 0) : null;
        const input = sum("inputTokens"), output = sum("outputTokens"), cacheRead = sum("cacheReadTokens"), cacheWrite = sum("cacheWriteTokens");
        const durations = attempts.map(f => f.payload?.durationMs);
        const modelMs = durations.length > 0 && durations.every(Number.isFinite) ? durations.reduce((a, b) => a + b, 0) : null;
        const tokens = [input, output, cacheRead, cacheWrite].every(Number.isFinite) ? input + output + cacheRead + cacheWrite : null;
        const steps = new Set((trace?.facts || []).filter(f => f.type === "tool_invocation").map(f => f.payload?.logicalInvocationId || f.executionId || f.toolCallId || f.factId)).size;
        return { tokens, input, output, cacheRead, cacheWrite, modelMs, steps, partial: trace?.coverage?.state !== "complete" };
      }
      const metricCache = new Map();
      function useRunMetrics(s) {
        const [state, setState] = React.useState({ scope: "", values: {} });
        const scope = `${s.targetId}:${s.selected?.conversationId}`;
        const tasks = (s.runDetails || []).filter(settled);
        const signature = JSON.stringify(tasks.map(t => [t.runId, t.status, t.updatedAt]));
        React.useEffect(() => {
          if (!services.observations?.trace) return undefined;
          let alive = true;
          void Promise.all(tasks.map(async task => {
            const key = `${scope}:${task.runId}:${task.updatedAt}`;
            if (!metricCache.has(key)) metricCache.set(key, services.observations.trace(task.runId).then(trace => {
              if (trace.runId !== task.runId || trace.conversationId !== s.selected?.conversationId) throw new Error("用量响应不属于当前任务");
              const metrics = metricsFromTrace(trace);
              if (metrics.partial || metrics.tokens === null) metricCache.delete(key);
              return metrics;
            }).catch(() => { metricCache.delete(key); return null; }));
            return [task.runId, await metricCache.get(key)];
          })).then(rows => { if (alive) setState({ scope, values: Object.fromEntries(rows) }); });
          return () => { alive = false; };
        }, [scope, signature, s.messages.length]);
        return state.scope === scope ? state.values : {};
      }
      const formatTokens = value => !Number.isFinite(value) ? "未知" : value >= 1e6 ? `${(value / 1e6).toFixed(1)}M tok` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}K tok` : `${value} tok`;
      function ConversationStatsBar({ s }) {
        const tasks = (s.runDetails || []).filter(settled);
        const context = React.useRef({ scope: null, estimate: null });
        const scope = `${s.targetId}:${s.selected?.conversationId}`;
        if (context.current.scope !== scope) context.current = { scope, estimate: null };
        const request = s.contextView?.lastRequest;
        if (tasks.some(task => task.runId === request?.runId)) context.current.estimate = request?.estimate || null;
        if (!tasks.length) return null;
        const rows = tasks.map(task => s.runMetrics?.[task.runId]);
        const sum = field => rows.every(row => Number.isFinite(row?.[field])) ? rows.reduce((n, row) => n + row[field], 0) : null;
        const tokens = sum("tokens"), output = sum("output"), modelMs = sum("modelMs"), input = sum("input"), cacheRead = sum("cacheRead"), cacheWrite = sum("cacheWrite"), steps = sum("steps");
        const speed = Number.isFinite(output) && modelMs > 0 ? `${Math.round(output * 1000 / modelMs)} tok/s` : "速率未知";
        const prompt = [input, cacheRead, cacheWrite].every(Number.isFinite) ? input + cacheRead + cacheWrite : null;
        const cache = prompt > 0 ? `${Math.round(cacheRead * 100 / prompt)}%` : "未知";
        const estimate = context.current.estimate;
        const percent = estimate?.contextWindow > 0 && Number.isFinite(estimate.inputTokens) ? `${Math.round(estimate.inputTokens * 100 / estimate.contextWindow)}%` : "未知";
        const partial = rows.some(row => !row || row.partial);
        return h("div", { className: "sa-conversation-stats-bar", "aria-label": "对话运行统计", title: "累计已结束任务；步骤为工具调用数；速率为输出 token / 模型调用总时间；上下文占比为最近已结束任务的估计值。" },
          h("span", { className: "sa-stats-item" }, `${tasks.length} 轮 ${steps ?? "未知"} 步 · ${speed}`),
          h("span", { className: "sa-stats-item" }, `${partial ? "已知用量 " : ""}${formatTokens(tokens)} · 缓存命中 ${cache}`),
          h("span", { className: "sa-stats-item" }, `上下文 ${percent}`));
      }
      function GoalCard({ s }) {
        const [increase, setIncrease] = React.useState(""), [objective, setObjective] = React.useState("");
        const goal = s.goal;
        if (!goal) return null;
        const labels = { running: "持续推进", waiting: "等待中", pausing: "正在暂停", paused: "已暂停", blocked: "已阻塞", exhausted: "预算或限制已耗尽", draining: "正在结束", completed: "已完成", cancelled: "已取消", failed: "失败" };
        const terminal = ["completed", "cancelled", "failed"].includes(goal.status), stopping = ["pausing", "draining"].includes(goal.status);
        const busy = s.goalBusy || s.busy, number = value => Number.isSafeInteger(value) ? value.toLocaleString("zh-CN") : "尚未确认";
        const budget = goal.budget || {}, progress = goal.checkpoint || {};
        const remaining = [goal.limits?.totalTokens, budget.settledTokens, budget.reservedTokens].every(Number.isSafeInteger) ? Math.max(0, goal.limits.totalTokens - budget.settledTokens - budget.reservedTokens) : null;
        return h("section", { className: "sa-run-card sa-goal-card", "aria-label": "持续目标", "data-goal-id": goal.goalId },
          h("strong", null, `目标 · ${labels[goal.status] || goal.status}`),
          h("p", { style: { whiteSpace: "pre-wrap" } }, goal.objective),
          h("p", { className: "sa-muted" }, `推进 ${number(goal.iteration)} · 阶段 ${{ execute: "执行", assess: "评估", verify: "完成审核", idle: "空闲" }[goal.phase] || "未知"} · 修订 ${goal.revision}`),
          h("p", null, `累计 token ${number(budget.settledTokens)} / ${number(goal.limits?.totalTokens)}；预留 ${number(budget.reservedTokens)}；未确认占用 ${number(budget.uncertainTokens)}；可用 ${number(remaining)}${budget.estimatedTokens !== undefined ? `；含估算 ${number(budget.estimatedTokens)} token` : ""}`),
          progress.nextStep && h("p", null, `下一步：${progress.nextStep}`),
          (progress.completedItems || []).length > 0 && h("details", null, h("summary", null, "已完成项"), h("ul", null, ...progress.completedItems.map((item, index) => h("li", { key: index }, item)))),
          (progress.remainingItems || []).length > 0 && h("details", null, h("summary", null, "待完成项"), h("ul", null, ...progress.remainingItems.map((item, index) => h("li", { key: index }, item)))),
          h("p", { className: "sa-muted" }, `模型请求 ${number(budget.modelRequests)} · 活跃时长 ${Number.isFinite(budget.activeElapsedMs) ? Math.round(budget.activeElapsedMs / 1000) + " 秒" : "尚未确认"}`),
          goal.currentRunId && h("p", { className: "sa-muted" }, `当前任务：${goal.currentRunId}`),
          goal.reason && h("p", { role: "status" }, `原因：${typeof goal.reason === "string" ? goal.reason : goal.reason.message || goal.reason.code || "请查看目标状态"}`),
          h("div", { style: { display: "flex", flexWrap: "wrap", gap: 8 } },
            !terminal && !stopping && ["running", "waiting"].includes(goal.status) && h("button", { type: "button", className: "sa-chip", disabled: busy, onClick: () => void run(() => controller.controlGoal("pause")) }, "暂停目标"),
            !terminal && ["paused", "blocked", "exhausted"].includes(goal.status) && h("button", { type: "button", className: "sa-chip", disabled: busy, onClick: () => void run(() => controller.controlGoal("resume")) }, "恢复目标"),
            !terminal && !stopping && h("button", { type: "button", className: "sa-chip", disabled: busy, onClick: () => void run(() => controller.controlGoal("cancel")) }, "取消目标"),
            h("button", { type: "button", className: "sa-chip", disabled: busy, onClick: () => void controller.refresh() }, "刷新目标")),
          !terminal && h("details", null, h("summary", null, "调整目标与预算"),
            h("p", { className: "sa-muted" }, "提高累计预算后，使用“恢复目标”继续。修改目标需先暂停；原有用量不会清零。"),
            h("label", null, "增加 token 预算", h("input", { type: "text", inputMode: "numeric", value: increase, disabled: busy, onChange: event => setIncrease(event.target.value) })),
            h("button", { type: "button", className: "sa-chip", disabled: busy || !increase, onClick: () => void run(async () => { await controller.increaseGoalBudget(increase); setIncrease(""); }) }, "提高预算"),
            h("label", null, "新的目标说明", h("textarea", { value: objective, disabled: busy || !["paused", "blocked", "exhausted"].includes(goal.status), onChange: event => setObjective(event.target.value) })),
            h("button", { type: "button", className: "sa-chip", disabled: busy || !objective.trim() || !["paused", "blocked", "exhausted"].includes(goal.status), onClick: () => void run(async () => { await controller.updateGoalObjective(objective); setObjective(""); }) }, "保存目标说明")),
          ...(controller.pendingGoalOperations?.() || []).map(record => h("p", { key: record.payload.requestId }, `原操作待确认：${record.action} · ${record.payload.goalId}`, h("button", { type: "button", className: "sa-chip", disabled: busy, onClick: () => void run(() => controller.retryGoalOperation(record.payload.requestId)) }, "重试原目标操作"))));
      }
      function Composer({ s }) {
        const input = React.useRef(null), files = React.useRef(null), attachButton = React.useRef(null), skillButton = React.useRef(null), contextButton = React.useRef(null), [attachmentMenu, setAttachmentMenu] = React.useState(false), [projectPicker, setProjectPicker] = React.useState(false), [skillPicker, setSkillPicker] = React.useState(false), [contextPreview, setContextPreview] = React.useState(false), [dragging, setDragging] = React.useState(false), [selection, setSelection] = React.useState(null);
        React.useEffect(() => { const pending = controller.loadAttachmentCapabilities?.(); pending?.catch(() => {}); }, [s.targetId, s.coreInstanceId]);
        React.useEffect(() => { if (input.current) { input.current.style.height = "auto"; input.current.style.height = `${Math.min(240, Math.max(s.selected ? 48 : 52, input.current.scrollHeight))}px`; } }, [s.draft, s.selected]);
        const config = s.conversation?.config || services.viewState.get?.().snapshot?.config || s.threads.find(t => t.threadId === s.selected?.threadId)?.conversation?.config;
        const chosen = s.conversation?.pendingConfig?.config || config;
        const modelId = s.selected ? chosen?.modelId || s.modelId : s.modelId;
        const model = s.models.find(m => m.id === modelId);
        const running = (s.runDetails || s.thread?.runs || []).some(task => task.conversationId === s.selected?.conversationId && ["queued", "starting", "running", "waiting", "cancelling"].includes(task.status));
        const thinkingLevel = s.selected ? chosen?.thinkingLevel ?? null : s.thinkingLevel ?? null;
        const thinkingValue = thinkingLevel || "provider_default";
        const activeRuns = (s.runDetails || s.thread?.runs || []).filter(task => task.conversationId === s.selected?.conversationId && ["starting", "running", "waiting"].includes(task.status));
        const retained = (s.attachments || []).length + (s.materials || []).length, blocked = (s.attachments || []).some(item => item.status !== "ready") || (s.attachmentRemovals || []).length > 0, unsupported = s.attachmentCapabilities?.supported === false;
        const disabled = s.busy || s.goalBusy || deleted(s), closeTo = ref => () => { setProjectPicker(false); setSkillPicker(false); setContextPreview(false); ref.current?.focus(); };
        const addFiles = selected => { if (!disabled && selected?.length) void run(() => controller.addMessageFiles(selected)); };
        const chooseFiles = () => { setAttachmentMenu(false); files.current?.click(); };
        const readSelection = event => { const start = event.target.selectionStart, end = event.target.selectionEnd; setSelection(end > start ? { start, end } : null); };
        return h("div", { className: "sa-composer-seat" },
          s.goalsSupported && !s.goal && h("p", { className: "sa-muted" }, "持续目标：/goal 目标说明 --budget token数量"),
          s.goalError && h("p", { className: "sa-composer-warning", role: "alert" }, s.goalError),
          s.goalNotice && h("p", { className: "sa-muted", role: "status" }, s.goalNotice),
          s.goal && !["completed", "cancelled", "failed"].includes(s.goal.status) && h("div", { className: "sa-workspace-picker" }, h(Choice, { label: "目标期间的输入用途", value: s.goalInputMode || "message", items: [{ id: "message", label: "发送新任务并暂停目标" }, { id: "steer", label: "补充当前目标" }], onSelect: value => controller.setGoalInputMode(value) }, s.goalInputMode === "steer" ? "补充当前目标" : "发送新任务并暂停目标")),
          deleted(s) && h("p", { className: "sa-muted", role: "status" }, "会话已删除，无法恢复。请新建会话。"),
          !s.selected && h("div", { className: "sa-workspace-picker" }, h(Choice, { label: "Super Agent 工作目录", value: s.root,
            items: [{ id: "none", label: "不绑定工作区 · 直接聊天" }, ...s.directories.map(d => ({ id: d.root, label: basename(d.root), icon: icon("IconFolderCloseRegular") })), { id: "add", label: "添加工作区", icon: icon("IconProjectAddOutlineRegular") }],
            onSelect: id => id === "add" ? controller.setWorkspaceForm(true) : controller.newConversation(id === "none" ? "" : id) }, icon("IconFolderCloseRegular"), s.root ? basename(s.root) : "直接聊天 · 可选工作区")),
          projectPicker && h(ProjectFilePicker, { key: `${s.targetId}:${s.selected?.conversationId || "new"}`, s, close: closeTo(attachButton) }),
          skillPicker && h(SkillPicker, { key: `skills:${s.targetId}:${s.selected?.conversationId || "new"}`, s, close: closeTo(skillButton) }),
          contextPreview && h(ContextPreview, { key: `context:${s.targetId}:${s.selected?.conversationId || "new"}`, s, close: closeTo(contextButton) }),
          s.conversation?.pendingConfig && h("div", { className: "sa-composer-notice sa-muted", role: "status" }, `当前 ${s.models.find(m => m.id === config?.modelId)?.name || config?.modelId || "模型未知"} · ${config?.thinkingLevel || "提供方默认"}；新选择将在当前任务结束后生效，已接收任务保持原配置。`, h("button", { type: "button", className: "sa-chip", disabled: s.busy || deleted(s), onClick: () => void run(() => controller.discardPendingConfig()) }, "撤销待生效选择")),
          s.thread?.status === "paused_by_user" && h("div", { className: "sa-workspace-picker" }, h("span", { className: "sa-muted" }, "会话已暂停"), h("button", { type: "button", className: "sa-chip", disabled: s.busy || deleted(s), onClick: () => void run(() => controller.controlThread("resume")) }, "恢复")),
          running && (!s.goal || ["completed", "cancelled", "failed"].includes(s.goal.status)) && h("div", { className: "sa-workspace-picker" }, h(Choice, { label: "输入用途", value: s.delivery,
            items: [{ id: "new_run", label: "排队新任务" }, { id: "next_turn", label: "补充当前任务" }], onSelect: value => controller.setDelivery(value) }, s.delivery === "next_turn" ? "补充当前任务" : "排队新任务")),
          running && (!s.goal || ["completed", "cancelled", "failed"].includes(s.goal.status)) && s.delivery === "next_turn" && h("div", { className: "sa-composer-target-select" }, h("label", { htmlFor: "sa-composer-target-run" }, "补充目标"), h("select", { id: "sa-composer-target-run", value: s.targetRunId || (activeRuns.length === 1 ? activeRuns[0].runId : ""), onChange: event => controller.setTargetRun(event.target.value || null), disabled }, h("option", { value: "", disabled: true }, "选择运行中的任务"), ...activeRuns.map((task, index) => h("option", { key: task.runId, value: task.runId }, `任务 ${index + 1} · ${runStatusLabel(task, s.thread)}`)))),
          h("form", { className: "sa-composer", "data-dragging": dragging, onSubmit: e => { e.preventDefault(); void controller.send(); },
            onDragOver: event => { if (!unsupported && !disabled && [...(event.dataTransfer?.types || [])].includes("Files")) { event.preventDefault(); setDragging(true); } },
            onDragLeave: event => { if (!event.currentTarget?.contains?.(event.relatedTarget)) setDragging(false); },
            onDrop: event => { setDragging(false); if (!unsupported && !disabled && event.dataTransfer?.files?.length) { event.preventDefault(); event.stopPropagation(); addFiles(Array.from(event.dataTransfer.files)); } } },
            h("input", { ref: files, type: "file", multiple: true, hidden: true, "aria-label": "添加图片或文件", disabled: disabled || unsupported, onChange: event => { addFiles(Array.from(event.target.files || [])); event.target.value = ""; } }),
            h(DraftAttachments, { s }),
            unsupported && h("p", { className: "sa-composer-warning", role: "status" }, s.attachmentCapabilities.reason || "当前运行时暂不支持附件与 Skill，请连接 TypeScript/Pi 服务"),
            s.attachmentCapabilityError && h("p", { className: "sa-composer-warning", role: "alert" }, `附件能力读取失败：${s.attachmentCapabilityError}`),
            retained > 0 && h("div", { className: "sa-composer-target" }, `附件接收服务：${s.coreTargetLabel || "当前 Core"} · 发送前不会交给模型`),
            s.delivery === "next_turn" && (s.selectedSkillIds || []).length > 0 && h("p", { className: "sa-composer-warning", role: "alert" }, "当前任务沿用原 Skill；请取消本次选择或改为排队新任务。"),
            h("textarea", { ref: input, className: "sa-input", rows: 1, "aria-label": "Super Agent 消息", placeholder: "发消息或创建任务", value: s.draft, disabled: s.busy || s.goalBusy || deleted(s),
              onChange: e => controller.setDraft(e.target.value), onSelect: readSelection,
              onPaste: event => { const images = Array.from(event.clipboardData?.items || []).filter(item => item.kind === "file" && item.type.startsWith("image/")).map(item => item.getAsFile()).filter(Boolean); if (!disabled && !unsupported && images.length) { event.preventDefault(); addFiles(images); } },
              onKeyDown: e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent?.isComposing && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); void controller.send(); } } }),
            selection && h("button", { type: "button", className: "sa-selected-text-action", disabled, onClick: () => { const range = selection; setSelection(null); void run(() => controller.convertSelectionToAttachment(range.start, range.end)); } }, "将选中资料转为附件（保留其余任务要求）"),
            s.attachmentNotice && h("p", { className: "sa-composer-warning", role: "status" }, s.attachmentNotice),
            (s.attachmentRemovals || []).length > 0 && h("button", { type: "button", className: "sa-attachment-action", onClick: () => void run(() => controller.resolveAttachmentRemovals()) }, "查询附件移除结果"),
            (retained > 0 || (s.selectedSkillIds || []).length > 0) && h("div", { className: "sa-attachment-summary" }, h("span", null, `${retained} 个附件 · ${(s.selectedSkillIds || []).length} 个 Skill`), h("button", { ref: contextButton, type: "button", disabled: s.busy, onClick: () => setContextPreview(true) }, "查看本次上下文"), s.previewLoading && h("span", { role: "status" }, "重新计算中")),
            h("div", { className: "sa-composer-bar" },
              h(Menu, { open: attachmentMenu, onClose: () => { setAttachmentMenu(false); attachButton.current?.focus(); }, portal: true, side: "top", align: "start", items: [{ id: "upload", label: "添加图片或文件" }, ...(s.root ? [{ id: "project", label: "引用项目文件" }] : [])], onSelect: id => { if (id === "upload") chooseFiles(); else { setAttachmentMenu(false); setProjectPicker(true); } }, anchor: h("button", { ref: attachButton, type: "button", className: "sa-composer-attach", "aria-label": "添加附件", "aria-haspopup": "menu", "aria-expanded": attachmentMenu, title: "添加图片或文件", disabled: disabled || unsupported, onClick: () => setAttachmentMenu(!attachmentMenu) },
                h("svg", { viewBox: "0 0 16 16", width: 15, height: 15, fill: "none", stroke: "#61666b", strokeWidth: 1.7, strokeLinecap: "round", "aria-hidden": true },
                  h("path", { d: "M8 3.5v9M3.5 8h9" }))) }),
              h("button", { ref: skillButton, type: "button", className: "sa-composer-skill", "aria-label": "选择本次任务使用的 Skill", "aria-haspopup": "dialog", disabled: disabled || unsupported, onClick: () => setSkillPicker(true) }, "Skill", (s.selectedSkillIds || []).length > 0 && h("span", null, (s.selectedSkillIds || []).length)),
              h(PermissionMenu, { s, disabled: s.busy || deleted(s) }),
              h("span", { style: { flex: "1 1 auto" } }),
              h("span", { className: "sa-model-slot" }, h(ComposerMenu, { s, modelId, model, thinkingValue, running, disabled: s.busy || deleted(s) || !s.models.some(item => item.selectable !== false) })),
              h(Tooltip, { label: "发送", shortcutKeys: ["Enter"], portal: true },
                    h("button", { className: "sa-send", type: "submit", "aria-label": "发送", disabled: deleted(s) || s.busy || s.goalBusy || !s.ready || blocked || (!s.draft.trim() && !retained) || (!s.selected && !s.modelId) || (s.delivery === "next_turn" && (s.selectedSkillIds || []).length > 0) },
                      h("svg", { viewBox: "0 0 16 16", width: 15, height: 15, fill: "none", stroke: "#ffffff", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
                        h("path", { d: "M8 12.5v-9M4.2 7.2L8 3.5l3.8 3.7" })))),
              running && h(Tooltip, { label: "停止", portal: true }, h("button", { className: "sa-send sa-send-stop", type: "button", "aria-label": "停止", disabled: deleted(s), onClick: () => void controller.stop() }, h("span", { style: { background: "#ffffff", width: 11, height: 11, borderRadius: 2 } }))))),
          h(ConversationStatsBar, { s }));
      }
      function WaitCard({ wait, root }) {
        const [answer, setAnswer] = React.useState(""), [snapshotId, setSnapshot] = React.useState(""), [sourcePath, setPath] = React.useState(wait.fileInput?.path || ""), [provisionMode, setProvisionMode] = React.useState("current_wait");
        const expired = wait.kind === "permission" && wait.expiresAt && Date.parse(wait.expiresAt) <= Date.now();
        const [snapshots, setSnapshots] = React.useState([]), [files, setFiles] = React.useState([]), [busy, setBusy] = React.useState(false), [error, setError] = React.useState(""), [receipt, setReceipt] = React.useState(null);
        const work = fn => async () => { if (busy) return; setBusy(true); setError(""); try { await fn(); } catch (failure) { setError(failure.message); } finally { setBusy(false); } };
        const submit = values => work(async () => { const result = await controller.resolveWait(wait, values); setReceipt(result); });
        const refreshVersions = work(async () => {
          const lookup = await controller.resource("workspace.find", { root });
          if (!lookup?.workspaceId) throw new Error("当前项目尚未注册；请先在工作区与同步中发布真实版本");
          const result = await controller.resource("files.snapshots", { workspaceId: lookup.workspaceId }); setSnapshots(result.items || []);
        });
        const selectVersion = value => void work(async () => { setSnapshot(value); const snapshot = await controller.resource("files.snapshot", { snapshotId: value }); setFiles(snapshot.manifest?.files || []); })();
        return h("section", { className: "sa-run-card", "aria-label": `${wait.kind === "file_input" ? "必需文件补件" : wait.kind === "permission" ? "动作审批" : "问题回答"} ${wait.waitId}` },
          h("strong", null, `${wait.kind === "file_input" ? "必需文件补件" : wait.kind === "permission" ? "动作审批" : "问题回答"} · ${({ waiting: "待确认", answered: "已处理", cancelled: "已取消" })[wait.status] || "状态未知"}`), h("p", null, wait.prompt),
          wait.context && h("pre", { style: { whiteSpace: "pre-wrap" } }, wait.context),
          wait.kind === "user" && h("p", { className: "sa-muted" }, wait.expiresAt ? `业务截止时间 ${new Date(wait.expiresAt).toLocaleString()}` : "此问题默认不自动超时；答案只回答问题，不批准动作。"),
          wait.kind === "permission" && h("p", { className: "sa-muted" }, `审批到期 ${wait.expiresAt ? new Date(wait.expiresAt).toLocaleString() : "未记录"}${expired ? " · 已过期，需要重新核验后生成新审批" : ""}`),
          expired && h("button", { type: "button", disabled: busy || wait.status !== "waiting", onClick: () => void work(async () => { setReceipt(await controller.renewApproval(wait)); })() }, "重新核验并创建新审批"),
          wait.kind === "file_input" ? h(React.Fragment, null,
            h("p", null, `目标文件 ${wait.fileInput?.path || "未知"} · 原基线 hash ${wait.fileInput?.baselineHash || "缺失"}`),
            h("p", { className: "sa-muted" }, "先在设置的工作区与同步中上传或发布含所需内容的真实版本，再选择版本与源文件。暂停期间可接收，恢复后才继续。"),
            h("button", { type: "button", disabled: busy || !root || wait.status !== "waiting", onClick: () => void refreshVersions() }, "读取项目可用版本"),
            h("label", null, "补件快照", h("select", { "aria-label": "补件快照", value: snapshotId, disabled: busy, onChange: event => selectVersion(event.target.value) }, h("option", { value: "" }, "选择已发布版本"), ...snapshots.map(item => h("option", { key: item.snapshotId, value: item.snapshotId }, `${item.snapshotId} · ${item.rootHash}`)))),
            h("label", null, "源文件", h("select", { "aria-label": "源文件", value: sourcePath, disabled: busy, onChange: event => setPath(event.target.value) }, h("option", { value: "" }, "选择快照内文件"), ...files.map(item => h("option", { key: item.path, value: item.path }, `${item.path} · ${item.hash}`)))),
            h("label", null, "补件用途", h("select", { "aria-label": "补件用途", value: provisionMode, disabled: busy, onChange: event => setProvisionMode(event.target.value) }, h("option", { value: "current_wait" }, "补给当前等待"), h("option", { value: "new_branch" }, "从原输入创建独立验证分支"))),
            provisionMode === "new_branch" && h("p", { className: "sa-muted" }, "新版本必须包含原缺失路径。新分支沿用原模型和权限，原等待保留；新任务可能排队，创建回执不表示完成。"),
            h("button", { type: "button", disabled: busy || wait.status !== "waiting" || !snapshotId || !files.some(item => item.path === sourcePath) || (provisionMode === "new_branch" && sourcePath !== wait.fileInput?.path), onClick: () => void submit({ snapshotId, sourcePath, ...(provisionMode === "new_branch" ? { mode: "new_branch" } : {}) })() }, provisionMode === "new_branch" ? "提供文件并创建独立验证分支" : "提供此版本的真实文件")) : wait.kind === "permission" ?
            h("div", { style: { display: "flex", gap: 8 } }, ...["allow", "deny"].map(decision => h("button", { key: decision, type: "button", disabled: busy || expired || wait.status !== "waiting", onClick: () => void submit({ decision })() }, decision === "allow" ? "允许此动作" : "拒绝此动作"))) :
            h("form", { onSubmit: event => { event.preventDefault(); void submit({ answer })(); } },
              Array.isArray(wait.options) && wait.options.length > 0 && h("div", null, ...wait.options.map(option => h("button", { key: option, type: "button", disabled: busy, onClick: () => setAnswer(option) }, option))),
              h("textarea", { "aria-label": "问题答案", value: answer, disabled: busy || wait.status !== "waiting", onChange: event => setAnswer(event.target.value), style: { width: "100%", boxSizing: "border-box" } }),
              h("button", { type: "submit", disabled: busy || wait.status !== "waiting" || !answer.trim() }, "提交问题答案")),
          error && h("p", { role: "alert", className: "sa-error" }, error), receipt && h("p", { role: "status" }, receipt.newBranch ? `已创建独立任务 ${receipt.newBranch.runId} · 对话 ${receipt.newBranch.conversationId}；任务可能排队。原等待保留，实际运行状态以下次读取为准。` : `持久接收回执 ${receipt.requestId || "已返回"}；实际运行状态以下次读取为准。`),
          receipt?.newBranch && h("button", { type: "button", disabled: busy, onClick: () => void work(() => controller.selectThread(controller.getSnapshot().selected.threadId, receipt.newBranch.conversationId))() }, "查看新分支任务"));
      }
      function ExecutionVerification({ execution }) {
        const [conclusion, setConclusion] = React.useState("unresolved"), [evidence, setEvidence] = React.useState(""), [busy, setBusy] = React.useState(false), [error, setError] = React.useState(""), [receipt, setReceipt] = React.useState(null);
        const verify = async () => { setBusy(true); setError(""); try { setReceipt(await controller.verifyExecution(execution, { conclusion, evidence })); } catch (failure) { setError(failure.message); } finally { setBusy(false); } };
        const verification = execution.verifications?.at(-1);
        return h("details", { className: "sa-run-card", open: !verification || verification.conclusion === "unresolved" }, h("summary", null, `${verification && verification.conclusion !== "unresolved" ? `已核验 ${verification.conclusion} · 原账本 unknown` : "外部动作结果未知"} · ${execution.toolName} · ${execution.executionId}`),
          h("p", null, `任务 ${execution.runId} · 会话 ${execution.conversationId || "未知"} · 原始状态 ${execution.status} · 参数 hash ${execution.paramsHash}`), h("p", null, execution.intent),
          h("details", null, h("summary", null, "原始参数与结果引用"), h("pre", { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } }, JSON.stringify({ arguments: execution.arguments, resultRef: execution.resultRef }, null, 2))),
          h("p", { className: "sa-muted" }, "请先在真实外部系统核对结果，再记录证据。核验只追加事实；原 unknown 账本保留，不重放动作，也不自动继续任务。"),
          ...execution.verifications.map(item => h("p", { key: item.requestId, className: "sa-muted" }, `${item.actorId} · ${new Date(item.at).toLocaleString()} · ${item.conclusion} · ${item.evidence}`)),
          h("label", null, "核验结论", h("select", { "aria-label": "核验结论", value: conclusion, disabled: busy, onChange: event => setConclusion(event.target.value) }, ...[["unresolved", "仍无法确认"], ["succeeded", "确认已成功"], ["failed", "确认已失败"], ["not_executed", "确认未执行"]].map(([value, label]) => h("option", { key: value, value }, label)))),
          h("label", null, "核验依据", h("textarea", { "aria-label": "核验依据", value: evidence, disabled: busy, onChange: event => setEvidence(event.target.value), style: { width: "100%", boxSizing: "border-box" } })),
          h("button", { type: "button", disabled: busy || !evidence.trim(), onClick: () => void verify() }, "保存核验证据"), error && h("p", { className: "sa-error", role: "alert" }, error), receipt && h("p", { role: "status" }, `已接收 ${receipt.requestId || "核验"}；继续任务、采用部分结果或原输入重试需要分别操作。`));
      }
      function TaskGraph({ s }) {
        const [open, setOpen] = React.useState(false), [graph, setGraph] = React.useState(null), [error, setError] = React.useState(""), [detail, setDetail] = React.useState(null), [detailError, setDetailError] = React.useState(""), [busy, setBusy] = React.useState(false);
        React.useEffect(() => { if (!open) return; let alive = true, reading = false;
          const refresh = async () => { if (reading) return; reading = true; try { const result = await services.observations.graph(s.selected.threadId); if (alive && result?.threadId === s.selected.threadId) { setGraph(result); setError(""); } } catch (failure) { if (alive) setError(failure.message); } finally { reading = false; } };
          void refresh(); const timer = setInterval(() => void refresh(), 3000); return () => { alive = false; clearInterval(timer); };
        }, [open, s.selected.threadId]);
        const inspect = async node => { setBusy(true); setDetailError(""); try {
          const [run, messages, trace] = await Promise.all([controller.resource("run.get", { runId: node.runId }), controller.resource("messages.list", { conversationId: node.conversationId, limit: 50 }), services.observations.trace(node.runId)]);
          setDetail({ run, messages: messages.items || [], nextCursor: messages.nextCursor || null, reports: (trace.facts || []).filter(fact => fact.type === "report"), links: trace.links || [] });
        } catch (failure) { setDetailError(failure.message); } finally { setBusy(false); } };
        const moreMessages = async () => {
          if (!detail?.nextCursor || busy) return;
          const runId = detail.run.runId, cursor = detail.nextCursor;
          setBusy(true); setDetailError("");
          try {
            const page = await controller.resource("messages.list", { conversationId: detail.run.conversationId, cursor, limit: 50 });
            setDetail(current => {
              if (current?.run.runId !== runId || current.nextCursor !== cursor) return current;
              const messages = new Map(current.messages.map(message => [message.messageId, message]));
              for (const message of page.items || []) messages.set(message.messageId, message);
              return { ...current, messages: [...messages.values()], nextCursor: page.nextCursor || null };
            });
          } catch (failure) { setDetailError(failure.message); } finally { setBusy(false); }
        };
        const relations = (graph?.edges || []).filter(edge => ["parent_run", "delegation", "report_delivery", "origin_run"].includes(edge.kind));
        const ids = new Set(relations.flatMap(edge => [edge.fromId, edge.toId]));
        return h("details", { className: "sa-run-card", "aria-label": "子任务与报告", onToggle: event => setOpen(event.currentTarget.open) }, h("summary", null, "父子任务与报告交付"),
          h("p", { className: "sa-muted" }, "关系来自实际委派、报告和原输入独立重试事实。子任务终态与报告接收是两个状态，打开详情不会重复交付。"), error && h("p", { className: "sa-error", role: "alert" }, error),
          graph && !relations.length && h("p", null, "当前没有已记录的委派或报告关系"),
          ...relations.map(edge => h("p", { key: `${edge.kind}:${edge.factId}`, className: "sa-muted" }, `${{ parent_run: "父子任务", delegation: "委派", report_delivery: "报告路由关联", origin_run: "原输入独立重试" }[edge.kind]}：${edge.fromId} → ${edge.toId} · 事实 ${edge.factId}`)),
          ...(graph?.nodes || []).filter(node => node.kind === "run" && ids.has(node.runId)).map(node => h("div", { className: "sa-run-card", key: node.runId }, h("p", null, `任务 ${node.runId} · ${node.status || "未知"} · 会话 ${node.conversationId || "未知"}`), h("button", { type: "button", disabled: busy || !node.conversationId, onClick: () => void inspect(node) }, "只读查看任务／报告详情"))),
          detailError && h("p", { role: "alert", className: "sa-error" }, detailError),
          detail && h("details", { open: true }, h("summary", null, `只读任务 ${detail.run.runId} · ${detail.run.status}`), h("p", null, detail.run.error || detail.run.answer || "尚无终态正文"),
            h("p", { className: "sa-muted" }, `冻结模型 ${detail.run.frozenModel?.provider || "未知"}/${detail.run.frozenModel?.modelId || "未知"} · 文件执行根 ${detail.run.fileBinding?.cwd || "无／未知"}`),
            ...detail.reports.map(fact => h("p", { className: "sa-muted", key: fact.factId }, `报告 ${fact.payload.reportId} · ${fact.payload.status} · 原父任务 ${fact.payload.originalParentRunId || "未知"} · 接收任务 ${fact.payload.recipientRunId || "未接收"} · 已接收 ${fact.payload.receivedAt || "未记录"} · 已处理 ${fact.payload.processedAt || "未记录"}`)),
            !detail.reports.length && h("p", { className: "sa-muted" }, "此任务轨迹尚无报告接收事实；不能仅凭子任务完成判定已交付。"),
            h("details", null, h("summary", null, `持久消息 · ${detail.messages.length}`), ...detail.messages.map(message => h("article", { key: message.messageId, className: "sa-message", "data-role": message.role }, h("strong", null, message.role),
              typeof message.text === "string" && renderMarkdown(message.text),
              message.kind === "tool_call" && message.toolCall && h("details", null, h("summary", null, `${message.toolCall.name} · ${message.toolCallId || "调用身份未知"}`),
                h("pre", null, typeof message.toolCall.arguments === "string" ? message.toolCall.arguments : JSON.stringify(message.toolCall.arguments, null, 2))))), detail.nextCursor && h("button", { type: "button", disabled: busy, onClick: () => void moreMessages() }, "只读加载下一页子任务消息"))));
      }
      function Space() {
        const snapshot = useSpace(), runMetrics = useRunMetrics(snapshot), s = { ...snapshot, runMetrics }, end = React.useRef(null), scroller = React.useRef(null), savedScroll = React.useRef(0), hero = !s.selected && !s.messages.length;
        const [tab, setTab] = React.useState("messages"), [atBottom, setAtBottom] = React.useState(true), [traceFocus, setTraceFocus] = React.useState(null);
        const [processOpen, setProcessOpen] = React.useState({}), [optionsOpen, setOptionsOpen] = React.useState(false);
        const surface = React.useRef(null), [available, setAvailable] = React.useState(1000), [expanded, setExpanded] = React.useState(false);
        const reviewLayout = diffLayout(available, s.diffWidth, expanded);
        React.useEffect(() => {
          const node = surface.current;
          if (!node) return;
          const measure = () => setAvailable(node.getBoundingClientRect().width);
          measure();
          if (typeof ResizeObserver === "undefined") return;
          const observer = new ResizeObserver(measure); observer.observe(node);
          return () => observer.disconnect();
        }, []);
        React.useEffect(() => { if (!s.diffSelection) setExpanded(false); }, [s.diffSelection, s.selected?.conversationId, s.targetId]);
        const tracing = tab === "trace" && !hero;
        const streamed = s.live.map(m => m.text).join("");
        React.useEffect(() => { if (tab === "messages" && atBottom) end.current?.scrollIntoView({ block: "end" }); }, [s.messages.length, streamed, tab, atBottom]);
        React.useEffect(() => { if (tab === "messages" && scroller.current) scroller.current.scrollTop = savedScroll.current; }, [tab]);
        React.useEffect(() => { if (!s.selected && tab === "trace") setTab("messages"); }, [s.selected, tab]);
        const current = s.threads.find(t => t.threadId === s.selected?.threadId);
        const groups = groupChatRuns(s.messages, s.live.map(message => ({ ...message, live: true })));
        const openEvent = message => {
          if (!message.runId) return;
          setTraceFocus({ targetId: s.targetId, threadId: s.selected.threadId, conversationId: s.selected.conversationId,
            runId: message.runId, turnId: message.turnId || null, messageId: message.messageId || null, factId: message.factId || null });
          setTab("trace");
        };
        const activeRunId = [...(s.runDetails || [])].reverse().find(r => r.status === "completed" && r.fileBinding)?.runId;
        const fish = primitives.FISH_LOGO_VIEWBOX;
        return h("div", { ref: surface, className: "sa-space", style: { "--sa-diff-width": `${reviewLayout.width}px` }, "data-super-agent-space": true, "data-diff-open": Boolean(s.diffSelection && !tracing), "data-diff-expanded": Boolean(s.diffSelection && !tracing && reviewLayout.full) }, h("style", null, CSS),
          h("header", { className: "sa-space-header", "data-blank": hero, "data-window-drag": true },
            !hero && h("span", { className: "sa-header-title" }, current ? title(s, current) : "会话"),
            tracing && h("span", { className: "sa-crumb sa-crumb-current" }, "Trace"),
            h("span", { style: { flex: "1 1 auto" } }),
            h("div", { className: "sa-header-actions", "data-window-no-drag": true },
              tracing && h("button", { type: "button", className: "sa-chip", onClick: () => { setTraceFocus(null); setTab("messages"); } }, "返回对话"),
              !hero && !tracing && activeRunId && h("button", { type: "button", className: "sa-header-btn", onClick: () => void run(() => controller.openLatestDiff()) }, "查看变更"),
              !hero && iconButton("IconEllipsisOutlineRegular", "会话选项", () => setOptionsOpen(true)),
              iconButton("IconWorkspaceTreeOutlineRegular", "返回工作区", () => ctx.layout.selectPanel(null)))),
          s.error && h("div", { className: "sa-error", role: "alert" }, s.error, iconButton("IconCloseOutlineRegular", "关闭提示", () => controller.reportError("")),
            h("button", { className: "sa-chip", onClick: () => { controller.reportError(""); void controller.refresh(); } }, "重试")),
          s.historyError && h("div", { className: "sa-error", role: "alert" }, s.historyError, h("button", { className: "sa-chip", onClick: () => void controller.refresh() }, "重试历史")),
          h("main", { ref: scroller, className: "sa-scroll", "data-hero": hero, onScroll: event => {
            savedScroll.current = event.currentTarget.scrollTop;
            setAtBottom(event.currentTarget.scrollHeight - event.currentTarget.scrollTop - event.currentTarget.clientHeight < 48);
          } },
            tracing && ConversationTrace && h("div", { className: "sa-message-list", "data-super-agent-trace-page": true }, h(Boundary || React.Fragment, { key: `trace:${s.targetId}:${s.selected.conversationId}` },
              h(ConversationTrace, { conversationId: s.selected.conversationId, threadId: s.selected.threadId, targetId: s.targetId,
                title: current ? title(s, current) : s.selected.conversationId, threadTitle: current ? title(s, current) : s.selected.threadId,
                messages: s.messages, initialFocus: traceFocus, controller,
                onOpenConversation: conversationId => void controller.selectThread(s.selected.threadId, conversationId) }))),
            !tracing && s.goal && h("div", { className: "sa-message-list", style: { flex: "none", paddingBottom: 0 } }, h(GoalCard, { key: s.goal.goalId, s })),
            hero && h("div", { className: "sa-hero" }, fish && h("svg", { className: "sa-hero-logo", viewBox: `0 0 ${fish.width} ${fish.height}`, "aria-hidden": true }, h("path", { d: primitives.FISH_LOGO_PATH, fill: "currentColor" })),
              h("span", null, "探索未至之境"), h("span", { className: "sa-badge" }, "Super Agent")),
            !hero && !tracing && (s.executions || []).filter(item => item.status === "unknown").map(execution => h("div", { className: "sa-message-list", key: `execution:${s.targetId}:${execution.executionId}`, style: { flex: "none", paddingBottom: 0 } }, h(Boundary || React.Fragment, null, h(ExecutionVerification, { execution })))),
            !hero && !tracing && (s.waits || []).filter(wait => wait.status === "waiting").map(wait => h("div", { className: "sa-message-list", key: `wait:${s.targetId}:${wait.waitId}`, style: { flex: "none", paddingBottom: 0 } }, h(Boundary || React.Fragment, null, h(WaitCard, { wait, root: s.root })))),
            !hero && !tracing && h("div", { className: "sa-message-list", "aria-live": "polite" },
              ...groups.map(group => h(ChatRunGroup, { key: group.key, s, group,
                processOpen: processOpen[group.key] === true,
                onProcessToggle: open => setProcessOpen(current => ({ ...current, [group.key]: open })),
                onEvent: openEvent, onOpenDiff: runId => void run(() => controller.openDiff(runId)) })),
              h("div", { ref: end }),
              !atBottom && h("button", { type: "button", className: "sa-latest", onClick: () => { setAtBottom(true); savedScroll.current = 0; end.current?.scrollIntoView({ block: "end" }); } }, "返回最新内容")),
            hero && h(Composer, { s })),
          !hero && !tracing && h(Composer, { s }),
          !tracing && s.diffSelection && h(Boundary || React.Fragment, { key: `diff:${s.targetId}:${s.selected?.conversationId}:${s.diffSelection.runId}` }, h(DiffPanel, { s, layout: reviewLayout, expanded, onResize: width => controller.setDiffWidth(width), onExpand: () => setExpanded(value => !value) })),
          h(Modal, { open: optionsOpen, onClose: () => setOptionsOpen(false), closeLabel: "关闭", title: "会话选项" },
            h("div", { className: "sa-dialog-body" },
              h("div", { className: "sa-dialog-footer" }, ...["pause", "resume", "stop"].map(action => h("button", { key: action, type: "button", className: "sa-chip", disabled: s.busy || deleted(s), onClick: () => void run(() => controller.controlThread(action)) }, ({ pause: "暂停", resume: "恢复", stop: "停止" })[action])),
                h("button", { type: "button", className: "sa-chip", disabled: deleted(s) || !s.runDetails?.some(t => t.runId === s.contextView?.latestRunId && t.status === "completed"), onClick: () => void run(() => controller.compactConversation(s.contextView.latestRunId)) }, "显式压缩最近已完成任务"),
                h("button", { type: "button", className: "sa-chip", onClick: () => void controller.refresh() }, "只读刷新状态")),
              s.contextView?.compactionOperation && h("section", { "aria-label": "最近压缩状态" },
                h("p", { role: "status" }, compactionStatusLabel(s.contextView.compactionOperation)),
                s.contextView.compactionOperation.reason && h("details", null, h("summary", null, "压缩状态详情"), h("p", null, s.contextView.compactionOperation.reason))),
              h(BranchList, { s, onOpen: conversationId => void run(() => controller.selectThread(s.selected.threadId, conversationId)), onLoad: () => void run(() => controller.loadBranches()) }),
              s.selected && h(TaskGraph, { s }))),
          h(Modal, { open: s.inspector, onClose: () => controller.setInspector(false), closeLabel: "关闭", title: "运行与观测" },
            s.inspector && h("div", { className: "sa-observation-dialog" }, h(Boundary || React.Fragment, null, h(Panel)))));
      }
      let Boundary;
      if (React.Component) Boundary = class extends React.Component {
        constructor(props) { super(props); this.state = { error: null }; }
        static getDerivedStateFromError(error) { return { error }; }
        componentDidCatch(error, info) { console.error("[super-agent] isolated view failure", error, info?.componentStack); }
        render() { return this.state.error ? h("div", { className: "sa-error", role: "alert" }, `局部界面读取失败：${this.state.error.message}`, h("button", { type: "button", onClick: () => { this.setState({ error: null }); void controller.refresh(); } }, "重试")) : this.props.children; }
      };
      return { GoalCard, Space: Boundary ? props => h(Boundary, { key: "space" }, h(Space, props)) : Space, DirectorySection, DiffPanel, groupChatRuns, latestModelAttempts, metricsFromTrace };
    }
    return { createSpaceView, CSS, diffLayout, diffSections, codeTokens, attachmentRangeLabel, currentAttachmentState, compactionStatusLabel, skillCatalogRowKey, skillChoiceState };
  },
});
