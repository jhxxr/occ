# 把「自建 Sub2API」从上游节点里彻底分出来

## 问题根因（已核实）

1. **`SUB2_ADMIN` 从来没进过同步分发表。**
   `src/lib/adapters/index.ts:504` 的 `switch (type)` 只有 `SUB2API` / `ONEAPI` / `NEWAPI` / `OTHER`，
   自建站会掉进 `default` 去打 NewAPI 的 `/api/user/self`。
   `syncUpstreamProvider`（`src/lib/sync.ts:37`）也无条件对所有 provider 调 `fetchUpstreamBalance`，
   完全没走 `src/lib/sub2-admin/sync.ts` 那套 admin-key 逻辑。

2. **总览把自建站当普通上游渲染。**
   `getDashboardData()`（`src/lib/sync.ts:302`）`findMany` 不带 type 过滤，
   于是自建站进了「上游站点」卡片网格、进了 `totalUpstreamBalance*`、进了 `alerts`、进了成本饼图。

3. **上游站点页 / providers API 也没有隔离**，`GET /api/providers` 返回全部 provider。

4. **你库里那条记录本身建错了。** `cms4gx8pz0000lbmn25xb1m5r`「自建 Sub2API」的 `type` 是
   `SUB2API` 而不是 `SUB2_ADMIN`，`lastError` = "JWT 无效或已过期"，
   `SelfHostedGroup` / `SelfHostedAccount` 都是 0 条 —— 说明它是从「上游站点」页面按第三方面板加的。

## 已定口径

- 自建站的钱**不进**顶部四卡。顶部四卡只算第三方上游成本 vs 下游发放收入。
- 自建站在总览里**单独一个分区**：本月官方用量、卖出收入、账号采购成本、结余、追踪分组数。
- 库里那条错记录：**直接改成 `SUB2_ADMIN`**（并清掉 JWT 残留字段），之后在自建页面补 Admin Key。

## 改动清单

### 1. 新增 `src/lib/provider-kinds.ts`
集中类型常量，替掉散落的字符串字面量：
- `SELF_HOSTED_TYPE = "SUB2_ADMIN"`
- `RELAY_TYPES = ["NEWAPI", "SUB2API", "ONEAPI", "OTHER"]`
- `isSelfHosted(type)` / Prisma where 片段 `relayOnly` `selfHostedOnly`

### 2. `src/lib/sync.ts` — 同步分发
- `SyncResultItem.kind` 加 `"self-hosted"`。
- `syncUpstreamProvider(id)` 开头：读到 provider 后若 `isSelfHosted(type)`，
  **改调 `syncSelfHostedMeta(id)`**（走 X-API-Key + `/api/v1/admin/*`），
  返回 `kind: "self-hosted"`，不写 `SnapshotLog`、不碰 `lastBalance`、不跑充值检测。
  失败时写 `lastError` 并返回 `success: false`。
- `syncAll()` 分三段查：relay 上游、自建站、下游，各自走对应函数，
  自建站额外顺带刷已 track 分组最近 7 天用量（`syncSelfHostedGroupUsage`），
  这样「全量同步」对自建站是有意义的动作。
- `getDashboardData()`：
  - provider 查询拆成 `relayProviders`（`type: { notIn: [SUB2_ADMIN] }`）和 `selfHosted`。
  - `totalUpstreamBalance*` / `alerts` / `providerShares` / `providers[]` 全部只用 `relayProviders`。
  - 新增 `selfHosted[]`：每站聚合本月 `SelfHostedGroupDaily`（track=true）得到
    `monthOfficialCost` / `monthSellRevenueRmb` / `monthRequests`，
    加 `SelfHostedAccount`（track=true）的 `accountPurchaseRmb`、`trackedGroups` / `trackedAccounts`，
    以及 `lastSyncAt` / `lastError` / `groupCount` / `accountCount`。
  - 顶部 metrics 数值口径不变（已确认不并入）。

