const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const crypto = require('crypto');

// ========== Config ==========
const PORT = 3000;
const TOKEN_EXPIRY = '30d';

// ========== Database Setup ==========
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'toolbox.db');
const fs = require('fs');
const dbDir = path.dirname(DB_PATH);
try { fs.mkdirSync(dbDir, { recursive: true }); } catch {}

// Persistent JWT secret: reuse across restarts so tokens survive.
// Priority: env var JWT_SECRET > file <dbDir>/jwt.secret > generate & save.
const JWT_SECRET = (() => {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16) return process.env.JWT_SECRET;
  const secretFile = path.join(dbDir, 'jwt.secret');
  try {
    if (fs.existsSync(secretFile)) {
      const s = fs.readFileSync(secretFile, 'utf8').trim();
      if (s.length >= 16) return s;
    }
  } catch {}
  const s = crypto.randomBytes(48).toString('hex');
  try { fs.writeFileSync(secretFile, s, { mode: 0o600 }); } catch (e) { console.warn('写入 jwt.secret 失败:', e.message); }
  return s;
})();

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    user_id INTEGER PRIMARY KEY,
    title TEXT DEFAULT 'My Toolbox',
    theme TEXT DEFAULT 'light',
    drag_enabled INTEGER DEFAULT 0,
    logo_icon TEXT DEFAULT '{"type":"emoji","value":"🧰"}',
    click_effect INTEGER DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS tools (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    category TEXT DEFAULT '',
    description TEXT DEFAULT '',
    icon_type TEXT DEFAULT 'auto',
    icon_emoji TEXT DEFAULT '',
    icon_custom TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    UNIQUE(user_id, name),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// ========== Lightweight migrations (additive, idempotent) ==========
// Add new columns to existing DBs without breaking data.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    console.log(`[migrate] ${table}.${column} added`);
  }
}
ensureColumn('settings', 'click_effect', 'click_effect INTEGER DEFAULT 1');
ensureColumn('users', 'role', "role TEXT DEFAULT 'user'");

// Ensure first user is admin
const firstUser = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
if (firstUser) {
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(firstUser.id);
}

// ========== Prepared Statements ==========
const stmts = {
  findUser: db.prepare('SELECT * FROM users WHERE username = ?'),
  createUser: db.prepare('INSERT INTO users (username, password) VALUES (?, ?)'),
  createSettings: db.prepare('INSERT INTO settings (user_id) VALUES (?)'),
  getSettings: db.prepare('SELECT * FROM settings WHERE user_id = ?'),
  updateSettings: db.prepare('UPDATE settings SET title=?, theme=?, drag_enabled=?, logo_icon=?, click_effect=? WHERE user_id=?'),
  getTools: db.prepare('SELECT * FROM tools WHERE user_id = ? ORDER BY sort_order ASC, created_at DESC'),
  getTool: db.prepare('SELECT * FROM tools WHERE id = ? AND user_id = ?'),
  createTool: db.prepare('INSERT INTO tools (id, user_id, name, url, category, description, icon_type, icon_emoji, icon_custom, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?)'),
  updateTool: db.prepare("UPDATE tools SET name=?, url=?, category=?, description=?, icon_type=?, icon_emoji=?, icon_custom=?, updated_at=datetime('now') WHERE id=? AND user_id=?"),
  deleteTool: db.prepare('DELETE FROM tools WHERE id = ? AND user_id = ?'),
  updateToolOrder: db.prepare('UPDATE tools SET sort_order = ? WHERE id = ? AND user_id = ?'),
  getCategories: db.prepare('SELECT name FROM categories WHERE user_id = ? ORDER BY id ASC'),
  addCategory: db.prepare('INSERT OR IGNORE INTO categories (user_id, name) VALUES (?, ?)'),
  setCategories: db.prepare('DELETE FROM categories WHERE user_id = ?'),
  getMaxOrder: db.prepare('SELECT COALESCE(MAX(sort_order), 0) as max_order FROM tools WHERE user_id = ?'),
};

