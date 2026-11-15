// dsh-hub-center — 自研中枢内核（P0 + P1 记忆/表情）
// 统一存储（SQLite，失败回退 JSON）、模块注册表、事件日志、状态汇总、记忆与表情库。
// 路由前缀：/hub-center/*
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync, readdirSync, openSync, readSync, closeSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'

export const name = 'dsh-hub-center'
export const inject = ['webServer']

const VERSION = '0.11.0'
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const BASE = join(HOME, 'plugins-data', 'dsh-hub')
const QQ_DATA = join(HOME, 'plugins-data', 'dsh-qq-hub')
const HALF_LIFE_DAYS = 60
const OUT_DIR = join(BASE, 'out')

// ===== 可配置路径：默认就是本机这套，别人改 paths.json 即可 =====
const PATHS_FILE = join(BASE, 'paths.json')
const PATH_DEFAULTS = {
  aiRoot: 'D:\\AI',
  ttsPy: 'D:\\AI\\ComfyUI_windows_portable\\python_embeded\\python.exe',
  ffmpeg: 'D:\\AI\\ComfyUI_windows_portable\\python_embeded\\Lib\\site-packages\\imageio_ffmpeg\\binaries\\ffmpeg-win-x86_64-v9.0.2.exe',
  gsvRoot: 'D:\\AI\\voice\\GPT-SoVITS',
  gsvPy: 'D:\\AI\\voice\\py310\\python.exe',
  gsvServeLog: 'D:\\AI\\voice\\gsv-serve.log',
  cosyPy: 'D:\\AI\\voice\\py310-cosy\\python.exe',
  cosyRoot: 'D:\\AI\\voice\\CosyVoice',
  asrCache: 'D:/AI/models/whisper',
  whisperDir: 'D:\\AI\\models\\whisper',
  comfyRoot: 'D:\\AI\\ComfyUI_windows_portable\\ComfyUI',
  llamaDir: 'D:\\AI\\llama',
  ocrScript: 'D:\\AI\\llama\\ocr.ps1',
}
function loadPaths() {
  let cfg = {}
  try { cfg = JSON.parse(readFileSync(PATHS_FILE, 'utf8')) } catch { cfg = {} }
  const merged = { ...PATH_DEFAULTS, ...cfg }
  // 首次运行：写一份出来，别人照着改
  try {
    if (!existsSync(PATHS_FILE)) {
      mkdirSync(BASE, { recursive: true })
      writeFileSync(PATHS_FILE, JSON.stringify(merged, null, 2), 'utf8')
    }
  } catch {}
  return merged
}
const PATHS = loadPaths()
const PATH_KEYS = Object.keys(PATH_DEFAULTS)
const TTS_PY = PATHS.ttsPy
const FFMPEG = PATHS.ffmpeg
const TMP_DIR = join(BASE, 'tmp')
const TTS_VOICE = 'zh-CN-liaoning-XiaobeiNeural'
const COSY_PRESETS_DEFAULT = [
  { name: '傲娇', instruct: '用小声嘀咕、别扭的语气说，别太用力，尾音有点上扬。', speed: 0.95 },
  { name: '高兴', instruct: '用轻快、开心的语气说，带一点笑意。', speed: 1.05 },
  { name: '生气', instruct: '用生气、带点责怪的语气说，语速稍快。', speed: 1.05 },
  { name: '喜欢', instruct: '用温柔、撒娇的语气说，声音放软。', speed: 0.95 },
  { name: '困', instruct: '用困倦、含糊的语气说，语速放慢。', speed: 0.9 },
]
const GSV_ROOT = PATHS.gsvRoot
const GSV_PY = PATHS.gsvPy
const GSV_DEFAULT_URL = 'http://127.0.0.1:9880'
const GSV_DIR = join(BASE, 'voice')
const ASR_MODEL = 'small'
const ASR_CACHE = PATHS.asrCache
const TEXT_URL = 'http://127.0.0.1:8090'
const TEXT_MODEL = 'qwen2.5-7b-instruct'
const MEME_SRC = join(BASE, 'memes.db')
function pickMeme(row) {
  if (!row) return null
  return {
    title: String(row.title || ''),
    aliases: String(row.aliases || ''),
    tags: String(row.tags || ''),
    summary: String(row.summary || row.origin || '').slice(0, 900),
    usage: String(row.usage || '').slice(0, 700),
    origin: String(row.origin || '').slice(0, 500),
    updated: Number(row.updated || 0),
  }
}
const DIARY_DEFAULTS = {
  enabled: true, hour: 23, chance: 0.12, minAgeDays: 1, maxAgeDays: 60,
  dailyMax: 3, useGroup: true, usePrivate: true, useBrowser: true, model: TEXT_MODEL,
}
const ASR_SCRIPT = [
  'import sys, os, wave, numpy as np',
  'p = sys.argv[1]',
  'with wave.open(p, "rb") as w:',
  '    n, sw, ch, sr = w.getnframes(), w.getsampwidth(), w.getnchannels(), w.getframerate()',
  '    raw = w.readframes(n)',
  'if sw != 2:',
  '    raise SystemExit("只支持 16-bit PCM wav")',
  'a = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0',
  'if ch > 1:',
  '    a = a.reshape(-1, ch).mean(axis=1)',
  'if sr != 16000:',
  '    idx = np.linspace(0, len(a) - 1, int(len(a) * 16000 / sr)).astype(np.int64)',
  '    a = a[idx]',
  'from faster_whisper import WhisperModel',
  "m = WhisperModel(os.environ.get('ASR_MODEL','small'), device='cpu', compute_type='int8', download_root=os.environ.get('ASR_CACHE','D:/AI/models/whisper'))",
  'segs, info = m.transcribe(a, language="zh", vad_filter=True, beam_size=1, initial_prompt="以下是普通话的句子，请用简体中文。")',
  "print(''.join(s.text for s in segs).strip(), flush=True)",
].join('\n')

const SEED_MODULES = [
  { id: 'memory', title: '记忆中枢', desc: '统一 QQ/DSH 记忆与表情库，参考 engram，带遗忘' },
  { id: 'voice', title: '语音中枢', desc: 'TTS：edge-tts / SAPI 兜底' },
  { id: 'hearing', title: '听觉中枢', desc: 'ASR：faster-whisper 语音转文字' },
  { id: 'vision', title: '视觉中枢', desc: '看图 + OCR（预留视频）' },
  { id: 'gen', title: '生图中枢', desc: 'ComfyUI 生图 + 表情库' },
  { id: 'behavior', title: '行为中枢', desc: '主动搭话/画图/排闹钟/ComfyUI' },
  { id: 'feedback', title: '反馈中枢', desc: '统一事件日志查看' },
  { id: 'panel', title: '中枢面板', desc: '状态汇总 + 设置面板' },
]

const QH_LOGS = join(QQ_DATA, 'logs')
const QH_CHATLOG = join(QQ_DATA, 'chatlog')
const GSV_SERVE_LOG = PATHS.gsvServeLog
const GSV_HUB_LOG = join(GSV_DIR, 'gsv.log')
const LLAMA_LOG = join(PATHS.llamaDir, 'server.log')
const LLAMA_ERR = join(PATHS.llamaDir, 'server.err')

const now = () => Date.now()
const safeJson = (t) => { if (t == null || t === '') return null; try { return JSON.parse(t) } catch { return t } }
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0))
const hashId = (scope, text) => createHash('sha1').update(String(scope) + '\n' + String(text)).digest('hex').slice(0, 16)
const tagsText = (tags) => Array.isArray(tags) ? tags.join(' ') : String(tags || '')

// ---- 日志来源：中枢事件、QQ 日志、聊天记录、GPT-SoVITS、llama、ComfyUI ----
function newestIn(dir, re) {
  try {
    const xs = readdirSync(dir).filter((n) => re.test(n)).map((n) => join(dir, n))
      .map((p) => { try { return { p, m: statSync(p).mtimeMs } } catch { return null } })
      .filter(Boolean).sort((a, b) => b.m - a.m)
    return xs.length ? xs[0].p : ''
  } catch { return '' }
}

function tailFile(file, maxBytes = 262144) {
  try {
    const st = statSync(file)
    const len = Math.min(st.size, maxBytes)
    const from = st.size - len
    const fd = openSync(file, 'r')
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, from)
    closeSync(fd)
    let s = buf.toString('utf8')
    if (from > 0) { const nl = s.indexOf('\n'); s = nl >= 0 ? s.slice(nl + 1) : '' }
    return s
  } catch { return '' }
}

function logTime(line) {
  const m = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(line)
  if (!m) return 0
  const t = Date.parse(m[1] + 'T' + m[2] + '+08:00')
  return Number.isFinite(t) ? t : 0
}

function logLevel(line) {
  if (/\b(ERROR|FATAL|CRITICAL)\b|错误|失败|异常|exception|traceback|Error:/i.test(line)) return 'error'
  if (/\bWARN(ING)?\b|警告|warn:/i.test(line)) return 'warn'
  return 'info'
}

function logSourceList() {
  const qqLog = newestIn(QH_LOGS, /^qq-hub-\d{4}-\d{2}-\d{2}\.log$/)
  const chat = newestIn(QH_CHATLOG, /^\d{4}-\d{2}-\d{2}\.jsonl$/)
  const defs = [
    { id: 'hub', name: '中枢事件', kind: 'events', path: join(BASE, 'hub.db') },
    { id: 'qq', name: 'QQ 运行日志', kind: 'file', path: qqLog },
    { id: 'chatlog', name: 'QQ 聊天记录', kind: 'chatlog', path: chat },
    { id: 'gsv', name: 'GPT-SoVITS', kind: 'file', path: GSV_SERVE_LOG },
    { id: 'gsvhub', name: 'GPT-SoVITS（中枢）', kind: 'file', path: GSV_HUB_LOG },
    { id: 'llama', name: '文本模型 8090', kind: 'file', path: LLAMA_LOG },
    { id: 'llamaerr', name: '文本模型错误', kind: 'file', path: LLAMA_ERR },
    { id: 'comfy', name: 'ComfyUI 任务', kind: 'comfy', path: COMFY },
  ]
  return defs.map((d) => {
    if (d.kind === 'events') {
      return { ...d, ok: !!hubStore, size: 0, mtime: 0, count: hubStore ? hubStore.counts().events : 0 }
    }
    if (d.kind === 'comfy') return { ...d, ok: true, size: 0, mtime: 0 }
    const ok = !!d.path && existsSync(d.path)
    let size = 0, mtime = 0
    if (ok) { try { const st = statSync(d.path); size = st.size; mtime = st.mtimeMs } catch {} }
    return { ...d, ok, size, mtime }
  })
}

function clockText(ts) {
  if (!ts) return '--:--:--'
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}

async function comfyEntries(limit) {
  const out = []
  try {
    const h = await fetch(COMFY + '/history?max_items=40').then((r) => r.json())
    for (const [id, item] of Object.entries(h || {})) {
      const st = (item && item.status) || {}
      const msgs = Array.isArray(st.messages) ? st.messages : []
      const find = (k) => { const x = msgs.find((m) => m[0] === k); return x ? x[1] || {} : null }
      const start = find('execution_start')?.timestamp || 0
      const end = find('execution_success')?.timestamp || start
      const err = find('execution_error')
      const dur = start && end ? Math.round(end - start) : 0
      const files = []
      for (const o of Object.values(item.outputs || {})) {
        for (const k of ['images', 'gifs', 'videos']) for (const f of (o && o[k]) || []) files.push(f.filename)
      }
      const ok = (st.status_str || '') === 'success'
      out.push({
        ts: end || start, level: err ? 'error' : ok ? 'info' : 'warn',
        text: `任务 ${String(id).slice(0, 8)} ${err ? '失败:' + (err.exception_message || err.node_type || '') : (st.status_str || '?')}` +
          (dur ? ' · ' + dur + 'ms' : '') + (files.length ? ' · ' + files.join(', ') : ''),
      })
    }
    const q = await fetch(COMFY + '/queue').then((r) => r.json())
    for (const id of (q && q.queue_running) || []) out.push({ ts: now(), level: 'info', text: `任务 ${String(id).slice(0, 8)} 运行中` })
  } catch (e) {
    out.push({ ts: now(), level: 'error', text: 'ComfyUI 不可达：' + (e && e.message || e) })
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, limit)
}

function chatEntries(file, limit) {
  const items = []
  for (const line of tailFile(file, 1024 * 1024).split('\n')) {
    if (!line.trim()) continue
    try {
      const j = JSON.parse(line)
      const text = String(j.text || '').replace(/\s+/g, ' ').slice(0, 240)
      items.push({ ts: Number(j.t || 0), level: 'info', text: `${clockText(Number(j.t || 0))} [${j.chatId || ''}] ${j.who || ''}: ${text}` })
    } catch {}
  }
  return items.slice(-limit)
}

function fileEntries(file, limit) {
  const lines = tailFile(file).split('\n').filter((l) => l.trim())
  return lines.slice(-limit).map((l) => ({ ts: logTime(l), level: logLevel(l), text: l.replace(/\s+$/, '') }))
}


function scoreOf(m, t = now()) {
  const days = Math.max(0, (t - Number(m.last_used || m.created || t)) / 86400000)
  const decay = Math.pow(0.5, days / HALF_LIFE_DAYS)
  return clamp01(Number(m.importance) || 0.5) * decay * (1 + Math.log1p(Number(m.use_count) || 0) * 0.15)
}

