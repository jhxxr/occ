# Liquid Glass 重设计 · 双主题自适应

Apple Liquid Glass 视觉语言（iOS 26 设计语言，我的知识截止到 2026 年初）+ 浅/深双主题。
视觉强度按你选的「明显」：侧边栏、顶栏、弹窗、**卡片**都用半透明毛玻璃，背景加柔和色晕。
切换方式：默认跟随系统，侧边栏底部提供 浅色/深色/自动 三态，选择存 localStorage。

## 现状评估（已勘查）

好消息：这个代码库**已经 ~99% 走 CSS 变量**，`@theme inline` 已把变量暴露给 Tailwind。
这意味着深色模式是「重定义变量」而不是「全局替换 4000 行 class」。已确认全库仅 3 处硬编码颜色。

需要处理的债务：
- 3 处硬编码色：`providers/page.tsx:733` `bg-black/55`、`:775` `bg-cyan text-white`、`:788` `bg-coral text-white`
- 14 处手写 `<table>`，thead/tbody 的 class 字符串逐字重复
- 8 处彩色状态面板（`border-coral/30 bg-coral/5` 等）各写一遍
- 4 处逐字重复的 spinner
- 2 处手搓 segmented control，激活态写法还不一致
- 3-4% alpha 的行底色（`bg-amber/[0.04]`）—— **在半透明卡片上会直接消失**，必须提成真令牌
- `--sidebar*` 现在恒为深灰，浅色模式下语义要反转

## 核心技术决策

**1. 主题机制**：`:root` 为浅色，`.dark` 类覆盖。Tailwind v4 用
`@custom-variant dark (&:where(.dark, .dark *));` 让 `dark:` 前缀跟 class 联动。
`@theme inline` 必须保留 —— inline 让工具类输出 `var(--surface)` 而非拷贝字面值，
这正是变量翻转能生效的前提。

**2. 防白闪**：`<html>` 上加 `suppressHydrationWarning`，body 开头插入同步内联
`<script>`，在 HTML 解析期（早于首帧绘制）读 localStorage 并打 class。
不用 `next/script beforeInteractive`——内联脚本对 pre-paint 更确定。

**3. `themeColor` 走 `generateViewport`**：本版本 `metadata.themeColor` / `colorScheme`
**已废弃**（已核对 `node_modules/next/dist/docs`，v13.2 起弃用）。用
`export const viewport: Viewport` 带 `prefers-color-scheme` media 数组。

**4. `color-scheme` 属性**必须跟着翻转，否则原生控件（日期选择器、下拉、滚动条）不跟随。

**5. backdrop-filter 降级**：`@supports not (backdrop-filter: blur(1px))` 时把玻璃填充
提到近乎不透明。不做这层，不支持的环境会看到糊成一片的文字。

## 可读性保障（这是「明显」玻璃的关键取舍）

财务数字的可读性不牺牲。具体约束：
- 正文 `--text` 对比度 ≥ 7:1，次要文字 ≥ 4.5:1，两个主题都要满足
- 卡片玻璃填充不低于 浅色 72% / 深色 58% 不透明度 —— 保证局部对比
- 背景色晕只用大尺度低透明径向渐变，不在表格区域制造局部明暗跳变
- `font-data` 表格数字始终 `--text` 满强度，不降级为 muted

诚实说明：通透感强化后，**极低对比的装饰性元素**（原来 3% 的行底色）观感会变，
所以我把它们提成 `--tint-*` 令牌并在深色下给更高 alpha，而不是任其消失。

## 令牌层设计（globals.css 重写）

```
层级       浅色                  深色
--bg       近白 + 色晕           近黑 (#000 系) + 色晕
--surface  玻璃 白 72%           玻璃 白 8% / 黑底 58%
--glass-*  填充/描边/高光/阴影   同名反相
--text     近黑                  近白
--accent   深青(可读于浅底)      亮青(可读于深底)
--series-N 6 色                  6 色提亮提饱和
```

新增令牌：`--glass-bg` `--glass-border` `--glass-highlight`（顶部内高光，玻璃的
标志性镜面边）`--scrim`（弹窗遮罩，替代 `bg-black/55`）`--on-accent`（替代 `text-white`）
`--tint-warn` `--tint-info`（行底色）`--ring`（焦点环）
半径 `--r-sm:10 --r-md:14 --r-lg:18 --r-xl:24` + 胶囊（iOS 26 圆角明显加大，同心内嵌）
动效 `--ease-spring: cubic-bezier(0.22,1,0.36,1)`

品牌色保留青绿家族（不擅自改成 iOS 系统蓝），仅按主题调明度/饱和以满足对比度。
想换成 `#007AFF`/`#0A84FF` 只需改一个令牌，我会在注释里标出位置。

## 新增组件（消除重复）

- `ui/table.tsx` — `Table/THead/TH/TBody/TR/TD` **基础件**（不是 columns 配置式
  DataTable）。14 处调用点的 padding/对齐/行底色各不相同，配置式会迫使我重写
  每处的单元格渲染逻辑，风险高；基础件把重复的默认值收进来，改动纯机械。
