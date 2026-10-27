/**
 * Stylesheet half of the bridge's client bundle, loaded as a package-local
 * chunk.
 *
 * dsh serves only a package's `client.js` entry to the page; every other file
 * in this directory reaches the browser as a chunk, which means it must be
 * named `client.<name>.js` and be asked for with `require.async`. See
 * `docs/requirements/dsh-integration/DSH界面验收.md` for the host rules this follows.
 *
 * Tokens only, so the panel follows the host theme instead of shipping its own
 * palette. This module owns no components: the kernel in `index.js` renders the
 * single `<style>` element from {@link CSS}.
 */
window.__ModuleLoader__.load({
  id: "@super-agent/dsh-bridge",
  chunk: "client.styles.js",
  factory() {
    /** Attribute marking this bundle's one stylesheet element. */
    const STYLE_ID = "@super-agent/dsh-bridge/client.css";

    const CSS = [
      ".sap-root{box-sizing:border-box;font:inherit;color:var(--dsw-alias-label-primary)}",
      ".sap-mono{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-variant-numeric:tabular-nums}",
      ".sap-muted{color:var(--dsw-alias-label-tertiary)}",
      ".sap-spacer{flex:1 1 auto}",
      ".sap-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto;display:inline-block}",
      ".sap-dot[data-tone=ok]{background:var(--dsw-alias-state-success-primary)}",
      ".sap-dot[data-tone=bad]{background:var(--dsw-alias-state-error-primary)}",
      ".sap-dot[data-tone=warn]{background:var(--dsw-alias-state-warn-primary)}",
      ".sap-dot[data-tone=idle]{background:var(--dsw-alias-state-idle-primary)}",
      ".sap-row{display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 8px;border:0;border-radius:8px;background:transparent;font-size:13px;color:var(--dsw-alias-label-secondary);cursor:pointer;text-align:left}",
      ".sap-row[data-active=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:500}",
      ".sap-row-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".sap-badge{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);font-size:11px;color:var(--dsw-alias-label-secondary)}",
      ".sap-badge[data-state=offline]{background:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-state-error-primary)}",
      ".sap-chip{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer}",
      ".sap-chip[data-disabled=true]{opacity:.5;cursor:default}",
      ".sap-btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer}",
      ".sap-btn[data-variant=solid]{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);font-weight:500}",
      ".sap-btn:disabled{opacity:.4;cursor:default}",
      ".sap-link{border:0;background:transparent;font:inherit;font-size:12px;color:var(--dsw-alias-link);cursor:pointer;padding:0}",
      ".sap-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:10px}",
      ".sap-card-head{display:flex;align-items:center;gap:8px}",
      ".sap-card-title{font-size:12px;font-weight:500;color:var(--dsw-alias-label-tertiary)}",
      ".sap-card-toggle{flex:1 1 auto;display:flex;align-items:center;gap:6px;min-width:0;padding:0;border:0;background:transparent;font:inherit;color:inherit;text-align:left;cursor:pointer}",
      ".sap-card-toggle:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px;border-radius:4px}",
      ".sap-card-chevron{flex:0 0 auto;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid var(--dsw-alias-label-tertiary);transition:transform .15s ease}",
      ".sap-card-chevron[data-open=false]{transform:rotate(-90deg)}",
      ".sap-status{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}",
      ".sap-field{display:flex;align-items:baseline;gap:12px;font-size:12px}",
      ".sap-field-label{flex:0 0 84px;color:var(--dsw-alias-label-tertiary)}",
      ".sap-field-value{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".sap-error{border-radius:8px;background:var(--dsw-alias-state-error-secondary);padding:8px 10px;font-size:11px;line-height:1.6;color:var(--dsw-alias-state-error-primary)}",
      ".sap-note{border-radius:8px;background:var(--dsw-alias-state-warn-tertiary);padding:8px 10px;font-size:11px;line-height:1.6;color:var(--dsw-alias-state-warn-label)}",
      ".sap-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".sap-turn{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}",
      ".sap-tag{border-radius:4px;background:var(--dsw-alias-bg-layer-2);padding:1px 6px;font-size:11px;color:var(--dsw-alias-label-secondary)}",
      ".sap-panel{display:flex;flex-direction:column;min-height:0;height:100%}",
      ".sap-panel-head{display:flex;align-items:center;gap:8px;height:48px;padding:0 16px}",
      ".sap-panel-title{font-size:13px;font-weight:500}",
      ".sap-tabs{display:flex;align-items:center;gap:20px;padding:0 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".sap-tab{height:40px;border:0;border-bottom:2px solid transparent;margin-bottom:-1px;background:transparent;font:inherit;font-size:13px;color:var(--dsw-alias-label-secondary);cursor:pointer}",
      ".sap-tab[data-active=true]{color:var(--dsw-alias-label-primary);font-weight:500;border-bottom-color:var(--dsw-alias-label-primary)}",
      ".sap-panel-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px}",
      ".sap-grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px}",
      ".sap-grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}",
      ".sap-metric{border-radius:8px;background:var(--dsw-alias-bg-layer-2);padding:10px}",
      ".sap-metric-label{font-size:11px;color:var(--dsw-alias-label-secondary)}",
      ".sap-metric-value{margin-top:4px;font-size:20px;font-weight:500;line-height:1.2}",
      ".sap-metric-detail{margin-top:2px;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
      ".sap-table-head,.sap-table-row{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
      ".sap-table-head{padding-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".sap-table-row{padding:7px 0;font-size:12px;color:var(--dsw-alias-label-primary);border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".sap-offline{max-width:480px;margin:0 auto;display:flex;flex-direction:column;gap:12px;padding:16px 0}",
      ".sap-offline-icon{width:40px;height:40px;border-radius:12px;background:var(--dsw-alias-state-error-secondary);display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-state-error-primary)}",
      ".sap-offline-title{font-size:16px;font-weight:500;line-height:1.3;margin:0}",
      ".sap-offline-body{font-size:13px;line-height:1.7;color:var(--dsw-alias-label-secondary);margin:0}",
      ".sap-step{display:flex;gap:12px}",
      ".sap-step-index{flex:0 0 auto;width:20px;height:20px;border-radius:50%;background:var(--dsw-alias-bg-layer-2);font-size:11px;font-weight:500;display:flex;align-items:center;justify-content:center}",
      ".sap-step-title{font-size:13px;font-weight:500}",
      ".sap-step-body{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}",
      ".sap-overlay{display:flex;align-items:center;justify-content:center;gap:8px;border-radius:12px;background:var(--dsw-alias-bg-mask-1);padding:10px;font-size:12px;color:var(--dsw-alias-label-secondary)}",
      ".sap-toolcard{display:flex;align-items:center;gap:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px}",
      ".sap-toolglyph{flex:0 0 auto;width:28px;height:28px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary)}",
      ".sap-toolmain{flex:1 1 auto;min-width:0}",
      ".sap-toolhead{display:flex;align-items:center;gap:8px}",
      ".sap-tooltitle{font-size:13px;font-weight:500}",
      ".sap-tooldesc{margin-top:2px;font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".sap-settings{display:flex;flex-direction:column;gap:10px;padding:4px 0}",
      ".sap-settings-title{font-size:13px;font-weight:500}",
      ".sap-choice{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".sap-choice-btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}",
      ".sap-choice-btn[data-active=true]{border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary);font-weight:500}",
      ".sap-demo{border-radius:8px;background:var(--dsw-alias-state-warn-tertiary);padding:8px 10px;font-size:11px;line-height:1.6;color:var(--dsw-alias-state-warn-label)}",
      ".sap-demo-chip{display:inline-flex;align-items:center;gap:6px;height:20px;padding:0 8px;border-radius:6px;background:var(--dsw-alias-state-warn-secondary);font-size:11px;font-weight:500;color:var(--dsw-alias-state-warn-label)}",
      ".sap-action{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
      ".sap-action[data-status=unsupported]{color:var(--dsw-alias-state-warn-label)}",
      ".sap-action[data-status=error]{color:var(--dsw-alias-state-error-primary)}",
      ".sap-empty{display:flex;flex-direction:column;gap:6px;align-items:center;justify-content:center;padding:14px 0;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary)}",
      ".sap-unavailable{border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;padding:10px;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}",
    ].join("");

    return { STYLE_ID, CSS };
  },
});
