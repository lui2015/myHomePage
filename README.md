# 个人工具汇总网页 — 需求文档（v4）

> 从最初的「单页 + localStorage」版本演进为「多用户 + 云端同步 + 管理后台 + AI 工具探索」的完整应用。
> 线上地址：http://159.75.56.177 ｜ 仓库：https://github.com/lui2015/myHomePage

---

## 一、项目概述

| 项目 | 说明 |
|------|------|
| 项目名称 | 个人工具汇总网页（My Toolbox） |
| 项目类型 | 前后端一体 Web 应用（Node 静态托管 + REST API） |
| 目标用户 | 个人 / 小团队，每人一套独立的工具集 |
| 核心价值 | 将日常使用的在线工具集中展示，支持多设备云端同步、一站式访问与管理 |
| 当前版本 | v4.x（视图切换 + 多分类 + 多特效 + 密码管理后台） |

---

## 二、核心功能需求

### 2.1 账号体系

- **注册 / 登录**：用户名 + 密码，密码 `bcrypt` 加盐哈希存储
- **鉴权**：JWT（`Authorization: Bearer <token>`），有效期 `30d`
- **密钥持久化**：`JWT_SECRET` 持久化到数据卷（`jwt.secret` 文件），容器重启 token 不失效
- **多用户隔离**：每个用户独立的工具、分类、设置，通过 `user_id` 外键 + `ON DELETE CASCADE` 严格隔离
- **角色管理**：支持 `admin` / `user` 两种角色，第一个注册用户自动成为管理员
- **管理后台鉴权**：独立密码验证（环境变量 `ADMIN_PASSWORD` 配置），所有用户均可通过密码进入后台

### 2.2 工具管理（CRUD）

- **展示**：卡片网格布局，卡片内容 = 图标 + 名称 + 描述 + 操作按钮
- **图标**：支持三种来源
  - `auto`：自动抓取目标站点 favicon
  - `emoji`：选用任意 Emoji
  - `custom`：自定义图片 URL 或本地上传（Base64）
- **新增 / 编辑**：同一模态框复用
- **删除**：二次确认
- **搜索**：顶部搜索框，按名称 / 描述 / 分类实时模糊过滤
- **分类筛选**：标签栏切换，支持「全部」
- **拖拽排序**：可在设置中开启，基于 Pointer Events 实现流畅拖拽，手柄触发 + 浮动副本 + 插入指示线，顺序云端持久化
- **视图切换**：支持网格视图（▦）和列表视图（☰），切换状态本地记忆

**表单字段**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| 工具名称 | 文本 | ✅ | 如「Google 翻译」 |
| 工具地址 | URL | ✅ | 自动校验协议合法性 |
| 分类标签 | 多选 chips / 可新建 | ❌ | 支持多选，逗号分隔存储 |
| 工具描述 | 文本域 | ❌ | 简要说明 |
| 图标类型 | 四选一 | ❌ | 自动获取 / Emoji / 图片URL / 本地上传 |

### 2.3 分类管理

- 分类列表存储在独立表 `categories`（每用户独立）
- 新建工具时可直接新建分类
- 设置里可批量管理分类

### 2.4 个性化设置（全量云端同步）

| 设置项 | 字段 | 说明 | 默认值 |
|--------|------|------|--------|
| 站点标题 | `title` | 顶部 Logo 右侧标题 | `My Toolbox` |
| 主题 | `theme` | 6 款主题（light/dark/ocean/sunset/forest/cyberpunk） | `light` |
| 拖拽排序 | `drag_enabled` | 是否启用卡片拖动 | `false` |
| Logo 图标 | `logo_icon` | `{type:'emoji'|'image', value:'...'}` | `🧰` |
| 点击特效 | `click_effect` | 6 种特效可选（off/firework/stars/confetti/bubbles/ripple） | `firework` |

### 2.5 头像下拉菜单

点击右上角头像展开下拉菜单，统一收拢以下入口：

- ⚙️ 设置
- 🛡️ 管理后台（仅管理员可见）
- 📤 导出数据（JSON 格式备份）
- 📥 导入数据（从 JSON 文件批量导入工具和分类）
- 🚪 退出登录

### 2.6 管理后台（`/admin`）

仅通过独立管理密码验证可访问，所有用户均可在头像下拉菜单中看到入口。

#### 仪表盘
- 注册用户数、工具总数、分类总数统计

