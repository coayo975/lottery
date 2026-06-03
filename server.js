const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3456;

// ── CORS（允许 GitHub Pages 跨域调用） ──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
const CODES_FILE = path.join(DATA_DIR, 'codes.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DRAW_LOG = path.join(DATA_DIR, 'draw_log.jsonl');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return fallback; }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

function initData() {
  ensureDir(DATA_DIR);

  if (!fs.existsSync(CODES_FILE)) {
    saveJSON(CODES_FILE, {
      weekCards: [],
      coupons: [],
      dayCards: []
    });
  }

  if (!fs.existsSync(STATS_FILE)) {
    saveJSON(STATS_FILE, {
      totalDraws: 0,
      totalUsers: 0,
      uniqueIPs: [],
      prizes: { dayCard: 0, coupon: 0, hourCard: 0, weekCard: 0 },
      daily: {}
    });
  }

  if (!fs.existsSync(CONFIG_FILE)) {
    saveJSON(CONFIG_FILE, {
      feishuWebhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/c80f2fb7-a6e0-4832-8bcb-9b2a9a35da86',
      downloadUrl: 'https://xmod-static.xhubplay.com/upload/20251216173832/app_version/xmodhubInstaller__20251215_173744_channel10065.exe',
      feishuReportHour: 20,
      enabled: true,
      hourCardCode: ''
    });
  }
}

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || req.headers['x-real-ip']
      || req.socket.remoteAddress
      || 'unknown';
}

// 抽奖
function drawPrize() {
  const rand = Math.random() * 100;
  if (rand < 15) return 'dayCard';
  if (rand < 52) return 'coupon';
  if (rand < 92) return 'hourCard';
  return 'weekCard';
}

// 获取可用兑换码
const KEY_MAP = { weekCard: 'weekCards', coupon: 'coupons', dayCard: 'dayCards' };
function getAvailableCode(type) {
  if (type === 'hourCard') {
    const config = loadJSON(CONFIG_FILE, {});
    if (!config.hourCardCode) return null;
    return { code: config.hourCardCode, name: '通用码' };
  }
  const codes = loadJSON(CODES_FILE, {});
  const arr = codes[KEY_MAP[type]] || [];
  const available = arr.find(c => !c.used);
  return available || null;
}

// 标记已使用
function markCodeUsed(type, code) {
  if (type === 'hourCard') return; // 固定码，无需标记
  const codes = loadJSON(CODES_FILE, {});
  const arr = codes[KEY_MAP[type]] || [];
  const entry = arr.find(c => c.code === code);
  if (entry) { entry.used = true; entry.usedAt = new Date().toISOString(); }
  saveJSON(CODES_FILE, codes);
}

// 更新统计
function updateStats(prizeType, ip) {
  const stats = loadJSON(STATS_FILE, {});
  const today = new Date().toISOString().slice(0, 10);

  stats.totalDraws = (stats.totalDraws || 0) + 1;
  stats.prizes = stats.prizes || {};
  stats.prizes[prizeType] = (stats.prizes[prizeType] || 0) + 1;

  stats.daily = stats.daily || {};
  stats.daily[today] = stats.daily[today] || { draws: 0, dayCard: 0, coupon: 0, hourCard: 0, weekCard: 0, users: 0 };
  stats.daily[today].draws = (stats.daily[today].draws || 0) + 1;
  stats.daily[today][prizeType] = (stats.daily[today][prizeType] || 0) + 1;

  if (!stats.uniqueIPs) stats.uniqueIPs = [];
  if (!stats.uniqueIPs.includes(ip)) {
    stats.uniqueIPs.push(ip);
    stats.totalUsers = stats.uniqueIPs.length;
    stats.daily[today].users = (stats.daily[today].users || 0) + 1;
  }

  saveJSON(STATS_FILE, stats);
}

