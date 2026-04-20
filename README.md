# 个人工具汇总网页 — 需求文档（v2）

> 从最初的「单页 + localStorage」版本演进为「多用户 + 云端同步 + Docker 部署」的完整小应用。
> 线上地址：http://159.75.56.177 ｜ 仓库：https://github.com/lui2015/myHomePage

---

## 一、项目概述

| 项目 | 说明 |
|------|------|
| 项目名称 | 个人工具汇总网页（My Toolbox） |
| 项目类型 | 前后端一体 Web 应用（Node 静态托管 + REST API） |
| 目标用户 | 个人 / 小团队，每人一套独立的工具集 |
| 核心价值 | 将日常使用的在线工具集中展示，支持多设备云端同步、一站式访问与管理 |
| 当前版本 | v2.x（云端化完成） |

---

## 二、核心功能需求

### 2.1 账号体系

- **注册 / 登录**：用户名 + 密码，密码 `bcrypt` 加盐哈希存储
- **鉴权**：JWT（`Authorization: Bearer <token>`），有效期 `30d`
- **密钥持久化**：`JWT_SECRET` 持久化到数据卷（`jwt.secret` 文件），容器重启 token 不失效
- **多用户隔离**：每个用户独立的工具、分类、设置，通过 `user_id` 外键 + `ON DELETE CASCADE` 严格隔离

### 2.2 工具管理（CRUD）

- **展示**：卡片网格布局，卡片内容 = 图标 + 名称 + 描述 + 操作按钮
- **图标**：支持三种来源
  - `auto`：自动抓取目标站点 favicon（`https://www.google.com/s2/favicons?domain=xxx`）
  - `emoji`：选用任意 Emoji
  - `custom`：自定义图片 URL
- **新增 / 编辑**：同一模态框复用，表单字段见下
- **删除**：二次确认
- **搜索**：顶部搜索框，按 名称 / 描述 / URL 实时模糊过滤
- **分类筛选**：标签栏切换，支持「全部」
- **拖拽排序**：可在设置中开启，开启后可按住卡片拖动重排，顺序云端持久化（`sort_order`）

**表单字段**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| 工具名称 | 文本 | ✅ | 如「Google 翻译」 |
| 工具地址 | URL | ✅ | 自动校验协议合法性 |
| 分类标签 | 下拉 / 可新建 | ❌ | 与「分类」共享 |
| 工具描述 | 文本域 | ❌ | 简要说明 |
| 图标类型 | 单选 | ❌ | auto / emoji / custom |
| 图标值 | 视类型而定 | ❌ | emoji 字符 或 图片 URL |

### 2.3 分类管理

- 分类列表存储在独立表 `categories`（每用户独立）
- 新建工具时可直接新建分类
- 设置里可批量管理分类（重命名 / 删除，删除分类时关联工具的 `category` 字段会被清空）

### 2.4 个性化设置（全量云端同步）

| 设置项 | 字段 | 说明 | 默认值 |
|--------|------|------|--------|
| 站点标题 | `title` | 顶部 Logo 右侧标题 | `My Toolbox` |
| 主题 | `theme` | 6 款主题（light/dark/ocean/sunset/forest/cyber 等） | `light` |
| 拖拽排序 | `drag_enabled` | 是否启用卡片拖动 | `false` |
| Logo 图标 | `logo_icon` | `{type:'emoji'\|'custom', value:'...'}` | `🧰` |
| 点击特效 | `click_effect` | 点击卡片/按钮时的粒子/水波特效 | `true` |

> 所有设置均通过 `GET/PUT /api/settings` 同步到 SQLite，**换设备 / 清浏览器缓存不会丢**。

### 2.5 数据持久化

- 服务端 SQLite（`better-sqlite3`）+ WAL 日志模式
- 数据文件放在 `/app/data/toolbox.db`（Docker 卷挂载，容器销毁数据不丢）
- 轻量级迁移：`ensureColumn(table, col, ddl)` 幂等函数，新增字段自动 `ALTER TABLE`，老库平滑升级

---

## 三、系统架构