#### 用户管理
| 操作 | 说明 |
|------|------|
| 查看列表 | ID、用户名、角色、工具数、分类数、注册时间 |
| 查看详情 | 展开用户的个性化设置、分类标签、所有工具列表 |
| 编辑设置 | 修改用户的网站标题、主题、拖拽排序、点击特效 |
| 重置密码 | 为任意用户设置新密码 |
| 角色切换 | 设为管理员 / 取消管理员（不能修改自己） |
| 删除用户 | 二次确认，级联删除所有数据（不能删除自己） |

#### 工具管理（代管用户工具）
| 操作 | 说明 |
|------|------|
| 查看工具 | 在用户详情中展示所有工具卡片 |
| 添加工具 | 为任意用户添加工具（名称、地址、分类、描述、图标） |
| 编辑工具 | 修改任意用户的工具信息 |
| 删除工具 | 删除任意用户的工具 |

### 2.7 热门 AI 工具推荐

#### 首页推荐区
- 页面底部「🔥 热门 AI 工具推荐」区域
- 从 30 个 AI 工具池中随机展示 10 个
- 支持「🔄 换一批」随机刷新
- 支持「🔍 查看更多」跳转探索页
- 每个卡片有「＋ 添加」按钮，已添加的显示「✓ 已添加」

#### 探索页面（`/explore`）
- **分类筛选**：对话、搜索、创作、开发、视频、音乐、办公、设计、语音、3D、平台等
- **搜索**：实时过滤工具名称和描述
- **工具卡片**：3 列网格布局，30 个精选 AI 工具
- **详情弹窗**：点击卡片展开，含：
  - 大图标 + 名称 + 分类标签
  - 官网链接
  - 100-150 字深度介绍
  - 「＋ 添加到我的工具箱」和「🌐 访问官网」按钮
- **一键添加**：登录用户可直接添加推荐工具到自己的工具箱

**AI 工具池（30 个）**：

| 分类 | 工具 |
|------|------|
| 对话 | ChatGPT、Claude、Gemini、Kimi、豆包、通义千问、DeepSeek |
| 搜索 | Perplexity、秘塔搜索 |
| 创作 | Midjourney、Ideogram |
| 开发 | Cursor、v0、Bolt.new、Replit Agent、Lovable |
| 视频 | Pika、Runway、Kling AI、HeyGen |
| 音乐 | Suno |
| 办公 | Gamma、Notion AI、Copilot、Napkin AI |
| 设计 | Canva AI |
| 语音 | ElevenLabs |
| 3D | Luma AI |
| 平台 | Dify、Coze |

### 2.8 数据持久化

- 服务端 SQLite（`better-sqlite3`）+ WAL 日志模式
- 数据文件放在 `/app/data/toolbox.db`（Docker 卷挂载）
- 轻量级迁移：`ensureColumn(table, col, ddl)` 幂等函数

---

## 三、系统架构

```
┌──────────────────────────────────────────────────────────┐
│                      Browser (SPA)                        │
│  public/index.html   — 首页（工具管理 + 推荐）              │
│  public/admin.html   — 管理后台                            │
│  public/explore.html — AI 工具探索                         │
│  登录态：localStorage 只存 token；业务数据全部走 API         │
└────────────────────────────┬─────────────────────────────┘
                             │ fetch + JWT
┌────────────────────────────▼─────────────────────────────┐
│                 Node.js + Express (server.js)              │
│  · Auth: /api/register /api/login /api/me                 │
│  · Settings: /api/settings (GET/PUT)                      │
│  · Categories: /api/categories (GET/PUT)                  │
│  · Tools: /api/tools CRUD + /api/tools-order              │
│  · Admin: /api/admin/users, tools, settings, stats        │
│  · Explore: /api/explore/list, /api/explore/:id           │
│  · Middleware: auth (JWT) + adminAuth (JWT + role check)   │
└────────────────────────────┬─────────────────────────────┘
                             │ better-sqlite3 (同步)
┌────────────────────────────▼─────────────────────────────┐
│               SQLite (WAL)  /app/data/toolbox.db          │
│  users │ settings │ tools │ categories                    │
└──────────────────────────────────────────────────────────┘
```

### 3.1 后端接口一览