// 飞书通知
async function sendFeishuNotification(type, code, name, ip) {
  const config = loadJSON(CONFIG_FILE, {});
  if (!config.feishuWebhook) return;

  const prizeNames = { dayCard: '☀️ 日卡', coupon: '🎫 优惠券', hourCard: '⏰ 小时卡', weekCard: '📅 周卡' };
  const colorMap = { dayCard: 'blue', coupon: 'turquoise', hourCard: 'green', weekCard: 'red' };
  const nameInfo = name ? `\n**员工**: ${name}` : '';

  const msg = {
    msg_type: 'interactive',
    card: {
      header: {
        title: { tag: 'plain_text', content: `${prizeNames[type]} 被抽中！` },
        template: colorMap[type]
      },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: `**奖品**: ${prizeNames[type]}${nameInfo}\n**兑换码**: ${code || '无'}\n**IP**: ${ip}\n**时间**: ${new Date().toLocaleString('zh-CN')}` } },
        { tag: 'hr' },
        { tag: 'note', elements: [{ tag: 'plain_text', content: '抽奖系统自动通知' }] }
      ]
    }
  };

  try { await fetch(config.feishuWebhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) }); }
  catch (e) { console.error('飞书通知失败:', e.message); }
}

function logDraw(type, code, name, ip) {
  fs.appendFileSync(DRAW_LOG, JSON.stringify({ time: new Date().toISOString(), prize: type, code: code || null, name: name || null, ip }) + '\n', 'utf-8');
}

// ═══ API ═══

// 抽奖
app.post('/api/draw', async (req, res) => {
  const config = loadJSON(CONFIG_FILE, {});
  if (!config.enabled) return res.json({ success: false, message: '活动已结束' });

  const ip = getClientIP(req);
  const type = drawPrize();
  const entry = getAvailableCode(type);

  let code = null, needDownload = false, message = '', name = null;

  if (entry) {
    markCodeUsed(type, entry.code);
    needDownload = true;
    code = entry.code;
    name = entry.name || null;
  }

  const msgs = {
    dayCard: code ? `恭喜获得日卡！兑换码：${code}` : '很遗憾，日卡已领完',
    coupon: code ? `恭喜获得优惠券！兑换码：${code}` : '很遗憾，优惠券已领完',
    hourCard: code ? `恭喜获得小时卡！兑换码：${code}` : '很遗憾，小时卡已用完',
    weekCard: code ? `恭喜获得周卡！兑换码：${code}` : '很遗憾，周卡已被领完'
  };
  message = msgs[type];

  updateStats(type, ip);
  logDraw(type, code, name, ip);
  if (code) sendFeishuNotification(type, code, name, ip);

  res.json({
    success: true,
    prizeType: type,
    prizeName: { dayCard: '日卡', coupon: '优惠券', hourCard: '小时卡', weekCard: '周卡' }[type],
    code, message, needDownload,
    downloadUrl: needDownload ? config.downloadUrl : null,
    employeeName: name
  });
});

// 统计
app.get('/api/stats', (req, res) => {
  const stats = loadJSON(STATS_FILE, {});
  const codes = loadJSON(CODES_FILE, {});
  const config = loadJSON(CONFIG_FILE, {});

  const avail = (t) => (codes[t] || []).filter(c => !c.used).length;
  const total = (t) => (codes[t] || []).length;

  res.json({
    totalDraws: stats.totalDraws || 0,
    totalUsers: stats.totalUsers || 0,
    prizes: stats.prizes || {},
    daily: stats.daily || {},
    codeBalance: {
      dayCards: { total: total('dayCards'), available: avail('dayCards') },
      coupons: { total: total('coupons'), available: avail('coupons') },
      weekCards: { total: total('weekCards'), available: avail('weekCards') },
      hourCards: { total: -1, available: config.hourCardCode ? -1 : 0, code: config.hourCardCode || '' }
    },
    enabled: config.enabled !== false
  });
});

// 导入兑换码（支持员工名）
app.post('/api/codes/import', (req, res) => {
  const { type, codes: codeList } = req.body;
  const validTypes = ['weekCard', 'coupon', 'dayCard'];
  if (!validTypes.includes(type)) return res.status(400).json({ success: false, message: '类型无效' });
  if (!Array.isArray(codeList) || codeList.length === 0) return res.status(400).json({ success: false, message: '请提供兑换码列表' });

  const codes = loadJSON(CODES_FILE, {});
  const key = KEY_MAP[type];
  const existingCodes = new Set((codes[key] || []).map(c => c.code));

  const newEntries = codeList
    .filter(c => typeof c === 'string' && c.trim() && !existingCodes.has(c.trim()))
    .map(c => ({ code: c.trim(), name: '', used: false, usedAt: null }));

  codes[key] = [...(codes[key] || []), ...newEntries];
  saveJSON(CODES_FILE, codes);

  res.json({ success: true, imported: newEntries.length, skipped: codeList.length - newEntries.length, total: codes[key].length });
});