// ---------- SQLite 存储 ----------
async function openSqlite() {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(BASE, 'hub.db'))
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS modules (id TEXT PRIMARY KEY, title TEXT, desc TEXT, enabled INTEGER DEFAULT 1, config TEXT DEFAULT '{}', updated INTEGER);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, module TEXT, level TEXT, kind TEXT, chat TEXT, summary TEXT, detail TEXT, refs TEXT);
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
    CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, scope TEXT, source TEXT, chat TEXT, kind TEXT, text TEXT, tags TEXT, importance REAL, created INTEGER, last_used INTEGER, use_count INTEGER DEFAULT 0, archived INTEGER DEFAULT 0);
    CREATE INDEX IF NOT EXISTS idx_mem_scope ON memories(scope);
    CREATE INDEX IF NOT EXISTS idx_mem_arch ON memories(archived);
    CREATE TABLE IF NOT EXISTS stickers (md5 TEXT PRIMARY KEY, name TEXT, tags TEXT, kind TEXT, file TEXT, bytes INTEGER, used INTEGER DEFAULT 0, created INTEGER);
    CREATE TABLE IF NOT EXISTS style_profiles (scope TEXT PRIMARY KEY, card TEXT, updated INTEGER);
    CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, at INTEGER, text TEXT, chat TEXT, done INTEGER DEFAULT 0, created INTEGER);
    CREATE TABLE IF NOT EXISTS diary (id TEXT PRIMARY KEY, day TEXT, text TEXT, tags TEXT, source TEXT, created INTEGER, last_used INTEGER, use_count INTEGER DEFAULT 0);
    CREATE INDEX IF NOT EXISTS idx_diary_day ON diary(day);
    CREATE TABLE IF NOT EXISTS memes (title TEXT PRIMARY KEY, slug TEXT, tags TEXT, usage TEXT, origin TEXT, other TEXT, summary TEXT, aliases TEXT, updated INTEGER);
    CREATE TABLE IF NOT EXISTS usage (id TEXT PRIMARY KEY, ts INTEGER, module TEXT, metric TEXT, value REAL, meta TEXT);
  `)
  let ftsReady = false
  for (const tok of ["tokenize='trigram'", '']) {
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, text, tags ${tok})`)
      ftsReady = true
      break
    } catch {}
  }
  const insModule = db.prepare('INSERT OR IGNORE INTO modules (id,title,desc,enabled,config,updated) VALUES (?,?,?,1,?,?)')
  for (const m of SEED_MODULES) insModule.run(m.id, m.title, m.desc, '{}', now())

  const getMem = db.prepare('SELECT * FROM memories WHERE id=?')
  const insertMem = db.prepare('INSERT OR IGNORE INTO memories (id,scope,source,chat,kind,text,tags,importance,created,last_used,use_count,archived) VALUES (?,?,?,?,?,?,?,?,?,?,?,0)')
  const insertFts = ftsReady ? db.prepare('INSERT INTO memories_fts (id,text,tags) VALUES (?,?,?)') : null
  const deleteFts = ftsReady ? db.prepare('DELETE FROM memories_fts WHERE id=?') : null

  return {
    kind: 'sqlite',
    file: join(BASE, 'hub.db'),
    fts: ftsReady,
    modules() {
      return db.prepare('SELECT id,title,desc,enabled,config,updated FROM modules').all()
        .map((r) => ({ ...r, enabled: Number(r.enabled), config: safeJson(r.config) || {} }))
    },
    setModule(id, patch) {
      const row = db.prepare('SELECT * FROM modules WHERE id=?').get(id)
      if (!row) return null
      const enabled = typeof patch.enabled === 'boolean' ? (patch.enabled ? 1 : 0) : row.enabled
      const config = patch.config && typeof patch.config === 'object'
        ? JSON.stringify({ ...(safeJson(row.config) || {}), ...patch.config })
        : row.config
      db.prepare('UPDATE modules SET enabled=?, config=?, updated=? WHERE id=?').run(enabled, config, now(), id)
      const next = db.prepare('SELECT * FROM modules WHERE id=?').get(id)
      return { ...next, enabled: Number(next.enabled), config: safeJson(next.config) || {} }
    },
    emit(ev) {
      const ts = Number(ev.ts) || now()
      const info = db.prepare('INSERT INTO events (ts,module,level,kind,chat,summary,detail,refs) VALUES (?,?,?,?,?,?,?,?)')
        .run(ts, ev.module || '', ev.level || 'info', ev.kind || '', ev.chat || '', String(ev.summary || ''),
          ev.detail ? JSON.stringify(ev.detail) : '', ev.refs ? JSON.stringify(ev.refs) : '')
      return { id: Number(info.lastInsertRowid), ts, ...ev }
    },
    events({ limit = 200, module = '', level = '', q = '' } = {}) {
      const where = []
      const args = []
      if (module) { where.push('module=?'); args.push(module) }
      if (level) { where.push('level=?'); args.push(level) }
      if (q) { where.push('summary LIKE ?'); args.push('%' + q + '%') }
      const sql = 'SELECT id,ts,module,level,kind,chat,summary,detail,refs FROM events' +
        (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY id DESC LIMIT ?'
      args.push(Math.min(2000, Math.max(1, Number(limit) || 200)))
      return db.prepare(sql).all(...args).map((r) => ({ ...r, detail: safeJson(r.detail), refs: safeJson(r.refs) }))
    },
    counts() {
      const one = (sql) => Number(db.prepare(sql).get()?.n || 0)
      return { memories: one('SELECT COUNT(*) n FROM memories WHERE archived=0'), stickers: one('SELECT COUNT(*) n FROM stickers'), memes: one('SELECT COUNT(*) n FROM memes'), events: one('SELECT COUNT(*) n FROM events') }
    },

    // ---- 记忆 ----
    addMemory(m) {
      const text = String(m.text || '').trim()
      if (!text) return null
      const scope = String(m.scope || 'global')
      // 同一作用域里已经有同样的话就返回旧的，不再插一条。
      // 没有这一层，memsync 把「中枢→QQ→中枢」绕一圈（id 变了、文本没变）就会造出重复。
      const dup = db.prepare('SELECT * FROM memories WHERE scope=? AND text=? LIMIT 1').get(scope, text)
      if (dup) return { ...dup, tags: safeJson(dup.tags) || [] }
      const id = String(m.id || hashId(scope, text))
      const tags = Array.isArray(m.tags) ? m.tags : []
      const info = insertMem.run(id, scope, String(m.source || 'hub'), String(m.chat || ''), String(m.kind || 'fact'),
        text, JSON.stringify(tags), clamp01(m.importance ?? 0.5), Number(m.created) || now(), Number(m.lastUsed) || now(), Number(m.useCount) || 0)
      // 只有真的插进去了才写索引：INSERT OR IGNORE 被忽略时再写，会让 FTS 里同一个 id 攒多条
      if (insertFts && Number(info.changes) > 0) { try { insertFts.run(id, text, tagsText(tags)) } catch {} }
      const row = getMem.get(id)
      return row ? { ...row, tags: safeJson(row.tags) || [] } : null
    },
    searchMemories({ q = '', scope = '', limit = 8, includeArchived = false } = {}) {
      const lim = Math.min(100, Math.max(1, Number(limit) || 8))
      const params = []
      let rows = []
      const qs = String(q || '').trim()
      if (qs && ftsReady && [...qs].length >= 3) {
        try {
          const where = ['memories_fts MATCH ?']
          params.push(qs)
          if (scope) { where.push('m.scope=?'); params.push(scope) }
          if (!includeArchived) where.push('m.archived=0')
          rows = db.prepare(`SELECT m.* FROM memories_fts f JOIN memories m ON m.id=f.id WHERE ${where.join(' AND ')} LIMIT 200`).all(...params)
        } catch { rows = [] }
      }
      if (!rows.length) {
        const where = []
        const args = []
        if (qs) { where.push('text LIKE ?'); args.push('%' + qs + '%') }
        if (scope) { where.push('scope=?'); args.push(scope) }
        if (!includeArchived) where.push('archived=0')
        rows = db.prepare(`SELECT * FROM memories ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY last_used DESC LIMIT 200`).all(...args)
      }
      return rows.map((r) => ({ ...r, tags: safeJson(r.tags) || [], score: Math.round(scoreOf(r) * 1000) / 1000 }))
        .sort((a, b) => b.score - a.score).slice(0, lim)
    },
    listMemories({ scope = '', limit = 50, includeArchived = false } = {}) {
      return this.searchMemories({ q: '', scope, limit, includeArchived })
    },
    bumpMemory(id) {
      db.prepare('UPDATE memories SET use_count=COALESCE(use_count,0)+1, last_used=? WHERE id=?').run(now(), String(id))
      return true
    },
    forgetMemory(id) {
      const info = db.prepare('UPDATE memories SET archived=1 WHERE id=?').run(String(id))
      return Number(info.changes) > 0
    },
    deleteMemory(id) {
      const row = getMem.get(String(id))
      const info = db.prepare('DELETE FROM memories WHERE id=?').run(String(id))
      if (row && deleteFts) { try { deleteFts.run(row.id) } catch {} }
      return Number(info.changes) > 0
    },
    decayMemories({ halfLifeDays = HALF_LIFE_DAYS, archiveBelow = 0.1, deleteArchivedDays = 45 } = {}) {
      const t = now()
      const rows = db.prepare('SELECT * FROM memories WHERE archived=0').all()
      let archived = 0
      for (const r of rows) {
        const days = Math.max(0, (t - Number(r.last_used || r.created || t)) / 86400000)
        const score = clamp01(r.importance) * Math.pow(0.5, days / Math.max(1, Number(halfLifeDays) || HALF_LIFE_DAYS))
        if (score < Number(archiveBelow)) {
          db.prepare('UPDATE memories SET archived=1 WHERE id=?').run(r.id)
          archived++
        }
      }
      const cutoff = t - Math.max(1, Number(deleteArchivedDays) || 45) * 86400000
      const old = db.prepare('SELECT id FROM memories WHERE archived=1 AND last_used < ?').all(cutoff)
      for (const r of old) this.deleteMemory(r.id)
      return { archived, deleted: old.length }
    },

    // ---- 表情 ----
    addSticker(s) {
      const md5 = String(s.md5 || '').trim()
      if (!md5) return null
      db.prepare('INSERT OR IGNORE INTO stickers (md5,name,tags,kind,file,bytes,used,created) VALUES (?,?,?,?,?,?,?,?)')
        .run(md5, String(s.name || '').slice(0, 24), JSON.stringify(Array.isArray(s.tags) ? s.tags : []), String(s.kind || 'sticker'),
          String(s.file || ''), Number(s.bytes) || 0, Number(s.used) || 0, Number(s.created) || now())
      const row = db.prepare('SELECT * FROM stickers WHERE md5=?').get(md5)
      return row ? { ...row, tags: safeJson(row.tags) || [] } : null
    },
    listStickers({ q = '', limit = 50 } = {}) {
      const lim = Math.min(500, Math.max(1, Number(limit) || 50))
      const qs = String(q || '').trim()
      const rows = qs
        ? db.prepare('SELECT * FROM stickers WHERE name LIKE ? OR tags LIKE ? ORDER BY used DESC, created DESC LIMIT ?').all('%' + qs + '%', '%' + qs + '%', lim)
        : db.prepare('SELECT * FROM stickers ORDER BY used DESC, created DESC LIMIT ?').all(lim)
      return rows.map((r) => ({ ...r, tags: safeJson(r.tags) || [] }))
    },
    useSticker(md5) {
      const info = db.prepare('UPDATE stickers SET used=COALESCE(used,0)+1 WHERE md5=?').run(String(md5))
      return Number(info.changes) > 0
    },
    saveStyle(card) {
      const scope = String(card.scope || '*')
      db.prepare('INSERT INTO style_profiles (scope,card,updated) VALUES (?,?,?) ON CONFLICT(scope) DO UPDATE SET card=excluded.card, updated=excluded.updated')
        .run(scope, JSON.stringify(card), now())
      return card
    },
    getStyle(scope) {
      const row = db.prepare('SELECT card FROM style_profiles WHERE scope=?').get(String(scope || '*'))
      return row ? safeJson(row.card) : null
    },
    listStyles() {
      return db.prepare('SELECT scope,updated FROM style_profiles ORDER BY updated DESC').all()
    },
    addReminder(r) {
      const at = Number(r.at) || now()
      const text = String(r.text || '')
      const id = String(r.id || createHash('sha1').update(String(at) + '|' + text).digest('hex').slice(0, 12))
      db.prepare('INSERT OR REPLACE INTO reminders (id,at,text,chat,done,created) VALUES (?,?,?,?,0,?)').run(id, at, text, String(r.chat || ''), now())
      return { id, at, text, chat: String(r.chat || ''), done: 0 }
    },
    listReminders({ includeDone = false, limit = 100 } = {}) {
      const sql = 'SELECT * FROM reminders ' + (includeDone ? '' : 'WHERE done=0 ') + 'ORDER BY at ASC LIMIT ?'
      return db.prepare(sql).all(Math.min(500, Number(limit) || 100))
    },
    doneReminder(id) {
      const info = db.prepare('UPDATE reminders SET done=1 WHERE id=?').run(String(id))
      return Number(info.changes) > 0
    },

    // ---- 日记 ----
    addDiary(d) {
      const text = String(d.text || '').trim()
      if (!text) return null
      const day = String(d.day || '')
      const id = String(d.id || hashId('diary:' + day, text))
      db.prepare('INSERT OR IGNORE INTO diary (id,day,text,tags,source,created,last_used,use_count) VALUES (?,?,?,?,?,?,?,0)')
        .run(id, day, text, JSON.stringify(Array.isArray(d.tags) ? d.tags : []), String(d.source || 'manual'), Number(d.created) || now(), now())
      const row = db.prepare('SELECT * FROM diary WHERE id=?').get(id)
      return row ? { ...row, tags: safeJson(row.tags) || [] } : null
    },
    listDiary({ day = '', limit = 50 } = {}) {
      const args = []
      let where = ''
      if (day) { where = 'WHERE day=?'; args.push(String(day)) }
      return db.prepare(`SELECT * FROM diary ${where} ORDER BY day DESC, created DESC LIMIT ?`).all(...args, Math.min(500, Number(limit) || 50))
        .map((r) => ({ ...r, tags: safeJson(r.tags) || [] }))
    },
    diaryDays() {
      return db.prepare('SELECT day, COUNT(*) n FROM diary GROUP BY day ORDER BY day DESC LIMIT 90').all()
    },
    recallDiary({ minAgeDays = 1, maxAgeDays = 60 } = {}) {
      const t = now()
      const from = t - Math.max(0, Number(maxAgeDays) || 60) * 86400000
      const to = t - Math.max(0, Number(minAgeDays) || 0) * 86400000
      const row = db.prepare('SELECT * FROM diary WHERE created<=? AND created>=? ORDER BY use_count ASC, RANDOM() LIMIT 1').get(to, from)
      return row ? { ...row, tags: safeJson(row.tags) || [] } : null
    },
    bumpDiary(id) {
      db.prepare('UPDATE diary SET use_count=COALESCE(use_count,0)+1, last_used=? WHERE id=?').run(now(), String(id))
      return true
    },
    deleteDiary(id) {
      const info = db.prepare('DELETE FROM diary WHERE id=?').run(String(id))
      return Number(info.changes) > 0
    },

    // ---- 梗（梗百科词库） ----
    memeCount() { return Number(db.prepare('SELECT COUNT(*) n FROM memes').get()?.n || 0) },
    memeGet(title) { return db.prepare('SELECT * FROM memes WHERE title=?').get(String(title)) || null },
    memeLookup(q) {
      const query = String(q || '').trim()
      if (!query) return null
      let row = db.prepare('SELECT * FROM memes WHERE title=?').get(query)
      if (row) return row
      row = db.prepare("SELECT * FROM memes WHERE aliases IS NOT NULL AND instr(',' || lower(aliases) || ',', ',' || lower(?) || ',') > 0 LIMIT 1").get(query)
      if (row) return row
      row = db.prepare("SELECT * FROM memes WHERE lower(title) LIKE lower(?) || '%' ORDER BY length(title) ASC LIMIT 1").get(query)
      if (row) return row
      row = db.prepare('SELECT * FROM memes WHERE length(title) >= 2 AND instr(?, title) > 0 ORDER BY length(title) DESC LIMIT 1').get(query)
      if (row) return row
      if (query.length >= 3 || (query.length >= 2 && /^[0-9a-z]+$/i.test(query))) {
        row = db.prepare('SELECT * FROM memes WHERE instr(title, ?) > 0 ORDER BY length(title) ASC LIMIT 1').get(query)
      }
      return row || null
    },
    memeList({ q = '', limit = 50, offset = 0 } = {}) {
      const lim = Math.min(200, Number(limit) || 50)
      const off = Math.max(0, Number(offset) || 0)
      if (q) {
        const like = '%' + String(q) + '%'
        return db.prepare('SELECT title,slug,tags,summary,aliases,updated FROM memes WHERE title LIKE ? OR summary LIKE ? OR aliases LIKE ? ORDER BY length(title) ASC LIMIT ? OFFSET ?').all(like, like, like, lim, off)
      }
      return db.prepare('SELECT title,slug,tags,summary,aliases,updated FROM memes ORDER BY updated DESC, title ASC LIMIT ? OFFSET ?').all(lim, off)
    },
    memeUpsert(d) {
      const title = String(d.title || '').trim()
      if (!title) return null
      db.prepare('INSERT INTO memes (title,slug,tags,usage,origin,other,summary,aliases,updated) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(title) DO UPDATE SET slug=excluded.slug,tags=excluded.tags,usage=excluded.usage,origin=excluded.origin,other=excluded.other,summary=excluded.summary,aliases=excluded.aliases,updated=excluded.updated')
        .run(title, String(d.slug || ''), String(d.tags || ''), String(d.usage || ''), String(d.origin || ''), String(d.other || ''), String(d.summary || ''), String(d.aliases || ''), now())
      return this.memeGet(title)
    },
    memeDelete(title) { const info = db.prepare('DELETE FROM memes WHERE title=?').run(String(title)); return Number(info.changes) > 0 },
    memeImport(rows) {
      let n = 0
      const stmt = db.prepare('INSERT OR REPLACE INTO memes (title,slug,tags,usage,origin,other,summary,aliases,updated) VALUES (?,?,?,?,?,?,?,?,?)')
      db.exec('BEGIN')
      try {
        for (const r of rows) {
          if (!r || !r.title) continue
          stmt.run(String(r.title), String(r.slug || ''), String(r.tags || ''), String(r.usage || ''), String(r.origin || ''), String(r.other || ''), String(r.summary || ''), String(r.aliases || ''), now())
          n++
        }
        db.exec('COMMIT')
      } catch (e) { try { db.exec('ROLLBACK') } catch {} throw e }
      return n
    },

    // ---- 迁移 ----
    migrate() {
      const out = { memories: 0, stickers: 0 }
      try {
        const memFile = join(QQ_DATA, 'memories.json')
        if (existsSync(memFile)) {
          const items = safeJson(readFileSync(memFile, 'utf8'))?.items || []
          for (const it of items) {
            if (!it || !it.text) continue
            this.addMemory({
              id: it.id, scope: it.scope || it.chatId || 'global', source: it.source || 'qq',
              chat: it.chatId || '', kind: 'fact', text: it.text, tags: it.tags || [],
              importance: it.importance, created: it.at, lastUsed: it.lastHit || it.at, useCount: it.hits,
            })
            out.memories++
          }
        }
      } catch {}
      try {
        const stFile = join(QQ_DATA, 'stickers', 'index.json')
        if (existsSync(stFile)) {
          const items = safeJson(readFileSync(stFile, 'utf8'))?.items || []
          for (const it of items) {
            if (!it || !it.md5) continue
            this.addSticker({ md5: it.md5, name: it.name, tags: it.tags, file: it.file, bytes: it.bytes, created: it.at })
            out.stickers++
          }
        }
      } catch {}
      return out
    },
    close() { try { db.close() } catch {} },
  }
}

