const { Resvg } = require('@resvg/resvg-js');
const fs = require('fs');
const path = require('path');

const USER_ID = process.env.HABITICA_USER_ID;
const API_TOKEN = process.env.HABITICA_API_TOKEN;
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const PUBLIC_STATS_URL = process.env.PUBLIC_STATS_URL || '';
const DB_KEY = 'habitica_stats_db';

const habiticaHeaders = {
  'x-api-user': USER_ID,
  'x-api-key': API_TOKEN,
  'x-client': `${USER_ID}-RPGStatsCard`,
};

let debugDbLoad = 'pending';
let debugDbSave = 'pending';
let fontLoadError = 'pending';

// ==========================================
// UTILITAS WAKTU & FORMAT
// ==========================================

const WIB_MS = 7 * 3600 * 1000;

function nowWIB() {
  return new Date(Date.now() + WIB_MS);
}

function dateOnly(d) {
  return new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate()
    )
  );
}

function fmtDateStr(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');

  return `${y}-${m}-${day}`;
}

// ==========================================
// FILE LOCAL
// ==========================================

function getLocalPath(filename) {
  const paths = [
    path.join(__dirname, filename),
    path.join(process.cwd(), 'api', filename),
    path.join('/var/task/api', filename),
    path.join('/var/task', filename),
    path.join(process.cwd(), filename),
  ];

  for (const p of paths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  return null;
}

function getLocalFile(filename) {
  const filePath = getLocalPath(filename);

  if (!filePath) {
    return null;
  }

  return fs.readFileSync(filePath);
}

// ==========================================
// UPSTASH DATABASE
// ==========================================

function defaultDB() {
  return {
    current_cycle_id: '',
    classes_used: [],
    peak_gold: 0,
    total_mana_spent: 0,

    last_mana: null,
    buffs_cast: 0,

    bosses_slain: 0,
    all_time_damage: 0,
    weekly_damage: 0,
    peak_daily_damage: 0,
    current_day_damage: 0,

    damage_day_date: '',
    last_damage_up: 0,

    // ==========================================
    // PHASE 3C 3.3 — PENDING DAMAGE + ACTIVE DAMAGE DAYS TRACKER
    // Pending damage di Habitica menjadi sumber utama.
    // Webhook hanya menjadi trigger/observasi dan tidak
    // menambahkan damage secara langsung.
    // ==========================================
    damage2_total: 0,
    damage2_weekly: 0,
    damage2_daily: 0,
    damage2_peak_daily: 0,
    damage2_day_date: '',
    damage2_week_id: '',
    damage2_event_keys: [],

    // Jumlah hari dalam minggu berjalan ketika damage > 0.
    damage2_active_days: 0,
    // Penanda agar satu hari hanya dihitung sekali.
    damage2_day_has_damage: false,

    damage2_initialized: false,
    damage2_last_quest_key: null,
    damage2_last_quest_active: false,
    damage2_last_pending_damage: 0,

    weekly_top_dailies: {},

    // ==========================================
    // PHASE 3B — HISTORICAL DAILY FAILURE TRACKING
    // Menyimpan snapshot Dailies yang jatuh tempo
    // dan yang selesai untuk menentukan kegagalan
    // pada pergantian hari berikutnya.
    // ==========================================
    dailies_failed: 0,
    dailies_snapshot_date: '',
    dailies_snapshot_due_ids: [],
    dailies_snapshot_completed_ids: [],

    last_daily_date: '',
    daily_habit_baseline: 0,

    last_quest_key: null,
    last_quest_is_boss: false,

    last_habit_counters: {},
    weekly_habit_clicks: {},
    weekly_habit_neg: {},

    today_habit_clicks: {},
    today_habit_neg: {},

    last_completed_daily_ids: [],

    monthly_habit_clicks: {},
    current_month_id: '',

    habit_daily_log: [],

    all_time_habits_pos: 0,
    all_time_habits_neg: 0,

    all_time_dailies_completed: 0,
    all_time_todos_completed: 0,

    last_completed_todo_ids: [],
  };
}

async function upstashCommand(command) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    throw new Error(
      'UPSTASH_REDIS_REST_URL atau UPSTASH_REDIS_REST_TOKEN belum tersedia.'
    );
  }

  const response = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
    cache: 'no-store',
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `Upstash mengembalikan response tidak valid: ${text.slice(0, 300)}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Upstash HTTP ${response.status}: ${data.error || text}`
    );
  }

  if (data.error) {
    throw new Error(`Upstash: ${data.error}`);
  }

  return data.result;
}

async function loadDB() {
  const db = defaultDB();

  try {
    const result = await upstashCommand([
      'GET',
      DB_KEY,
    ]);

    // Database belum pernah dibuat.
    if (result === null || result === undefined) {
      debugDbLoad = 'empty';
      return db;
    }

    if (typeof result !== 'string') {
      throw new Error('Data database Upstash bukan string JSON.');
    }

    const parsed = JSON.parse(result);

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Format database Upstash tidak valid.');
    }

    Object.assign(db, parsed);

    // Pastikan struktur lama yang mungkin belum memiliki field
    // tetap aman digunakan.
    db.classes_used = Array.isArray(db.classes_used)
      ? db.classes_used
      : [];

    db.weekly_top_dailies =
      db.weekly_top_dailies || {};

    db.last_habit_counters =
      db.last_habit_counters || {};

    db.weekly_habit_clicks =
      db.weekly_habit_clicks || {};

    db.weekly_habit_neg =
      db.weekly_habit_neg || {};

    db.today_habit_clicks =
      db.today_habit_clicks || {};

    db.today_habit_neg =
      db.today_habit_neg || {};

    db.monthly_habit_clicks =
      db.monthly_habit_clicks || {};

    db.habit_daily_log =
      Array.isArray(db.habit_daily_log)
        ? db.habit_daily_log
        : [];

    db.last_completed_daily_ids =
      Array.isArray(db.last_completed_daily_ids)
        ? db.last_completed_daily_ids
        : [];

    db.dailies_failed =
      Number.isFinite(Number(db.dailies_failed))
        ? Number(db.dailies_failed)
        : 0;

    db.dailies_snapshot_date =
      typeof db.dailies_snapshot_date === 'string'
        ? db.dailies_snapshot_date
        : '';

    db.dailies_snapshot_due_ids =
      Array.isArray(db.dailies_snapshot_due_ids)
        ? db.dailies_snapshot_due_ids
        : [];

    db.dailies_snapshot_completed_ids =
      Array.isArray(db.dailies_snapshot_completed_ids)
        ? db.dailies_snapshot_completed_ids
        : [];

    db.last_completed_todo_ids =
      Array.isArray(db.last_completed_todo_ids)
        ? db.last_completed_todo_ids
        : [];

    db.damage2_total =
      Number.isFinite(Number(db.damage2_total))
        ? Number(db.damage2_total)
        : Number(db.all_time_damage) || 0;

    db.damage2_weekly =
      Number.isFinite(Number(db.damage2_weekly))
        ? Number(db.damage2_weekly)
        : Number(db.weekly_damage) || 0;

    db.damage2_daily =
      Number.isFinite(Number(db.damage2_daily))
        ? Number(db.damage2_daily)
        : 0;

    // Migrasi aman: jika field baru belum ada, infer dari damage harian
    // yang sudah tersimpan agar statistik lama tidak berubah menjadi 0.
    if (Number.isFinite(Number(db.damage2_active_days))) {
      db.damage2_active_days = Math.max(
        0,
        Math.floor(Number(db.damage2_active_days))
      );
    } else {
      db.damage2_active_days =
        db.damage2_daily > 0 ? 1 : 0;
    }

    if (typeof db.damage2_day_has_damage !== 'boolean') {
      db.damage2_day_has_damage =
        db.damage2_daily > 0;
    }

    db.damage2_peak_daily =
      Number.isFinite(Number(db.damage2_peak_daily))
        ? Number(db.damage2_peak_daily)
        : Number(db.peak_daily_damage) || 0;

    db.damage2_event_keys =
      Array.isArray(db.damage2_event_keys)
        ? db.damage2_event_keys
        : [];

    db.damage2_initialized = Boolean(db.damage2_initialized);

    db.damage2_last_quest_key =
      typeof db.damage2_last_quest_key === 'string'
        ? db.damage2_last_quest_key
        : null;

    db.damage2_last_quest_active =
      Boolean(db.damage2_last_quest_active);

    db.damage2_last_pending_damage =
      Number.isFinite(Number(db.damage2_last_pending_damage))
        ? Number(db.damage2_last_pending_damage)
        : 0;

    debugDbLoad = 'ok';

    return db;

  } catch (e) {
    debugDbLoad = `err: ${e.message}`;

    // Sangat penting:
    // jangan membuat DB kosong ketika Upstash gagal.
    // Kalau dilakukan, statistik lama berisiko tertimpa.
    throw e;
  }
}

async function saveDB(db) {
  try {
    await upstashCommand([
      'SET',
      DB_KEY,
      JSON.stringify(db),
    ]);

    debugDbSave = 'ok';

  } catch (e) {
    debugDbSave = `err: ${e.message}`;

    // Jangan diam-diam mengabaikan kegagalan database.
    throw e;
  }
}

// ==========================================
// UTILITAS STATISTIK
// ==========================================

function bump(store, tid, text, amount) {
  const entry = store[tid] || {
    text,
    count: 0,
  };

  entry.text = text;
  entry.count += amount;

  store[tid] = entry;
}

function mergeClickDicts(...dicts) {
  const merged = {};

  for (const d of dicts) {
    for (const [tid, entry] of Object.entries(d)) {
      const m = merged[tid] || {
        text: entry.text,
        count: 0,
      };

      m.text = entry.text;
      m.count += entry.count;

      merged[tid] = m;
    }
  }

  return merged;
}

function trunc(s, n = 17) {
  const text = String(s ?? '');

  return text.length <= n
    ? text
    : text.slice(0, n - 1).trimEnd() + '\u2026';
}

