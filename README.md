#AI Control Center

轻量级个人仪表盘：聚合上游 API 中转站（NewAPI / Sub2API / OneAPI 等）的余额、消耗。

## 功能

- **凭证管理**：多站点配置，API Key AES-256-GCM 加密存储
- **数据同步**：手动/全量拉取余额、消耗、充值流水、下游按日消费
- **收益核算**：周/月服务毛利，实测法与倍率法双口径互校（见下文）
- **成本台账**：买号/订阅按记账日或有效期摊销，账号被风控可压缩结算
- **可视化**：指标卡、逐日趋势、成本占比、余额预警

## 技术栈

- Next.js 16 (App Router) + TypeScript
- Tailwind CSS 4 + 自定义深色控制台 UI
- Prisma 5 + MySQL
- Recharts

## 快速开始

```bash
# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 必填：ENCRYPTION_SECRET、AUTH_SECRET 各设为独立的随机长字符串
#      AUTH_USERNAME、AUTH_PASSWORD 设为你的登录账号密码

# 初始化数据库
npx prisma migrate dev

# 开发
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `DATABASE_URL` | **是** | MySQL 连接串，如 `mysql://user:pass@host:3306/db` |
| `ENCRYPTION_SECRET` | **是** | 加密存储 API Key / 密码的密钥材料，随机长字符串 |
| `AUTH_USERNAME` | **是** | 登录用户名（固定单账号，无注册） |
| `AUTH_PASSWORD` | **是** | 登录密码 |
| `AUTH_SECRET` | **是** | 签名会话 Cookie 的密钥，与 `ENCRYPTION_SECRET` 用不同的随机值 |
| `DEFAULT_USD_CNY` | 否 | 默认美元兑人民币汇率，默认 `7.2` |

四个必填项缺任意一个都无法登录：`AUTH_SECRET` 缺失会在签发/校验会话时抛错，`AUTH_USERNAME` 或 `AUTH_PASSWORD` 缺失则所有登录请求一律失败。已有数据库不要改动 `ENCRYPTION_SECRET`，否则已存的凭据无法解密。

Docker 部署的完整变量说明见 [DOCKER.md](DOCKER.md)。

## 收益核算

### 口径

```
服务毛利 = 消费收入 − 上游使用成本 − 额外成本
```

三条铁律：

- **充值不是收入。** 用户充值是预收款（负债），钱进来时服务还没发生。
- **已发放额度也不是收入。** 那是存量，用户没调用就不算赚到。
- **测试账号的消费不是收入。** 没人付钱给它，它只是把上游额度烧掉了。
  算进收入等于虚增利润。

收入 = **付费账号**在下游 NewAPI 日志里真实被扣掉的额度。
站点「排除名单」里的账号（测试号）单独存一列，用途见下。

### 差值对账

测试号虽然不算收入，但它确实烧了上游成本，所以另存一个**全站消费**口径：

```
全站消费（含测试号） − 上游成本 = 整体加价空间
付费账号消费        − 上游成本 − 额外成本 = 服务毛利
```

两个数分开看：前者衡量「买入卖出的整体差价」，后者才是真正赚到的钱。
报表里「差值对账」面板同时给出两者与整体加价倍数。

排除口径依赖 `/api/data/users`（按 username × 小时聚合）。拿不到逐账号数据时
收入会退回全站口径，并明确警告「测试号未剔除（收入偏高）」，而不是假装已经扣干净。

### 双口径互校

上下游计费细节不完全一致，单条算法都做不到绝对精准，所以两条同时跑、互相印证：

| | 算法 | 数据来源 |
|---|---|---|
| **实测法** | Σ 付费账号日志实际扣费 | `/api/log/stat` + `/api/data/users` 拆账号 |
| **倍率法** | Σ 官方基准用量 × 下游卖出倍率 | 上游用量明细 + `/api/option/` 的 `GroupRatio` |

官方基准用量优先取请求明细里的官方计价；缺失时按上游分组倍率还原（`实扣 ÷ 上游倍率`）。
两法差异率越小，估算越可信；差得远说明某一侧数据不全或倍率绑错了。

倍率法需要在「上游站点 → API Key」勾选**计入中转成本**，再绑定该 Key 卖到哪个下游站点/分组。
分组倍率自动同步，也可手工覆盖。

### 成本

- **上游使用成本** = Σ 计费 Key 当日实扣 × 当日购入成本率。成本率写入当日即冻结，
  以后改站点折扣率不会把历史成本重算一遍。没有 Key 级日志的上游回退为快照估算，报表标注来源。