// 导入兑换码（带员工名，格式：员工名,兑换码）
app.post('/api/codes/import-named', (req, res) => {
  const { type, codes: codeList } = req.body;
  const validTypes = ['weekCard', 'coupon', 'dayCard'];
  if (!validTypes.includes(type)) return res.status(400).json({ success: false, message: '类型无效' });
  if (!Array.isArray(codeList) || codeList.length === 0) return res.status(400).json({ success: false, message: '请提供兑换码列表' });

  const codes = loadJSON(CODES_FILE, {});
  const key = KEY_MAP[type];
  const existingCodes = new Set((codes[key] || []).map(c => c.code));

  const newEntries = [];
  for (const item of codeList) {
    if (typeof item !== 'string' || !item.trim()) continue;
    // 支持 "员工名,兑换码" 或纯 "兑换码"
    let name = '', code = item.trim();
    if (code.includes(',')) {
      const parts = code.split(',');
      name = parts[0].trim();
      code = parts.slice(1).join(',').trim();
    }
    if (!code || existingCodes.has(code)) continue;
    newEntries.push({ code, name, used: false, usedAt: null });
    existingCodes.add(code);
  }

  codes[key] = [...(codes[key] || []), ...newEntries];
  saveJSON(CODES_FILE, codes);

  res.json({ success: true, imported: newEntries.length, skipped: codeList.length - newEntries.length, total: codes[key].length });
});

// 飞书配置
app.post('/api/config/feishu', (req, res) => {
  const { webhook, reportHour } = req.body;
  const config = loadJSON(CONFIG_FILE, {});
  if (webhook !== undefined) config.feishuWebhook = webhook;
  if (reportHour !== undefined) config.feishuReportHour = parseInt(reportHour) || 20;
  saveJSON(CONFIG_FILE, config);
  res.json({ success: true });
});

// 小时卡固定码
app.post('/api/config/hourcard', (req, res) => {
  const { code } = req.body;
  if (!code || !code.trim()) return res.status(400).json({ success: false, message: '请输入兑换码' });
  const config = loadJSON(CONFIG_FILE, {});
  config.hourCardCode = code.trim();
  saveJSON(CONFIG_FILE, config);
  res.json({ success: true });
});

// 获取配置
app.get('/api/config', (req, res) => {
  const config = loadJSON(CONFIG_FILE, {});
  res.json({ feishuWebhook: config.feishuWebhook ? config.feishuWebhook.substring(0, 40) + '...' : '', feishuReportHour: config.feishuReportHour || 20, enabled: config.enabled !== false, downloadUrl: config.downloadUrl });
});

// 开关活动
app.post('/api/config/toggle', (req, res) => {
  const config = loadJSON(CONFIG_FILE, {});
  config.enabled = !config.enabled;
  saveJSON(CONFIG_FILE, config);
  res.json({ success: true, enabled: config.enabled });
});

// 兑换码列表
app.get('/api/codes/list/:type', (req, res) => {
  const { type } = req.params;
  const codes = loadJSON(CODES_FILE, {});
  const key = KEY_MAP[type];
  if (!key) return res.status(400).json({ success: false, message: '类型无效' });
  const list = codes[key] || [];
  res.json({ total: list.length, used: list.filter(c => c.used).length, available: list.filter(c => !c.used).length, codes: list });
});

// 飞书测试
app.post('/api/feishu/report', async (req, res) => {
  const config = loadJSON(CONFIG_FILE, {});
  if (!config.feishuWebhook) return res.json({ success: false, message: '未配置飞书' });
  try {
    const resp = await fetch(config.feishuWebhook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'interactive', card: { header: { title: { tag: 'plain_text', content: '🧪 测试成功' }, template: 'blue' }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: '后端已连接！抽奖通知正常工作。' } }] } })
    });
    res.json({ success: resp.ok, message: resp.ok ? '发送成功' : '发送失败' });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

// 重置