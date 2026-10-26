import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const playwrightModule = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = await import(playwrightModule);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const startedAt = new Date();
const taskDate = startedAt.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
const taskName = `${taskDate}_agent-session-visualizer-browser`;
const artifacts = process.env.ARTIFACT_DIR
  ? resolve(process.env.ARTIFACT_DIR)
  : resolve(root, "../../.scratch/agent-session-visualizer", taskName);
await mkdir(artifacts, { recursive: true });


const consoleErrors = [];
const pageErrors = [];
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(7000);
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("pageerror", (error) => pageErrors.push(error.message));

const invariant = (condition, message) => { if (!condition) throw new Error(message); };
await page.goto("http://127.0.0.1:3789");
await page.waitForLoadState("networkidle");

await page.locator("#session-count").waitFor({ state: "visible" });
invariant(Number(await page.locator("#session-count").innerText()) >= 80, "The deduplicated ~/.codex conversation index was not loaded");
invariant((await page.locator("#live-state").innerText()).includes("LIVE WATCH"), "The live session watcher did not connect");

invariant((await page.locator("#header-session").innerText()).includes("019FE4CB"), "Root session id was not rendered");
invariant(await page.locator(".thread-card").count() === 4, "Expected root plus 3 sub-agent threads");
invariant(await page.locator(".lane").count() === 4, "Expected 4 graph lanes");
invariant(await page.locator(".graph-node-shell").count() === 24, "Expected 24 graph nodes");
invariant(await page.locator(".graph-edge").count() > 20, "Expected a connected execution graph");
invariant(await page.locator(".turn-button.active").count() === 1, "A default Turn scope was not selected");
invariant((await page.locator("#node-kind").innerText()).includes("USER"), "The default Turn did not select its first user node");

await page.locator("[data-node-id='root-research']").dispatchEvent("click");
invariant((await page.locator("#node-kind").innerText()).includes("TOOL BATCH"), "Tool batch detail did not open");
invariant(await page.locator(".tool-detail").count() === 20, "The 20 merged tools were not preserved in detail view");
invariant((await page.locator("#detail-content").innerText()).includes("完整原始输入"), "Tool input/result inspector is missing");

await page.locator("[data-node-id='selection-task-1']").dispatchEvent("click");
invariant((await page.locator("#node-kind").innerText()).includes("USER"), "Sub-agent task node did not open");
invariant((await page.locator("#detail-content").innerText()).includes("encrypted_content"), "Encrypted source boundary was not disclosed");
invariant((await page.locator("#detail-content").innerText()).includes("完整消息内容"), "Complete message panel is missing");

await page.locator("[data-node-id='selection-final-1']").dispatchEvent("click");
invariant((await page.locator("#detail-content").innerText()).includes("Codex 原生子 Agent"), "Sub-agent result content was not rendered");

await page.locator("#color-legend [data-type='tool']").click();
invariant(await page.locator(".graph-node-shell.dimmed").count() > 0, "Color/action filter did not dim other nodes");
await page.locator("#color-legend [data-type='tool']").click();

const beforeZoom = (await page.locator("#graph-svg").getAttribute("viewBox")).split(" ").map(Number);
await page.getByRole("button", { name: "放大" }).click();
const afterZoom = (await page.locator("#graph-svg").getAttribute("viewBox")).split(" ").map(Number);
invariant(afterZoom[2] < beforeZoom[2], "Zoom-in control did not change the SVG viewBox");

await page.getByRole("button", { name: "Halley" }).click();
invariant((await page.locator("#node-kind").innerText()).includes("USER"), "Thread focus did not select the first Halley node");

await page.getByRole("button", { name: "定位 Sub-agent" }).click();
await page.locator("[data-node-id='root-spawn']").dispatchEvent("click");
await page.getByRole("button", { name: "完整内容" }).click();
invariant((await page.locator(".detail-tab.active").innerText()).includes("完整内容"), "Detail tab active state is inconsistent");