// ========== Default tools for new user ==========
const DEFAULT_TOOLS = [
  { name: 'Google 日历', url: 'https://calendar.google.com', category: '效率', description: '日程安排与时间管理' },
  { name: 'Google 翻译', url: 'https://translate.google.com', category: '翻译', description: 'Google 提供的免费在线翻译服务' },
  { name: 'Notion', url: 'https://www.notion.so', category: '效率', description: '全能型笔记与项目管理工具' },
  { name: 'ChatGPT', url: 'https://chat.openai.com', category: 'AI', description: 'OpenAI 的智能对话助手' },
  { name: 'GitHub', url: 'https://github.com', category: '开发', description: '全球最大的代码托管平台' },
  { name: 'Stack Overflow', url: 'https://stackoverflow.com', category: '开发', description: '开发者问答社区' },
  { name: '天气查询', url: 'https://www.weather.com', category: '生活', description: '全球天气预报与实时天气' },
  { name: 'JSON 格式化', url: 'https://jsonformatter.org', category: '开发', description: '在线 JSON 格式化与校验工具' },
];

const DEFAULT_CATEGORIES = ['效率', '开发', '生活', '翻译', 'AI'];

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 9); }

const initNewUser = db.transaction((userId) => {
  stmts.createSettings.run(userId);
  DEFAULT_CATEGORIES.forEach(cat => stmts.addCategory.run(userId, cat));
  DEFAULT_TOOLS.forEach((t, i) => {
    stmts.createTool.run(uid(), userId, t.name, t.url, t.category, t.description, 'auto', '', '', i);
  });
});

// ========== Express App ==========
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ========== Auth Middleware ==========
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录' });
  }
  try {
    const decoded = jwt.verify(header.slice(7), JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

// ========== Auth Routes ==========
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名长度 2-20 个字符' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 个字符' });

  const existing = stmts.findUser.get(username);
  if (existing) return res.status(409).json({ error: '用户名已存在' });

  const hash = bcrypt.hashSync(password, 10);
  const result = stmts.createUser.run(username, hash);
  const userId = result.lastInsertRowid;

  // Init default data
  initNewUser(userId);

  const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
  res.json({ token, user: { id: userId, username } });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });

  const user = stmts.findUser.get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
  res.json({ token, user: { id: user.id, username: user.username } });
});

// ========== Admin Middleware ==========
function adminAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录' });
  }
  try {
    const decoded = jwt.verify(header.slice(7), JWT_SECRET);
    req.userId = decoded.userId;
    const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: '无管理员权限' });
    }
    next();
  } catch {
    return res.status(401).json({ error: '登录已过期' });
  }
}