- `ui/callout.tsx` — 语义状态面板 `tone: error|warn|success|info|neutral`，收敛 8 处
- `ui/spinner.tsx` — 收敛 4 处
- `ui/segmented.tsx` — 收敛 2 处，统一激活态
- `ui/theme-toggle.tsx` — 三态切换（client，监听系统变化，auto 模式下跟随）

## 语义修正

现在 `amber` 同时表示「警告」和「这是一笔成本」，两个含义挤在一个颜色上。
我会拆开：`--warn`（警告）与 `--cost`（成本数字）分离为两个令牌，初始可给相近色值，
但语义解耦后以后能独立调。这处改动会在报表页可见，若你想保持完全一致我可以让两者同值。

## 落地阶段

**A. 令牌与骨架** — `globals.css` 全量重写、`layout.tsx`（viewport / 防闪脚本 /
`suppressHydrationWarning` / 背景色晕层）、`ui/theme-toggle.tsx`

**B. 基础组件** — `card` `button` `input`(含 Label/Select/Textarea) `badge`
+ 新建 `table` `callout` `spinner` `segmented`

**C. 框架层** — `layout/sidebar.tsx`（玻璃 + 挂载切换器 + sidebar 令牌语义反转）、
`layout/top-bar.tsx`、`login/page.tsx`（含 `bg-sidebar` 标记块修正）

**D. 页面适配** — dashboard 7 个组件、reports 3 个、`self-hosted/cost-ledger.tsx`、
`providers/page.tsx`（3 处硬编码色 + 弹窗玻璃化 + segmented 换用共享件）

**E. 表格调用点迁移** — settings、providers/[id]/usage(3表)、recharges、
downstream/[id]、self-hosted/[id](2表)、orphan-channel-panel、report-view(4表)

**F. 验证** — `npm run lint` + `npm run build` 必须通过；逐页核对浅/深两态；
确认无残留硬编码色（grep 兜底）；键盘焦点环在两个主题下都可见

实际改动约 27 个文件（比问你时估的 ~20 多，因为表格调用点比预想分散）。

---

## 落地结果（已完成）

28 个文件改动 + 5 个新组件（975 insertions / 751 deletions）。
tsc、eslint、`npm run build` 全部通过；浏览器实测浅/深两态。

### 实测对比度（WCAG AA 要求 4.5:1，正文目标 7:1）

| 组合 | 浅色 | 深色 |
|---|---|---|
| 正文 / 卡片 | 19.13 | 16.57 |
| 次要文字 | 9.13 | 10.04 |
| muted | 5.34 | 6.11 |
| accent | 5.81 | 10.70 |
| coral（错误） | 5.67 | 7.34 |
| mint（成功） | 6.31 | 10.07 |
| cost（成本） | 5.05 | 9.45 |
| on-accent / accent | 5.81 | 9.58 |

全部达标，正文远超 7:1 目标。

### 过程中修掉的两个真问题

**1. Lightning CSS 吃掉了 `backdrop-filter`（严重）**
原先按惯例把标准属性写在 `-webkit-` 前面，构建期 Lightning CSS 判定标准属性冗余
并删除，只留下 `-webkit-` 版本 —— Chrome 不认，**整个毛玻璃效果完全不生效**。
构建和 lint 都不会报错，只有在浏览器里查 computed style 才能发现
（`backdropFilter: "none"`）。修法：只写标准属性，让构建按 browserslist 自己加前缀。
同理 `@supports` 检测也不能手写双前缀。

**2. React Compiler 拦下 theme-toggle 的 effect + setState**
`react-hooks/set-state-in-effect` 报错：effect 里同步 setState 会引起级联渲染。
localStorage 属于 React 之外的系统，正确解法是 `useSyncExternalStore`
（服务端快照固定 `auto`，客户端 hydration 后自动切真实值），顺带白拿了跨标签页同步。

### 与计划的偏差

- 表格迁移比预估干净：全部 14 处收敛完毕，窄表（`px-2`/`px-3`）显式保留原 padding，
  宽表取 `px-4 py-2.5` 默认值。行状态底色统一走 `tone="warn"|"info"` 属性。
- 顺手清掉了计划外的重复：4 处 spinner、3 处裸 `<select>`、6 处裸 checkbox、
  1 处裸搜索 `<input>`（新增 `Checkbox` 导出）。
- `--warn` / `--cost` 已拆分，报表页成本数字走 `text-cost`；警告与计数仍用 `text-amber`。

### 已知遗留

- Metric 卡片原有的「顶部 2px 彩色边」在玻璃语言下改为纯阴影浮起。若想保留彩条，
  改 `metric-cards.tsx` / `report-view.tsx` 的 `Metric` 即可。
- 品牌色仍是青绿家族。想换 iOS 系统蓝只需改 `--accent` / `--accent-strong`
  （浅色 `#007AFF`、深色 `#0A84FF`），其余令牌会跟着走。

## 我不会碰的

业务逻辑、API 路由、Prisma schema、数据计算（`lib/` 下除 `utils.ts` 可能加个
class 辅助外不动）。纯表现层改造。