| Method | Path | 说明 | 鉴权 |
|---|---|---|:---:|
| POST | `/api/register` | 注册 | — |
| POST | `/api/login` | 登录 | — |
| GET  | `/api/me` | 获取当前用户信息（含 role） | ✅ |
| GET  | `/api/settings` | 读取个性化设置 | ✅ |
| PUT  | `/api/settings` | 保存设置 | ✅ |
| GET  | `/api/categories` | 分类列表 | ✅ |
| PUT  | `/api/categories` | 覆盖式保存分类列表 | ✅ |
| GET  | `/api/tools` | 工具列表（按 sort_order 升序） | ✅ |
| POST | `/api/tools` | 新增工具 | ✅ |
| PUT  | `/api/tools/:id` | 编辑工具 | ✅ |
| DELETE | `/api/tools/:id` | 删除工具 | ✅ |
| PUT  | `/api/tools-order` | 批量更新排序 | ✅ |
| POST | `/api/admin/login` | 管理后台密码验证，返回 admin token | — |
| GET  | `/api/admin/stats` | 仪表盘统计 | 🔒 Admin |
| GET  | `/api/admin/users` | 用户列表（含工具/分类统计） | 🔒 Admin |
| GET  | `/api/admin/users/:id` | 用户详情（工具+设置+分类） | 🔒 Admin |
| DELETE | `/api/admin/users/:id` | 删除用户 | 🔒 Admin |
| PUT  | `/api/admin/users/:id/role` | 切换角色 | 🔒 Admin |
| PUT  | `/api/admin/users/:id/password` | 重置密码 | 🔒 Admin |
| PUT  | `/api/admin/users/:id/settings` | 修改用户设置 | 🔒 Admin |
| POST | `/api/admin/tools` | 为用户添加工具 | 🔒 Admin |
| PUT  | `/api/admin/tools/:id` | 编辑任意工具 | 🔒 Admin |
| DELETE | `/api/admin/tools/:id` | 删除任意工具 | 🔒 Admin |
| GET  | `/api/explore/list` | 推荐工具列表（支持 cat/q 参数） | — |
| GET  | `/api/explore/:id` | 推荐工具详情 | — |

### 3.2 数据库 Schema

```sql
-- 用户
users(id PK, username UNIQUE, password, role DEFAULT 'user', created_at)

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

### 4.1 页面列表

| 页面 | 路径 | 说明 |
|------|------|------|
| 首页 | `/` | 登录/注册 + 工具卡片管理 + 热门推荐 |
| 管理后台 | `/admin` | 用户管理 + 工具管理 + 设置管理 |
| AI 工具探索 | `/explore` | 分类浏览 + 搜索 + 详情 + 一键添加 |

### 4.2 首页布局

```
┌──────────────────────────────────────────────────┐
│  顶部导航：Logo + 标题 | 搜索框 | ＋添加 | 头像▾   │
│                          头像下拉：设置/管理/导出… │
├──────────────────────────────────────────────────┤
│  分类标签栏：全部 | 效率 | 开发 | 生活 | AI | …    │
├──────────────────────────────────────────────────┤
│  共 N 个工具                         [▦ 网格][☰ 列表] │
├──────────────────────────────────────────────────┤
│   ┌─────┐  ┌─────┐  ┌─────┐  ┌─────┐            │
│   │ 卡片 │  │ 卡片 │  │ 卡片 │  │ 卡片 │            │
│   └─────┘  └─────┘  └─────┘  └─────┘            │
│                  (可拖拽排序)                      │
├──────────────────────────────────────────────────┤
│  🔥 热门 AI 工具推荐        [🔄换一批] [🔍查看更多] │
│   ┌───┐ ┌───┐ ┌───┐ ┌───┐ ┌───┐                 │
│   │推荐│ │推荐│ │推荐│ │推荐│ │推荐│ (10 个，可添加) │
│   └───┘ └───┘ └───┘ └───┘ └───┘                 │
├──────────────────────────────────────────────────┤
│  页脚                                             │
└──────────────────────────────────────────────────┘
```

### 4.3 关键交互

| 场景 | 行为 |
|---|---|
| 未登录访问 | 自动跳转登录/注册页 |
| 点击卡片主体 | 新标签页打开 URL，触发点击特效（可关） |
| 悬停卡片 | 微上浮 + 阴影加深，显示编辑/删除按钮 |
| 拖拽开启时 | 按住 ≡ 手柄拖动，浮动副本跟随鼠标，插入指示线标记位置 |
| 点击头像 | 展开下拉菜单（设置/管理/导出/导入/退出） |
| 点击外部 | 自动关闭下拉菜单 |
| 推荐区换一批 | 从 30 个工具池随机抽取 10 个展示 |
| 推荐区查看更多 | 跳转 `/explore` 探索页 |
| 探索页点击卡片 | 弹出详情弹窗，含深度介绍 |
| Token 失效 | 自动登出回到登录页 |

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
| cyberpunk | 赛博霓虹 | `#22D3EE` | 个性 |