function fmt(n) {
  const value = Number(n) || 0;

  if (value >= 1000000) {
    return `${(value / 1000000).toFixed(2)}m`;
  }

  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }

  return String(Math.trunc(value));
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ==========================================
// DECODE TEXT LAMA
// ==========================================
// Versi lama menyimpan sebagian text yang sudah di-escape.
// Fungsi ini membantu mencegah &amp; menjadi &amp;amp;
// ketika database lama masih digunakan.

function decodeStoredText(s) {
  return String(s ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// Gunakan ini HANYA saat memasukkan text ke SVG.
function svgText(s, maxLength = 35) {
  const decoded = decodeStoredText(s);
  return escapeHtml(trunc(decoded, maxLength));
}

function safeAsciiName(name, fallback = 'HERO') {
  try {
    const normalized = String(name ?? '').normalize('NFKD');

    return (
      normalized
        .split('')
        .filter(
          (ch) =>
            ch.charCodeAt(0) < 128 &&
            /[A-Za-z0-9\s\-_.']/.test(ch)
        )
        .join('')
        .trim() || fallback
    );

  } catch (e) {
    return fallback;
  }
}

function wrapText(text, width) {
  const words = String(text ?? '').split(' ');
  const lines = [];

  let line = '';

  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) {
      if (line) {
        lines.push(line.trim());
      }

      line = w;

    } else {
      line = (line + ' ' + w).trim();
    }
  }

  if (line) {
    lines.push(line);
  }

  return lines.slice(0, 4);
}

// ==========================================
// HABITICA API
// ==========================================

async function habiticaFetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...habiticaHeaders,
      ...(options.headers || {}),
    },
    cache: 'no-store',
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `Habitica response bukan JSON (${response.status}): ${text.slice(0, 300)}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Habitica HTTP ${response.status}: ${
        data.message ||
        data.error ||
        text.slice(0, 300)
      }`
    );
  }

  if (data.success === false) {
    throw new Error(
      `Habitica API error: ${
        data.message ||
        data.error ||
        'Unknown error'
      }`
    );
  }

  return data;
}

// ==========================================
// PEMBUATAN SVG & PENGELOLAAN DATA
// ==========================================

function getWebhookBody(req) {
  if (!req || !req.body) {
    return null;
  }

  if (typeof req.body === 'object') {
    return req.body;
  }

  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch (e) {
      return null;
    }
  }

  return null;
}

function getWebhookDamageEvent(webhookEvent) {
  if (!webhookEvent || typeof webhookEvent !== 'object') {
    return null;
  }

  if (webhookEvent.webhookType !== 'taskActivity') {
    return null;
  }

  if (webhookEvent.type !== 'scored') {
    return null;
  }

  if (webhookEvent.direction !== 'up') {
    return null;
  }

  const progressDelta = Number(
    webhookEvent.user &&
    webhookEvent.user._tmp &&
    webhookEvent.user._tmp.quest &&
    webhookEvent.user._tmp.quest.progressDelta
  );

  if (!Number.isFinite(progressDelta) || progressDelta <= 0) {
    return null;
  }

  const task = webhookEvent.task || {};
  const taskId = task.id || task._id || 'unknown-task';
  const updatedAt = task.updatedAt || '';
  const delta = Number(webhookEvent.delta) || 0;

  // Fingerprint harus identik pada webhook retry yang sama,
  // tetapi berubah ketika score event baru terjadi.
  const eventKey = [
    webhookEvent.type,
    webhookEvent.direction,
    taskId,
    updatedAt,
    delta,
    progressDelta,
  ].join('|');

  return {
    eventKey,
    damage: progressDelta,
    taskId,
    taskText: task.text || '',
    updatedAt,
  };
}

function recordWebhookObservation(db, webhookEvent) {
  if (!webhookEvent || typeof webhookEvent !== 'object') {
    return {
      observed: false,
      reason: 'no-webhook',
    };
  }

  console.log(
    'PHASE 3C: webhook observation',
    JSON.stringify({
      type: webhookEvent.type,
      webhookType: webhookEvent.webhookType,
      direction: webhookEvent.direction,
      taskId:
        webhookEvent.task &&
        (webhookEvent.task.id || webhookEvent.task._id),
    })
  );

  return {
    observed: true,
  };
}

function recordPendingDamage(db, uData, partyData) {
  // Habitica memiliki dua representasi data quest di endpoint yang kita baca:
  // - /user: dipakai untuk membaca personal pending damage (progress.up)
  // - /groups/party: dipakai sebagai source of truth untuk status/key quest
  //
  // Sebelumnya status active/key dibaca dari /user saja. Pada kondisi tertentu
  // field tersebut tidak merefleksikan status quest party, sehingga tracker
  // berhenti di branch "quest-inactive" walaupun quest sebenarnya aktif.
  const userQuest = (uData.party || {}).quest || {};
  const partyQuest = (partyData || {}).quest || {};

  const progress = userQuest.progress || {};

  const hasPartyQuestState =
    typeof partyQuest.active === 'boolean' ||
    typeof partyQuest.key === 'string';

  const questKey = hasPartyQuestState
    ? (partyQuest.key || null)
    : (userQuest.key || null);

  const questActive = hasPartyQuestState
    ? !!partyQuest.active
    : !!userQuest.active;

  const pendingDamageRaw = Number(progress.up);
  const pendingDamage =
    Number.isFinite(pendingDamageRaw) && pendingDamageRaw > 0
      ? pendingDamageRaw
      : 0;

  console.log(
    'PHASE 3C: quest source',
    JSON.stringify({
      source: hasPartyQuestState ? 'party' : 'user-fallback',
      partyQuestActive: !!partyQuest.active,
      partyQuestKey: partyQuest.key || null,
      userQuestActive: !!userQuest.active,
      userQuestKey: userQuest.key || null,
      questActive,
      questKey,
      pendingDamage,
    })
  );

  // First run: establish a baseline. Existing pending damage from
  // before this tracker was installed must not be counted retroactively.
  if (!db.damage2_initialized) {
    db.damage2_initialized = true;
    db.damage2_last_quest_key = questActive ? questKey : null;
    db.damage2_last_quest_active = questActive;
    db.damage2_last_pending_damage = questActive
      ? pendingDamage
      : 0;

    console.log(
      'PHASE 3C: pending damage tracker initialized',
      JSON.stringify({
        questKey,
        questActive,
        pendingDamage,
      })
    );

    return {
      recorded: false,
      initialized: true,
      pendingDamage,
      delta: 0,
    };
  }

  // No active quest: clear the baseline so a later quest can start cleanly.
  if (!questActive) {
    db.damage2_last_quest_key = null;
    db.damage2_last_quest_active = false;
    db.damage2_last_pending_damage = 0;

    return {
      recorded: false,
      reason: 'quest-inactive',
      pendingDamage,
      delta: 0,
    };
  }

  let delta = 0;

  const previousPendingDamage =
    Number.isFinite(Number(db.damage2_last_pending_damage)) &&
    Number(db.damage2_last_pending_damage) >= 0
      ? Number(db.damage2_last_pending_damage)
      : 0;

  /*
   * PHASE 3C 3.3 — DAMAGE LEDGER RULE
   *
   * Pending Damage adalah meter kumulatif sementara milik Habitica.
   * Pergantian quest TIDAK otomatis berarti ada damage baru.
   *
   * Contoh:
   *   8000 -> quest berganti -> 8000  = +0
   *   8000 -> 8300                  = +300
   *   8300 -> quest berganti -> 8300 = +0
   *
   * Jika pending turun, anggap Habitica telah mereset/menerapkan
   * pending damage (misalnya saat Cron). Kita tidak mengurangi ledger;
   * nilai pending yang sekarang menjadi baseline baru.
   */
  if (pendingDamage >= previousPendingDamage) {
    delta = pendingDamage - previousPendingDamage;
  } else {
    // Pending turun/reset: jangan kurangi total.
    // Nilai sekarang dianggap damage baru yang sudah terkumpul
    // setelah reset.
    delta = pendingDamage;
  }

  if (delta > 0) {
    db.damage2_total += delta;
    db.damage2_weekly += delta;
    db.damage2_daily += delta;

    // Daily Avg hanya menghitung hari yang benar-benar menghasilkan damage.
    // Satu hari hanya boleh menambah counter satu kali.
    if (!db.damage2_day_has_damage) {
      db.damage2_active_days += 1;
      db.damage2_day_has_damage = true;
    }

    if (db.damage2_daily > db.damage2_peak_daily) {
      db.damage2_peak_daily = db.damage2_daily;
    }

    console.log(
      'PHASE 3C: pending damage recorded',
      JSON.stringify({
        questKey,
        pendingDamage,
        previousPendingDamage,
        delta,
        total: db.damage2_total,
      })
    );
  } else {
    console.log(
      'PHASE 3C: pending damage checked',
      JSON.stringify({
        questKey,
        pendingDamage,
        previousPendingDamage,
        delta: 0,
        total: db.damage2_total,
      })
    );
  }

  db.damage2_last_quest_key = questKey;
  db.damage2_last_quest_active = true;
  db.damage2_last_pending_damage = pendingDamage;

  return {
    recorded: delta > 0,
    initialized: false,
    pendingDamage,
    delta,
  };
}