### 3. `src/app/api/sync/route.ts`
`target` 增加 `"self-hosted"`，转调同一个 `syncUpstreamProvider`（内部已分发）。
保留 `"upstream"` 兼容旧调用。

### 4. `src/app/api/providers/route.ts` — 防再建错
- `GET` 只返回 relay 类型（`where: { type: { notIn: ["SUB2_ADMIN"] } }`）。
- `POST` / `PUT` 的 zod enum 本来就不含 `SUB2_ADMIN`，补一条守卫：
  `PUT` 若目标记录是自建站 → 400「请到自建上游页面管理」，避免从上游页面改坏它。
- `DELETE` 同样拒绝删自建站（引导去 `/api/self-hosted`）。

### 5. 总览 UI
- `src/components/dashboard/self-hosted-grid.tsx`（新）：自建站卡片。
  紫色系（跟 `/self-hosted` 页的 `violet` badge 一致），展示
  本月官方用量 / 卖出收入 ¥ / 采购成本 ¥ / 结余，底部「打开面板」「分组与账号」「同步」。
  无 `OrbitRing`、无余额、无预警线 —— 因为自建站不是余额模型。
- `src/components/dashboard/dashboard-view.tsx`：
  `DashboardPayload` 加 `selfHosted[]`；在「上游站点」和图表之间插入
  「自建上游」分区（`data.selfHosted.length > 0` 才渲染）。
  「上游站点」小标题下的计数改成只数 relay。

### 6. `src/app/self-hosted/page.tsx` — 补齐管理能力
现在这页只能加/删。补：
- 每张卡加「同步」按钮（`POST /api/sync` target `self-hosted`），显示分组/账号数。
- 加「更新 Admin Key」内联表单（走已有的 `PUT /api/self-hosted`，
  它已经带 `adminProbe` 验证）—— 你那条转过来的记录需要用它补 Key。

### 7. `scripts/fix-self-hosted-type.js`（一次性）
把 `type: "SUB2API"` 且看起来是自建站的记录转成 `SUB2_ADMIN`：
- 按 id 或 `--name` 定位，默认 **dry-run**，加 `--apply` 才写。
- 写入：`type = "SUB2_ADMIN"`、`discountRate = 1`、`quotaPerDollar = 1`、
  清空 `accountEmail` / `accountPassword` / `refreshToken` / `tokenExpiresAt` / `apiKey`（JWT 无用）、
  `lastBalance = null`、`lastConsumed = null`、
  `lastError = "请补填 Admin API Key"`。
- 顺带清掉它名下可能存在的 `UpstreamApiKey` / `UpstreamUsageDaily` 脏数据（会先打印条数）。
- 跑完提示：去 `/self-hosted` 用「更新 Admin Key」补 `admin-xxxx`。

> `apiKey` 清空是有意的：那是个作废 JWT，留着只会让同步继续 401。
> 这一步只动你确认过的那条记录，且默认 dry-run 先给你看。

### 8. 文档
`README.md` 补一句自建上游 ≠ 上游站点的区别（一句话，不铺开）。

## 验证

1. `npx tsc --noEmit` + `npm run lint`
2. `node scripts/fix-self-hosted-type.js` 看 dry-run 输出 → `--apply`
3. `npm run build`
4. 浏览器过 `http://localhost:3000/`：确认自建站不再出现在「上游站点」网格、
   不在余额卡里、不在预警里；「自建上游」分区出现。
5. `/self-hosted` 补 Admin Key → 点同步 → 分组/账号数出来。
6. 点「全量同步」确认自建站不再报 JWT 错误。

## 不做

- 不动 `discountRate` 语义、不动第三方 SUB2API 的 Key 归因逻辑。
- 不把自建收入并进净利润（已确认）。
- 不加 schema 迁移 —— 现有 `SelfHosted*` 表够用。