```
┌─────────────────────────────────────────────────────────┐
│                      Browser (SPA)                       │
│  public/index.html  ——  原生 HTML/CSS/JS，零框架依赖      │
│  登录态：localStorage 只存 token；业务数据全部走 API       │
└───────────────────────────┬─────────────────────────────┘
                            │ fetch + JWT
┌───────────────────────────▼─────────────────────────────┐
│                Node.js + Express (server.js)             │
│  · /api/register /api/login /api/me                     │
│  · /api/settings (GET/PUT)                              │
│  · /api/categories (GET/PUT)                            │
│  · /api/tools (GET/POST) /api/tools/:id (PUT/DELETE)    │
│  · /api/tools-order (PUT)                               │
│  · auth 中间件：JWT 校验 + 注入 userId                    │
└───────────────────────────┬─────────────────────────────┘
                            │ better-sqlite3 (同步)
┌───────────────────────────▼─────────────────────────────┐
│              SQLite (WAL)  /app/data/toolbox.db          │
│  users │ settings │ tools │ categories                   │
└─────────────────────────────────────────────────────────┘
```

### 3.1 后端接口一览

| Method | Path | 说明 | 鉴权 |
|---|---|---|:---:|
| POST | `/api/register` | 注册 | — |
| POST | `/api/login` | 登录，返回 `{token, username}` | — |
| GET  | `/api/me` | 获取当前用户信息 | ✅ |
| GET  | `/api/settings` | 读取个性化设置 | ✅ |
| PUT  | `/api/settings` | 保存设置（title/theme/dragEnabled/logoIcon/clickEffect） | ✅ |
| GET  | `/api/categories` | 分类列表 | ✅ |
| PUT  | `/api/categories` | 覆盖式保存分类列表 | ✅ |
| GET  | `/api/tools` | 工具列表（按 sort_order 升序） | ✅ |
| POST | `/api/tools` | 新增工具 | ✅ |
| PUT  | `/api/tools/:id` | 编辑工具 | ✅ |
| DELETE | `/api/tools/:id` | 删除工具 | ✅ |
| PUT  | `/api/tools-order` | 批量更新排序 | ✅ |

### 3.2 数据库 Schema

```sql
-- 用户
users(id PK, username UNIQUE, password, created_at)

-- 设置（与 users 1:1）
settings(user_id PK/FK, title, theme, drag_enabled, logo_icon, click_effect)

-- 工具
tools(id PK[uuid], user_id FK, name, url, category, description,
      icon_type, icon_emoji, icon_custom, sort_order, created_at, updated_at)

-- 分类
categories(id PK, user_id FK, name, UNIQUE(user_id,name))
```

所有表的 `user_id` 均 `ON DELETE CASCADE`，删号即清空。

---

## 四、页面结构与交互

### 4.1 页面布局

```
┌──────────────────────────────────────────────────┐
│  顶部导航：Logo + 标题 | 搜索框 | 添加 | 设置 | 用户菜单 │
├──────────────────────────────────────────────────┤
│  分类标签栏：全部 | 效率 | 开发 | 生活 | 学习 | …     │
├──────────────────────────────────────────────────┤
│   ┌─────┐  ┌─────┐  ┌─────┐  ┌─────┐             │
│   │ 卡片 │  │ 卡片 │  │ 卡片 │  │ 卡片 │             │
│   └─────┘  └─────┘  └─────┘  └─────┘             │
│                  (可拖拽)                          │
├──────────────────────────────────────────────────┤
│  页脚                                             │
└──────────────────────────────────────────────────┘
```

### 4.2 关键交互

| 场景 | 行为 |
|---|---|
| 未登录访问 | 自动跳转登录/注册页 |
| 点击卡片主体 | 新标签页打开 URL，触发点击特效（可关） |
| 悬停卡片 | 微上浮 + 阴影加深，显示编辑/删除按钮 |
| 拖拽开启时 | 鼠标按住可拖动，松手后顺序立即落库 |
| 搜索框输入 | 本地实时过滤（不请求后端） |
| 切换主题 | 立即应用并保存到云端 |
| Token 失效/过期 | 自动登出回到登录页 |

---

## 五、UI 设计规范

### 5.1 主题系统（6 款）

| 主题 | 风格 | 主色 | 适用场景 |
|------|------|------|----------|
| light | 现代简约 | `#6366F1` | 默认，白天办公 |
| dark | 深色低亮 | `#818CF8` | 夜间 |
| ocean | 海洋蓝 | `#0EA5E9` | 清爽 |
| sunset | 落日橙 | `#F97316` | 温暖 |
| forest | 森林绿 | `#10B981` | 自然 |
| cyber | 赛博霓虹 | `#22D3EE` | 个性 |