### 5.2 响应式

| 屏幕宽度 | 首页卡片列数 | 探索页列数 |
|----------|:--------:|:--------:|
| ≥ 1200px | 4 列 | 3 列 |
| 768 – 1199px | 3 列 | 2 列 |
| 480 – 767px | 2 列 | 2 列 |
| < 480px | 1 列 | 1 列 |

---

## 六、技术栈

| 方面 | 选型 |
|------|------|
| 前端 | 原生 HTML + CSS + JavaScript（单文件页面，零框架依赖） |
| 后端 | Node.js 20 + Express 4 |
| 数据库 | SQLite（better-sqlite3，同步 API，WAL） |
| 鉴权 | JSON Web Token + bcryptjs |
| 容器 | Docker（基于 `node:20-slim`） |
| 部署 | 腾讯云轻量应用服务器 + systemd 服务托管 |

---

## 七、部署与运维

### 7.1 本地开发

```bash
npm install
node server.js   # 监听 :3000
```

### 7.2 服务器直接部署（推荐）

```bash
# 上传项目文件到服务器
npm install --production
mkdir -p /root/toolbox-data
DB_PATH=/root/toolbox-data/toolbox.db node server.js
```

配合 systemd 管理：

```ini
[Unit]
Description=My Toolbox Web App
After=network.target

[Service]
Type=simple
WorkingDirectory=/root/myHomePage
Environment=DB_PATH=/root/toolbox-data/toolbox.db
ExecStart=/usr/local/bin/node server.js
Restart=always

[Install]
WantedBy=multi-user.target
```

### 7.3 Docker 部署

```bash
docker build -t my-toolbox .
docker run -d --name my-toolbox \
  -p 3000:3000 \
  -v /root/toolbox-data:/app/data \
  --restart unless-stopped \
  my-toolbox
```

---

## 八、安全与合规

- 密码：`bcryptjs` 10 轮加盐
- Token：HS256，密钥 ≥ 96 hex 字符，持久化且权限 `0600`
- SQL：全部 `prepare` + 参数绑定，无字符串拼接
- 管理后台：双重鉴权（JWT + role check），非 admin 返回 403
- 输入校验：URL 协议、字段长度在服务端校验
- CORS：默认同源，未开放跨域

---

## 九、已完成功能清单

- [x] 用户注册 / 登录 / JWT 鉴权（30d，密钥持久化）
- [x] 角色管理（admin / user，首个用户自动 admin）
- [x] 工具增删改查 + 自动 favicon / Emoji / 自定义图标 / 本地上传
- [x] 分类管理（多选 chips + 新建，逗号分隔存储）
- [x] 搜索 + 分类筛选（支持多分类匹配）
- [x] 视图切换（网格 ▦ / 列表 ☰，本地记忆）
- [x] 流畅拖拽排序（Pointer Events，手柄触发 + 浮动副本 + 插入指示线）
- [x] 6 款主题切换
- [x] 自定义站点标题、Logo 图标
- [x] 6 种点击特效（关闭 / 烟花 / 星光 / 彩纸屑 / 气泡 / 水波）
- [x] 头像下拉菜单（设置/管理/导出/导入/退出）
- [x] 数据导出（JSON）和导入
- [x] 管理后台：独立密码验证（面向所有人开放入口）
- [x] 管理后台：用户管理（查看/删除/角色/密码重置）
- [x] 管理后台：工具管理（查看/添加/编辑/删除任意用户工具）
- [x] 管理后台：设置管理（修改任意用户的主题/标题等设置）
- [x] 管理后台：仪表盘统计
- [x] 首页热门 AI 工具推荐（30 个工具池，随机 10 个，换一批）
- [x] AI 工具探索页（分类筛选 + 搜索 + 详情弹窗 + 一键添加）
- [x] 全量设置云端同步
- [x] SQLite + WAL + 幂等迁移
- [x] Docker 化部署 + systemd 服务（80 端口）
- [x] 响应式布局

---

## 十、后续规划

- [ ] 工具使用次数统计 / 按热度排序
- [ ] 多级分类（文件夹）
- [ ] 工具卡片尺寸 / 布局密度切换
- [ ] 分享某个工具集合的只读页
- [ ] 第三方登录（GitHub OAuth / 微信）
- [ ] HTTPS + 域名 + CDN
- [ ] 推荐工具数据后台可配置（管理员可增删推荐工具）
- [ ] 用户行为分析（热门工具排行、活跃用户统计）