// ---------- JSON 回退 ----------
function openJson() {
  const file = join(BASE, 'hub.json')
  let data = { modules: [], events: [], memories: [], stickers: [], usage: [], diary: [], memes: [], seq: 0 }
  try { data = JSON.parse(readFileSync(file, 'utf8')) } catch {}
  for (const k of ['modules', 'events', 'memories', 'stickers', 'usage', 'diary', 'memes']) if (!Array.isArray(data[k])) data[k] = []
  const save = () => { try { writeFileSync(file, JSON.stringify(data, null, 2)) } catch {} }
  for (const m of SEED_MODULES) if (!data.modules.some((x) => x.id === m.id)) data.modules.push({ ...m, enabled: 1, config: {}, updated: now() })
  save()
  return {
    kind: 'json',
    file,
    modules() { return data.modules.slice() },
    setModule(id, patch) {
      const m = data.modules.find((x) => x.id === id)
      if (!m) return null
      if (typeof patch.enabled === 'boolean') m.enabled = patch.enabled ? 1 : 0
      if (patch.config && typeof patch.config === 'object') m.config = { ...(m.config || {}), ...patch.config }
      m.updated = now(); save(); return m
    },
    emit(ev) {
      const row = { id: ++data.seq, ts: Number(ev.ts) || now(), ...ev }
      data.events.push(row)
      if (data.events.length > 20000) data.events = data.events.slice(-15000)
      save(); return row
    },
    events({ limit = 200, module = '', level = '', q = '' } = {}) {
      let list = data.events.slice().reverse()
      if (module) list = list.filter((x) => x.module === module)
      if (level) list = list.filter((x) => x.level === level)
      if (q) list = list.filter((x) => String(x.summary || '').includes(q))
      return list.slice(0, Math.min(2000, Math.max(1, limit)))
    },
    counts() { return { memories: data.memories.filter((m) => !m.archived).length, stickers: data.stickers.length, memes: data.memes.length, events: data.events.length } },
    addMemory(m) {
      const text = String(m.text || '').trim(); if (!text) return null
      const id = String(m.id || hashId(m.scope || 'global', text))
      if (data.memories.some((x) => x.id === id)) return data.memories.find((x) => x.id === id)
      const row = { id, scope: String(m.scope || 'global'), source: String(m.source || 'hub'), chat: String(m.chat || ''), kind: String(m.kind || 'fact'), text, tags: Array.isArray(m.tags) ? m.tags : [], importance: clamp01(m.importance ?? 0.5), created: Number(m.created) || now(), last_used: Number(m.lastUsed) || now(), use_count: Number(m.useCount) || 0, archived: 0 }
      data.memories.push(row); save(); return row
    },
    searchMemories({ q = '', scope = '', limit = 8, includeArchived = false } = {}) {
      let list = data.memories.slice()
      if (!includeArchived) list = list.filter((m) => !m.archived)
      if (scope) list = list.filter((m) => m.scope === scope)
      if (q) list = list.filter((m) => String(m.text).includes(q))
      return list.map((m) => ({ ...m, score: Math.round(scoreOf(m) * 1000) / 1000 })).sort((a, b) => b.score - a.score).slice(0, Math.min(100, Number(limit) || 8))
    },
    listMemories(o = {}) { return this.searchMemories({ ...o, q: '' }) },
    bumpMemory(id) { const m = data.memories.find((x) => x.id === id); if (!m) return false; m.use_count = (m.use_count || 0) + 1; m.last_used = now(); save(); return true },
    forgetMemory(id) { const m = data.memories.find((x) => x.id === id); if (!m) return false; m.archived = 1; save(); return true },
    deleteMemory(id) { const i = data.memories.findIndex((x) => x.id === id); if (i < 0) return false; data.memories.splice(i, 1); save(); return true },
    decayMemories({ halfLifeDays = HALF_LIFE_DAYS, archiveBelow = 0.1, deleteArchivedDays = 45 } = {}) {
      const t = now(); let archived = 0
      for (const m of data.memories) {
        if (m.archived) continue
        const days = Math.max(0, (t - (m.last_used || m.created || t)) / 86400000)
        const score = clamp01(m.importance) * Math.pow(0.5, days / Math.max(1, Number(halfLifeDays) || HALF_LIFE_DAYS))
        if (score < Number(archiveBelow)) { m.archived = 1; archived++ }
      }
      const cutoff = t - Math.max(1, Number(deleteArchivedDays) || 45) * 86400000
      const before = data.memories.length
      data.memories = data.memories.filter((m) => !(m.archived && (m.last_used || m.created) < cutoff))
      save()
      return { archived, deleted: before - data.memories.length }
    },
    addSticker(s) {
      const md5 = String(s.md5 || ''); if (!md5) return null
      if (data.stickers.some((x) => x.md5 === md5)) return data.stickers.find((x) => x.md5 === md5)
      const row = { md5, name: String(s.name || ''), tags: Array.isArray(s.tags) ? s.tags : [], kind: String(s.kind || 'sticker'), file: String(s.file || ''), bytes: Number(s.bytes) || 0, used: Number(s.used) || 0, created: Number(s.created) || now() }
      data.stickers.push(row); save(); return row
    },
    listStickers({ q = '', limit = 50 } = {}) {
      let list = data.stickers.slice()
      if (q) list = list.filter((s) => String(s.name).includes(q) || (s.tags || []).some((t) => String(t).includes(q)))
      return list.sort((a, b) => (b.used || 0) - (a.used || 0)).slice(0, Math.min(500, Number(limit) || 50))
    },
    useSticker(md5) { const s = data.stickers.find((x) => x.md5 === md5); if (!s) return false; s.used = (s.used || 0) + 1; save(); return true },
    saveStyle(card) { data.styles = data.styles || {}; data.styles[String(card.scope || '*')] = card; save(); return card },
    getStyle(scope) { return (data.styles || {})[String(scope || '*')] || null },
    listStyles() { return Object.keys(data.styles || {}).map((scope) => ({ scope, updated: (data.styles[scope] || {}).updated || 0 })) },
    addReminder(r) {
      const at = Number(r.at) || now()
      const text = String(r.text || '')
      const id = String(r.id || createHash('sha1').update(String(at) + '|' + text).digest('hex').slice(0, 12))
      data.reminders = data.reminders || []
      data.reminders = data.reminders.filter((x) => x.id !== id)
      data.reminders.push({ id, at, text, chat: String(r.chat || ''), done: 0 })
      save()
      return { id, at, text, chat: String(r.chat || ''), done: 0 }
    },
    listReminders({ includeDone = false, limit = 100 } = {}) {
      const list = (data.reminders || []).filter((x) => includeDone || !x.done).sort((a, b) => a.at - b.at)
      return list.slice(0, Math.min(500, Number(limit) || 100))
    },
    doneReminder(id) { const r = (data.reminders || []).find((x) => x.id === id); if (!r) return false; r.done = 1; save(); return true },
    addDiary(d) {
      const text = String(d.text || '').trim(); if (!text) return null
      const day = String(d.day || '')
      const id = String(d.id || hashId('diary:' + day, text))
      if (data.diary.some((x) => x.id === id)) return data.diary.find((x) => x.id === id)
      const row = { id, day, text, tags: Array.isArray(d.tags) ? d.tags : [], source: String(d.source || 'manual'), created: Number(d.created) || now(), last_used: now(), use_count: 0 }
      data.diary.push(row); save(); return row
    },
    listDiary({ day = '', limit = 50 } = {}) {
      let list = data.diary.slice()
      if (day) list = list.filter((x) => x.day === day)
      return list.sort((a, b) => String(b.day).localeCompare(String(a.day)) || b.created - a.created).slice(0, Math.min(500, Number(limit) || 50))
    },
    diaryDays() { const m = new Map(); for (const x of data.diary) m.set(x.day, (m.get(x.day) || 0) + 1); return Array.from(m, ([day, n]) => ({ day, n })).sort((a, b) => b.day.localeCompare(a.day)).slice(0, 90) },
    recallDiary({ minAgeDays = 1, maxAgeDays = 60 } = {}) {
      const t = now(); const from = t - Math.max(0, Number(maxAgeDays) || 60) * 86400000; const to = t - Math.max(0, Number(minAgeDays) || 0) * 86400000
      const pool = data.diary.filter((x) => x.created <= to && x.created >= from)
      return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null
    },
    bumpDiary(id) { const r = data.diary.find((x) => x.id === id); if (!r) return false; r.use_count++; r.last_used = now(); save(); return true },
    deleteDiary(id) { const i = data.diary.findIndex((x) => x.id === id); if (i < 0) return false; data.diary.splice(i, 1); save(); return true },
    // ---- 梗 ----
    memeCount() { return data.memes.length },
    memeGet(title) { return data.memes.find((x) => x.title === String(title)) || null },
    memeLookup(query) {
      const q = String(query || '').trim()
      if (!q) return null
      const low = q.toLowerCase()
      let row = data.memes.find((x) => x.title === q)
      if (row) return row
      row = data.memes.find((x) => x.aliases && String(x.aliases).toLowerCase().split(',').map((s) => s.trim()).includes(low))
      if (row) return row
      row = data.memes.filter((x) => String(x.title).toLowerCase().startsWith(low)).sort((a, b) => a.title.length - b.title.length)[0]
      if (row) return row
      row = data.memes.filter((x) => String(x.title).length >= 2 && q.includes(x.title)).sort((a, b) => b.title.length - a.title.length)[0]
      if (row) return row
      if (q.length >= 3 || (q.length >= 2 && /^[0-9a-z]+$/i.test(q))) {
        row = data.memes.filter((x) => String(x.title).includes(q)).sort((a, b) => a.title.length - b.title.length)[0]
      }
      return row || null
    },
    memeList({ q = '', limit = 50, offset = 0 } = {}) {
      const lim = Math.min(200, Number(limit) || 50)
      const off = Math.max(0, Number(offset) || 0)
      let list = data.memes.slice()
      if (q) {
        const s = String(q).toLowerCase()
        list = list.filter((x) => String(x.title).toLowerCase().includes(s) || String(x.summary || '').toLowerCase().includes(s) || String(x.aliases || '').toLowerCase().includes(s))
      }
      list.sort((a, b) => String(b.updated || 0).localeCompare(String(a.updated || 0)) || a.title.localeCompare(b.title))
      return list.slice(off, off + lim)
    },
    memeUpsert(d) {
      const title = String(d.title || '').trim()
      if (!title) return null
      let row = data.memes.find((x) => x.title === title)
      if (!row) { row = { title }; data.memes.push(row) }
      Object.assign(row, {
        slug: String(d.slug || ''), tags: String(d.tags || ''), usage: String(d.usage || ''),
        origin: String(d.origin || ''), other: String(d.other || ''), summary: String(d.summary || ''),
        aliases: String(d.aliases || ''), updated: now(),
      })
      save()
      return row
    },
    memeDelete(title) { const i = data.memes.findIndex((x) => x.title === String(title)); if (i < 0) return false; data.memes.splice(i, 1); save(); return true },
    memeImport(rows) { let n = 0; for (const r of rows) if (r && r.title) { this.memeUpsert(r); n++ } return n },
    migrate() {
      const out = { memories: 0, stickers: 0 }
      try {
        const items = safeJson(readFileSync(join(QQ_DATA, 'memories.json'), 'utf8'))?.items || []
        for (const it of items) if (it && it.text) { this.addMemory({ id: it.id, scope: it.scope || it.chatId || 'global', source: it.source || 'qq', chat: it.chatId || '', kind: 'fact', text: it.text, tags: it.tags || [], importance: it.importance, created: it.at, lastUsed: it.lastHit || it.at, useCount: it.hits }); out.memories++ }
      } catch {}
      try {
        const items = safeJson(readFileSync(join(QQ_DATA, 'stickers', 'index.json'), 'utf8'))?.items || []
        for (const it of items) if (it && it.md5) { this.addSticker({ md5: it.md5, name: it.name, tags: it.tags, file: it.file, bytes: it.bytes, created: it.at }); out.stickers++ }
      } catch {}
      return out
    },
    close() {},
  }
}