- **额外成本**（买号、订阅）走成本台账，两种入账方式：
  - `一次性`：整笔计入记账日所属的自然周/月。
  - `按有效期摊销`：按天直线摊。**账号被风控时填「实际结束日」，整笔成本压缩到实际存活的那几天摊完**，
    受影响的历史周/月报随之回算。
- 自建 Sub2API 的「官方用量 × 卖出倍率」只是中间层估算，**不进总账** ——
  那批流量的真实收入已经在下游消费里，相加会重复确认。动态路由命中的上游消耗同理，只在上游成本计一次。

### 周期

自然周（周一至周日）与自然月，全部按 `Asia/Shanghai` 日历日，闭区间。

### 上游成本率

```
上游成本(RMB) = Σ (增量消耗 × 该站购入成本率 ¥/每 1 面值)
```

购入折扣示例：上游充值面值 $100 实付 ¥300 → 成本率 = 3.0。

## 自检

```bash
npm run check:reporting   # 周期边界 + 成本摊销的纯函数自检
npm run lint
npm run build
```

## 目录结构

```
src/
  app/                 # 页面与 API Routes
  components/          # UI、仪表盘、报表、布局
  lib/
    adapters/          # 上游/下游 API 适配器
    reporting-period.ts  # 自然周/月边界（Asia/Shanghai）
    financial-report.ts  # 双口径收益报表
    operating-cost.ts    # 额外成本入账与摊销
    downstream-usage.ts  # 下游按日消费 + 分组倍率同步
    profit.ts          # 成本与收支核算
    sync.ts            # 同步编排
    crypto.ts          # 密钥加解密
prisma/
  schema.prisma
scripts/
  check-reporting.ts   # 纯函数自检
```

## API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST/PUT/DELETE | `/api/providers` | 上游 CRUD |
| GET/POST/PUT/DELETE | `/api/downstream` | 下游 CRUD |
| POST | `/api/sync` | `{ target: "all" \| "upstream" \| "downstream", id? }` |
| POST | `/api/downstream/usage-sync` | 拉取下游按日真实消费 + 分组倍率 |
| GET | `/api/financial-report` | 周/月收益报表（`period=week\|month`、`offset`、或 `startDay`+`endDay`） |
| GET/POST/PUT/DELETE | `/api/operating-costs` | 额外成本台账 |
| GET | `/api/dashboard` | 仪表盘聚合数据 |
| GET/PUT | `/api/settings` | 汇率等设置 |
| GET/POST/DELETE | `/api/extension/tokens` | 扩展注入 token 管理（需登录） |
| GET/POST | `/api/extension/inject` | 扩展凭据注入（Header token） |

## 浏览器扩展注入

创建 token 时，明文只在 `POST /api/extension/tokens` 的响应中显示一次，数据库仅保存 SHA-256 verifier 和显示前缀。扩展调用注入接口时必须使用以下任一 Header：

```text
X-Orbit-Token: oct_...
Authorization: Bearer oct_...
```

禁止把 token 放在 URL、日志、截图或问题报告中。升级到 hash-token migration 后，历史 query-string 注入链接会被全部撤销，需要登录控制台重新生成 token。

## 适配说明

- **NewAPI / OneAPI**：`GET /api/user/self`（用户令牌），Quota 默认 `500000 = $1`
- **Sub2API**：尝试多种个人额度接口
- **下游 Admin**：`/api/dashboard/`、`/api/data/`、`/api/topup/`、`/api/log/stat` 等

不同部署的路径可能略有差异；适配器会依次尝试并统一为 `{ success, balance, consumed }` 结构。

## 安全提示

本项目面向**个人**使用，只有一个固定账号，没有注册和多用户隔离。

全站页面与 API 默认需要登录（会话 Cookie，30 天有效期），唯一例外是浏览器扩展注入接口 `/api/extension/inject`，它不校验登录、改用 Header 中的扩展 token 鉴权。

暴露到公网前请注意：

- 前置 TLS 反向代理，`AUTH_PASSWORD` 用强密码。
- 上游站点地址（`baseUrl`）由你自行填写，服务端会直接请求该地址，未对内网地址做限制。不要填入不受信任的地址。
- 扩展 token 长期有效且无速率限制，不用时在设置中禁用或删除。
- 登录接口没有失败次数限制，公网部署建议在反向代理层加限流。