async function generateSVG(webhookEvent = null) {
  const db = await loadDB();

  const now = nowWIB();
  const todayStr = fmtDateStr(now);

  // ==========================================
  // SIKLUS MINGGUAN
  // ==========================================

  const adjusted = new Date(
    now.getTime() - 6 * 3600 * 1000
  );

  const daysSinceSunday = adjusted.getUTCDay();

  const weekStartDate = dateOnly(
    new Date(
      adjusted.getTime() -
        daysSinceSunday * 86400000
    )
  );

  const cycle = fmtDateStr(weekStartDate);

  // RESET SIKLUS MINGGUAN & BULANAN

  if (db.current_cycle_id !== cycle) {
    db.weekly_damage = 0;
    db.damage2_weekly = 0;
    db.damage2_active_days = 0;
    db.damage2_day_has_damage = false;
    db.damage2_week_id = cycle;
    db.weekly_top_dailies = {};
    db.weekly_habit_clicks = {};
    db.weekly_habit_neg = {};
    db.current_cycle_id = cycle;
  }

  const monthId =
    `${adjusted.getUTCFullYear()}-` +
    `${String(adjusted.getUTCMonth() + 1).padStart(2, '0')}`;

  if (db.current_month_id !== monthId) {
    db.monthly_habit_clicks = {};
    db.current_month_id = monthId;
  }

  // ==========================================
  // RESET HARIAN
  // ==========================================

  if (db.last_daily_date !== todayStr) {
    db.habit_daily_log =
      db.habit_daily_log || [];

    if (
      Object.keys(db.today_habit_clicks || {}).length ||
      Object.keys(db.today_habit_neg || {}).length
    ) {
      db.habit_daily_log.push({
        date: db.last_daily_date,
        clicks: db.today_habit_clicks,
        neg: db.today_habit_neg,
      });
    }

    db.habit_daily_log =
      db.habit_daily_log.slice(-3);

    // ==========================================
    // PHASE 3B — HITUNG DAILIES GAGAL HARI SEBELUMNYA
    // ==========================================
    // Hanya hitung Dailies yang memang jatuh tempo
    // pada snapshot hari sebelumnya tetapi tidak selesai.
    // Ini BUKAN jumlah Dailies yang belum dikerjakan hari ini.
    if (
      db.dailies_snapshot_date &&
      db.dailies_snapshot_date !== todayStr
    ) {
      const previousDueIds =
        new Set(db.dailies_snapshot_due_ids || []);

      const previousCompletedIds =
        new Set(db.dailies_snapshot_completed_ids || []);

      const failedYesterday =
        [...previousDueIds].filter(
          (id) => !previousCompletedIds.has(id)
        ).length;

      // Dailies Gagal bersifat cumulative.
      db.dailies_failed += failedYesterday;
    }

    db.last_daily_date = todayStr;

    db.daily_habit_baseline =
      db.all_time_habits_pos;

    db.today_habit_clicks = {};
    db.today_habit_neg = {};
  }

  if (db.damage_day_date !== todayStr) {
    if (
      db.current_day_damage >
      db.peak_daily_damage
    ) {
      db.peak_daily_damage =
        db.current_day_damage;
    }

    db.damage_day_date = todayStr;
    db.current_day_damage = 0;
  }

  // PHASE 3C daily rollover + active-day tracking.
  if (db.damage2_day_date !== todayStr) {
    if (db.damage2_daily > db.damage2_peak_daily) {
      db.damage2_peak_daily = db.damage2_daily;
    }

    db.damage2_day_date = todayStr;
    db.damage2_daily = 0;
    db.damage2_day_has_damage = false;
  }

  if (db.damage2_week_id !== cycle) {
    db.damage2_week_id = cycle;
    db.damage2_weekly = 0;
    db.damage2_daily = 0;
    db.damage2_active_days = 0;
    db.damage2_day_has_damage = false;
  }

  // ==========================================
  // HABITICA API PARALEL
  // ==========================================

  const fetchOpts = {
    headers: habiticaHeaders,
    cache: 'no-store',
  };

  const [
    uRes,
    tResRaw,
    cResRaw,
    pResRaw,
  ] = await Promise.all([
    habiticaFetchJson(
      'https://habitica.com/api/v3/user',
      fetchOpts
    ),

    habiticaFetchJson(
      'https://habitica.com/api/v3/tasks/user',
      fetchOpts
    ),

    habiticaFetchJson(
      'https://habitica.com/api/v3/tasks/user?type=completedTodos',
      fetchOpts
    ),

    habiticaFetchJson(
      'https://habitica.com/api/v3/groups/party',
      fetchOpts
    ).catch(() => ({})),
  ]);

  const uData = uRes.data || {};

  const tRes =
    Array.isArray(tResRaw.data)
      ? tResRaw.data
      : [];

  const cRes =
    Array.isArray(cResRaw.data)
      ? cResRaw.data
      : [];

  const partyData =
    pResRaw.data || {};

  // ==========================================
  // PHASE 3C 3.0 — WEBHOOK OBSERVATION
  // ==========================================
  // Webhook tidak menambahkan damage secara langsung.
  // Pending damage dari user.party.quest.progress.up
  // menjadi sumber angka damage yang dicatat.
  if (webhookEvent) {
    recordWebhookObservation(db, webhookEvent);
  }

  // ==========================================
  // PLAYER
  // ==========================================

  const rawName =
    (uData.profile &&
      uData.profile.name) ||
    'Hero';

  const svgName =
    escapeHtml(
      safeAsciiName(rawName).slice(0, 18)
    );

  const cClass =
    (
      (uData.stats &&
        uData.stats.class) ||
      'warrior'
    ).toLowerCase();

  const lvl =
    (uData.stats &&
      uData.stats.lvl) ||
    1;

  const gold =
    (uData.stats &&
      uData.stats.gp) ||
    0;

  const mp =
    (uData.stats &&
      uData.stats.mp) ||
    0;

  if (!db.classes_used.includes(cClass)) {
    db.classes_used.push(cClass);
  }

  db.peak_gold =
    Math.max(
      db.peak_gold,
      gold
    );

  // ==========================================
  // 🔒 BUFF LOGIC — LOCKED
  // JANGAN DIUBAH
  // ==========================================

  if (db.last_mana !== null && mp < db.last_mana) {
    const diff = db.last_mana - mp;
    if (diff > 0) {
      db.total_mana_spent += diff;
      db.buffs_cast += 1;
    }
  }
  db.last_mana = mp;

  // ==========================================
  // 🔒 BOSS / QUEST LOGIC — LOCKED
  // JANGAN DIUBAH
  // ==========================================

  const dmgUp = ((uData.party || {}).quest || {}).progress ? (uData.party.quest.progress.up || 0) : 0;
  if (dmgUp > db.last_damage_up) {
    const delta = dmgUp - db.last_damage_up;
    db.weekly_damage += delta;
    db.all_time_damage += delta;
    db.current_day_damage += delta;
    if (db.current_day_damage > db.peak_daily_damage) db.peak_daily_damage = db.current_day_damage;
  }
  db.last_damage_up = dmgUp;

  const questNow = partyData.quest || {};
  const questKeyNow = questNow.key || null;
  const questActiveNow = !!questNow.active;
  const isBossNow = !!(questNow.progress && 'hp' in questNow.progress);
  if (db.last_quest_key && db.last_quest_is_boss && questKeyNow !== db.last_quest_key) {
    db.bosses_slain += 1;
  }
  db.last_quest_key = questActiveNow ? questKeyNow : null;
  db.last_quest_is_boss = questActiveNow ? isBossNow : false;

  // ==========================================
  // PHASE 3C 3.0 — PENDING DAMAGE
  // ==========================================
  // Jalankan setelah data Habitica terbaru dibaca.
  // Refresh/GET berulang aman karena yang dicatat hanya delta.
  recordPendingDamage(db, uData, partyData);

  // ==========================================
  // DAILY
  // ==========================================

  const dailies =
    tRes.filter(
      (t) => t.type === 'daily'
    );

  const due =
    dailies.filter(
      (t) => t.isDue
    );

  const done =
    due.filter(
      (t) => t.completed
    );

  const pct =
    due.length
      ? Math.round(
          (done.length / due.length) * 100
        )
      : 100;

  // ==========================================
  // PHASE 3B — DAILIES GAGAL
  // ==========================================
  // Gunakan jumlah kegagalan historis yang sudah
  // dihitung saat pergantian hari, bukan:
  // due.length - done.length.
  const dailiesGagal =
    Number.isFinite(Number(db.dailies_failed))
      ? Number(db.dailies_failed)
      : 0;

  const currentCompletedIds =
    new Set(
      done.map((d) => d.id)
    );

  const lastCompletedIds =
    new Set(
      db.last_completed_daily_ids || []
    );

  const newlyCompleted =
    [...currentCompletedIds].filter(
      (id) =>
        !lastCompletedIds.has(id)
    );

  db.all_time_dailies_completed +=
    newlyCompleted.length;

  for (const dTask of done) {
    if (
      newlyCompleted.includes(
        dTask.id
      )
    ) {
      // Simpan TEXT MENTAH ke database.
      // Escape dilakukan nanti saat render SVG.
      const text =
        (dTask.text || '').slice(0, 28);

      bump(
        db.weekly_top_dailies,
        dTask.id,
        text,
        1
      );
    }
  }

  db.last_completed_daily_ids =
    [...currentCompletedIds];

  // Snapshot Dailies hari ini untuk dipakai saat
  // pergantian hari berikutnya.
  db.dailies_snapshot_date = todayStr;
  db.dailies_snapshot_due_ids =
    due.map((d) => d.id);
  db.dailies_snapshot_completed_ids =
    [...currentCompletedIds];

  const topD =
    Object.values(
      db.weekly_top_dailies
    )
      .sort(
        (a, b) =>
          b.count - a.count
      )
      .slice(0, 5);

  // ==========================================
  // HABITS
  // ==========================================

  const habits =
    tRes.filter(
      (t) => t.type === 'habit'
    );

  const up =
    habits.reduce(
      (s, h) =>
        s + (h.counterUp || 0),
      0
    );

  const dn =
    habits.reduce(
      (s, h) =>
        s + (h.counterDown || 0),
      0
    );

  const hratio =
    up + dn > 0
      ? Math.round(
          (up / (up + dn)) * 100
        )
      : 100;

  if (
    db.all_time_habits_pos === 0 &&
    up > 0
  ) {
    db.all_time_habits_pos = up;
  }

  if (
    db.all_time_habits_neg === 0 &&
    dn > 0
  ) {
    db.all_time_habits_neg = dn;
  }

  const lastHabitCounters =
    db.last_habit_counters || {};

  const weeklyHabitClicks =
    db.weekly_habit_clicks || {};

  const weeklyHabitNeg =
    db.weekly_habit_neg || {};

  const todayHabitClicks =
    db.today_habit_clicks || {};

  const todayHabitNeg =
    db.today_habit_neg || {};

  const monthlyHabitClicks =
    db.monthly_habit_clicks || {};

  for (const h of habits) {
    const hid = h.id;

    // Simpan text mentah.
    const text =
      (h.text || '').slice(0, 28);

    const curUp =
      h.counterUp || 0;

    const curDn =
      h.counterDown || 0;

    const prev =
      lastHabitCounters[hid] || {
        up: curUp,
        down: curDn,
      };

    const deltaUp =
      Math.max(
        0,
        curUp -
          (prev.up ?? curUp)
      );

    const deltaDn =
      Math.max(
        0,
        curDn -
          (prev.down ?? curDn)
      );

    if (deltaUp > 0) {
      db.all_time_habits_pos +=
        deltaUp;

      bump(
        weeklyHabitClicks,
        hid,
        text,
        deltaUp
      );

      bump(
        todayHabitClicks,
        hid,
        text,
        deltaUp
      );

      bump(
        monthlyHabitClicks,
        hid,
        text,
        deltaUp
      );
    }

    if (deltaDn > 0) {
      db.all_time_habits_neg +=
        deltaDn;

      bump(
        weeklyHabitNeg,
        hid,
        text,
        deltaDn
      );

      bump(
        todayHabitNeg,
        hid,
        text,
        deltaDn
      );
    }

    lastHabitCounters[hid] = {
      up: curUp,
      down: curDn,
    };
  }

  db.last_habit_counters =
    lastHabitCounters;

  db.weekly_habit_clicks =
    weeklyHabitClicks;

  db.weekly_habit_neg =
    weeklyHabitNeg;

  db.today_habit_clicks =
    todayHabitClicks;

  db.today_habit_neg =
    todayHabitNeg;

  db.monthly_habit_clicks =
    monthlyHabitClicks;

  // ==========================================
  // TODO
  // ==========================================

  const currentCompletedTodos =
    new Set(
      cRes.map((t) => t.id)
    );

  const previousCompletedTodoIds =
    db.last_completed_todo_ids || [];

  const newlyCompletedTodos =
    [
      ...currentCompletedTodos
    ].filter(
      (id) =>
        !previousCompletedTodoIds.includes(id)
    );

  const hasTodoHistory =
    previousCompletedTodoIds.length > 0;

  // Mencegah double-count pada initial run.
  if (
    !hasTodoHistory &&
    db.all_time_todos_completed === 0
  ) {
    db.all_time_todos_completed =
      cRes.length;
  } else {
    db.all_time_todos_completed +=
      newlyCompletedTodos.length;
  }

  db.last_completed_todo_ids =
    [...currentCompletedTodos];

  // ==========================================
  // DERIVED STATS
  // ==========================================

  const topH =
    Object.values(
      weeklyHabitClicks
    )
      .sort(
        (a, b) =>
          b.count - a.count
      )
      .slice(0, 5);

  const topHNeg3 =
    Object.values(
      weeklyHabitNeg
    )
      .sort(
        (a, b) =>
          b.count - a.count
      )
      .slice(0, 3);

  const topHMonth =
    Object.values(
      monthlyHabitClicks
    )
      .sort(
        (a, b) =>
          b.count - a.count
      )
      .slice(0, 5);

  const touchedIdsWeek =
    new Set([
      ...Object.keys(
        weeklyHabitClicks
      ),
      ...Object.keys(
        weeklyHabitNeg
      ),
    ]);

  const habitsUntouchedWeek =
    habits.filter(
      (h) =>
        !touchedIdsWeek.has(h.id)
    ).length;

  const totalHabitsCount =
    habits.length;

  const idleWeekPct =
    totalHabitsCount
      ? Math.round(
          (habitsUntouchedWeek /
            totalHabitsCount) *
            100
        )
      : 0;

  const log =
    db.habit_daily_log || [];

  let idleYesterdayCount =
    totalHabitsCount;

  if (log.length) {
    const yesterday =
      log[log.length - 1];

    const touchedYesterdayIds =
      new Set([
        ...Object.keys(
          yesterday.clicks || {}
        ),
        ...Object.keys(
          yesterday.neg || {}
        ),
      ]);

    idleYesterdayCount =
      habits.filter(
        (h) =>
          !touchedYesterdayIds.has(
            h.id
          )
      ).length;
  }

  const topH5Daily =
    Object.values(
      todayHabitClicks
    )
      .sort(
        (a, b) =>
          b.count - a.count
      )
      .slice(0, 5);

  const recentLogs =
    (
      db.habit_daily_log || []
    )
      .slice(-2)
      .map(
        (e) => e.clicks
      );

  const rolling3Source =
    mergeClickDicts(
      todayHabitClicks,
      ...recentLogs
    );

  const topH3day =
    Object.values(
      rolling3Source
    )
      .sort(
        (a, b) =>
          b.count - a.count
      )
      .slice(0, 5);

  const hToday =
    Object.values(
      todayHabitClicks
    ).reduce(
      (acc, it) =>
        acc + (it.count || 0),
      0
    );

  const tToday =
    cRes.filter((t) => {
      if (!t.dateCompleted) {
        return false;
      }

      const dWIB =
        new Date(
          new Date(
            t.dateCompleted
          ).getTime() + WIB_MS
        );

      return (
        fmtDateStr(dWIB) ===
        todayStr
      );
    }).length;

  const tActive =
    tRes.filter(
      (t) => t.type === 'todo'
    ).length;

  const tCleared =
    cRes.length;

  const gTotal =
    db.all_time_habits_pos +
    db.all_time_todos_completed +
    db.all_time_dailies_completed;

  const streak =
    dailies.reduce(
      (mx, t) =>
        Math.max(
          mx,
          t.streak || 0
        ),
      0
    );

  // DAILY AVG DMG = rata-rata hanya pada hari yang benar-benar
  // menghasilkan damage pada minggu berjalan. Hari dengan 0 damage
  // tidak ikut menjadi pembagi.
  const avgDmg =
    db.damage2_active_days > 0
      ? db.damage2_weekly / db.damage2_active_days
      : 0;

  // ==========================================
  // BACA QUOTE LOKAL
  // ==========================================

  let quoteText =
    'Konsistensi kecil setiap hari membangun benteng keberhasilan di masa depan.';

  try {
    const quoteBuffer =
      getLocalFile('quote.txt');

    if (quoteBuffer) {
      const parsedText =
        quoteBuffer
          .toString('utf8')
          .trim();

      if (parsedText) {
        quoteText = parsedText;
      }
    }

  } catch (e) {
    console.log(
      'Gagal baca quote:',
      e.message
    );
  }

  // ==========================================
  // UPDATE BIO
  // ==========================================

  if (PUBLIC_STATS_URL) {
    const habitBioLines =
      topH.length
        ? topH
            .map(
              (it, i) =>
                `${i + 1}. ${decodeStoredText(it.text)} (+${it.count})`
            )
            .join('\n')
        : '-';

    const dailyBioLines =
      topD.length
        ? topD
            .map(
              (it, i) =>
                `${i + 1}. ${decodeStoredText(it.text)} (${it.count}x)`
            )
            .join('\n')
        : '-';

    let statsImageUrl;

    try {
      const imageUrl =
        new URL(
          PUBLIC_STATS_URL
        );

      imageUrl.searchParams.set(
        'v',
        String(Date.now())
      );

      statsImageUrl =
        imageUrl.toString();

    } catch (e) {
      statsImageUrl =
        `${PUBLIC_STATS_URL}${
          PUBLIC_STATS_URL.includes('?')
            ? '&'
            : '?'
        }v=${Date.now()}`;
    }

    const bio =
      `### PERFORMANCE MATRIX\n\n` +
      `![](${statsImageUrl})\n\n` +

      `⚡ **Streak:** ${streak} hari • ` +
      `💰 **Peak Gold:** ${fmt(db.peak_gold)} G • ` +
      `🗡️ **Peak Dmg/Hari:** ${fmt(db.damage2_peak_daily)}\n\n` +

      `---\n` +

      `🔴 **COMBAT & EXPEDITION**\n` +
      `- Total Damage (All-Time): **${fmt(db.damage2_total)}**\n` +
      `- Weekly Damage: **${fmt(db.damage2_weekly)}**\n` +
      `- Bosses Slain: **${db.bosses_slain}**\n` +
      `- Buffs Cast: **${db.buffs_cast}** • ` +
      `Mana Spent: **${fmt(db.total_mana_spent)} MP**\n\n` +

      `---\n` +

      `🔵 **PRODUCTIVITY MATRIX**\n` +
      `- Dailies Hari Ini: **${done.length}/${due.length} (${pct}%)**\n` +
      `- Habit Mastery: **${hratio}% Positive**\n` +
      `- Selesai Hari Ini: **${hToday} Habits • ${done.length} Dailies • ${tToday} To-Dos**\n\n` +

      `---\n` +

      `🟠 **TOP 5 HABITS (MINGGUAN)**\n` +
      `${habitBioLines}\n\n` +

      `🟢 **TOP 5 DAILIES (MINGGUAN)**\n` +
      `${dailyBioLines}\n\n` +

      `---\n` +

      `> "${quoteText}"\n`;

    try {
      const bioResponse =
        await fetch(
          'https://habitica.com/api/v3/user',
          {
            method: 'PUT',

            headers: {
              ...habiticaHeaders,
              'Content-Type':
                'application/json',
            },

            body: JSON.stringify({
              'profile.blurb': bio,
            }),

            cache: 'no-store',
          }
        );

      if (!bioResponse.ok) {
        console.error(
          `Gagal update Habitica Bio: HTTP ${bioResponse.status}`
        );
      }

    } catch (e) {
      console.error(
        'Gagal update Habitica Bio:',
        e.message
      );
    }
  }

  // ==========================================
  // RENDER SVG COMPONENTS
  // ==========================================

  const logoSvg = `
    <rect x="14" y="20" width="100" height="100" rx="22" fill="url(#logoBgGlow)" stroke="url(#goldRing)" stroke-width="3"/>
    <rect x="21" y="27" width="86" height="86" rx="17" fill="none" stroke="#f5d78e" stroke-width="1" opacity="0.35"/>
    <circle cx="64" cy="66" r="34" fill="#f2b705" opacity="0.14"/>
    <g filter="url(#goldGlow)"><path d="M64 36 L86 66 L64 96 L42 66 Z" fill="#fbbf24" opacity="0.5"/></g>
    <path d="M64 36 L86 66 L64 96 L42 66 Z" fill="url(#gemGlow)" stroke="#78350f" stroke-width="2"/>
    <path d="M64 36 L86 66 L64 66 Z" fill="#fff7d6" opacity="0.5"/>
    <circle cx="64" cy="60" r="7" fill="#fffbe8" opacity="0.9"/>
    <path d="M64 22 L67 31 L76 33 L67 35 L64 44 L61 35 L52 33 L61 31 Z" fill="#fde68a"/>
    <path d="M40 92 L42 97 L47 99 L42 101 L40 106 L38 101 L33 99 L38 97 Z" fill="#f5d78e" opacity="0.85"/>
    <path d="M87 46 L89 51 L94 53 L89 55 L87 60 L85 55 L80 53 L85 51 Z" fill="#fff7d6" opacity="0.9"/>
    <path d="M45 82 L46.5 85.5 L50 87 L46.5 88.5 L45 92 L43.5 88.5 L40 87 L43.5 85.5 Z" fill="#fde68a" opacity="0.85"/>
  `;

  function seededRandom(seed) {
    let s = seed % 2147483647;

    if (s <= 0) {
      s += 2147483646;
    }

    return function () {
      s =
        (s * 16807) %
        2147483647;

      return (
        (s - 1) /
        2147483646
      );
    };
  }

  function randInt(
    rnd,
    min,
    max
  ) {
    return (
      Math.floor(
        rnd() *
          (max - min + 1)
      ) + min
    );
  }

  function randFloat(
    rnd,
    min,
    max
  ) {
    return (
      rnd() *
        (max - min) +
      min
    );
  }

  let rnd =
    seededRandom(42);

  let pineTrees = '';

  for (let i = 0; i < 16; i++) {
    const x =
      randInt(
        rnd,
        -30,
        430
      );

    const scale =
      randFloat(
        rnd,
        0.7,
        1.3
      );

    const y =
      128 -
      scale * 80 +
      randFloat(
        rnd,
        -4,
        4
      );

    const opacity =
      randFloat(
        rnd,
        0.55,
        0.95
      );

    pineTrees +=
      `<g transform="translate(${x}, ${y.toFixed(1)}) scale(${scale.toFixed(2)})" opacity="${opacity.toFixed(2)}">`;

    pineTrees +=
      '<polygon points="25,0 0,35 50,35" fill="#0d7a58"/>' +
      '<polygon points="25,15 0,50 50,50" fill="#0a6b4d"/>' +
      '<polygon points="25,30 0,65 50,65" fill="#085c42"/>' +
      '<rect x="21" y="65" width="8" height="15" fill="#3f2c22"/></g>';
  }

  rnd =
    seededRandom(21);

  let nightStars = '';

  for (let i = 0; i < 30; i++) {
    const sx =
      randInt(
        rnd,
        5,
        455
      );

    const sy =
      randInt(
        rnd,
        5,
        125
      );

    const r =
      randFloat(
        rnd,
        0.6,
        1.8
      );

    const op =
      randFloat(
        rnd,
        0.4,
        0.95
      );

    nightStars +=
      `<circle cx="${sx}" cy="${sy}" r="${r.toFixed(2)}" fill="#fef9e7" opacity="${op.toFixed(2)}"/>`;
  }

  const groundBand =
    '<rect x="0" y="90" width="460" height="50" fill="url(#groundGrad)"/>';

  rnd =
    seededRandom(33);

  let grass = '';

  for (let i = 0; i < 45; i++) {
    const gx =
      randInt(
        rnd,
        0,
        460
      );

    const gh =
      randFloat(
        rnd,
        5,
        12
      );

    const gy =
      140 - gh;

    const op =
      randFloat(
        rnd,
        0.5,
        0.9
      );

    grass +=
      `<polygon points="${gx - 2},140 ${gx},${gy.toFixed(1)} ${gx + 2},140" fill="#15803d" opacity="${op.toFixed(2)}"/>`;
  }

  rnd =
    seededRandom(58);

  let rocks = '';

  for (
    const bx of [
      265,
      335,
      405,
    ]
  ) {
    const rx =
      bx +
      randInt(
        rnd,
        -15,
        15
      );

    const ry =
      randInt(
        rnd,
        126,
        136
      );

    const rs =
      randFloat(
        rnd,
        0.8,
        1.3
      );

    rocks +=
      `<g transform="translate(${rx},${ry}) scale(${rs.toFixed(2)})"><ellipse cx="0" cy="0" rx="9" ry="5" fill="#57534e" stroke="#3f3a36" stroke-width="1"/><ellipse cx="-3" cy="-2" rx="3" ry="1.6" fill="#78716c" opacity="0.6"/></g>`;
  }

  // ==========================================
  // ICONS
  // ==========================================

  const icSw =
    '<path d="M4 20L20 4M8 20L20 8" stroke="#fb7185" stroke-width="2.5" stroke-linecap="round"/>';

  const icFr =
    '<path d="M12 22C12 22 5 15 5 10C5 6 8 2 12 2C12 2 10 6 10 10C10 12 12 14 12 14C12 14 15 11 15 8C17 10 19 13 19 16C19 19.5 16 22 12 22Z" fill="#f59e0b"/>';

  const icTr =
    '<path d="M4 6H20M5 6V11C5 14.8 8.1 18 12 18C15.9 18 19 14.8 19 11V6M8 18V22M16 18V22M6 22H18" stroke="#facc15" stroke-width="2" stroke-linecap="round" fill="none"/>';

  const icGd =
    '<circle cx="12" cy="12" r="8" fill="#f59e0b"/><text x="12" y="16" font-size="11" fill="#141724" text-anchor="middle" font-weight="700" font-family="Roboto">G</text>';

  const icCh =
    '<path d="M18 20V10M12 20V4M6 20V14" stroke="#60a5fa" stroke-width="2.5" stroke-linecap="round"/>';

  const icSp =
    '<path d="M12 2L14 9L21 11L14 13L12 20L10 13L3 11L10 9Z" fill="#b45309"/>';

  const icCk =
    '<path d="M5 12L10 17L19 7" stroke="#059669" stroke-width="2.5" stroke-linecap="round" fill="none"/>';

  const icTg =
    '<circle cx="12" cy="12" r="8" stroke="#0284c7" stroke-width="2" fill="none"/><circle cx="12" cy="12" r="3" fill="#0284c7"/>';

  const icSt =
    '<path d="M12 2L15 9L22 9L16 14L18 21L12 17L6 21L8 14L2 9L9 9Z" fill="#ca8a04"/>';

  const icSparkle =
    '<path d="M12 2L14 9L21 11L14 13L12 20L10 13L3 11L10 9Z" fill="#facc15"/>';

  const icDrop =
    '<path d="M12 2C12 2 5 11 5 15.5C5 19.6 8.1 22 12 22C15.9 22 19 19.6 19 15.5C19 11 12 2 12 2Z" fill="#60a5fa"/>';

  const icThumbUp =
    '<path d="M2 21H6V10H2V21ZM9 21H17C17.8 21 18.5 20.4 18.7 19.6L21 12.4C21.3 11.4 20.5 10.5 19.5 10.5H14.4L15 6.5C15.1 5.7 14.5 5 13.7 5C13.3 5 12.9 5.2 12.6 5.5L8.3 10.3C8.1 10.5 8 10.8 8 11.1V19.5C8 20.3 8.7 21 9 21Z" fill="#22c55e"/>';

  const icThumbDown =
    '<path d="M22 3H18V14H22V3ZM15 3H7C6.2 3 5.5 3.6 5.3 4.4L3 11.6C2.7 12.6 3.5 13.5 4.5 13.5H9.6L9 17.5C8.9 18.3 9.5 19 10.3 19C10.7 19 11.1 18.8 11.4 18.5L15.7 13.7C15.9 13.5 16 13.2 16 12.9V4.5C16 3.7 15.3 3 15 3Z" fill="#ef4444"/>';

  const icX =
    '<path d="M6 6L18 18M6 18L18 6" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round"/>';

  const icClip =
    '<rect x="5" y="4" width="14" height="17" rx="2" stroke="#a78bfa" stroke-width="2" fill="none"/><path d="M9 2H15V6H9V2Z" fill="#a78bfa"/>';

  const icClassWar =
    '<path d="M4 20L18 6M8 20L18 10" stroke="#fb7185" stroke-width="2.2" stroke-linecap="round"/><path d="M15 3L21 9L18 12L12 6Z" fill="#fb7185"/>';

  const icClassMag =
    '<path d="M12 2L14 9L21 11L14 13L12 20L10 13L3 11L10 9Z" fill="#60a5fa"/>';

  const icClassRog =
    '<path d="M4 20L16 8M16 8L14 4L20 6L16 8Z" fill="#f59e0b" stroke="#f59e0b" stroke-linejoin="round"/>';

  const icClassHea =
    '<path d="M12 21C12 21 4 14.5 4 9.5C4 6.5 6.5 4 9.5 4C11 4 12 5 12 5C12 5 13 4 14.5 4C17.5 4 20 6.5 20 9.5C20 14.5 12 21 12 21Z" fill="#34d399"/>';

  const icMoon =
    '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" fill="#94a3b8"/>';

  const icCalendar =
    '<rect x="3" y="4" width="18" height="17" rx="2" stroke="#a5b4fc" stroke-width="1.8" fill="none"/><path d="M3 9.5H21" stroke="#a5b4fc" stroke-width="1.8"/><path d="M7 2.2V6M17 2.2V6" stroke="#a5b4fc" stroke-width="1.8" stroke-linecap="round"/>';

  // ==========================================
  // CLASS CONFIG
  // ==========================================

  const cfgMap = {
    warrior: {
      sec: '#fb7185',
      n: 'WARRIOR',
    },

    mage: {
      sec: '#60a5fa',
      n: 'ARCHMAGE',
    },

    rogue: {
      sec: '#fbbf24',
      n: 'SHADOW ROGUE',
    },

    healer: {
      sec: '#34d399',
      n: 'HIGH HEALER',
    },
  };

  const cfg =
    cfgMap[cClass] ||
    cfgMap.warrior;

  // ==========================================
  // QUOTE
  // ==========================================

  const quoteLines =
    wrapText(
      quoteText,
      50
    );

  const quoteTspans =
    quoteLines
      .map(
        (line, i) =>
          `<tspan x="28" dy="${i === 0 ? 0 : 18}">${escapeHtml(line)}</tspan>`
      )
      .join('');

  const canvasW = 460;

  const QUOTE_Y = 1335;

  const quoteBoxH =
    40 +
    Math.max(
      1,
      quoteLines.length
    ) *
      18 +
    12;

  const canvasH =
    QUOTE_Y +
    quoteBoxH +
    20;

  // ==========================================
  // BACKGROUND PATTERN
  // ==========================================

  rnd =
    seededRandom(7);

  let bgPattern = '';

  for (let i = 0; i < 24; i++) {
    const x =
      randInt(
        rnd,
        -20,
        canvasW - 20
      );

    const y =
      randInt(
        rnd,
        150,
        canvasH - 40
      );

    const scale =
      randFloat(
        rnd,
        0.5,
        1.0
      );

    bgPattern +=
      `<g transform="translate(${x},${y}) scale(${scale.toFixed(2)})" opacity="0.045"><polygon points="25,0 0,35 50,35" fill="#94a3b8"/><polygon points="25,15 0,50 50,50" fill="#94a3b8"/></g>`;
  }

  // ==========================================
  // TOP LISTS
  // ==========================================

  const h5dailyStr =
    topH5Daily.length
      ? topH5Daily
          .map(
            (it, i) =>
              `<text x="28" y="${696 + i * 18}" class="list">${i + 1}. ${svgText(it.text, 35)} (+${it.count})</text>`
          )
          .join('')
      : '<text x="28" y="696" class="list" fill="#64748b" font-style="italic">Belum ada aktivitas habit hari ini</text>';

  const h53dayStr =
    topH3day
      .map(
        (it, i) =>
          `<text x="28" y="${834 + i * 18}" class="list">${i + 1}. ${svgText(it.text, 35)} (+${it.count})</text>`
      )
      .join('');

  const hnegStr =
    topHNeg3
      .map(
        (it, i) =>
          `<text x="28" y="${972 + i * 18}" class="list">${i + 1}. ${svgText(it.text, 35)} (-${it.count})</text>`
      )
      .join('');

  const hStr =
    topH
      .map(
        (it, i) =>
          `<text x="28" y="${1072 + i * 18}" class="list">${i + 1}. ${svgText(it.text, 17)} (+${it.count})</text>`
      )
      .join('');

  const dStr =
    topD
      .map(
        (it, i) =>
          `<text x="248" y="${1072 + i * 18}" class="list">${i + 1}. ${svgText(it.text, 17)} (${it.count}x)</text>`
      )
      .join('');

  const hmonthStr =
    topHMonth
      .map(
        (it, i) =>
          `<text x="28" y="${1220 + i * 18}" class="list">${i + 1}. ${svgText(it.text, 17)} (+${it.count})</text>`
      )
      .join('');

  // ==========================================
  // SVG
  // ==========================================

  const svg = `<svg width="${canvasW * 2}" height="${canvasH * 2}" viewBox="0 0 ${canvasW} ${canvasH}" fill="none" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">

  <defs>

    <clipPath id="rc">
      <rect
        width="${canvasW}"
        height="${canvasH}"
        rx="18"
      />
    </clipPath>

    <linearGradient
      id="g1"
      x1="0%"
      y1="0%"
      x2="100%"
      y2="100%"
    >
      <stop offset="0%" stop-color="#141724"/>
      <stop offset="100%" stop-color="#07080f"/>
    </linearGradient>

    <linearGradient
      id="gB"
      x1="0%"
      y1="0%"
      x2="100%"
      y2="100%"
    >
      <stop offset="0%" stop-color="#f59e0b"/>
      <stop offset="100%" stop-color="#78350f"/>
    </linearGradient>

    <linearGradient
      id="gC"
      x1="0%"
      y1="0%"
      x2="100%"
      y2="100%"
    >
      <stop offset="0%" stop-color="#24121b"/>
      <stop offset="100%" stop-color="#180c13"/>
    </linearGradient>

    <linearGradient
      id="gP"
      x1="0%"
      y1="0%"
      x2="100%"
      y2="100%"
    >
      <stop offset="0%" stop-color="#12182b"/>
      <stop offset="100%" stop-color="#0b101e"/>
    </linearGradient>

    <linearGradient
      id="gH"
      x1="0%"
      y1="0%"
      x2="100%"
      y2="100%"
    >
      <stop offset="0%" stop-color="#332010"/>
      <stop offset="100%" stop-color="#1c1106"/>
    </linearGradient>

    <linearGradient
      id="gD"
      x1="0%"
      y1="0%"
      x2="100%"
      y2="100%"
    >
      <stop offset="0%" stop-color="#0a2c1e"/>
      <stop offset="100%" stop-color="#051a12"/>
    </linearGradient>

    <linearGradient
      id="gI"
      x1="0%"
      y1="0%"
      x2="100%"
      y2="100%"
    >
      <stop offset="0%" stop-color="#3d2b0a"/>
      <stop offset="100%" stop-color="#1c1405"/>
    </linearGradient>

    <linearGradient
      id="gBar"
      x1="0%"
      y1="0%"
      x2="100%"
      y2="0%"
    >
      <stop offset="0%" stop-color="#10b981"/>
      <stop offset="100%" stop-color="#34d399"/>
    </linearGradient>

    <linearGradient
      id="gT5H"
      x1="0%"
      y1="0%"
      x2="100%"
      y2="100%"
    >
      <stop offset="0%" stop-color="#082629"/>
      <stop offset="100%" stop-color="#051619"/>
    </linearGradient>

    <linearGradient
      id="gT5V"
      x1="0%"
      y1="0%"
      x2="100%"
      y2="100%"
    >
      <stop offset="0%" stop-color="#2a1145"/>
      <stop offset="100%" stop-color="#170a28"/>
    </linearGradient>

    <linearGradient
      id="gT5M"
      x1="0%"
      y1="0%"
      x2="100%"
      y2="100%"
    >
      <stop offset="0%" stop-color="#1e1b4b"/>
      <stop offset="100%" stop-color="#0f0d2e"/>
    </linearGradient>

    <linearGradient
      id="gNeg"
      x1="0%"
      y1="0%"
      x2="100%"
      y2="100%"
    >
      <stop offset="0%" stop-color="#2a0f14"/>
      <stop offset="100%" stop-color="#180a0d"/>
    </linearGradient>

    <linearGradient
      id="goldRing"
      x1="0%"
      y1="0%"
      x2="100%"
      y2="100%"
    >
      <stop offset="0%" stop-color="#fde68a"/>
      <stop offset="50%" stop-color="#f59e0b"/>
      <stop offset="100%" stop-color="#92400e"/>
    </linearGradient>

    <linearGradient
      id="gemGrad"
      x1="0%"
      y1="0%"
      x2="100%"
      y2="100%"
    >
      <stop offset="0%" stop-color="#fde68a"/>
      <stop offset="50%" stop-color="#f59e0b"/>
      <stop offset="100%" stop-color="#b45309"/>
    </linearGradient>

    <radialGradient
      id="logoBgGlow"
      cx="50%"
      cy="42%"
      r="72%"
    >
      <stop offset="0%" stop-color="#1e4534"/>
      <stop offset="45%" stop-color="#123024"/>
      <stop offset="100%" stop-color="#061410"/>
    </radialGradient>

    <radialGradient
      id="gemGlow"
      cx="50%"
      cy="32%"
      r="68%"
    >
      <stop offset="0%" stop-color="#fff7d6"/>
      <stop offset="35%" stop-color="#fde68a"/>
      <stop offset="70%" stop-color="#f2b705"/>
      <stop offset="100%" stop-color="#8a5a10"/>
    </radialGradient>

    <linearGradient
      id="groundGrad"
      x1="0%"
      y1="0%"
      x2="0%"
      y2="100%"
    >
      <stop offset="0%" stop-color="#2a1f14" stop-opacity="0"/>
      <stop offset="45%" stop-color="#2a1f14" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="#120d09" stop-opacity="1"/>
    </linearGradient>

    <filter
      id="goldGlow"
      x="-60%"
      y="-60%"
      width="220%"
      height="220%"
    >
      <feGaussianBlur
        stdDeviation="3.2"
        result="blur"
      />
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>

  </defs>

  <style>

    .t {
      font-family: Roboto, sans-serif;
      font-weight: 700;
      fill: #fff;
    }

    .s {
      font-family: Roboto, sans-serif;
      font-size: 11.5px;
      font-weight: 400;
      fill: #94a3b8;
    }

    .l {
      font-family: Roboto, sans-serif;
      font-size: 9.5px;
      font-weight: 400;
      fill: #94a3b8;
      letter-spacing: 0.5px;
    }

    .v {
      font-family: Roboto, sans-serif;
      font-size: 14px;
      font-weight: 700;
      fill: #f8fafc;
    }

    .list {
      font-family: Roboto, sans-serif;
      font-size: 11.5px;
      font-weight: 400;
      fill: #cbd5e1;
    }

  </style>

  <g clip-path="url(#rc)">

    <rect
      width="${canvasW}"
      height="${canvasH}"
      fill="url(#g1)"
    />

    ${bgPattern}

    <rect
      x="0"
      y="0"
      width="460"
      height="140"
      fill="#0f172a"
    />

    ${nightStars}
    ${groundBand}
    ${pineTrees}
    ${rocks}
    ${grass}

    <rect
      width="460"
      height="140"
      fill="#0b0e18"
      opacity="0.22"
    />

    <line
      x1="0"
      y1="140"
      x2="460"
      y2="140"
      stroke="url(#gB)"
      stroke-width="1.5"
    />

    ${logoSvg}

    <text
      x="128"
      y="38"
      font-family="Roboto, sans-serif"
      font-size="9"
      font-weight="700"
      letter-spacing="1.5"
      fill="#d4a72c"
      opacity="0.85"
    >
      PLAYER IDENTIFICATION
    </text>

    <text
      x="128"
      y="70"
      class="t"
      font-size="22"
    >
      ${svgName}
    </text>

    <text
      x="128"
      y="90"
      class="s"
    >
      Level ${lvl}
      •
      <tspan fill="${cfg.sec}">
        ${cfg.n}
      </tspan>
    </text>

    <g
      transform="translate(128, 100) scale(0.75)"
      opacity="${db.classes_used.includes('warrior') ? '1.0' : '0.2'}"
    >
      ${icClassWar}
    </g>

    <g
      transform="translate(156, 100) scale(0.75)"
      opacity="${db.classes_used.includes('mage') ? '1.0' : '0.2'}"
    >
      ${icClassMag}
    </g>

    <g
      transform="translate(184, 100) scale(0.75)"
      opacity="${db.classes_used.includes('rogue') ? '1.0' : '0.2'}"
    >
      ${icClassRog}
    </g>

    <g
      transform="translate(212, 100) scale(0.75)"
      opacity="${db.classes_used.includes('healer') ? '1.0' : '0.2'}"
    >
      ${icClassHea}
    </g>

    <text
      x="18"
      y="162"
      font-family="Roboto, sans-serif"
      font-size="11"
      fill="#fb7185"
      font-weight="700"
    >
      COMBAT &amp; EXPEDITION LOG
    </text>

    <rect
      x="16"
      y="172"
      width="208"
      height="46"
      rx="8"
      fill="url(#gC)"
      stroke="#4c1d2c"
    />

    <text
      x="26"
      y="188"
      class="l"
    >
      TOTAL DMG
    </text>

    <g
      transform="translate(26, 193) scale(0.8)"
    >
      ${icSw}
    </g>

    <text
      x="50"
      y="207"
      class="v"
    >
      ${fmt(db.damage2_total)}
    </text>

    <rect
      x="236"
      y="172"
      width="208"
      height="46"
      rx="8"
      fill="url(#gC)"
      stroke="#4c1d2c"
    />

    <text
      x="246"
      y="188"
      class="l"
    >
      WEEKLY DMG
    </text>

    <g
      transform="translate(246, 193) scale(0.8)"
    >
      ${icSw}
    </g>

    <text
      x="270"
      y="207"
      class="v"
    >
      ${fmt(db.damage2_weekly)}
    </text>

    <rect
      x="16"
      y="226"
      width="208"
      height="46"
      rx="8"
      fill="url(#gC)"
      stroke="#4c1d2c"
    />

    <text
      x="26"
      y="242"
      class="l"
    >
      DAILY AVG DMG
    </text>

    <g
      transform="translate(26, 247) scale(0.8)"
    >
      ${icCh}
    </g>

    <text
      x="50"
      y="261"
      class="v"
    >
      ${fmt(avgDmg)}/day
    </text>

    <rect
      x="236"
      y="226"
      width="208"
      height="46"
      rx="8"
      fill="url(#gC)"
      stroke="#4c1d2c"
    />

    <text
      x="246"
      y="242"
      class="l"
    >
      PEAK DAILY RECORD
    </text>

    <g
      transform="translate(246, 247) scale(0.8)"
    >
      ${icFr}
    </g>

    <text
      x="270"
      y="261"
      class="v"
    >
      ${fmt(db.damage2_peak_daily)}
    </text>

    <rect
      x="16"
      y="280"
      width="208"
      height="46"
      rx="8"
      fill="url(#gC)"
      stroke="#4c1d2c"
    />

    <text
      x="26"
      y="296"
      class="l"
    >
      BOSSES SLAIN
    </text>

    <g
      transform="translate(26, 301) scale(0.8)"
    >
      ${icTr}
    </g>

    <text
      x="50"
      y="315"
      class="v"
    >
      ${db.bosses_slain}
    </text>

    <rect
      x="236"
      y="280"
      width="208"
      height="46"
      rx="8"
      fill="url(#gC)"
      stroke="#4c1d2c"
    />

    <text
      x="246"
      y="296"
      class="l"
    >
      PEAK GOLD HOARDED
    </text>

    <g
      transform="translate(246, 301) scale(0.8)"
    >
      ${icGd}
    </g>

    <text
      x="270"
      y="315"
      class="v"
      fill="#fbbf24"
    >
      ${fmt(db.peak_gold)} G
    </text>

    <rect
      x="16"
      y="334"
      width="428"
      height="36"
      rx="8"
      fill="url(#gC)"
      stroke="#4c1d2c"
    />

    <g
      transform="translate(26, 344) scale(0.7)"
    >
      ${icSparkle}
    </g>

    <text
      x="42"
      y="357"
      class="s"
    >
      Buffs:
      <tspan class="v">
        ${db.buffs_cast}
      </tspan>
      Casts
    </text>

    <g
      transform="translate(190, 344) scale(0.7)"
    >
      ${icDrop}
    </g>

    <text
      x="206"
      y="357"
      class="s"
    >
      Mana Spent:
      <tspan class="v">
        ${fmt(db.total_mana_spent)} MP
      </tspan>
    </text>

    <text
      x="18"
      y="404"
      font-family="Roboto, sans-serif"
      font-size="11"
      fill="#60a5fa"
      font-weight="700"
    >
      PRODUCTIVITY &amp; DISCIPLINE MATRIX
    </text>

    <text
      x="18"
      y="424"
      class="s"
    >
      Dailies Today:
      <tspan class="v">
        ${done.length}/${due.length} (${pct}%)
      </tspan>
    </text>

    <rect
      x="16"
      y="432"
      width="428"
      height="11"
      rx="5.5"
      fill="#151b2e"
    />

    <rect
      x="16"
      y="432"
      width="${Math.round(428 * (pct / 100))}"
      height="11"
      rx="5.5"
      fill="url(#gBar)"
    />

    <rect
      x="16"
      y="451"
      width="428"
      height="34"
      rx="7"
      fill="url(#gP)"
      stroke="#1e293b"
    />

    <g
      transform="translate(26, 460) scale(0.7)"
    >
      ${icThumbUp}
    </g>

    <text
      x="42"
      y="472"
      class="s"
    >
      Habit Mastery:
      <tspan class="v">
        ${hratio}% Positive
      </tspan>
    </text>

    <g
      transform="translate(280, 460) scale(0.7)"
    >
      ${icThumbUp}
    </g>

    <text
      x="296"
      y="472"
      class="s"
    >
      ${up}
    </text>

    <g
      transform="translate(330, 460) scale(0.7)"
    >
      ${icThumbDown}
    </g>

    <text
      x="346"
      y="472"
      class="s"
    >
      ${dn}
    </text>

    <rect
      x="16"
      y="493"
      width="101"
      height="46"
      rx="7"
      fill="#1f1610"
      stroke="#b45309"
    />

    <text
      x="22"
      y="509"
      class="l"
    >
      HABITS TODAY
    </text>

    <g
      transform="translate(22, 513) scale(0.75)"
    >
      ${icSp}
    </g>

    <text
      x="44"
      y="528"
      class="v"
    >
      ${hToday}
    </text>

    <rect
      x="125"
      y="493"
      width="101"
      height="46"
      rx="7"
      fill="#0d1f18"
      stroke="#059669"
    />

    <text
      x="131"
      y="509"
      class="l"
    >
      DAILIES TODAY
    </text>

    <g
      transform="translate(131, 513) scale(0.75)"
    >
      ${icCk}
    </g>

    <text
      x="153"
      y="528"
      class="v"
    >
      ${done.length}
    </text>

    <rect
      x="234"
      y="493"
      width="101"
      height="46"
      rx="7"
      fill="#0f1f33"
      stroke="#0284c7"
    />

    <text
      x="240"
      y="509"
      class="l"
    >
      TO-DOS TODAY
    </text>

    <g
      transform="translate(240, 513) scale(0.75)"
    >
      ${icTg}
    </g>

    <text
      x="262"
      y="528"
      class="v"
    >
      ${tToday}
    </text>

    <rect
      x="343"
      y="493"
      width="101"
      height="46"
      rx="7"
      fill="#241b0b"
      stroke="#ca8a04"
    />

    <text
      x="349"
      y="509"
      class="l"
    >
      ALL COMPLETED
    </text>

    <g
      transform="translate(349, 513) scale(0.75)"
    >
      ${icSt}
    </g>

    <text
      x="371"
      y="528"
      class="v"
      fill="#fbbf24"
    >
      ${fmt(gTotal)}
    </text>

    <rect
      x="16"
      y="547"
      width="101"
      height="46"
      rx="7"
      fill="#0d2818"
      stroke="#16a34a"
    />

    <text
      x="22"
      y="563"
      class="l"
    >
      HABITS POSITIF
    </text>

    <g
      transform="translate(22, 567) scale(0.7)"
    >
      ${icThumbUp}
    </g>

    <text
      x="40"
      y="581"
      class="v"
    >
      ${fmt(db.all_time_habits_pos)}
    </text>

    <rect
      x="125"
      y="547"
      width="101"
      height="46"
      rx="7"
      fill="#2a0f14"
      stroke="#dc2626"
    />

    <text
      x="131"
      y="563"
      class="l"
    >
      HABITS NEGATIF
    </text>

    <g
      transform="translate(131, 567) scale(0.7)"
    >
      ${icThumbDown}
    </g>

    <text
      x="149"
      y="581"
      class="v"
    >
      ${fmt(db.all_time_habits_neg)}
    </text>

    <rect
      x="234"
      y="547"
      width="101"
      height="46"
      rx="7"
      fill="#2a1608"
      stroke="#ea580c"
    />

    <text
      x="240"
      y="563"
      class="l"
    >
      DAILIES GAGAL
    </text>

    <g
      transform="translate(240, 567) scale(0.75)"
    >
      ${icX}
    </g>

    <text
      x="260"
      y="581"
      class="v"
    >
      ${dailiesGagal}
    </text>

    <rect
      x="343"
      y="547"
      width="101"
      height="46"
      rx="7"
      fill="#170f33"
      stroke="#7c3aed"
    />

    <text
      x="349"
      y="563"
      class="l"
    >
      TODO BELUM
    </text>

    <g
      transform="translate(349, 567) scale(0.7)"
    >
      ${icClip}
    </g>

    <text
      x="367"
      y="581"
      class="v"
    >
      ${tActive}
    </text>

    <rect
      x="16"
      y="601"
      width="208"
      height="46"
      rx="8"
      fill="url(#gP)"
      stroke="#1e293b"
    />

    <text
      x="26"
      y="617"
      class="l"
    >
      BOUNTY BOARD
    </text>

    <g
      transform="translate(26, 622) scale(0.8)"
    >
      ${icTg}
    </g>

    <text
      x="50"
      y="636"
      class="v"
    >
      ${tActive} Open / ${tCleared} Done
    </text>

    <rect
      x="236"
      y="601"
      width="208"
      height="46"
      rx="8"
      fill="url(#gP)"
      stroke="#1e293b"
    />

    <text
      x="246"
      y="617"
      class="l"
    >
      DISCIPLINE FLAME
    </text>

    <g
      transform="translate(246, 622) scale(0.8)"
    >
      ${icFr}
    </g>

    <text
      x="270"
      y="636"
      class="v"
    >
      ${streak} Days Streak
    </text>

    <rect
      x="16"
      y="655"
      width="428"
      height="130"
      rx="8"
      fill="url(#gT5H)"
      stroke="#06b6d4"
    />

    <text
      x="28"
      y="675"
      font-family="Roboto, sans-serif"
      font-size="11"
      font-weight="700"
      fill="#22d3ee"
    >
      TOP 5 HABITS (HARI INI)
    </text>

    ${h5dailyStr}

    <rect
      x="16"
      y="793"
      width="428"
      height="130"
      rx="8"
      fill="url(#gT5V)"
      stroke="#a855f7"
    />

    <text
      x="28"
      y="813"
      font-family="Roboto, sans-serif"
      font-size="11"
      font-weight="700"
      fill="#c084fc"
    >
      TOP 5 HABITS (3 HARI TERAKHIR)
    </text>

    ${h53dayStr}

    <rect
      x="16"
      y="931"
      width="428"
      height="92"
      rx="8"
      fill="url(#gNeg)"
      stroke="#dc2626"
    />

    <text
      x="28"
      y="951"
      font-family="Roboto, sans-serif"
      font-size="11"
      font-weight="700"
      fill="#f87171"
    >
      TOP 3 HABITS NEGATIF (MINGGUAN)
    </text>

    ${hnegStr}

    <rect
      x="16"
      y="1031"
      width="208"
      height="140"
      rx="8"
      fill="url(#gH)"
      stroke="#f59e0b"
    />

    <text
      x="28"
      y="1051"
      font-family="Roboto, sans-serif"
      font-size="10.5"
      font-weight="700"
      fill="#fbbf24"
    >
      TOP 5 HABITS (MINGGUAN)
    </text>

    ${hStr}

    <rect
      x="236"
      y="1031"
      width="208"
      height="140"
      rx="8"
      fill="url(#gD)"
      stroke="#10b981"
    />

    <text
      x="248"
      y="1051"
      font-family="Roboto, sans-serif"
      font-size="10.5"
      font-weight="700"
      fill="#34d399"
    >
      TOP 5 DAILIES (MINGGUAN)
    </text>

    ${dStr}

    <rect
      x="16"
      y="1179"
      width="208"
      height="140"
      rx="8"
      fill="url(#gT5M)"
      stroke="#6366f1"
    />

    <text
      x="28"
      y="1199"
      font-family="Roboto, sans-serif"
      font-size="10.5"
      font-weight="700"
      fill="#818cf8"
    >
      TOP 5 HABITS (BULANAN)
    </text>

    ${hmonthStr}

    <rect
      x="236"
      y="1179"
      width="208"
      height="140"
      rx="8"
      fill="url(#gP)"
      stroke="#1e293b"
    />

    <text
      x="248"
      y="1199"
      font-family="Roboto, sans-serif"
      font-size="10.5"
      font-weight="700"
      fill="#cbd5e1"
      letter-spacing="0.5"
    >
      IDLE HABITS
    </text>

    <g
      transform="translate(248, 1212) scale(0.85)"
    >
      ${icMoon}
    </g>

    <text
      x="270"
      y="1227"
      font-family="Roboto, sans-serif"
      font-size="11.5px"
      fill="#cbd5e1"
    >
      Yesterday
    </text>

    <text
      x="270"
      y="1244"
      class="v"
    >
      ${idleYesterdayCount}

      <tspan
        font-family="Roboto, sans-serif"
        font-size="11.5px"
        fill="#cbd5e1"
      >
        / ${totalHabitsCount} habits
      </tspan>
    </text>

    <line
      x1="246"
      y1="1256"
      x2="442"
      y2="1256"
      stroke="#334155"
      stroke-width="1"
    />

    <g
      transform="translate(248, 1263) scale(0.85)"
    >
      ${icCalendar}
    </g>

    <text
      x="270"
      y="1278"
      font-family="Roboto, sans-serif"
      font-size="11.5px"
      fill="#cbd5e1"
    >
      This Week
    </text>

    <text
      x="270"
      y="1295"
      class="v"
    >
      ${habitsUntouchedWeek}

      <tspan
        font-family="Roboto, sans-serif"
        font-size="11.5px"
        fill="#cbd5e1"
      >
        (${idleWeekPct}%)
      </tspan>
    </text>

    <rect
      x="16"
      y="${QUOTE_Y}"
      width="428"
      height="${quoteBoxH}"
      rx="9"
      fill="url(#gI)"
      stroke="url(#gB)"
    />

    <text
      x="28"
      y="${QUOTE_Y + 23}"
      font-family="Roboto, sans-serif"
      font-size="11"
      font-weight="700"
      fill="#facc15"
    >
      SCROLL OF INSIGHT
    </text>

    <text
      x="28"
      y="${QUOTE_Y + 45}"
      font-family="Roboto, sans-serif"
      font-size="12"
      fill="#e2e8f0"
    >
      ${quoteTspans}
    </text>

  </g>

  <rect
    width="${canvasW}"
    height="${canvasH}"
    rx="18"
    fill="none"
    stroke="url(#gB)"
    stroke-width="3.5"
  />

</svg>`;

  // ==========================================
  // SIMPAN DATABASE
  // ==========================================

  await saveDB(db);

  return svg;
}