await page.locator("#open-sessions").click();
invariant(await page.locator(".session-item").count() >= 80, "The all-conversations category did not render all deduplicated conversations");
invariant(await page.locator(".project-item").count() >= 10, "Project-level Session categories were not rendered");
invariant((await page.locator("#session-stats").innerText()).includes("MERGED"), "Conversation merge metrics are missing");
invariant(!(await page.locator("#session-stats").innerText()).includes("ARCHIVED"), "Archived sessions are still exposed");
const directoryIds = await page.locator(".session-item").evaluateAll((items) => items.map((item) => item.dataset.sessionId));
invariant(new Set(directoryIds).size === directoryIds.length, "Duplicate conversation ids remain in the Session Directory");
await page.locator("#session-search").fill("01a00f1f-5570-79d1-beee-706875d5f3b0");
invariant(await page.locator("[data-session-id='01a00f1f-5570-79d1-beee-706875d5f3b0']").count() === 1, "Session search did not expose the exact requested id");
await page.locator("[data-session-id='01a00f1f-5570-79d1-beee-706875d5f3b0']").click();
await page.locator("#header-session").filter({ hasText: "01A00F1F" }).waitFor();
invariant(await page.locator(".graph-node-shell").count() >= 50, "The causal regression Session was not converted into a graph");
invariant((await page.locator("#source-file").innerText()).includes("CODEX"), "The live graph source was not identified");
const graphIds = await page.locator(".graph-node-shell").evaluateAll((items) => items.map((item) => item.dataset.nodeId));
invariant(new Set(graphIds).size === graphIds.length, "Duplicate node ids remain in the rendered graph");
invariant(await page.locator(".turn-button").count() >= 8, "Root Turn navigation was not rendered");
const childTurnLabels = await page.locator(".thread-card.child .turn-count").allInnerTexts();
invariant(childTurnLabels.every((label) => label === "1T"), "Sub-agent inherited Turns are still visible");
await page.getByRole("button", { name: /Noether/ }).click();
invariant((await page.locator("#detail-content").innerText()).includes("Noether"), "A Sub-agent node opened another thread's detail");
await page.screenshot({ path: resolve(artifacts, "causal-session-graph.png"), fullPage: true });

await page.locator("#open-sessions").click();
await page.locator("#session-search").fill("");
await page.locator(".project-item").filter({ hasText: "learning" }).first().click();
invariant(await page.locator(".session-item").count() >= 10, "Selecting a project did not show its Sessions");
invariant((await page.locator("#current-project-name").innerText()).includes("learning"), "The selected project heading was not updated");
await page.screenshot({ path: resolve(artifacts, "agent-session-visualizer.png"), fullPage: true });

await page.locator("[data-provider='grok']").click();
await page.locator("[data-provider='grok'].active").waitFor();
await page.locator(".session-item").first().waitFor();
invariant((await page.locator("#provider-eyebrow").innerText()).includes("GROK BUILD"), "The Session Directory did not switch to Grok Build");
invariant((await page.locator("#session-directory").innerText()).includes(".grok/sessions"), "The Grok session directory was not displayed");
invariant(await page.locator(".session-item").count() >= 1, "Local Grok Build sessions were not listed");
await page.locator("#session-search").fill("feature-iteration");
invariant(await page.locator(".session-item").count() >= 1, "Grok session search did not find the real workflow session");
await page.locator(".session-item").first().click();
await page.locator("#source-file").filter({ hasText: "GROK" }).waitFor();
invariant(await page.locator(".graph-node-shell").count() >= 20, "The Grok conversation was not converted to the common execution graph");
invariant(await page.locator(".turn-button").count() >= 2, "Grok Turn navigation was not rendered");
const grokToolNode = page.locator(".graph-node-shell:has(.node-tool), .graph-node-shell:has(.node-agent)").first();
await grokToolNode.dispatchEvent("click");
invariant((await page.locator("#detail-content").innerText()).includes("完整原始输入"), "Grok tool input was not available in the common inspector");
invariant((await page.locator("#detail-content").innerText()).includes("完整原始结果"), "Grok tool result was not available in the common inspector");
await page.screenshot({ path: resolve(artifacts, "grok-session-graph.png"), fullPage: true });
await page.locator("#open-sessions").click();
await page.locator("[data-provider='codex']").click();
await page.locator("[data-provider='codex'].active").waitFor();
await page.waitForFunction(() => document.querySelector("#session-directory")?.textContent.includes(".codex/sessions"));
invariant((await page.locator("#session-directory").innerText()).includes(".codex/sessions"), "Switching back to Codex did not restore its directory");