// ========== Admin API ==========
// Get all users with stats
app.get('/api/admin/users', adminAuth, (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.username, u.role, u.created_at,
      (SELECT COUNT(*) FROM tools WHERE user_id = u.id) as tool_count,
      (SELECT COUNT(*) FROM categories WHERE user_id = u.id) as category_count
    FROM users u ORDER BY u.id ASC
  `).all();
  res.json({ users });
});

// Get single user detail with tools and settings
app.get('/api/admin/users/:id', adminAuth, (req, res) => {
  const user = db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const tools = stmts.getTools.all(user.id).map(t => ({
    id: t.id, name: t.name, url: t.url, category: t.category,
    description: t.description, iconType: t.icon_type, iconEmoji: t.icon_emoji,
    iconCustom: t.icon_custom, sortOrder: t.sort_order, createdAt: t.created_at
  }));
  const settings = stmts.getSettings.get(user.id);
  const categories = stmts.getCategories.all(user.id).map(c => c.name);
  res.json({ user, tools, settings: settings ? {
    title: settings.title, theme: settings.theme,
    dragEnabled: !!settings.drag_enabled,
    logoIcon: JSON.parse(settings.logo_icon || '{}')
  } : null, categories });
});

// Delete user (cannot delete self)
app.delete('/api/admin/users/:id', adminAuth, (req, res) => {
  const targetId = parseInt(req.params.id);
  if (targetId === req.userId) return res.status(400).json({ error: '不能删除自己' });
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  res.json({ success: true });
});

// Toggle user role
app.put('/api/admin/users/:id/role', adminAuth, (req, res) => {
  const targetId = parseInt(req.params.id);
  if (targetId === req.userId) return res.status(400).json({ error: '不能修改自己的角色' });
  const { role } = req.body;
  if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: '无效角色' });
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, targetId);
  res.json({ success: true });
});

// Reset user password
app.put('/api/admin/users/:id/password', adminAuth, (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: '密码至少6个字符' });
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(parseInt(req.params.id));
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, user.id);
  res.json({ success: true });
});

// Delete a tool of any user
app.delete('/api/admin/tools/:id', adminAuth, (req, res) => {
  const tool = db.prepare('SELECT id FROM tools WHERE id = ?').get(req.params.id);
  if (!tool) return res.status(404).json({ error: '工具不存在' });
  db.prepare('DELETE FROM tools WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Edit a tool of any user
app.put('/api/admin/tools/:id', adminAuth, (req, res) => {
  const { name, url, category, description, iconType, iconEmoji, iconCustom } = req.body;
  if (!name || !url) return res.status(400).json({ error: '名称和地址不能为空' });
  const tool = db.prepare('SELECT * FROM tools WHERE id = ?').get(req.params.id);
  if (!tool) return res.status(404).json({ error: '工具不存在' });
  db.prepare("UPDATE tools SET name=?, url=?, category=?, description=?, icon_type=?, icon_emoji=?, icon_custom=?, updated_at=datetime('now') WHERE id=?")
    .run(name, url, category || '', description || '', iconType || 'auto', iconEmoji || '', iconCustom || '', req.params.id);
  if (category) {
    db.prepare('INSERT OR IGNORE INTO categories (user_id, name) VALUES (?, ?)').run(tool.user_id, category);
  }
  res.json({ success: true });
});

// Add a tool for any user
app.post('/api/admin/tools', adminAuth, (req, res) => {
  const { userId, name, url, category, description, iconType, iconEmoji, iconCustom } = req.body;
  if (!userId || !name || !url) return res.status(400).json({ error: '用户ID、名称和地址不能为空' });
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const id = uid();
  const maxOrder = stmts.getMaxOrder.get(userId).max_order;
  stmts.createTool.run(id, userId, name, url, category || '', description || '', iconType || 'auto', iconEmoji || '', iconCustom || '', maxOrder + 1);
  if (category) {
    db.prepare('INSERT OR IGNORE INTO categories (user_id, name) VALUES (?, ?)').run(userId, category);
  }
  res.json({ success: true, toolId: id });
});

// Update settings of any user
app.put('/api/admin/users/:id/settings', adminAuth, (req, res) => {
  const userId = parseInt(req.params.id);
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const { title, theme, dragEnabled, logoIcon, clickEffect } = req.body;
  const existing = stmts.getSettings.get(userId);
  if (!existing) { stmts.createSettings.run(userId); }
  stmts.updateSettings.run(
    title || 'My Toolbox',
    theme || 'light',
    dragEnabled ? 1 : 0,
    JSON.stringify(logoIcon || { type: 'emoji', value: '🧰' }),
    clickEffect === false ? 0 : 1,
    userId
  );
  res.json({ success: true });
});

// Dashboard stats
app.get('/api/admin/stats', adminAuth, (req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const toolCount = db.prepare('SELECT COUNT(*) as c FROM tools').get().c;
  const catCount = db.prepare('SELECT COUNT(DISTINCT name) as c FROM categories').get().c;
  const recentUsers = db.prepare('SELECT id, username, created_at FROM users ORDER BY id DESC LIMIT 5').all();
  res.json({ userCount, toolCount, catCount, recentUsers });
});

// Return user role in /api/me
app.get('/api/me', auth, (req, res) => {
  const user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({ user });
});

// Serve admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ========== Settings Routes ==========
app.get('/api/settings', auth, (req, res) => {
  const s = stmts.getSettings.get(req.userId);
  if (!s) return res.json({ title: 'My Toolbox', theme: 'light', dragEnabled: false, logoIcon: { type: 'emoji', value: '🧰' }, clickEffect: true });
  res.json({
    title: s.title,
    theme: s.theme,
    dragEnabled: !!s.drag_enabled,
    logoIcon: JSON.parse(s.logo_icon || '{"type":"emoji","value":"🧰"}'),
    clickEffect: s.click_effect == null ? true : !!s.click_effect
  });
});

app.put('/api/settings', auth, (req, res) => {
  const { title, theme, dragEnabled, logoIcon, clickEffect } = req.body;
  stmts.updateSettings.run(
    title || 'My Toolbox',
    theme || 'light',
    dragEnabled ? 1 : 0,
    JSON.stringify(logoIcon || { type: 'emoji', value: '🧰' }),
    clickEffect === false ? 0 : 1,
    req.userId
  );
  res.json({ success: true });
});

// ========== Categories Routes ==========
app.get('/api/categories', auth, (req, res) => {
  const cats = stmts.getCategories.all(req.userId).map(c => c.name);
  res.json({ categories: cats });
});

app.put('/api/categories', auth, (req, res) => {
  const { categories } = req.body;
  if (!Array.isArray(categories)) return res.status(400).json({ error: '参数错误' });
  stmts.setCategories.run(req.userId);
  categories.forEach(cat => stmts.addCategory.run(req.userId, cat));
  res.json({ success: true });
});

// ========== Tools Routes ==========
app.get('/api/tools', auth, (req, res) => {
  const tools = stmts.getTools.all(req.userId).map(t => ({
    id: t.id,
    name: t.name,
    url: t.url,
    category: t.category,
    description: t.description,
    iconType: t.icon_type,
    iconEmoji: t.icon_emoji,
    iconCustom: t.icon_custom,
    sortOrder: t.sort_order,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  }));
  res.json({ tools });
});

app.post('/api/tools', auth, (req, res) => {
  const { name, url, category, description, iconType, iconEmoji, iconCustom } = req.body;
  if (!name || !url) return res.status(400).json({ error: '名称和地址不能为空' });
  const id = uid();
  const maxOrder = stmts.getMaxOrder.get(req.userId).max_order;
  stmts.createTool.run(id, req.userId, name, url, category || '', description || '', iconType || 'auto', iconEmoji || '', iconCustom || '', maxOrder + 1);
  if (category) stmts.addCategory.run(req.userId, category);
  const tool = stmts.getTool.get(id, req.userId);
  res.json({ tool: { id: tool.id, name: tool.name, url: tool.url, category: tool.category, description: tool.description, iconType: tool.icon_type, iconEmoji: tool.icon_emoji, iconCustom: tool.icon_custom, sortOrder: tool.sort_order } });
});

app.put('/api/tools/:id', auth, (req, res) => {
  const { name, url, category, description, iconType, iconEmoji, iconCustom } = req.body;
  if (!name || !url) return res.status(400).json({ error: '名称和地址不能为空' });
  const existing = stmts.getTool.get(req.params.id, req.userId);
  if (!existing) return res.status(404).json({ error: '工具不存在' });
  stmts.updateTool.run(name, url, category || '', description || '', iconType || 'auto', iconEmoji || '', iconCustom || '', req.params.id, req.userId);
  if (category) stmts.addCategory.run(req.userId, category);
  res.json({ success: true });
});

app.delete('/api/tools/:id', auth, (req, res) => {
  const existing = stmts.getTool.get(req.params.id, req.userId);
  if (!existing) return res.status(404).json({ error: '工具不存在' });
  stmts.deleteTool.run(req.params.id, req.userId);
  res.json({ success: true });
});

app.put('/api/tools-order', auth, (req, res) => {
  const { order } = req.body; // array of tool ids in desired order
  if (!Array.isArray(order)) return res.status(400).json({ error: '参数错误' });
  const updateOrder = db.transaction(() => {
    order.forEach((id, idx) => {
      stmts.updateToolOrder.run(idx, id, req.userId);
    });
  });
  updateOrder();
  res.json({ success: true });
});

// ========== Explore / Recommend API (public, no auth) ==========
const RECOMMEND_DATA = [
  { id:'chatgpt', name:'ChatGPT', url:'https://chat.openai.com', cat:'对话', emoji:'🤖', color:'#10A37F', tag:'最热',
    desc:'OpenAI 旗舰对话 AI，支持 GPT-4o', detail:'ChatGPT 是 OpenAI 推出的大语言模型对话产品，支持文字、图片、语音等多模态交互。GPT-4o 是最新旗舰模型，具备极强的推理、编程、写作和创意能力。支持插件生态、自定义 GPTs、数据分析、联网搜索等高级功能，是目前全球用户量最大的 AI 对话工具。' },
  { id:'claude', name:'Claude', url:'https://claude.ai', cat:'对话', emoji:'🧠', color:'#D97706', tag:'热门',
    desc:'Anthropic 出品，擅长长文分析与编程', detail:'Claude 是 Anthropic 公司推出的 AI 助手，以安全、有用和诚实为核心设计理念。Claude 3.5 Sonnet 具备业界领先的代码生成和长文本理解能力，支持 200K tokens 超长上下文窗口，特别适合文档分析、学术研究、代码开发等专业场景。' },
  { id:'gemini', name:'Gemini', url:'https://gemini.google.com', cat:'对话', emoji:'✨', color:'#4285F4', tag:'热门',
    desc:'Google 多模态 AI，深度整合搜索', detail:'Gemini 是 Google DeepMind 推出的多模态 AI 模型，深度整合 Google 搜索、Gmail、Google Docs 等全家桶产品。支持文本、图片、视频、代码等多种输入方式，能够实时联网获取最新信息，是 Google 生态用户的首选 AI 助手。' },
  { id:'midjourney', name:'Midjourney', url:'https://www.midjourney.com', cat:'创作', emoji:'🎨', color:'#7C3AED', tag:'创作',
    desc:'顶级 AI 绘画工具，艺术感极强', detail:'Midjourney 是当前最受欢迎的 AI 图像生成工具之一，以其出色的艺术风格和审美水准著称。通过自然语言描述即可生成高质量图片，支持多种风格、比例和细节控制。广泛应用于概念设计、插画创作、产品展示等领域，V6 版本大幅提升了真实感和文字渲染能力。' },
  { id:'cursor', name:'Cursor', url:'https://www.cursor.com', cat:'开发', emoji:'⚡', color:'#2563EB', tag:'开发',
    desc:'AI 驱动的代码编辑器，效率翻倍', detail:'Cursor 是一款基于 VS Code 的 AI 代码编辑器，内置强大的代码补全、重构和对话功能。支持 Tab 智能补全、Cmd+K 内联编辑、Chat 对话式编程等功能，能够理解整个项目上下文。被众多开发者评为最佳 AI 编程工具，显著提升开发效率。' },
  { id:'perplexity', name:'Perplexity', url:'https://www.perplexity.ai', cat:'搜索', emoji:'🔍', color:'#22D3EE', tag:'搜索',
    desc:'AI 搜索引擎，实时联网回答', detail:'Perplexity 是一款 AI 驱动的搜索引擎，能够实时联网搜索并以结构化方式呈现答案，每个回答都附带来源链接。支持学术搜索、视频搜索、文件分析等高级功能，Pro 版本可选择 GPT-4、Claude 等多种模型。被誉为"搜索引擎的未来"。' },
  { id:'suno', name:'Suno', url:'https://suno.com', cat:'音乐', emoji:'🎵', color:'#EC4899', tag:'音乐',
    desc:'AI 音乐生成，输入文字即可作曲', detail:'Suno 是领先的 AI 音乐创作平台，用户只需输入文字描述或歌词，即可自动生成包含人声、乐器和编曲的完整歌曲。V4 版本支持多种音乐风格，音质和创意水平令人印象深刻。适合音乐爱好者、内容创作者和短视频制作者使用。' },
  { id:'gamma', name:'Gamma', url:'https://gamma.app', cat:'办公', emoji:'📊', color:'#F97316', tag:'办公',
    desc:'AI 一键生成精美 PPT 和文档', detail:'Gamma 是一款 AI 演示文稿和文档生成工具，输入主题或大纲即可自动生成设计精美的幻灯片、网页文档或报告。内置丰富的模板和视觉元素，支持嵌入图表、视频和互动内容。是职场人士高效制作演示材料的利器。' },
  { id:'v0', name:'v0 by Vercel', url:'https://v0.dev', cat:'开发', emoji:'🖥️', color:'#000000', tag:'开发',
    desc:'AI 前端界面生成，描述即代码', detail:'v0 是 Vercel 推出的 AI 前端代码生成工具，通过自然语言描述即可生成基于 React、Tailwind CSS 和 shadcn/ui 的高质量 UI 组件。支持迭代修改和实时预览，大幅降低了前端开发门槛，适合快速原型设计和 UI 开发。' },
  { id:'pika', name:'Pika', url:'https://pika.art', cat:'视频', emoji:'🎬', color:'#8B5CF6', tag:'视频',
    desc:'AI 视频生成与编辑，创意无限', detail:'Pika 是一款创新的 AI 视频生成和编辑平台，支持文字生成视频、图片生成视频、视频风格转换等多种功能。Pika 2.0 大幅提升了视频质量和运动一致性，支持场景扩展、唇形同步等高级特效，适合创意内容创作和社交媒体运营。' },
  { id:'bolt', name:'Bolt.new', url:'https://bolt.new', cat:'开发', emoji:'⚡', color:'#6366F1', tag:'开发',
    desc:'AI 全栈应用生成，一句话建站', detail:'Bolt.new 由 StackBlitz 推出，是一款 AI 全栈应用开发工具。用户只需用自然语言描述需求，即可在浏览器中自动生成、调试和部署完整的 Web 应用。支持多种前后端技术栈，一键部署到云端，让非技术人员也能快速构建 Web 应用。' },
  { id:'kimi', name:'Kimi', url:'https://kimi.moonshot.cn', cat:'对话', emoji:'🌙', color:'#1E293B', tag:'对话',
    desc:'月之暗面出品，支持 20 万字长文', detail:'Kimi 是月之暗面（Moonshot AI）推出的 AI 助手，以超长上下文处理能力著称，支持一次性输入 20 万字的超长文本。特别适合长文档阅读、学术论文分析、法律合同审查等场景。同时支持联网搜索、文件解析、数据分析等实用功能。' },
  { id:'doubao', name:'豆包', url:'https://www.doubao.com', cat:'对话', emoji:'🫘', color:'#00D1A0', tag:'对话',
    desc:'字节跳动 AI 助手，多模态能力强', detail:'豆包是字节跳动推出的 AI 智能助手，基于云雀大模型打造。支持多轮对话、文档分析、图片理解、写作辅助等功能，具备出色的中文理解能力。内置丰富的智能体生态，覆盖学习、工作、娱乐等各种场景，是国内最受欢迎的 AI 助手之一。' },
  { id:'tongyi', name:'通义千问', url:'https://tongyi.aliyun.com', cat:'对话', emoji:'🌐', color:'#FF6A00', tag:'对话',
    desc:'阿里巴巴大模型，企业级应用', detail:'通义千问是阿里巴巴推出的大语言模型产品，具备强大的多模态理解和生成能力。支持文本对话、文档解析、图片理解、代码生成等功能。Qwen 系列模型在开源社区表现出色，企业版本深度整合阿里云生态，适合企业级 AI 应用开发。' },
  { id:'deepseek', name:'DeepSeek', url:'https://chat.deepseek.com', cat:'对话', emoji:'🔬', color:'#4F46E5', tag:'热门',
    desc:'深度求索开源大模型，推理能力强', detail:'DeepSeek 是深度求索公司推出的 AI 对话助手，基于自研大模型 DeepSeek-V3/R1。以出色的推理能力和代码生成能力著称，在多项基准测试中表现优异。完全开源的技术路线使其在开发者社区中广受好评，API 价格极具竞争力。' },
  { id:'notion-ai', name:'Notion AI', url:'https://www.notion.so/product/ai', cat:'办公', emoji:'📝', color:'#000000', tag:'办公',
    desc:'笔记与文档的 AI 助手', detail:'Notion AI 是集成在 Notion 平台中的 AI 功能，能够自动生成、编辑、总结和翻译文档内容。支持 AI 数据库自动填充、智能问答、内容改写等功能，与 Notion 的笔记、项目管理和知识库深度融合，是知识工作者的效率利器。' },
  { id:'canva', name:'Canva AI', url:'https://www.canva.com', cat:'设计', emoji:'🖌️', color:'#00C4CC', tag:'设计',
    desc:'AI 设计工具，模板丰富一键出图', detail:'Canva 是全球最受欢迎的在线设计平台，内置 Magic Studio AI 功能套件。支持 AI 图片生成、背景移除、一键排版、视频编辑等功能，拥有海量设计模板。适合社交媒体运营、市场营销和个人创意设计，即使零基础也能做出专业设计。' },
  { id:'runway', name:'Runway', url:'https://runwayml.com', cat:'视频', emoji:'🎥', color:'#0A0A0A', tag:'视频',
    desc:'专业级 AI 视频编辑与生成', detail:'Runway 是专业级 AI 视频创作平台，Gen-3 Alpha 模型能生成高质量、高一致性的视频内容。支持文字生视频、图片生视频、运动笔刷、绿幕抠像等 30+ 种 AI 工具。广泛应用于影视制作、广告创意和内容创作领域，曾参与多部奥斯卡获奖影片的特效制作。' },
  { id:'elevenlabs', name:'ElevenLabs', url:'https://elevenlabs.io', cat:'语音', emoji:'🎤', color:'#2563EB', tag:'语音',
    desc:'最自然的 AI 语音合成与克隆', detail:'ElevenLabs 是行业领先的 AI 语音技术公司，提供极其自然的文本转语音、语音克隆和语音翻译服务。支持 29 种语言，可以用几秒钟的样本克隆任何人的声音。广泛应用于有声书制作、视频配音、游戏角色和客服系统等场景。' },
  { id:'kling', name:'Kling AI', url:'https://klingai.com', cat:'视频', emoji:'🎞️', color:'#FF4500', tag:'视频',
    desc:'快手出品，AI 视频生成黑马', detail:'Kling AI 是快手推出的 AI 视频生成工具，凭借出色的运动理解和物理模拟能力迅速成为行业黑马。支持最长 2 分钟的高质量视频生成，运动一致性和画面质量达到国际一流水平。同时支持图片动画化、视频续写和唇形同步等功能。' },
  { id:'ideogram', name:'Ideogram', url:'https://ideogram.ai', cat:'创作', emoji:'🎯', color:'#8B5CF6', tag:'创作',
    desc:'AI 图像生成，文字渲染极佳', detail:'Ideogram 是一款以文字渲染能力著称的 AI 图像生成工具，能够在生成的图片中准确渲染文字，这是其他 AI 绘画工具的短板。2.0 版本在整体图像质量和创意表现上都有大幅提升，特别适合制作海报、Logo、封面等需要文字与图像结合的设计作品。' },
  { id:'replit', name:'Replit Agent', url:'https://replit.com', cat:'开发', emoji:'💻', color:'#F26207', tag:'开发',
    desc:'AI 编程代理，对话式开发应用', detail:'Replit 是一款在线 IDE 和 AI 编程平台，其 Agent 功能可以通过对话自动完成完整的应用开发流程。从需求分析、代码编写、调试测试到一键部署，全程自动化。支持数十种编程语言，内置数据库和部署服务，让编程变得前所未有的简单。' },
  { id:'lovable', name:'Lovable', url:'https://lovable.dev', cat:'开发', emoji:'❤️', color:'#E11D48', tag:'开发',
    desc:'AI 全栈开发，描述需求即可建站', detail:'Lovable（原 GPT-Engineer）是一款 AI 全栈应用开发平台，用户只需描述产品需求，即可自动生成包含前后端的完整 Web 应用。支持 React、Supabase 等主流技术栈，具备可视化编辑和实时预览功能，一键部署上线。被誉为"最接近产品经理梦想的 AI 工具"。' },
  { id:'heygen', name:'HeyGen', url:'https://www.heygen.com', cat:'视频', emoji:'👤', color:'#6D28D9', tag:'视频',
    desc:'AI 数字人视频生成，多语言唇同步', detail:'HeyGen 是领先的 AI 数字人视频生成平台，可以从照片或模板创建逼真的 AI 数字人形象，自动生成带唇形同步的视频内容。支持 40+ 种语言的自动翻译和配音，广泛应用于营销视频、培训课程、产品介绍等商业场景。' },
  { id:'dify', name:'Dify', url:'https://dify.ai', cat:'平台', emoji:'🛠️', color:'#2563EB', tag:'平台',
    desc:'开源 LLM 应用开发平台', detail:'Dify 是一个开源的大语言模型应用开发平台，提供可视化的 Prompt 编排、RAG 管道、Agent 工作流和模型管理能力。支持对接 OpenAI、Claude、千问等数百种模型，内置向量数据库和应用监控。帮助开发者快速构建和部署生产级 AI 应用。' },
  { id:'coze', name:'Coze', url:'https://www.coze.com', cat:'平台', emoji:'🤹', color:'#5B6EF5', tag:'平台',
    desc:'字节跳动 AI Bot 开发平台', detail:'Coze（扣子）是字节跳动推出的 AI Bot 开发平台，提供零代码的 Bot 构建体验。支持插件调用、知识库、长期记忆、定时任务和工作流编排等功能，可一键发布到飞书、微信、Discord 等多个渠道。适合快速构建各类智能体和自动化助手。' },
  { id:'napkin', name:'Napkin AI', url:'https://www.napkin.ai', cat:'办公', emoji:'📈', color:'#F59E0B', tag:'办公',
    desc:'AI 自动将文字转为精美图表', detail:'Napkin AI 是一款创新的 AI 可视化工具，能够自动分析文字内容并转换为精美的信息图表、流程图和示意图。只需粘贴文字或输入 URL，即可一键生成专业的数据可视化图表。适合报告制作、数据展示和内容传播。' },
  { id:'luma', name:'Luma AI', url:'https://lumalabs.ai', cat:'3D', emoji:'🌀', color:'#7C3AED', tag:'3D',
    desc:'AI 3D 模型生成与场景重建', detail:'Luma AI 是一款 AI 3D 技术平台，Dream Machine 可以从文字或图片生成高质量 3D 模型和视频。同时提供 NeRF 三维场景重建能力，用手机拍摄即可生成逼真的 3D 场景。广泛应用于游戏开发、建筑可视化、电商产品展示等领域。' },
  { id:'copilot', name:'Copilot', url:'https://copilot.microsoft.com', cat:'办公', emoji:'🪟', color:'#0078D4', tag:'办公',
    desc:'微软 AI 助手，整合 Office 全家桶', detail:'Microsoft Copilot 是微软推出的 AI 助手，深度整合 Windows、Office 365、Bing 搜索等微软生态产品。可以在 Word 中自动撰写文档、Excel 中分析数据、PowerPoint 中生成演示文稿、Teams 中总结会议内容，显著提升办公生产力。' },
  { id:'metaso', name:'秘塔搜索', url:'https://metaso.cn', cat:'搜索', emoji:'🔎', color:'#3B82F6', tag:'搜索',
    desc:'无广告 AI 搜索引擎，结构化回答', detail:'秘塔搜索是一款国产 AI 搜索引擎，以无广告、结构化回答为核心特色。支持简洁、深入、研究三种搜索模式，自动整合多来源信息并给出带引用的结构化回答。特别适合学术研究、深度调研和信息整理，是国内最受好评的 AI 搜索产品之一。' },
];

app.get('/api/explore/list', (req, res) => {
  const { cat, q } = req.query;
  let list = RECOMMEND_DATA.map(({ detail, ...rest }) => rest);
  if (cat && cat !== '全部') list = list.filter(t => t.cat === cat);
  if (q) { const kw = q.toLowerCase(); list = list.filter(t => t.name.toLowerCase().includes(kw) || t.desc.toLowerCase().includes(kw) || t.cat.toLowerCase().includes(kw)); }
  const cats = [...new Set(RECOMMEND_DATA.map(t => t.cat))];
  res.json({ tools: list, categories: cats });
});

app.get('/api/explore/:id', (req, res) => {
  const tool = RECOMMEND_DATA.find(t => t.id === req.params.id);
  if (!tool) return res.status(404).json({ error: '工具不存在' });
  res.json({ tool });
});

app.get('/explore', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'explore.html'));
});

// ========== SPA Fallback ==========
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== Start ==========
app.listen(PORT, () => {
  console.log(`✅ My Toolbox 服务已启动: http://localhost:${PORT}`);
});
