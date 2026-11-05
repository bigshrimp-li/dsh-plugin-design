import { createHash, randomUUID } from "node:crypto";
const stable = (value) => JSON.stringify(value, (_key, val) => val && !Array.isArray(val) && typeof val === "object" ? Object.
fromEntries(Object.keys(val).sort().map((key) => [key, val[key]])) : val);
const hash = (value) => createHash("sha256").update(typeof value === "string" ? value : stable(value)).digest("hex");
const id = (prefix) => `${prefix}_${randomUUID()}`;
const clone = (value) => structuredClone(value);
function fail(code, message, kind = "failed") {
  return { kind, error: { code, message } };
}
function dataOf(receipt) {
  if (!receipt || !["read", "saved", "accepted", "pending", "trial"].includes(receipt.kind)) throw Object.assign(new Error(
  receipt?.error?.message || "操作未成功"), { code: receipt?.error?.code || receipt?.kind || "FAILED", receipt });
  return receipt.data;
}
const stateValue = (receipt) => {
  const data = dataOf(receipt);
  return data?.state || data;
};
function assertUser(binding) {
  if (!binding.trusted || !binding.userInitiated) throw new Error("此操作必须由用户审查入口发起");
}
const safeId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(value) && !["groups", "m\
igrations", ".", ".."].includes(value);
export {
  assertUser,
  clone,
  dataOf,
  fail,
  hash,
  id,
  safeId,
  stable,
  stateValue
};
