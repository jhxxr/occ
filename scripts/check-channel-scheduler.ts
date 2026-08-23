import assert from "node:assert/strict";
import { buildOptimizationActions, type SchedulableChannel } from "../src/lib/channel-scheduler.ts";

const base: SchedulableChannel = {
  siteId: "site",
  siteName: "站点",
  channelId: 1,
  name: "渠道",
  group: "g",
  enabled: true,
  health: "healthy",
  priority: 10,
  autoBan: false,
  requests24h: 100,
  requests7d: 500,
  issueRate24h: 0,
  responseTimeMs: 1000,
  rateMultiplier: 1,
  costMatched: true,
};

const costActions = buildOptimizationActions([
  base,
  { ...base, channelId: 2, name: "便宜", priority: 5, rateMultiplier: 0.1 },
]);
assert(costActions.some((item) => item.channelId === 2 && item.kind === "raise-priority"));
assert(costActions.some((item) => item.channelId === 1 && item.kind === "lower-priority"));

const unknown = buildOptimizationActions([{ ...base, costMatched: false, rateMultiplier: null }]);
assert.equal(unknown.length, 1);
assert.equal(unknown[0].kind, "cost-unknown");
assert(!unknown.some((item) => item.kind === "raise-priority"));

const autoBanned = buildOptimizationActions([{ ...base, health: "critical", autoBan: true }]);
assert(!autoBanned.some((item) => item.kind === "disable-candidate"));

const risks = buildOptimizationActions([
  { ...base, health: "critical", requests24h: 800, issueRate24h: 0.2 },
  { ...base, channelId: 2, name: "便宜", priority: 5, rateMultiplier: 0.1, requests24h: 2 },
]);
assert.equal(risks[0].kind, "disable-candidate");
assert.equal(risks[0].severity, "critical");
assert(risks.some((item) => item.reason.includes("当前节省有限")));

const crossGroup = buildOptimizationActions([
  base,
  { ...base, channelId: 2, group: "other", priority: 1, rateMultiplier: 0.1 },
]);
assert(!crossGroup.some((item) => item.kind === "raise-priority" || item.kind === "lower-priority"));

const unknownBoundary = buildOptimizationActions([
  { ...base, channelId: 3, priority: 20, rateMultiplier: null, costMatched: false },
  { ...base, channelId: 4, priority: 10, rateMultiplier: 0.1 },
  { ...base, channelId: 5, priority: 5, rateMultiplier: 1 },
]);
assert(!unknownBoundary.some((item) => item.channelId === 5 && item.kind === "lower-priority"));

console.log("channel scheduler checks passed");