// ==========================================
// FONT
// ==========================================

let fontFilesCache = null;

function getFontsSync() {
  if (fontFilesCache) {
    return fontFilesCache;
  }

  try {
    const regularPath =
      getLocalPath(
        'Roboto-Regular.ttf'
      );

    const boldPath =
      getLocalPath(
        'Roboto-Bold.ttf'
      );

    if (!regularPath) {
      throw new Error(
        'Roboto-Regular.ttf tidak ditemukan.'
      );
    }

    if (!boldPath) {
      throw new Error(
        'Roboto-Bold.ttf tidak ditemukan.'
      );
    }

    const regularSize =
      fs.statSync(
        regularPath
      ).size;

    const boldSize =
      fs.statSync(
        boldPath
      ).size;

    if (regularSize <= 0) {
      throw new Error(
        'Roboto-Regular.ttf kosong.'
      );
    }

    if (boldSize <= 0) {
      throw new Error(
        'Roboto-Bold.ttf kosong.'
      );
    }

    fontFilesCache = {
      files: [
        regularPath,
        boldPath,
      ],

      regularPath,
      boldPath,

      regularSize,
      boldSize,
    };

    fontLoadError = 'ok';

    return fontFilesCache;

  } catch (e) {
    fontLoadError =
      `error: ${e.message}`;

    throw e;
  }
}