async function createStore() {
  mkdirSync(BASE, { recursive: true })
  try { return await openSqlite() } catch (error) {
    console.warn('[hub-center] SQLite 不可用，回退 JSON：', error?.message)
    return openJson()
  }
}

function runCmd(cmd, args, timeoutMs = 120000, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: 'ignore', env: env ? { ...process.env, ...env } : process.env })
    const timer = setTimeout(() => { try { p.kill() } catch {} ; reject(new Error('超时')) }, timeoutMs)
    p.on('error', (e) => { clearTimeout(timer); reject(e) })
    p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(cmd + ' 退出码 ' + code)) })
  })
}

async function stopComfy() {
  try {
    await runCmd('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -like '*ComfyUI*main.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], 20000)
  } catch {}
}

async function stopTts() {
  try {
    await runCmd('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'api_v2\\.py|cosy_server\\.py' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], 20000)
  } catch {}
}

async function sapiWav(text, wav) {
  const safe = String(text).replace(/'/g, "''").replace(/[\r\n]+/g, ' ').slice(0, 2000)
  const ps = [
    'Add-Type -AssemblyName System.Speech;',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
    `$s.SetOutputToWaveFile('${wav.replace(/'/g, "''")}');`,
    `$s.Speak('${safe}');`,
    '$s.Dispose()',
  ].join(' ')
  await runCmd('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], 60000)
}

let hubStore = null

function voiceCfg() {
  let cfg = {}
  try {
    const m = hubStore ? hubStore.modules().find((x) => x.id === 'voice') : null
    if (m && m.config) cfg = typeof m.config === 'string' ? JSON.parse(m.config) : m.config
  } catch {}
  return {
    engine: cfg.engine === 'gsv' ? 'gsv' : cfg.engine === 'cosy' ? 'cosy' : 'edge',
    gsvUrl: cfg.gsvUrl || GSV_DEFAULT_URL,
    gsvRef: cfg.gsvRef || '',
    gsvPrompt: cfg.gsvPrompt || '',
    gsvLang: cfg.gsvLang || 'zh',
    gsvSpeed: cfg.gsvSpeed,
    gsvTemperature: cfg.gsvTemperature,
    gsvTopK: cfg.gsvTopK,
    cosyUrl: cfg.cosyUrl || 'http://127.0.0.1:9881',
    cosyInstruct: cfg.cosyInstruct || '',
    cosySpeed: cfg.cosySpeed,
    cosyAuto: cfg.cosyAuto !== false,
    cosyPresets: Array.isArray(cfg.cosyPresets) && cfg.cosyPresets.length ? cfg.cosyPresets : COSY_PRESETS_DEFAULT,
    rate: cfg.rate || '+0%',
    pitch: cfg.pitch || '+0Hz',
    voice: cfg.voice || TTS_VOICE,
  }
}

function gsvPort(url) {
  try { return Number(new URL(url).port) || 9880 } catch { return 9880 }
}

async function gsvUp(url) {
  try {
    await fetch(String(url).replace(/\/+$/, '') + '/', { signal: AbortSignal.timeout(1500) })
    return true
  } catch { return false }
}

async function ensureGsv(url) {
  if (await gsvUp(url)) return true
  if (!existsSync(GSV_PY)) throw new Error('没找到语音克隆运行环境：' + GSV_PY)
  if (!existsSync(join(GSV_ROOT, 'api_v2.py'))) throw new Error('没找到 GPT-SoVITS：' + GSV_ROOT)
  try { await fetch('http://127.0.0.1:8090/admin/unload', { method: 'POST', signal: AbortSignal.timeout(8000) }) } catch {}
  await stopComfy()
  mkdirSync(GSV_DIR, { recursive: true })
  const log = openSync(join(GSV_DIR, 'gsv.log'), 'a')
  const p = spawn(GSV_PY, ['api_v2.py', '-a', '127.0.0.1', '-p', String(gsvPort(url)), '-c', 'GPT_SoVITS/configs/tts_infer.yaml'], {
    cwd: GSV_ROOT,
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  p.unref()
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500))
    if (await gsvUp(url)) return true
  }
  throw new Error('语音克隆服务启动超时，看日志：' + join(GSV_DIR, 'gsv.log'))
}

async function gsvTts(text, cfg) {
  const t = String(text || '').trim()
  if (!t) throw new Error('没有要念的文字')
  if (!cfg.gsvRef || !existsSync(cfg.gsvRef)) throw new Error('还没设置参考音色')
  mkdirSync(OUT_DIR, { recursive: true })
  const ratePct = /^([+-]?\d+(?:\.\d+)?)%$/.exec(String(cfg.rate || '').trim())
  const speed = ratePct ? Math.max(0.5, Math.min(2, 1 + Number(ratePct[1]) / 100)) : Number(cfg.gsvSpeed || 1.0)
  const pitchM = /^([+-]?\d+(?:\.\d+)?)Hz$/.exec(String(cfg.pitch || '').trim())
  const pitchHz = pitchM ? Number(pitchM[1]) : 0
  const st = statSync(cfg.gsvRef)
  const key = createHash('sha1').update(['gsv', t, cfg.gsvRef, String(st.mtimeMs), cfg.gsvPrompt, cfg.gsvLang, String(speed), String(pitchHz)].join('|')).digest('hex').slice(0, 16)
  const wav = join(OUT_DIR, `gsv-${key}.wav`)
  if (existsSync(wav) && statSync(wav).size > 1000) return { file: wav, engine: 'gpt-sovits', cached: true }
  await ensureGsv(cfg.gsvUrl)
  const started = now()
  const r = await fetch(String(cfg.gsvUrl).replace(/\/+$/, '') + '/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: t, text_lang: cfg.gsvLang || 'zh', ref_audio_path: cfg.gsvRef, prompt_text: cfg.gsvPrompt || '', prompt_lang: cfg.gsvLang || 'zh',
      top_k: Number(cfg.gsvTopK || 5), top_p: 1, temperature: Number(cfg.gsvTemperature || 1), text_split_method: 'cut5', batch_size: 1, speed_factor: speed,
      media_type: 'wav', streaming_mode: false,
    }),
    signal: AbortSignal.timeout(180000),
  })
  if (!r.ok) throw new Error('语音克隆合成失败 ' + r.status + '：' + (await r.text()).slice(0, 200))
  let buf = Buffer.from(await r.arrayBuffer())
  if (!buf.length) throw new Error('语音克隆没有返回音频')
  writeFileSync(wav, buf)
  let file = wav
  if (pitchHz && Math.abs(pitchHz) >= 1) file = await shiftPitch(wav, pitchHz)
  return { file, engine: 'gpt-sovits', cached: false, ms: now() - started }
}

async function shiftPitch(file, hz) {
  const f = 1 + Number(hz) / 220
  if (!Number.isFinite(f) || Math.abs(f - 1) < 0.004) return file
  const out = file.replace(/\.wav$/i, `-p${Math.round(Number(hz))}.wav`)
  if (existsSync(out) && statSync(out).size > 1000) return out
  try {
    await runCmd(FFMPEG, ['-y', '-i', file, '-filter:a', `aformat=sample_rates=44100,asetrate=${Math.round(44100 * f)},aresample=44100,atempo=${(1 / f).toFixed(4)}`, '-ac', '1', out], 60000)
  } catch (e) {
    hubStore?.emit({ module: 'voice', level: 'warn', kind: 'tts', summary: '变调失败，用原音：' + String(e?.message || e).slice(0, 60) })
    return file
  }
  return existsSync(out) && statSync(out).size > 1000 ? out : file
}

async function cosyUp(url) {
  try {
    const r = await fetch(String(url || 'http://127.0.0.1:9881').replace(/\/+$/, '') + '/docs', { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch { return false }
}

async function ensureCosy(url) {
  if (await cosyUp(url)) return true
  try { await fetch('http://127.0.0.1:8090/admin/unload', { method: 'POST', signal: AbortSignal.timeout(8000) }) } catch {}
  await stopComfy()
  const py = PATHS.cosyPy
  const root = PATHS.cosyRoot
  if (!existsSync(py) || !existsSync(join(root, 'cosy_server.py'))) throw new Error('没找到 CosyVoice 运行环境')
  mkdirSync(GSV_DIR, { recursive: true })
  const log = openSync(join(GSV_DIR, 'cosy.log'), 'a')
  const p = spawn(py, ['cosy_server.py'], {
    cwd: root, detached: true, stdio: ['ignore', log, log], windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  p.unref()
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500))
    if (await cosyUp(url)) return true
  }
  throw new Error('CosyVoice 启动超时，看日志：' + join(GSV_DIR, 'cosy.log'))
}

function pickCosyPreset(t, cfg) {
  const list = Array.isArray(cfg.cosyPresets) ? cfg.cosyPresets : []
  if (!list.length) return null
  const find = (name) => list.find((p) => String(p.name || '').includes(name))
  const rules = [
    [/(气死|生气|讨厌|烦死|不理你|过分|混蛋|哼[！!]|气炸)/, '生气'],
    [/(才不是|谁要|随便你|笨蛋|傲娇|不理你了|哼)/, '傲娇'],
    [/(喜欢|想你|抱抱|贴贴|爱你|亲亲)/, '喜欢'],
    [/(哈哈|开心|好耶|太棒|嘿嘿|高兴|太好了)/, '高兴'],
    [/(困|睡觉|晚安|好累|疲惫)/, '困'],
  ]
  for (const [re, name] of rules) {
    const p = find(name)
    if (p && re.test(t)) return p
  }
  return null
}

async function cosyTts(text, cfg) {
  const t = String(text || '').trim()
  if (!t) throw new Error('没有要念的文字')
  if (!cfg.gsvRef || !existsSync(cfg.gsvRef)) throw new Error('还没设置参考音色')
  let picked = null
  if (cfg.cosyAuto !== false && !cfg.explicitInstruct) picked = pickCosyPreset(t, cfg)
  const instruct = picked ? String(picked.instruct || '') : String(cfg.cosyInstruct || '')
  const speed = Number((picked && picked.speed) || cfg.cosySpeed || 1)
  const base = String(cfg.cosyUrl || 'http://127.0.0.1:9881').replace(/\/+$/, '')
  if (!(await cosyUp(base))) await ensureCosy(base)
  mkdirSync(OUT_DIR, { recursive: true })
  const key = createHash('sha1').update(['cosy', t, cfg.gsvRef, instruct, String(speed)].join('|')).digest('hex').slice(0, 16)
  const wav = join(OUT_DIR, `cosy-${key}.wav`)
  if (existsSync(wav) && statSync(wav).size > 1000) return { file: wav, engine: 'cosyvoice', cached: true }
  const started = now()
  const r = await fetch(base + '/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: t, instruct, ref: cfg.gsvRef, prompt: cfg.gsvPrompt || '', speed }),
    signal: AbortSignal.timeout(300000),
  })
  if (!r.ok) throw new Error('CosyVoice 合成失败 ' + r.status + '：' + (await r.text()).slice(0, 200))
  const buf = Buffer.from(await r.arrayBuffer())
  if (!buf.length) throw new Error('CosyVoice 没有返回音频')
  writeFileSync(wav, buf)
  return { file: wav, engine: 'cosyvoice', cached: false, ms: now() - started }
}

async function ttsEngine(text, { voice = TTS_VOICE, rate, pitch } = {}, override) {
  const t = String(text || '').trim()
  if (!t) throw new Error('没有要念的文字')
  const vc = voiceCfg()
  if (override) for (const k of ['engine', 'gsvUrl', 'gsvRef', 'gsvPrompt', 'gsvLang', 'cosyUrl', 'cosyInstruct', 'cosySpeed', 'explicitInstruct', 'cosyAuto']) if (override[k] !== undefined && override[k] !== '') vc[k] = override[k]
  if (rate !== undefined && rate !== null && rate !== '') vc.rate = rate
  if (pitch !== undefined && pitch !== null && pitch !== '') vc.pitch = pitch
  const rateV = String(vc.rate || '+0%')
  const pitchV = String(vc.pitch || '+0Hz')
  if (vc.engine === 'cosy' && vc.gsvRef) {
    try {
      return await cosyTts(t, vc)
    } catch (e) {
      hubStore?.emit({ module: 'voice', level: 'warn', kind: 'tts', summary: 'CosyVoice 失败，回退：' + String(e?.message || e).slice(0, 80) })
    }
  }
  if (vc.engine === 'gsv' && vc.gsvRef) {
    try {
      return await gsvTts(t, vc)
    } catch (e) {
      hubStore?.emit({ module: 'voice', level: 'warn', kind: 'tts', summary: '语音克隆失败，回退 edge：' + String(e?.message || e).slice(0, 80) })    }
  }
  mkdirSync(OUT_DIR, { recursive: true })
  const key = createHash('sha1').update([t, voice, rateV, pitchV].join('|')).digest('hex').slice(0, 16)
  const mp3 = join(OUT_DIR, `tts-${key}.mp3`)
  const wav = join(OUT_DIR, `tts-${key}.wav`)
  if (existsSync(mp3) && statSync(mp3).size > 0) return { file: mp3, engine: 'edge-tts', cached: true }
  if (existsSync(wav) && statSync(wav).size > 0) return { file: wav, engine: 'sapi', cached: true }
  const started = now()
  try {
    await runCmd(TTS_PY, ['-m', 'edge_tts', '--text', t, '--voice', voice, '--rate', rateV, '--pitch', pitchV, '--write-media', mp3], 90000)
    if (existsSync(mp3) && statSync(mp3).size > 0) return { file: mp3, engine: 'edge-tts', cached: false, ms: now() - started }
    throw new Error('没有生成音频')
  } catch (error) {
    await sapiWav(t, wav)
    if (!existsSync(wav) || statSync(wav).size === 0) throw new Error('语音合成失败：' + (error?.message || error))
    return { file: wav, engine: 'sapi', cached: false, ms: now() - started }
  }
}

async function asrEngine(file) {
  const f = String(file || '')
  if (!f || !existsSync(f)) throw new Error('音频文件不存在')
  const started = now()
  const text = await new Promise((resolve, reject) => {
    const p = spawn(TTS_PY, ['-c', ASR_SCRIPT, f], {
      windowsHide: true,
      env: { ...process.env, HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com', PYTHONIOENCODING: 'utf-8', ASR_MODEL, ASR_CACHE },
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => { try { p.kill() } catch {} ; reject(new Error('语音识别超时')) }, 180000)
    p.stdout.on('data', (d) => { out += d.toString('utf8') })
    p.stderr.on('data', (d) => { err += d.toString('utf8') })
    p.on('error', (e) => { clearTimeout(timer); reject(e) })
    p.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error('语音识别失败：' + err.slice(-300)))
      else resolve(out.trim())
    })
  })
  return { text, ms: now() - started }
}