所有主题通过 CSS 变量 + `[data-theme]` 属性切换，无需刷新。

### 5.2 响应式

| 屏幕宽度 | 卡片列数 |
|----------|:--------:|
| ≥ 1200px | 4 列 |
| 768 – 1199px | 3 列 |
| 480 – 767px | 2 列 |
| < 480px | 1 列 |

### 5.3 动效

- 卡片进出：`fadeInUp` / `fadeOutScale`
- 模态框：淡入 + 底部滑入
- 点击特效：可关闭的粒子 / 水波动画

---

## 六、技术栈

| 方面 | 选型 |
|------|------|
| 前端 | 原生 HTML + CSS + JavaScript（单文件 `public/index.html`，零依赖） |
| 后端 | Node.js 20 + Express 4 |
| 数据库 | SQLite（better-sqlite3，同步 API，WAL） |
| 鉴权 | JSON Web Token（jsonwebtoken） + bcryptjs |
| 容器 | Docker（基于 `node:20-slim`，apt/npm 腾讯云镜像加速） |
| 部署 | 腾讯云轻量应用服务器 + TAT + `docker run -v data:/app/data` |

---

## 七、部署与运维

### 7.1 本地开发

```bash
npm install
node server.js   # 监听 :3000
```

### 7.2 Docker 部署

```bash
docker build -t myhomepage .
docker run -d --name myhomepage \
  -p 80:3000 \
  -v /data/myhomepage:/app/data \
  --restart unless-stopped \
  myhomepage
```

数据卷 `/app/data` 同时存放 `toolbox.db` 和 `jwt.secret`，**不要删除**。

### 7.3 升级策略

- **小改动（只改 server.js / 静态文件）**：`docker cp` 热替换 + `docker restart`，秒级生效
- **改依赖 / Dockerfile**：重建镜像并替换容器
- **Schema 变更**：只允许通过 `ensureColumn` 做向后兼容的增列；禁止破坏性 DDL

---

## 八、安全与合规

- 密码：`bcryptjs` 10 轮加盐
- Token：HS256，密钥 ≥ 96 hex 字符，持久化且权限 `0600`
- SQL：全部 `prepare` + 参数绑定，无字符串拼接（满足安全规范）
- 输入校验：URL 协议、字段长度、分类白名单在服务端再校验一次
- CORS：默认同源，未开放跨域

---

## 九、已完成功能清单

- [x] 用户注册 / 登录 / JWT 鉴权（30d，密钥持久化）
- [x] 工具增删改查 + 自动 favicon / Emoji / 自定义图标
- [x] 分类管理（新建、重命名、删除）
- [x] 搜索 + 分类筛选
- [x] 拖拽排序（可开关，顺序云端同步）
- [x] 6 款主题切换
- [x] 自定义站点标题、Logo 图标
- [x] 点击特效开关
- [x] 全量设置云端同步（title/theme/drag/logo/clickEffect）
- [x] SQLite + WAL + 幂等迁移
- [x] Docker 化部署 + 数据卷
- [x] 响应式布局

---

## 十、后续规划

- [ ] 工具使用次数统计 / 按热度排序
- [ ] 浏览器书签一键导入 / JSON 导入导出
- [ ] 多级分类（文件夹）
- [ ] 工具卡片尺寸 / 布局密度切换
- [ ] 分享某个工具集合的只读页
- [ ] 第三方登录（GitHub OAuth）
- [ ] HTTPS + 域名 + CDN

---

## 十一、验收标准

1. 未登录访问被拦截到登录页，登录后自动跳回首页
2. 新建 / 编辑 / 删除工具全部实时落库，刷新不丢
3. 所有 5 项设置（标题/主题/拖拽/Logo/特效）在 A 设备改动后，B 设备重新登录立即生效
4. 拖拽排序保存后，刷新、换设备顺序仍然一致
5. 搜索 + 分类筛选组合工作正常
6. 主流浏览器（Chrome / Firefox / Safari / Edge）表现一致
7. 移动端响应式布局、触屏点击 / 拖拽正常
8. 容器 `docker restart` 后，用户无需重新登录（token 仍有效）
9. 老数据库能被新版本自动迁移（`ensureColumn` 日志正常输出）