await page.locator("[data-provider='claude']").click();
await page.locator("[data-provider='claude'].active").waitFor();
await page.locator(".session-item").first().waitFor();
invariant((await page.locator("#provider-eyebrow").innerText()).includes("CLAUDE CODE"), "The Session Directory did not switch to Claude Code");
invariant((await page.locator("#session-directory").innerText()).includes(".claude/projects"), "The Claude projects directory was not displayed");
await page.locator("#session-search").fill("e7f3932d-7cb2-4e4d-a6cf-f32af5c1b3a9");
invariant(await page.locator(".session-item").count() === 1, "Claude Session search did not find the Sub-agent fixture");
await page.locator(".session-item").click();
await page.locator("#source-file").filter({ hasText: "CLAUDE" }).waitFor();
invariant(await page.locator(".thread-card").count() === 6, "Claude Root and five Sub-agent Threads were not rendered");
invariant(await page.locator(".lane").count() === 6, "Claude Sub-agent graph lanes were not rendered");
invariant(await page.locator(".graph-node-shell").count() >= 250, "Claude message/content blocks were not converted to graph nodes");
const claudeAgentNode = page.locator(".graph-node-shell:has(.node-agent)").first();
await claudeAgentNode.dispatchEvent("click");
invariant((await page.locator("#detail-content").innerText()).includes("完整原始输入"), "Claude Agent input is missing from the inspector");
invariant((await page.locator("#detail-content").innerText()).includes("完整原始结果"), "Claude Agent result is missing from the inspector");
await page.locator(".thread-card.child").first().click();
invariant((await page.locator("#node-kind").innerText()).includes("USER"), "Claude child Thread did not focus its Agent task node");
const agentTaskDetail = await page.locator("#detail-content").innerText();
invariant(agentTaskDetail.includes("AGENT RUNTIME CONTEXT"), "Claude Agent task has no runtime context section");
invariant(agentTaskDetail.includes("SYSTEM PROMPT NOT PERSISTED"), "Claude Agent task does not disclose system-prompt provenance");
invariant(agentTaskDetail.includes("声明工具策略"), "Claude Agent task has no declared tool policy");
invariant(agentTaskDetail.includes("本次实际使用工具"), "Claude Agent task has no observed tool inventory");
invariant(agentTaskDetail.includes("Read") && agentTaskDetail.includes("Bash"), "Claude Agent task did not render observed tool names");
await page.screenshot({ path: resolve(artifacts, "claude-session-graph.png"), fullPage: true });
await page.locator("#open-sessions").click();
await page.locator("[data-provider='codex']").click();
await page.waitForFunction(() => document.querySelector("#session-directory")?.textContent.includes(".codex/sessions"));

const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
mobile.on("console", (message) => { if (message.type() === "error") consoleErrors.push(`mobile: ${message.text()}`); });
mobile.on("pageerror", (error) => pageErrors.push(`mobile: ${error.message}`));
await mobile.goto("http://127.0.0.1:3789/?provider=grok");
await mobile.waitForLoadState("networkidle");
await mobile.locator("#open-sessions").click();
await mobile.locator("[data-provider='grok'].active").waitFor();
await mobile.waitForTimeout(300);
invariant(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Session Directory overflows the mobile viewport");
invariant(await mobile.locator("#provider-switch button").count() === 3, "All three providers are not available on mobile");
invariant(await mobile.locator("#provider-switch button").evaluateAll((buttons) => buttons.every((button) => {
  const rect = button.getBoundingClientRect();
  return rect.width > 0 && rect.left >= 0 && rect.right <= window.innerWidth;
})), "Provider switch is clipped on mobile");
await mobile.close();

invariant(pageErrors.length === 0, `Page errors: ${pageErrors.join(" | ")}`);
invariant(consoleErrors.length === 0, `Console errors: ${consoleErrors.join(" | ")}`);
await browser.close();

console.log("PASS: Codex/Grok/Claude provider switching, unique graph ids, causal lanes, Turn scope, tool inspection, Session Directory, and watcher connection");
console.log(`Screenshot: ${resolve(artifacts, "agent-session-visualizer.png")}`);