const VISION_URL = 'http://127.0.0.1:8091'
const OCR_SCRIPT = PATHS.ocrScript

function mimeOf(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif'
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return 'image/webp'
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp'
  return 'image/jpeg'
}

async function visionDescribe(source, question) {
  let buf
  if (/^https?:\/\//i.test(source)) {
    const r = await fetch(source, { signal: AbortSignal.timeout(30000) })
    if (!r.ok) throw new Error('下载图片失败 HTTP ' + r.status)
    buf = Buffer.from(await r.arrayBuffer())
  } else if (/^data:image\//i.test(source)) {
    buf = Buffer.from(source.slice(source.indexOf(',') + 1), 'base64')
  } else {
    if (!existsSync(source)) throw new Error('图片不存在：' + source)
    buf = readFileSync(source)
  }
  if (!buf.length) throw new Error('图片是空的')
  if (buf.length > 20 * 1024 * 1024) throw new Error('图片太大（>20MB）')
  const prompt = question
    ? `${question}\n只描述你确实看到的内容，用中文，不要寒暄。`
    : '用中文客观描述这张图：画面内容、有没有文字（有就原样写出来）、像不像表情包。不要寒暄。'
  const started = now()
  const r = await fetch(VISION_URL + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen2.5-vl',
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mimeOf(buf)};base64,${buf.toString('base64')}` } },
      ] }],
      max_tokens: 400,
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(120000),
  })
  if (!r.ok) throw new Error('视觉服务返回 ' + r.status)
  const j = await r.json()
  const description = String(j?.choices?.[0]?.message?.content || '').trim()
  if (!description) throw new Error('视觉模型没有返回描述')
  return { description, ms: now() - started }
}

async function ocrFile(file) {
  if (!file || !existsSync(file)) throw new Error('图片不存在：' + file)
  const winPath = String(file).replace(/\//g, '\\')
  const started = now()
  const text = await new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', OCR_SCRIPT, '-Path', winPath], { windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => { try { p.kill() } catch {} ; reject(new Error('OCR 超时')) }, 60000)
    p.stdout.on('data', (d) => { out += d.toString('utf8') })
    p.stderr.on('data', (d) => { err += d.toString('utf8') })
    p.on('error', (e) => { clearTimeout(timer); reject(e) })
    p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(out.trim()) : reject(new Error('OCR 失败：' + err.slice(-200))) })
  })
  return { text, ms: now() - started }
}

async function videoDescribe(file, question) {
  if (!file || !existsSync(file)) throw new Error('视频不存在：' + file)
  const started = now()
  const dir = join(TMP_DIR, 'v-' + started.toString(36))
  mkdirSync(dir, { recursive: true })
  try {
    await new Promise((resolve, reject) => {
      const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', String(file),
        '-vf', 'fps=1/2,scale=512:-2', '-frames:v', '4', '-q:v', '4', join(dir, 'f%02d.jpg')], { windowsHide: true })
      let err = ''
      const timer = setTimeout(() => { try { p.kill() } catch {} ; reject(new Error('抽帧超时')) }, 90000)
      p.stderr.on('data', (d) => { err += d.toString('utf8') })
      p.on('error', (e) => { clearTimeout(timer); reject(e) })
      p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('抽帧失败：' + err.slice(-200))) })
    })
    const frames = readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort()
    if (!frames.length) throw new Error('视频里没抽出画面')
    const content = [{
      type: 'text',
      text: (question || '这是一个视频按时间顺序抽取的几帧。请用中文描述：画面里发生了什么、人物/物体、场景、明显的动作变化，以及画面上的文字（有就原样写出来）。不要寒暄。'),
    }]
    for (const f of frames.slice(0, 4)) {
      const buf = readFileSync(join(dir, f))
      content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${buf.toString('base64')}` } })
    }
    const r = await fetch(VISION_URL + '/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen2.5-vl', messages: [{ role: 'user', content }], max_tokens: 500, temperature: 0.2 }),
      signal: AbortSignal.timeout(180000),
    })
    if (!r.ok) throw new Error('视觉服务返回 ' + r.status)
    const j = await r.json()
    const description = String(j?.choices?.[0]?.message?.content || '').trim()
    if (!description) throw new Error('视觉模型没有返回描述')
    return { description, frames: frames.length, ms: now() - started }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

// ---- 视频生成（ComfyUI Wan2.1 T2V 1.3B） ----
const COMFY = (process.env.COMFY_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '')
const COMFY_ROOT = PATHS.comfyRoot
const COMFY_MODELS = join(COMFY_ROOT, 'models')
const COMFY_OUT = join(COMFY_ROOT, 'output')
const VIDEO_FILES = {
  unet: join(COMFY_MODELS, 'diffusion_models', 'wan2.1_t2v_1.3B_bf16.safetensors'),
  clip: join(COMFY_MODELS, 'text_encoders', 'umt5_xxl_fp8_e4m3fn_scaled.safetensors'),
  vae: join(COMFY_MODELS, 'vae', 'wan_2.1_vae.safetensors'),
}

function videoGraph(prompt, { seed, width, height, length, steps, cfg, shift }) {
  const negative = '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走'
  return {
    1: { class_type: 'UNETLoader', inputs: { unet_name: 'wan2.1_t2v_1.3B_bf16.safetensors', weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', type: 'wan' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: 'wan_2.1_vae.safetensors' } },
    4: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['2', 0] } },
    5: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['2', 0] } },
    6: { class_type: 'ModelSamplingSD3', inputs: { shift, model: ['1', 0] } },
    7: { class_type: 'EmptyHunyuanLatentVideo', inputs: { width, height, length, batch_size: 1 } },
    8: {
      class_type: 'KSampler',
      inputs: {
        seed, steps, cfg, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
        model: ['6', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['7', 0],
      },
    },
    9: { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    10: { class_type: 'CreateVideo', inputs: { images: ['9', 0], fps: 16 } },
    11: { class_type: 'SaveVideo', inputs: { video: ['10', 0], filename_prefix: 'hubvideo', format: 'mp4', codec: 'h264' } },
  }
}

async function comfyVideo(prompt, opts = {}) {
  const missing = Object.entries(VIDEO_FILES).filter(([, f]) => !existsSync(f)).map(([k]) => k)
  if (missing.length) throw new Error('视频模型还没下好：' + missing.join(' / '))
  // 显存独占：先卸文本模型、停语音服务
  try { await fetch('http://127.0.0.1:8090/admin/unload', { method: 'POST', signal: AbortSignal.timeout(8000) }) } catch {}
  await stopTts()
  try { await fetch(COMFY + '/system_stats', { signal: AbortSignal.timeout(1500) }) } catch {
    try { await runCmd('schtasks', ['/Run', '/TN', 'ComfyUI_Start'], 15000) } catch {}
    const deadline = Date.now() + 90000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000))
      try { const rr = await fetch(COMFY + '/system_stats', { signal: AbortSignal.timeout(1500) }); if (rr.ok) break } catch {}
    }
  }
  const seed = Number.isFinite(opts.seed) ? Math.floor(opts.seed) : Math.floor(Math.random() * 2147483647)
  let length = Math.max(5, Math.min(81, Number(opts.length) || 33))
  length = Math.round((length - 1) / 4) * 4 + 1
  const graph = videoGraph(prompt, {
    seed,
    width: Math.max(256, Math.min(832, Number(opts.width) || 512)),
    height: Math.max(256, Math.min(480, Number(opts.height) || 384)),
    length,
    steps: Math.max(10, Math.min(50, Number(opts.steps) || 20)),
    cfg: Math.max(1, Math.min(10, Number(opts.cfg) || 6)),
    shift: Math.max(1, Math.min(20, Number(opts.shift) || 8)),
  })
  const started = now()
  const r = await fetch(COMFY + '/prompt', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: graph, client_id: 'dsh-hub-video' }),
    signal: AbortSignal.timeout(30000),
  })
  if (!r.ok) throw new Error('ComfyUI 提交失败 ' + r.status)
  const j = await r.json()
  const id = j && j.prompt_id
  if (!id) throw new Error('ComfyUI 没有返回 prompt_id')
  const deadline = Date.now() + 20 * 60 * 1000
  let file = ''
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 1500))
    let h = null
    try { h = await (await fetch(`${COMFY}/history/${encodeURIComponent(id)}`)).json() } catch {}
    const rec = h && h[id]
    if (!rec) continue
    if (rec.status && rec.status.status_str === 'error') throw new Error('ComfyUI 执行出错：' + JSON.stringify(rec.status.messages || '').slice(0, 200))
    const outs = rec.outputs || {}
    for (const k of Object.keys(outs)) {
      const v = outs[k]
      for (const key of ['videos', 'gifs', 'images']) {
        const list = v && v[key]
        if (!Array.isArray(list)) continue
        for (const it of list) {
          if (it && typeof it.filename === 'string' && /\.(mp4|webm|mkv|mov)$/i.test(it.filename)) {
            file = join(COMFY_OUT, it.subfolder || '', it.filename)
          }
        }
      }
    }
    if (!file) {
      // 有的版本只把结果写进 output 目录，按时间找最新的 hubvideo*
      try {
        const cands = readdirSync(COMFY_OUT).filter((f) => /^hubvideo.*\.(mp4|webm|mkv|mov)$/i.test(f))
          .map((f) => join(COMFY_OUT, f))
          .filter((f) => { try { return statSync(f).mtimeMs >= started - 5000 } catch { return false } })
        if (cands.length) file = cands[cands.length - 1]
      } catch {}
    }
    if (file) break
  }
  if (!file || !existsSync(file)) throw new Error('等待视频生成超时')
  const buf = readFileSync(file)
  if (!buf.length) throw new Error('ComfyUI 返回空视频')
  const outDir = join(OUT_DIR, 'video')
  mkdirSync(outDir, { recursive: true })
  const outFile = join(outDir, 'v' + started.toString(36) + '.mp4')
  writeFileSync(outFile, buf)
  try { rmSync(file, { force: true }) } catch {}
  return { file: outFile, bytes: buf.length, ms: now() - started, seconds: Math.round(length / 16 * 10) / 10, seed }
}

