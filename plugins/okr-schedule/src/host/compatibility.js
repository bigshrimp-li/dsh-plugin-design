import fs from "node:fs";
import path from "node:path";
import { safeId } from "./protocol.js";
function createCompatibilityStore({ baseDir, legacy, getService }) {
  const migrated = (objectiveId) => safeId(objectiveId) && fs.existsSync(path.join(baseDir, objectiveId, "space.sqlite"));
  const binding = (objectiveId) => ({ objectiveId, trusted: true, sourceScope: "legacy-global" });
  const unwrap = (receipt) => {
    if (!["saved", "read"].includes(receipt.kind)) throw Object.assign(new Error(receipt.error?.message || receipt.data?.
    reason || "操作未完成"), { code: receipt.error?.code || receipt.kind });
    return receipt.data;
  };
  async function query({ objectiveId, date, allDates } = {}) {
    if (objectiveId) {
      if (!migrated(objectiveId)) return legacy.query({ objectiveId, date, allDates });
      const data = unwrap(await getService().domain.execute("legacy.query", { date, all_dates: allDates }, binding(objectiveId)));
      return { success: true, ...data };
    }
    const hasModern = fs.existsSync(baseDir) && fs.readdirSync(baseDir, { withFileTypes: true }).some((entry) => entry.isDirectory() &&
    migrated(entry.name));
    if (!hasModern) return legacy.query({ date, allDates });
    const modern = await getService().execute("spaces.list", {}, { trusted: true, global: true });
    const result = { success: true, objectives: [], key_points: [], schedules: [], errors: modern.data?.errors || [] };
    for (const space of modern.data?.spaces || []) {
      try {
        const part = await query({ objectiveId: space.objectiveId || space.id, date, allDates });
        for (const key of ["objectives", "key_points", "schedules"]) result[key].push(...part[key] || []);
      } catch (error) {
        result.errors.push({ objective_id: space.id, code: error.code || "STORAGE_ERROR", message: error.message });
      }
    }
    return result;
  }
  return { query, async checkin(input) {
    let objectiveId = input.objectiveId;
    if (!objectiveId) {
      const data2 = await query({ allDates: true });
      const matches = data2.schedules.filter((item) => item.id === input.scheduleId);
      if (matches.length !== 1) throw Object.assign(new Error(matches.length ? "日程ID存在歧义，请指定目标" :
      "未找到日程"), { code: matches.length ? "AMBIGUOUS_ID" : "NOT_FOUND" });
      objectiveId = matches[0].objective_id || matches[0].objectiveId;
    }
    if (!migrated(objectiveId)) return legacy.checkin({ ...input, objectiveId });
    const result = await getService().domain.execute("legacy.checkin", { schedule_id: input.scheduleId, status: input.status,
    note: input.note, date: input.date, occurrence_key: input.occurrenceKey }, binding(objectiveId));
    const data = unwrap(result);
    return { success: true, operationId: result.operationId, schedule: { id: input.scheduleId, objective_id: objectiveId,
    status: data.state, checkin_note: data.note, ...data } };
  }, async capture(input) {
    if (!migrated(input.objectiveId)) return legacy.capture(input);
    const result = await getService().domain.execute("legacy.capture", { inspiration: input.inspiration }, binding(input.
    objectiveId));
    const data = unwrap(result);
    const item = data.item || data.inspiration || data;
    return { success: true, operationId: result.operationId, inspiration: { id: item.id || data.itemId, text: item.fields?.
    text || item.body || input.inspiration, ...item } };
  } };
}
export {
  createCompatibilityStore
};
