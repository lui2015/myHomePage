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

app.get('/api/me', auth, (req, res) => {
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({ user });
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

// ========== SPA Fallback ==========
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== Start ==========
app.listen(PORT, () => {
  console.log(`✅ My Toolbox 服务已启动: http://localhost:${PORT}`);
});
