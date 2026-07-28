# Orbit Control Center

轻量级个人仪表盘：聚合上游 API 中转站（NewAPI / Sub2API / OneAPI 等）与下游自营中转站的余额、消耗与收益，核算真实毛利与资金风险。

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
# 编辑 ENCRYPTION_SECRET 为随机长字符串

# 初始化数据库
npx prisma migrate dev

# 开发
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。

## 环境变量

| 变量 | 说明 |
|------|------|
| `DATABASE_URL` | SQLite 路径，默认 `file:./dev.db` |
| `ENCRYPTION_SECRET` | 加密 API Key 的密钥材料 |
| `DEFAULT_USD_CNY` | 默认美元兑人民币汇率 |

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

## 适配说明

- **NewAPI / OneAPI**：`GET /api/user/self`（用户令牌），Quota 默认 `500000 = $1`
- **Sub2API**：尝试多种个人额度接口
- **下游 Admin**：`/api/dashboard/`、`/api/data/`、`/api/topup/`、`/api/log/stat` 等

不同部署的路径可能略有差异；适配器会依次尝试并统一为 `{ success, balance, consumed }` 结构。

## 安全提示

本项目面向**个人本地**使用。若暴露到公网，请自行增加鉴权（如 Basic Auth / 反向代理登录），并轮换所有已配置的 API Key。