function analyzeStyle({ scope = '*', days = 14 } = {}) {
  const dir = join(QQ_DATA, 'chatlog')
  if (!existsSync(dir)) return { scope, messages: 0, updated: now(), error: '没有聊天记录目录' }
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().slice(-Math.max(1, Math.min(60, Number(days) || 14)))
  const texts = []
  const all = []
  for (const f of files) {
    let lines = []
    try { lines = readFileSync(join(dir, f), 'utf8').split('\n') } catch { continue }
    for (const line of lines) {
      const m = safeJson(line)
      if (!m || !m.text) continue
      if (scope && scope !== '*' && m.chatId !== scope) continue
      if (m.who !== 'bot' && m.who !== '大肥鱼') continue
      all.push(m)
      const t = String(m.text).replace(/\[sticker\]/gi, '').replace(/\[图片\]/g, '').trim()
      if (!t) continue
      // 跳过跑偏的推理/错误提示，别让它们污染风格画像
      if (/真实的用户|用户正在|若反复出现|请重试|上下文不足|模型只输出|好的，用户|分析对话|确保回复|思考过程/.test(t)) continue
      texts.push(t)
    }
  }
  const total = texts.length
  const lens = texts.map((t) => [...t].length).sort((a, b) => a - b)
  const avg = total ? lens.reduce((a, b) => a + b, 0) / total : 0
  const median = total ? lens[Math.floor(total / 2)] : 0
  const punct = texts.filter((t) => /[。！？!?…~～]$/.test(t)).length
  const emoji = texts.filter((t) => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(t)).length
  const stickers = all.filter((m) => /\[sticker\]/i.test(String(m.text))).length
  const freq = new Map()
  for (const t of texts) {
    for (const part of t.split(/[，。！？!?、,.~～\s]+/)) {
      const p = part.trim()
      const n = [...p].length
      if (n >= 2 && n <= 6) freq.set(p, (freq.get(p) || 0) + 1)
    }
  }
  const topPhrases = [...freq.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 8)
  const textCount = new Map()
  for (const t of texts) textCount.set(t, (textCount.get(t) || 0) + 1)
  const repeatTop = [...textCount.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 5)
  const hints = []
  if (total && avg <= 14) hints.push('句子很短，通常一句话')
  if (total && punct / total < 0.35) hints.push('经常不加标点')
  if (total && emoji / total > 0.15) hints.push('爱用 emoji')
  if (topPhrases.length) hints.push('常用口头禅：' + topPhrases.slice(0, 4).map(([t]) => t).join('、'))
  return {
    scope,
    days: files.length,
    messages: total,
    avgLen: Math.round(avg * 10) / 10,
    medianLen: median,
    punctRate: total ? Math.round(punct / total * 100) / 100 : 0,
    emojiRate: total ? Math.round(emoji / total * 100) / 100 : 0,
    stickerRate: total ? Math.round(stickers / total * 100) / 100 : 0,
    topPhrases: topPhrases.map(([text, count]) => ({ text, count })),
    repeatTop: repeatTop.map(([text, count]) => ({ text, count })),
    hints,
    updated: now(),
  }
}

function createQqLogBridge(store) {
  const dir = join(QQ_DATA, 'logs')
  const stateFile = join(BASE, 'qqlog-state.json')
  let state = { file: '', offset: 0 }
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')) } catch {}
  let firstRun = !state.file
  const save = () => { try { writeFileSync(stateFile, JSON.stringify(state)) } catch {} }
  const latestFile = () => {
    try {
      const files = readdirSync(dir).filter((f) => /^qq-hub-.*\.log$/.test(f)).sort()
      return files.length ? join(dir, files[files.length - 1]) : ''
    } catch { return '' }
  }
  return {
    tick() {
      const file = latestFile()
      if (!file) return
      let size = 0
      try { size = statSync(file).size } catch { return }
      if (file !== state.file) {
        state.file = file
        state.offset = firstRun ? size : 0
        firstRun = false
        save()
        if (state.offset >= size) return
      }
      if (size < state.offset) state.offset = 0
      if (size === state.offset) return
      let buf
      try {
        const fd = openSync(file, 'r')
        const len = Math.min(256 * 1024, size - state.offset)
        buf = Buffer.alloc(len)
        readSync(fd, buf, 0, len, state.offset)
        closeSync(fd)
      } catch { return }
      state.offset += buf.length
      save()
      const recent = tick.recent || (tick.recent = new Map())
      let n = 0
      for (const line of buf.toString('utf8').split('\n')) {
        if (n >= 20) break
        const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[(\w+)\] (.*)$/.exec(line.trim())
        if (!m) continue
        const ts = new Date(m[1].replace(' ', 'T')).getTime() || now()
        const summary = m[3].replace(/\s*\[host\.(stdout|stderr|kernel\.qq-hub)\].*$/, '').slice(0, 300)
        const last = recent.get(summary)
        if (last && ts - last < 90000) continue
        recent.set(summary, ts)
        if (recent.size > 500) {
          for (const [k, v] of recent) { if (ts - v > 300000) recent.delete(k) }
        }
        n++
        const level = m[2] === 'error' ? 'error' : m[2] === 'warn' ? 'warn' : 'info'
        store.emit({ module: 'qq', level, kind: 'log', summary, ts })
      }
    },
  }
}

async function probe(url, timeoutMs = 1500) {
  const t = now()
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    const text = await r.text()
    let body = null
    try { body = JSON.parse(text) } catch {}
    return { ok: r.ok, ms: now() - t, body }
  } catch (error) {
    return { ok: false, ms: now() - t, error: String(error?.message || error) }
  }
}

// ---- OneBot（SnowLuma）状态 ----
function onebotCfg() {
  try {
    const c = JSON.parse(readFileSync(join(QQ_DATA, 'config.json'), 'utf8'))
    const s = c.snowluma || {}
    const out = {
      url: String(s.httpUrl || '').replace(/\/+$/, ''),
      token: String(s.httpToken || ''),
      webui: 'http://127.0.0.1:' + Number(s.webuiPort || 5099),
    }
    // SnowLuma 自己的配置里才有真实的 HTTP 端口和 accessToken
    try {
      const f = join('C:\\Aurabot\\snowluma', 'config', 'onebot_' + (c.botQQ || '') + '.json')
      if (existsSync(f)) {
        const sl = JSON.parse(readFileSync(f, 'utf8'))
        const srv = (sl.networks && sl.networks.httpServers && sl.networks.httpServers[0]) || null
        if (srv) {
          out.url = 'http://' + (srv.host || '127.0.0.1') + ':' + Number(srv.port || 3000)
          out.token = String(srv.accessToken || out.token)
        }
      }
    } catch {}
    if (!out.url) out.url = 'http://127.0.0.1:3000'
    return out
  } catch {
    return { url: 'http://127.0.0.1:3000', token: '', webui: 'http://127.0.0.1:5099' }
  }
}
async function onebotCall(action, timeoutMs = 2500) {
  const { url, token } = onebotCfg()
  const t = now()
  try {
    const headers = { 'Content-Type': 'application/json' }
    if (token) headers.Authorization = 'Bearer ' + token
    const r = await fetch(url + '/' + action, { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(timeoutMs) })
    const body = await r.json().catch(() => null)
    return { ok: r.ok, ms: now() - t, body }
  } catch (error) {
    return { ok: false, ms: now() - t, error: String(error?.message || error) }
  }
}

