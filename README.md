# Orbit Control Center

轻量级个人仪表盘：聚合上游 API 中转站（NewAPI / Sub2API / OneAPI 等）的余额、消耗。

## 功能

- **凭证管理**：多上游 + 多下游配置，API Key AES-256-GCM 加密存储
- **数据同步**：手动/全量拉取余额、消耗、充值流水
- **利润引擎**：按购入折扣率计算上游成本，对比下游收入得净利润
- **可视化**：指标卡、30 日收入 vs 成本、上游成本占比、余额预警

## 技术栈

- Next.js 16 (App Router) + TypeScript
- Tailwind CSS 4 + 自定义深色控制台 UI
- Prisma 5 + SQLite
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
| `DATABASE_URL` | 否 | SQLite 路径，默认 `file:./dev.db` |
| `ENCRYPTION_SECRET` | **是** | 加密存储 API Key / 密码的密钥材料，随机长字符串 |
| `AUTH_USERNAME` | **是** | 登录用户名（固定单账号，无注册） |
| `AUTH_PASSWORD` | **是** | 登录密码 |
| `AUTH_SECRET` | **是** | 签名会话 Cookie 的密钥，与 `ENCRYPTION_SECRET` 用不同的随机值 |
| `DEFAULT_USD_CNY` | 否 | 默认美元兑人民币汇率，默认 `7.2` |

四个必填项缺任意一个都无法登录：`AUTH_SECRET` 缺失会在签发/校验会话时抛错，`AUTH_USERNAME` 或 `AUTH_PASSWORD` 缺失则所有登录请求一律失败。已有数据库不要改动 `ENCRYPTION_SECRET`，否则已存的凭据无法解密。

Docker 部署的完整变量说明见 [DOCKER.md](DOCKER.md)。

## 利润计算

```
上游成本(RMB) = Σ (同步周期内增量消耗 USD × 该站购入折扣 ¥/$1)
下游收入(RMB) = Σ 充值/收入（USD 则 × 汇率）
净利润       = 下游收入 − 上游成本
```

购入折扣示例：上游充值面值 $100 实际支付 ¥300 → 折扣率 = 3.0（即 ¥3 / $1 额度）。

## 目录结构

```
src/
  app/                 # 页面与 API Routes
  components/          # UI、仪表盘、布局
  lib/
    adapters/          # 上游/下游 API 适配器
    profit.ts          # 利润核算
    sync.ts            # 同步编排
    crypto.ts          # 密钥加解密
prisma/
  schema.prisma
```

## API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST/PUT/DELETE | `/api/providers` | 上游 CRUD |
| GET/POST/PUT/DELETE | `/api/downstream` | 下游 CRUD |
| POST | `/api/sync` | `{ target: "all" \| "upstream" \| "downstream", id? }` |
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