// ==========================================
// HTTP HANDLER
// ==========================================

// ==========================================
// PHASE 3A — HABITICA WEBHOOK + PNG ENDPOINT
// ==========================================

module.exports = async (req, res) => {
  const isWebhook = req.method === 'POST';

  try {
    // --------------------------------------
    // HABITICA WEBHOOK
    // --------------------------------------
    if (isWebhook) {
      console.log('PHASE 3A: Habitica webhook diterima');

      const webhookEvent = getWebhookBody(req);

      if (webhookEvent) {
        console.log(
          'PHASE 3C: webhook event diterima',
          JSON.stringify({
            type: webhookEvent.type,
            webhookType: webhookEvent.webhookType,
            direction: webhookEvent.direction,
            taskId: webhookEvent.task && (webhookEvent.task.id || webhookEvent.task._id),
            progressDelta:
              webhookEvent.user &&
              webhookEvent.user._tmp &&
              webhookEvent.user._tmp.quest &&
              webhookEvent.user._tmp.quest.progressDelta,
          })
        );
      }

      await generateSVG(webhookEvent);

      res.setHeader('Content-Type', 'application/json');
      res.status(200).json({
        ok: true,
        message: 'Habitica webhook processed',
        timestamp: new Date().toISOString(),
      });

      return;
    }

    // --------------------------------------
    // NORMAL PNG REQUEST
    // GET /api/stats
    // --------------------------------------
    const svg = await generateSVG();
    const fontInfo = getFontsSync();

    // getFontsSync() mengembalikan object berisi path font.
    // resvg harus menerima path tersebut melalui fontFiles.
    if (!fontInfo || !Array.isArray(fontInfo.files) || !fontInfo.files.length) {
      throw new Error(`Font tidak ditemukan: ${fontLoadError}`);
    }

    const resvgOpts = {
      fitTo: { mode: 'original' },
      font: {
        fontFiles: fontInfo.files,
        defaultFontFamily: 'Roboto',
        sansSerifFamily: 'Roboto',
        loadSystemFonts: false,
      },
    };

    const resvg = new Resvg(svg, resvgOpts);
    const pngData = resvg.render();
    const pngBuffer = pngData.asPng();

    res.setHeader('Content-Type', 'image/png');
    res.setHeader(
      'Cache-Control',
      'no-store, no-cache, must-revalidate, proxy-revalidate'
    );
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    res.setHeader('X-Debug-Font', fontLoadError);
    res.setHeader('X-Debug-DB-Load', debugDbLoad);
    res.setHeader('X-Debug-DB-Save', debugDbSave);

    res.status(200).send(pngBuffer);

  } catch (e) {
    console.error('PHASE 3A ERROR:', e);

    if (isWebhook) {
      res.setHeader('Content-Type', 'application/json');
      res.status(500).json({
        ok: false,
        error: e.message,
      });
      return;
    }

    res.status(500).send(`Error: ${e.message}`);
  }
};

module.exports.generateSVG = generateSVG;