export async function apply(ctx, config) {
  const store = await createStore()
  hubStore = store
  const startedAt = now()
  const api = { version: VERSION, store, emit: (ev) => store.emit(ev), modules: () => store.modules(), counts: () => store.counts(), base: BASE }
  try { ctx.set('hubCenter', api) } catch {}
  try { ctx.effect(() => () => store.close()) } catch {}

  store.emit({ module: 'hub', level: 'info', kind: 'start', summary: '中枢内核已启动（' + store.kind + '）' })

  const qqBridge = createQqLogBridge(store)
  const qqTimer = setInterval(() => { try { qqBridge.tick() } catch {} }, 10000)
  try { ctx.effect(() => () => clearInterval(qqTimer)) } catch {}

  // 语音克隆按需启动：不预占显存（8G 卡要和 ComfyUI 共用），首次 TTS 时再拉起

  const send = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(obj))
  }
  const readBody = (req) => new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) } })
  })

  // ---- 日记：每天记几件有意思的小事，聊天时可以偶尔翻出来讲 ----
  const diaryCfg = () => {
    const b = store.modules().find((m) => m.id === 'behavior')
    return { ...DIARY_DEFAULTS, ...((b && b.config && b.config.diary) || {}) }
  }
  const dayKey = (ts = now()) => {
    const d = new Date(Number(ts) || now())
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  function chatlogParts(day) {
    const out = { group: [], private: [] }
    try {
      const file = join(QQ_DATA, 'chatlog', day + '.jsonl')
      if (!existsSync(file)) return out
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue
        let o = null
        try { o = JSON.parse(line) } catch { continue }
        const text = String(o.text || '').replace(/\s+/g, ' ').trim()
        if (!text || text.startsWith('[')) continue
        const who = String(o.who || '')
        const row = `${who}: ${text.slice(0, 90)}`
        if (String(o.chatId || '').startsWith('group:')) out.group.push(row)
        else if (String(o.chatId || '').startsWith('private:') || String(o.chatId || '').startsWith('c2c:')) out.private.push(row)
      }
    } catch {}
    return out
  }
  async function browserParts(day) {
    const out = []
    try {
      const d0 = new Date(day + 'T00:00:00').getTime()
      const d1 = d0 + 86400000
      const chromeEpoch = (t) => Math.round((t / 1000 + 11644473600) * 1000000)
      const homes = [
        join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data', 'Default', 'History'),
        join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data', 'Default', 'History'),
      ]
      mkdirSync(TMP_DIR, { recursive: true })
      for (const src of homes) {
        if (!existsSync(src)) continue
        const tmp = join(TMP_DIR, 'hist-' + Math.random().toString(36).slice(2) + '.db')
        try {
          readFileSync(src)
          writeFileSync(tmp, readFileSync(src))
          const { DatabaseSync } = await import('node:sqlite')
          const db = new DatabaseSync(tmp, { readOnly: true })
          const rows = db.prepare(`SELECT title,url FROM urls WHERE last_visit_time>=? AND last_visit_time<? AND (url LIKE '%bilibili.com/video%' OR url LIKE '%douyin.com/video%' OR url LIKE '%bilibili.com/list%') ORDER BY last_visit_time DESC LIMIT 25`).all(chromeEpoch(d0), chromeEpoch(d1))
          for (const r of rows) if (r.title) out.push('刷到: ' + String(r.title).slice(0, 80))
          db.close()
        } catch {} finally { try { rmSync(tmp, { force: true }) } catch {} }
        if (out.length) break
      }
    } catch {}
    return out
  }
  async function callText(messages, { maxTokens = 400, timeout = 120000 } = {}) {
    const r = await fetch(TEXT_URL + '/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: TEXT_MODEL, messages, max_tokens: maxTokens, temperature: 0.8 }),
      signal: AbortSignal.timeout(timeout),
    })
    if (!r.ok) throw new Error('文本模型 ' + r.status + '：' + (await r.text()).slice(0, 160))
    const j = await r.json()
    return String(j?.choices?.[0]?.message?.content || '').trim()
  }
  async function generateDiary(day, { force = false } = {}) {
    const cfg = diaryCfg()
    const key = String(day || dayKey())
    if (!cfg.enabled && !force) return { ok: true, skipped: 'disabled' }
    const had = store.listDiary({ day: key, limit: 20 })
    if (had.length && !force) return { ok: true, skipped: 'exists', items: had }
    const chat = chatlogParts(key)
    const material = []
    if (cfg.useGroup) material.push(...chat.group.slice(-80))
    if (cfg.usePrivate) material.push(...chat.private.slice(-40))
    if (cfg.useBrowser) { try { material.push(...(await browserParts(key))) } catch {} }
    if (!material.length) return { ok: true, skipped: 'no-material' }
    const max = Math.max(1, Math.min(5, Number(cfg.dailyMax) || 3))
    const sys = '你是米粒，一只嘴硬心软、有点懒的蓝色鲸鱼女仆。你在写只给自己看的日记：只写今天真实发生的有意思的小事，第一人称，口语，短句；不要总结、不要讲道理、不要编造没发生的事。'
    const user = `今天是 ${key}。今天看到的片段：\n${material.join('\n').slice(0, 6000)}\n\n从里面挑 1-${max} 件最有意思的，写成日记，每行一条，每条 15~45 字，不要编号，不要写日期。`
    const raw = await callText([{ role: 'system', content: sys }, { role: 'user', content: user }], { maxTokens: 500 })
    const lines = raw.split(/\r?\n/).map((s) => s.replace(/^[\s\-–—•*·\d.、)）]+/, '').replace(/^["'“”]+|["'“”]+$/g, '').trim())
      .filter((s) => s.length >= 6 && s.length <= 120)
    const seen = new Set()
    const items = []
    for (const text of lines) {
      if (seen.has(text)) continue
      seen.add(text)
      const row = store.addDiary({ day: key, text, tags: ['日记', key], source: 'diary' })
      if (row) items.push(row)
      if (items.length >= max) break
    }
    if (items.length) store.emit({ module: 'behavior', level: 'info', kind: 'diary', summary: `日记 ${key}：${items.length} 条` })
    return { ok: true, day: key, items, material: material.length }
  }
  let diaryBusy = false
  const diaryTried = new Map()
  async function diaryTick() {
    if (diaryBusy) return
    const cfg = diaryCfg()
    if (!cfg.enabled) return
    diaryBusy = true
    try {
      const today = dayKey()
      const hour = new Date().getHours()
      const targets = []
      if (hour >= Number(cfg.hour || 23)) targets.push(today)
      const y = dayKey(now() - 86400000)
      if (!store.listDiary({ day: y, limit: 1 }).length && (Date.now() - (diaryTried.get(y) || 0)) > 3 * 3600000) targets.push(y)
      for (const day of targets) {
        if (store.listDiary({ day, limit: 1 }).length) continue
        if (Date.now() - (diaryTried.get(day) || 0) < 30 * 60000) continue
        diaryTried.set(day, Date.now())
        try { await generateDiary(day) } catch (e) {
          store.emit({ module: 'behavior', level: 'warn', kind: 'diary', summary: '日记生成失败：' + String(e?.message || e).slice(0, 100) })
        }
      }
    } finally { diaryBusy = false }
  }
  const diaryTimer = setInterval(() => { diaryTick().catch(() => {}) }, 5 * 60000)
  try { ctx.effect(() => () => clearInterval(diaryTimer)) } catch {}
  setTimeout(() => { diaryTick().catch(() => {}) }, 40000)

  const routes = []
  const route = (path, handler) => {
    routes.push(ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        try { await handler(req, res) } catch (error) { send(res, 500, { ok: false, error: String(error?.message || error) }) }
      },
    }))
  }

  // ---- 路径配置：默认本机，别人改了存 paths.json，重启生效 ----
  const checkPaths = (p2) => {
    const out = {}
    for (const k of PATH_KEYS) {
      const v = String(p2[k] || '')
      let exists = false
      try { exists = existsSync(v) } catch {}
      out[k] = { value: v, exists }
    }
    return out
  }
  // ---- 首次使用：网页版路径核对（包内自带，不依赖中枢）----
  route('/hub-center/setup', async (req, res) => {
    const path = await import('node:path')
    const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    if (String(req.method || 'GET').toUpperCase() === 'POST') {
      const body = await readBody(req)
      const next = { ...PATHS }
      for (const k of PATH_KEYS) if (typeof body[k] === 'string' && body[k].trim()) next[k] = body[k].trim()
      try { writeFileSync(PATHS_FILE, JSON.stringify(next, null, 2), 'utf8') } catch {}
      res.writeHead(302, { Location: '/hub-center/setup?saved=1' })
      return res.end()
    }
    const rows = PATH_KEYS.map((k) => {
      const v = String(PATHS[k] || '')
      let ok = false
      try { ok = existsSync(v) } catch {}
      return '<tr>'
        + '<td style="white-space:nowrap;color:#8a7a68;font-size:12.5px;padding:6px 8px 6px 0">' + esc(k) + '</td>'
        + '<td style="width:100%"><input name="' + esc(k) + '" value="' + esc(v) + '" style="width:100%;font-size:12.5px;padding:6px 9px;border:1px solid ' + (ok ? '#d9b68c' : '#e0736a') + ';border-radius:8px;background:#fff"></td>'
        + '<td style="white-space:nowrap;font-size:11.5px;color:' + (ok ? '#3f8f4f' : '#c0392b') + ';padding-left:8px">' + (ok ? 'OK' : '缺失') + '</td>'
        + '</tr>'
    }).join('')
    const saved = /saved=1/.test(String(req.url || ''))
    const html = '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>中枢 · 首次设置</title>'
      + '<style>body{background:#fdf6ec;color:#4d3b2b;font:14px/1.7 "Microsoft YaHei",system-ui;margin:0;padding:24px}'
      + '.card{max-width:760px;margin:0 auto;background:#fffdf8;border:1px solid #ecd9bd;border-radius:14px;padding:18px 20px}'
      + 'h1{font-size:18px;margin:0 0 6px}table{border-collapse:collapse;width:100%}'
      + 'button{margin-top:14px;background:#f3c894;border:1px solid #d9ae78;border-radius:9px;padding:8px 18px;font-size:14px;cursor:pointer;color:#4d3b2b}'
      + '.ok{background:#eaf6e6;border:1px solid #9ec98f;color:#3f6b34;border-radius:9px;padding:8px 12px;margin-bottom:12px;font-size:13px}'
      + '.muted{color:#8a7a68;font-size:12.5px}</style></head><body><div class="card">'
      + '<h1>先核对一下本机路径</h1>'
      + '<div class="muted" style="margin-bottom:12px">这些路径只是“可选功能”的位置：填对了对应功能就能用，留错也能启动。改完点保存，重启 DSH 生效。</div>'
      + (saved ? '<div class="ok" style="background:#eaf6e6;border:1px solid #9ec98f;color:#3f6b34;border-radius:9px;padding:8px 12px;margin-bottom:12px;font-size:13px">✓ 已保存，重启 DSH 生效</div>' : '')
      + '<form method="post" action="/hub-center/setup"><table>' + rows + '</table>'
      + '<button type="submit">保存</button></form>'
      + '<div class="muted" style="margin-top:14px">配置文件：' + esc(PATHS_FILE) + '</div>'
      + '</div></body></html>'
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    return res.end(html)
  })

  route('/hub-center/paths', async (req, res) => {
    if (String(req.method || 'GET').toUpperCase() === 'POST') {
      const body = await readBody(req)
      const next = { ...PATHS }
      for (const k of PATH_KEYS) {
        if (typeof body[k] === 'string' && body[k].trim()) next[k] = body[k].trim()
      }
      try {
        writeFileSync(PATHS_FILE, JSON.stringify(next, null, 2), 'utf8')
        return send(res, 200, { ok: true, note: '已保存，重启 DSH 生效', file: PATHS_FILE, paths: next, check: checkPaths(next) })
      } catch (e) {
        return send(res, 500, { ok: false, error: String(e?.message || e) })
      }
    }
    send(res, 200, { ok: true, file: PATHS_FILE, paths: PATHS, defaults: PATH_DEFAULTS, check: checkPaths(PATHS) })
  })

  route('/hub-center/status', async (req, res) => {
    const [m8090, m8091, c8188] = await Promise.all([
      probe('http://127.0.0.1:8090/health'),
      probe('http://127.0.0.1:8091/health'),
      probe('http://127.0.0.1:8188/system_stats', 3000),
    ])
    const since = now() - 10 * 60 * 1000
    const errByModule = {}
    try {
      for (const e of store.events({ level: 'error', limit: 500 })) {
        if (Number(e.ts || 0) < since) continue
        errByModule[e.module] = (errByModule[e.module] || 0) + 1
      }
    } catch {}
    const alerts = Object.entries(errByModule).filter(([, n]) => n >= 3)
      .map(([module, count]) => ({ level: 'error', module, count, text: `${module} 10 分钟内报错 ${count} 次` }))
    send(res, 200, {
      ok: true,
      version: VERSION,
      alerts,
      uptimeMs: now() - startedAt,
      store: { kind: store.kind, file: store.file, base: BASE, fts: store.fts !== false },
      services: {
        model8090: { ok: m8090.ok, loaded: m8090.body?.loaded || null, ms: m8090.ms, error: m8090.error || null },
        vision8091: { ok: m8091.ok, ms: m8091.ms, error: m8091.error || null },
        comfy8188: { ok: c8188.ok, ms: c8188.ms, error: c8188.error || null },
        whisperModel: { ok: existsSync(PATHS.whisperDir), dir: PATHS.whisperDir },
        ttsPython: { ok: existsSync('D:\\AI\\ComfyUI_windows_portable\\python_embeded\\python.exe'), path: 'D:\\AI\\ComfyUI_windows_portable\\python_embeded\\python.exe' },
      },
      counts: store.counts(),
      modules: store.modules(),
    })
  })

  route('/hub-center/modules', async (req, res) => send(res, 200, { ok: true, modules: store.modules() }))

  route('/hub-center/qqbot/status', async (req, res) => {
    const cfg = onebotCfg()
    const [st, info, web] = await Promise.all([
      onebotCall('get_status'),
      onebotCall('get_login_info'),
      probe(cfg.webui + '/', 1200),
    ])
    const d = (st.body && st.body.data) || {}
    const online = !!(st.ok && st.body && st.body.retcode === 0 && d.online)
    const good = !!d.good
    const nickname = (info.body && info.body.data && info.body.data.nickname) || ''
    const selfId = (info.body && info.body.data && info.body.data.user_id) || null
    let level = 'red', text = 'QQ 未连接'
    if (online && good) { level = 'green'; text = 'QQ 在线' + (nickname ? '（' + nickname + '）' : '') }
    else if (!st.ok) { level = 'red'; text = 'SnowLuma 网关未启动（' + cfg.url + ' 连不上）' }
    else if (!online) { level = 'red'; text = 'SnowLuma 已启动，但 QQ 未登录' }
    else { level = 'red'; text = 'QQ 在线但状态异常' }
    send(res, 200, {
      ok: true, level, text, online, good, nickname, selfId,
      gateway: { url: cfg.url, ok: st.ok, ms: st.ms, error: st.error || null, retcode: st.body ? st.body.retcode : null },
      webui: { url: cfg.webui, ok: !!web.ok },
    })
  })

  route('/hub-center/module', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    const body = await readBody(req)
    const id = String(body.id || '')
    if (!id) return send(res, 400, { ok: false, error: 'id required' })
    const next = store.setModule(id, body)
    if (!next) return send(res, 404, { ok: false, error: 'unknown module: ' + id })
    store.emit({ module: 'hub', level: 'info', kind: 'module', summary: `模块 ${id} 已更新` })
    send(res, 200, { ok: true, module: next })
  })

  route('/hub-center/events', async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    send(res, 200, {
      ok: true,
      events: store.events({
        limit: Number(u.searchParams.get('limit') || 200),
        module: String(u.searchParams.get('module') || ''),
        level: String(u.searchParams.get('level') || ''),
        q: String(u.searchParams.get('q') || ''),
      }),
    })
  })

  route('/hub-center/logs/sources', async (req, res) => {
    send(res, 200, { ok: true, sources: logSourceList() })
  })

  route('/hub-center/logs', async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const source = String(u.searchParams.get('source') || 'hub')
    const limit = Math.max(20, Math.min(1000, Number(u.searchParams.get('limit') || 300)))
    const q = String(u.searchParams.get('q') || '').trim().toLowerCase()
    const level = String(u.searchParams.get('level') || '')
    let items = []
    try {
      if (source === 'hub') {
        items = store.events({ limit: limit * 2, level, q }).map((e) => ({
          ts: Number(e.ts || 0), level: e.level, text: `[${e.module}] ${e.summary}`,
        }))
      } else if (source === 'memory') {
        const mods = ['memory', 'memsync', 'journal', 'diary', 'style'];
        items = store.events({ limit: limit * 4, level, q })
          .filter((e) => mods.includes(String(e.module)))
          .map((e) => ({ ts: Number(e.ts || 0), level: e.level, text: `[${e.module}] ${e.summary}` }))
      } else if (source === 'comfy') {
        items = await comfyEntries(limit)
      } else {
        const src = logSourceList().find((s) => s.id === source)
        if (!src || !src.path || !src.ok) return send(res, 200, { ok: true, source, items: [], error: '来源文件不存在' })
        items = src.kind === 'chatlog' ? chatEntries(src.path, limit) : fileEntries(src.path, limit)
      }
    } catch (e) {
      return send(res, 200, { ok: true, source, items: [], error: String(e && e.message || e) })
    }
    if (q) items = items.filter((x) => String(x.text || '').toLowerCase().includes(q))
    if (level) items = items.filter((x) => x.level === level)
    send(res, 200, { ok: true, source, items: items.slice(-limit) })
  })

  route('/hub-center/event', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    const body = await readBody(req)
    const ev = store.emit({
      module: String(body.module || 'external'), level: String(body.level || 'info'), kind: String(body.kind || ''),
      chat: String(body.chat || ''), summary: String(body.summary || ''), detail: body.detail || null, refs: body.refs || null,
    })
    send(res, 200, { ok: true, event: ev })
  })

  // ---- 记忆 ----
  route('/hub-center/memory', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    const body = await readBody(req)
    const row = store.addMemory(body)
    if (!row) return send(res, 400, { ok: false, error: 'text required' })
    send(res, 200, { ok: true, memory: row })
  })

  route('/hub-center/memory/search', async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const scope = String(u.searchParams.get('scope') || '')
    const items = store.searchMemories({
      q: String(u.searchParams.get('q') || ''),
      scope,
      limit: Number(u.searchParams.get('limit') || 8),
      includeArchived: u.searchParams.get('archived') === '1',
    })
    if (u.searchParams.get('bump') === '1') for (const m of items) store.bumpMemory(m.id)
    send(res, 200, { ok: true, items })
  })

  route('/hub-center/memory/list', async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    send(res, 200, {
      ok: true,
      items: store.listMemories({
        scope: String(u.searchParams.get('scope') || ''),
        limit: Number(u.searchParams.get('limit') || 50),
        includeArchived: u.searchParams.get('archived') === '1',
      }),
    })
  })

  route('/hub-center/memory/forget', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    const body = await readBody(req)
    const ok = store.forgetMemory(String(body.id || ''))
    send(res, ok ? 200 : 404, { ok, id: body.id || '' })
  })

  route('/hub-center/memory/delete', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    const body = await readBody(req)
    const ok = store.deleteMemory(String(body.id || ''))
    send(res, ok ? 200 : 404, { ok, id: body.id || '' })
  })

  route('/hub-center/memory/decay', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    const body = await readBody(req)
    const r = store.decayMemories(body || {})
    store.emit({ module: 'memory', level: 'info', kind: 'decay', summary: `遗忘：归档 ${r.archived}，删除 ${r.deleted}` })
    send(res, 200, { ok: true, ...r })
  })

  // ---- 表情 ----
  route('/hub-center/stickers', async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    send(res, 200, { ok: true, items: store.listStickers({ q: String(u.searchParams.get('q') || ''), limit: Number(u.searchParams.get('limit') || 50) }) })
  })

  route('/hub-center/sticker', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    const body = await readBody(req)
    if (!body || !body.md5) return send(res, 400, { ok: false, error: 'md5 required' })
    const row = store.addSticker(body)
    store.emit({ module: 'gen', level: 'info', kind: 'sticker', summary: '表情入库：' + String(body.name || body.md5).slice(0, 24) })
    send(res, 200, { ok: true, sticker: row })
  })

  route('/hub-center/sticker/use', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    const body = await readBody(req)
    const ok = store.useSticker(String(body.md5 || ''))
    send(res, ok ? 200 : 404, { ok })
  })

  // ---- 梗百科词库 ----
  route('/hub-center/meme/status', async (req, res) => {
    send(res, 200, { ok: true, count: store.memeCount(), src: MEME_SRC, srcOk: existsSync(MEME_SRC) })
  })

  route('/hub-center/meme/lookup', async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const text = String(u.searchParams.get('text') || '')
    const row = store.memeLookup(text)
    send(res, 200, { ok: true, hit: row ? pickMeme(row) : null })
  })

  route('/hub-center/meme', async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'POST') {
      const body = await readBody(req)
      const row = store.memeUpsert(body || {})
      if (!row) return send(res, 400, { ok: false, error: 'title required' })
      store.emit({ module: 'memory', level: 'info', kind: 'meme', summary: '梗词条保存：' + row.title })
      return send(res, 200, { ok: true, item: pickMeme(row) })
    }
    const items = store.memeList({ q: String(u.searchParams.get('q') || ''), limit: Number(u.searchParams.get('limit') || 50), offset: Number(u.searchParams.get('offset') || 0) })
    send(res, 200, { ok: true, items: items.map(pickMeme), total: store.memeCount() })
  })

  route('/hub-center/meme/delete', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    const body = await readBody(req)
    const ok = store.memeDelete(String(body.title || ''))
    send(res, ok ? 200 : 404, { ok })
  })

  route('/hub-center/meme/import', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    const body = await readBody(req)
    const file = String(body.file || MEME_SRC)
    if (!existsSync(file)) return send(res, 404, { ok: false, error: '词库文件不存在：' + file })
    const { DatabaseSync: DS } = await import('node:sqlite')
    const src = new DS(file, { readOnly: true })
    let rows = []
    try { rows = src.prepare('SELECT title,slug,tags,usage,origin,other,summary,aliases FROM memes').all() } finally { try { src.close() } catch {} }
    const n = store.memeImport(rows)
    store.emit({ module: 'memory', level: 'info', kind: 'meme', summary: `梗词库导入 ${n} 条` })
    send(res, 200, { ok: true, imported: n, total: store.memeCount() })
  })

  // ---- 迁移 ----
  route('/hub-center/migrate', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    const r = store.migrate()
    store.emit({ module: 'memory', level: 'info', kind: 'migrate', summary: `迁移：记忆 ${r.memories} 条，表情 ${r.stickers} 条` })
    send(res, 200, { ok: true, ...r })
  })

  // ---- 语音 / 听觉 ----
  route('/hub-center/tts', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    const body = await readBody(req)
    const ov = body.engine ? Object.assign({}, body, { explicitInstruct: !!(body.cosyInstruct || body.preset) }) : null
    const r = await ttsEngine(body.text, { voice: body.voice, rate: body.rate, pitch: body.pitch }, ov)
    store.emit({ module: 'voice', level: 'info', kind: 'tts', summary: `TTS ${r.engine}${r.cached ? '（缓存）' : ''}：${String(body.text || '').slice(0, 30)}` })
    send(res, 200, { ok: true, ...r })
  })

  route('/hub-center/asr', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    const body = await readBody(req)
    const r = await asrEngine(body.file)
    store.emit({ module: 'hearing', level: 'info', kind: 'asr', summary: `ASR：${String(r.text).slice(0, 40) || '（没听清）'}` })
    send(res, 200, { ok: true, ...r })
  })

  route('/hub-center/voice/status', async (req, res) => {
    let files = 0
    try { files = readdirSync(OUT_DIR).length } catch {}
    const vc = voiceCfg()
    const gsv = {
      engine: vc.engine,
      url: vc.gsvUrl,
      up: await gsvUp(vc.gsvUrl),
      python: GSV_PY,
      pythonOk: existsSync(GSV_PY),
      root: GSV_ROOT,
      rootOk: existsSync(join(GSV_ROOT, 'api_v2.py')),
      ref: vc.gsvRef,
      refOk: !!vc.gsvRef && existsSync(vc.gsvRef),
      prompt: vc.gsvPrompt,
    }
    const cosyUpNow = await (async () => {
      try { const r = await fetch(String(vc.cosyUrl || 'http://127.0.0.1:9881').replace(/\/+$/, '') + '/', { signal: AbortSignal.timeout(1500) }); return r.ok } catch { return false }
    })()
    send(res, 200, {
      ok: true,
      tts: { python: TTS_PY, pythonOk: existsSync(TTS_PY), dir: OUT_DIR, files, defaultVoice: TTS_VOICE, engine: vc.engine },
      gsv,
      cosy: { url: vc.cosyUrl || 'http://127.0.0.1:9881', up: cosyUpNow, instruct: vc.cosyInstruct || '', speed: Number(vc.cosySpeed || 1) },
      asr: { python: TTS_PY, cache: ASR_CACHE, modelOk: existsSync(ASR_CACHE), model: ASR_MODEL },
    })
  })

  route('/hub-center/voice/config', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    const body = await readBody(req)
    const cur = voiceCfg()
    const next = {
      engine: body.engine === 'gsv' ? 'gsv' : body.engine === 'edge' ? 'edge' : body.engine === 'cosy' ? 'cosy' : cur.engine,
      gsvUrl: String(body.gsvUrl || cur.gsvUrl),
      gsvRef: String(body.gsvRef ?? cur.gsvRef),
      gsvPrompt: String(body.gsvPrompt ?? cur.gsvPrompt),
      gsvLang: String(body.gsvLang || cur.gsvLang || 'zh'),
      gsvSpeed: Number(body.gsvSpeed ?? cur.gsvSpeed ?? 1),
      gsvTemperature: Number(body.gsvTemperature ?? cur.gsvTemperature ?? 1),
      gsvTopK: Number(body.gsvTopK ?? cur.gsvTopK ?? 5),
      cosyUrl: String(body.cosyUrl || cur.cosyUrl || 'http://127.0.0.1:9881'),
      cosyInstruct: String(body.cosyInstruct ?? cur.cosyInstruct ?? ''),
      cosySpeed: Number(body.cosySpeed ?? cur.cosySpeed ?? 1),
      rate: String(body.rate ?? cur.rate ?? '+0%'),
      pitch: String(body.pitch ?? cur.pitch ?? '+0Hz'),
    }
    if (next.gsvRef && !existsSync(next.gsvRef)) return send(res, 400, { ok: false, error: '参考音频不存在：' + next.gsvRef })
    store.setModule('voice', { config: next })
    store.emit({ module: 'voice', level: 'info', kind: 'config', summary: `语音引擎：${next.engine}${next.engine === 'gsv' ? '（参考 ' + (next.gsvPrompt || '无提示词') + '）' : ''}` })
    send(res, 200, { ok: true, ...next })
  })

  // ---- 视觉 ----
  route('/hub-center/vision/describe', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    const body = await readBody(req)
    const r = await visionDescribe(String(body.source || body.file || ''), String(body.question || ''))
    store.emit({ module: 'vision', level: 'info', kind: 'describe', summary: '看图：' + r.description.slice(0, 40) })
    send(res, 200, { ok: true, ...r })
  })

  route('/hub-center/vision/ocr', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    const body = await readBody(req)
    const r = await ocrFile(String(body.file || ''))
    store.emit({ module: 'vision', level: 'info', kind: 'ocr', summary: 'OCR：' + (r.text.slice(0, 40) || '（无文字）') })
    send(res, 200, { ok: true, ...r })
  })

  route('/hub-center/vision/analyze', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    const body = await readBody(req)
    const source = String(body.source || body.file || '')
    const [desc, ocr] = await Promise.allSettled([
      visionDescribe(source, String(body.question || '')),
      body.ocr === false ? Promise.resolve({ text: '', ms: 0 }) : ocrFile(source),
    ])
    send(res, 200, {
      ok: true,
      description: desc.status === 'fulfilled' ? desc.value.description : '',
      descriptionError: desc.status === 'rejected' ? String(desc.reason?.message || desc.reason) : null,
      text: ocr.status === 'fulfilled' ? ocr.value.text : '',
      ocrError: ocr.status === 'rejected' ? String(ocr.reason?.message || ocr.reason) : null,
    })
  })

  route('/hub-center/vision/video', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    const body = await readBody(req)
    const r = await videoDescribe(String(body.file || ''), String(body.question || ''))
    store.emit({ module: 'vision', level: 'info', kind: 'video', summary: '看视频：' + r.description.slice(0, 40) })
    send(res, 200, { ok: true, ...r })
  })

  route('/hub-center/vision/status', async (req, res) => {
    const v = await probe(VISION_URL + '/health')
    send(res, 200, {
      ok: true,
      vl: { ok: v.ok, ms: v.ms, error: v.error || null },
      ocr: { script: OCR_SCRIPT, exists: existsSync(OCR_SCRIPT) },
      video: { supported: existsSync(FFMPEG), ffmpeg: FFMPEG, frames: 4 },
    })
  })

  // ---- 视频生成 ----
  route('/hub-center/video', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    const body = await readBody(req)
    const prompt = String(body.prompt || '').trim()
    if (!prompt) return send(res, 400, { ok: false, error: 'prompt required' })
    const seconds = Math.max(1, Math.min(5, Number(body.seconds) || 2))
    const r = await comfyVideo(prompt, {
      width: body.width, height: body.height, steps: body.steps, cfg: body.cfg, shift: body.shift, seed: body.seed,
      length: Math.round(seconds * 16 / 4) * 4 + 1,
    })
    store.emit({ module: 'gen', level: 'info', kind: 'video', summary: `视频 ${r.seconds}s：${prompt.slice(0, 30)}` })
    send(res, 200, { ok: true, ...r })
  })

  route('/hub-center/video/status', async (req, res) => {
    const c = await probe(COMFY + '/system_stats', 3000)
    const models = Object.fromEntries(Object.entries(VIDEO_FILES).map(([k, f]) => [k, { file: f, ok: existsSync(f), gb: (() => { try { return Math.round(statSync(f).size / 1073741824 * 100) / 100 } catch { return 0 } })() }]))
    send(res, 200, {
      ok: true,
      comfy: { ok: c.ok, ms: c.ms, error: c.error || null },
      models,
      ready: Object.values(models).every((m) => m.ok),
      out: join(OUT_DIR, 'video'),
    })
  })

  // ---- 行为 ----
  route('/hub-center/style/analyze', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    const body = await readBody(req)
    const card = analyzeStyle({ scope: String(body.scope || '*'), days: Number(body.days || 14) })
    store.saveStyle(card)
    store.emit({ module: 'behavior', level: 'info', kind: 'style', summary: `风格分析：${card.scope}，${card.messages} 条样本` })
    send(res, 200, { ok: true, card })
  })

  route('/hub-center/style', async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    send(res, 200, { ok: true, card: store.getStyle(String(u.searchParams.get('scope') || '*')) })
  })

  route('/hub-center/reminder', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    const body = await readBody(req)
    const r = store.addReminder({ at: body.at, text: body.text, chat: body.chat })
    store.emit({ module: 'behavior', level: 'info', kind: 'reminder', summary: `提醒：${new Date(r.at).toLocaleString('zh-CN', { hour12: false })} ${String(r.text).slice(0, 30)}` })
    send(res, 200, { ok: true, reminder: r })
  })

  route('/hub-center/reminders', async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    send(res, 200, { ok: true, items: store.listReminders({ includeDone: u.searchParams.get('done') === '1', limit: Number(u.searchParams.get('limit') || 100) }) })
  })

  route('/hub-center/reminder/done', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    const body = await readBody(req)
    const ok = store.doneReminder(String(body.id || ''))
    send(res, ok ? 200 : 404, { ok })
  })

  // ---- 日记路由 ----
  route('/hub-center/diary', async (req, res) => {
    if (req.method === 'POST') {
      const body = await readBody(req)
      const r = store.addDiary({ day: body.day || dayKey(), text: body.text, tags: body.tags, source: 'manual' })
      return send(res, r ? 200 : 400, { ok: Boolean(r), item: r })
    }
    const u = new URL(req.url, 'http://127.0.0.1')
    send(res, 200, {
      ok: true,
      days: store.diaryDays(),
      items: store.listDiary({ day: u.searchParams.get('day') || '', limit: Number(u.searchParams.get('limit') || 50) }),
      config: diaryCfg(),
    })
  })

  route('/hub-center/diary/generate', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    const body = await readBody(req)
    try {
      const out = await generateDiary(body.day || dayKey(), { force: Boolean(body.force) })
      send(res, 200, out)
    } catch (e) { send(res, 500, { ok: false, error: String(e?.message || e) }) }
  })

  route('/hub-center/diary/delete', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    const body = await readBody(req)
    const ok = store.deleteDiary(String(body.id || ''))
    send(res, ok ? 200 : 404, { ok })
  })

  route('/hub-center/diary/recall', async (req, res) => {
    const cfg = diaryCfg()
    if (!cfg.enabled) return send(res, 200, { ok: true, item: null, reason: 'disabled' })
    const u = new URL(req.url, 'http://127.0.0.1')
    const chance = u.searchParams.has('chance') ? Number(u.searchParams.get('chance')) : Number(cfg.chance)
    if (!(Math.random() < Math.max(0, Math.min(1, chance)))) return send(res, 200, { ok: true, item: null, reason: 'chance' })
    const item = store.recallDiary({ minAgeDays: cfg.minAgeDays, maxAgeDays: cfg.maxAgeDays })
    if (!item) return send(res, 200, { ok: true, item: null, reason: 'empty' })
    store.bumpDiary(item.id)
    store.emit({ module: 'behavior', level: 'info', kind: 'diary', summary: `翻到日记 ${item.day}` })
    send(res, 200, { ok: true, item })
  })

  route('/hub-center/diary/config', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    const body = await readBody(req)
    const b = store.modules().find((m) => m.id === 'behavior')
    if (!b) return send(res, 404, { ok: false, error: 'behavior module missing' })
    const cur = (b.config && b.config.diary) || {}
    store.setModule('behavior', { config: { diary: { ...cur, ...body } } })
    send(res, 200, { ok: true, config: diaryCfg() })
  })

  route('/hub-center/behavior/status', async (req, res) => {
    let qqCfg = {}
    try { qqCfg = safeJson(readFileSync(join(QQ_DATA, 'config.json'), 'utf8')) || {} } catch {}
    const dh = (qqCfg.ext && qqCfg.ext.drawhook) || {}
    const reminders = store.listReminders({ limit: 5 })
    send(res, 200, {
      ok: true,
      qq: {
        drawhook: {
          refinePrompt: dh.refinePrompt !== false,
          selfIdea: dh.selfIdea !== false,
          proactiveEnabled: dh.proactiveEnabled !== false,
          proactiveChance: Number.isFinite(dh.proactiveChance) ? dh.proactiveChance : 10,
          proactiveCooldownMin: Number.isFinite(dh.proactiveCooldownMin) ? dh.proactiveCooldownMin : 30,
        },
        imageGen: Boolean(qqCfg.imageGen && qqCfg.imageGen.enabled),
      },
      reminders: { pending: store.listReminders({}).length, next: reminders[0] || null },
      diary: {
        config: diaryCfg(),
        days: store.diaryDays().length,
        total: store.listDiary({ limit: 500 }).length,
        today: store.listDiary({ day: dayKey(), limit: 5 }),
        recent: store.listDiary({ limit: 3 }),
      },
      styles: store.listStyles(),
      recent: store.events({ limit: 8, module: 'behavior' }),
    })
  })

  try { ctx.effect(() => () => { for (const d of routes) { try { d() } catch {} } }) } catch {}
}
