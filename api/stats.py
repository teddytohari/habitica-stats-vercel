from http.server import BaseHTTPRequestHandler
import os, json, html, requests, random, textwrap, unicodedata
from datetime import datetime, timezone, timedelta

# ==========================================
# KONFIGURASI (diambil dari Environment Variables Vercel)
# ==========================================
USER_ID = os.environ.get("HABITICA_USER_ID")
API_TOKEN = os.environ.get("HABITICA_API_TOKEN")
UPSTASH_URL = os.environ.get("UPSTASH_REDIS_REST_URL")
UPSTASH_TOKEN = os.environ.get("UPSTASH_REDIS_REST_TOKEN")
DB_KEY = "habitica_stats_db"  # nama "file" kita di Upstash

WIB = timezone(timedelta(hours=7))
headers = {"x-api-user": USER_ID, "x-api-key": API_TOKEN, "x-client": f"{USER_ID}-RPGStatsCard"}
upstash_headers = {"Authorization": f"Bearer {UPSTASH_TOKEN}"}


# ==========================================
# GANTI database.json -> UPSTASH (REST API)
# ==========================================
def load_db():
    default = {
        "current_cycle_id": "", "classes_used": [], "peak_gold": 0.0, "total_mana_spent": 0.0,
        "last_mana": None, "buffs_cast": 0, "bosses_slain": 0, "all_time_damage": 0.0,
        "weekly_damage": 0.0, "peak_daily_damage": 0.0, "current_day_damage": 0.0,
        "damage_day_date": "", "last_damage_up": 0.0, "weekly_top_dailies": {},
        "last_daily_date": "", "daily_habit_baseline": 0,
        "last_quest_key": None, "last_quest_is_boss": False,
        "last_habit_counters": {}, "weekly_habit_clicks": {}, "weekly_habit_neg": {},
        "today_habit_clicks": {}, "today_habit_neg": {}, "last_completed_daily_ids": [],
        "monthly_habit_clicks": {}, "current_month_id": "", "habit_daily_log": [],
        "all_time_habits_pos": 0, "all_time_habits_neg": 0,
        "all_time_dailies_completed": 0, "all_time_todos_completed": 0,
        "last_completed_todo_ids": []
    }
    try:
        r = requests.get(f"{UPSTASH_URL}/get/{DB_KEY}", headers=upstash_headers, timeout=10)
        result = r.json().get("result")
        if result:
            default.update(json.loads(result))
    except Exception as e:
        print(f"Upstash load notice: {e}")
    return default


def save_db(db):
    try:
        requests.post(f"{UPSTASH_URL}/set/{DB_KEY}", headers=upstash_headers,
                      data=json.dumps(db), timeout=10)
    except Exception as e:
        print(f"Upstash save notice: {e}")


# ==========================================
# FUNGSI UTAMA: generate SVG (isinya = skrip lama kamu, disesuaikan)
# ==========================================
def generate_svg():
    db = load_db()

    now = datetime.now(WIB)
    today_str = now.strftime("%Y-%m-%d")

    adjusted = now - timedelta(hours=6)
    days_since_sunday = (adjusted.weekday() + 1) % 7
    week_start = (adjusted - timedelta(days=days_since_sunday)).date()
    cycle = week_start.isoformat()

    if db["current_cycle_id"] != cycle:
        db["weekly_damage"] = 0.0
        db["weekly_top_dailies"] = {}
        db["weekly_habit_clicks"] = {}
        db["weekly_habit_neg"] = {}
        db["current_cycle_id"] = cycle

    month_id = adjusted.strftime("%Y-%m")
    if db.get("current_month_id") != month_id:
        db["monthly_habit_clicks"] = {}
        db["current_month_id"] = month_id

    if db.get("damage_day_date") != today_str:
        if db.get("current_day_damage", 0) > db.get("peak_daily_damage", 0):
            db["peak_daily_damage"] = db["current_day_damage"]
        db["damage_day_date"] = today_str
        db["current_day_damage"] = 0.0

    u_res = requests.get("https://habitica.com/api/v3/user", headers=headers, timeout=20).json().get("data", {})
    t_res = requests.get("https://habitica.com/api/v3/tasks/user", headers=headers, timeout=20).json().get("data", [])
    c_res = requests.get("https://habitica.com/api/v3/tasks/user?type=completedTodos", headers=headers, timeout=20).json().get("data", [])

    if not isinstance(t_res, list): t_res = []
    if not isinstance(c_res, list): c_res = []

    raw_name = u_res.get("profile", {}).get("name", "Hero")
    p_name = html.escape(raw_name[:18])

    def safe_ascii_name(name, fallback="HERO"):
        try:
            decomposed = unicodedata.normalize("NFKD", name)
            cleaned = "".join(ch for ch in decomposed if ord(ch) < 128 and (ch.isalnum() or ch.isspace() or ch in "-_.'"))
            cleaned = cleaned.strip()
            return cleaned if cleaned else fallback
        except Exception:
            return fallback

    svg_name = html.escape(safe_ascii_name(raw_name)[:18])

    c_class = u_res.get("stats", {}).get("class", "warrior").lower()
    lvl = u_res.get("stats", {}).get("lvl", 1)
    gold = u_res.get("stats", {}).get("gp", 0.0)
    mp = u_res.get("stats", {}).get("mp", 0.0)

    if c_class not in db["classes_used"]: db["classes_used"].append(c_class)
    db["peak_gold"] = max(db["peak_gold"], gold)

    if db["last_mana"] is not None and mp < db["last_mana"]:
        diff = db["last_mana"] - mp
        if diff > 0:
            db["total_mana_spent"] += diff
            db["buffs_cast"] += 1
    db["last_mana"] = mp

    dmg_up = u_res.get("party", {}).get("quest", {}).get("progress", {}).get("up", 0.0)
    if dmg_up > db["last_damage_up"]:
        delta = dmg_up - db["last_damage_up"]
        db["weekly_damage"] += delta
        db["all_time_damage"] += delta
        db["current_day_damage"] += delta
        if db["current_day_damage"] > db.get("peak_daily_damage", 0):
            db["peak_daily_damage"] = db["current_day_damage"]
    db["last_damage_up"] = dmg_up

    try:
        party_res = requests.get("https://habitica.com/api/v3/groups/party", headers=headers, timeout=8).json().get("data", {})
    except Exception:
        party_res = {}
    quest_now = party_res.get("quest") or {}
    quest_key_now = quest_now.get("key")
    quest_active_now = quest_now.get("active", False)
    is_boss_now = bool(quest_now.get("progress") and "hp" in quest_now.get("progress", {}))
    prev_key = db.get("last_quest_key")
    prev_is_boss = db.get("last_quest_is_boss", False)
    if prev_key and prev_is_boss and quest_key_now != prev_key:
        db["bosses_slain"] += 1
    db["last_quest_key"] = quest_key_now if quest_active_now else None
    db["last_quest_is_boss"] = is_boss_now if quest_active_now else False

    def bump(store, tid, text, amount):
        entry = store.get(tid, {"text": text, "count": 0})
        entry["text"] = text
        entry["count"] += amount
        store[tid] = entry

    dailies = [t for t in t_res if t.get("type") == "daily"]
    due = [t for t in dailies if t.get("isDue", False)]
    done = [t for t in due if t.get("completed", False)]
    pct = int((len(done) / len(due) * 100)) if due else 100
    dailies_gagal = max(0, len(due) - len(done))

    current_completed_ids = set(d.get("id") for d in done)
    last_completed_ids = set(db.get("last_completed_daily_ids", []))
    newly_completed = current_completed_ids - last_completed_ids

    db["all_time_dailies_completed"] += len(newly_completed)

    for d_task in done:
        tid = d_task.get("id")
        if tid in newly_completed:
            text = html.escape(d_task.get("text", "")[:28])
            bump(db["weekly_top_dailies"], tid, text, 1)

    db["last_completed_daily_ids"] = list(current_completed_ids)

    top_d = sorted(db["weekly_top_dailies"].values(), key=lambda x: x["count"], reverse=True)[:5]

    habits = [t for t in t_res if t.get("type") == "habit"]
    up = sum(t.get("counterUp", 0) for t in habits)
    dn = sum(t.get("counterDown", 0) for t in habits)
    hratio = int((up / (up + dn) * 100)) if (up + dn) > 0 else 100

    if db["all_time_habits_pos"] == 0 and up > 0: db["all_time_habits_pos"] = up
    if db["all_time_habits_neg"] == 0 and dn > 0: db["all_time_habits_neg"] = dn

    last_habit_counters = db.get("last_habit_counters", {})
    weekly_habit_clicks = db.get("weekly_habit_clicks", {})
    weekly_habit_neg = db.get("weekly_habit_neg", {})
    today_habit_clicks = db.get("today_habit_clicks", {})
    today_habit_neg = db.get("today_habit_neg", {})
    monthly_habit_clicks = db.get("monthly_habit_clicks", {})

    for h in habits:
        hid = h.get("id")
        text = h.get("text", "")[:28]
        cur_up = h.get("counterUp", 0)
        cur_dn = h.get("counterDown", 0)
        prev = last_habit_counters.get(hid, {"up": cur_up, "down": cur_dn})
        delta_up = max(0, cur_up - prev.get("up", cur_up))
        delta_dn = max(0, cur_dn - prev.get("down", cur_dn))

        if delta_up > 0:
            db["all_time_habits_pos"] += delta_up
            bump(weekly_habit_clicks, hid, text, delta_up)
            bump(today_habit_clicks, hid, text, delta_up)
            bump(monthly_habit_clicks, hid, text, delta_up)
        if delta_dn > 0:
            db["all_time_habits_neg"] += delta_dn
            bump(weekly_habit_neg, hid, text, delta_dn)
            bump(today_habit_neg, hid, text, delta_dn)
        last_habit_counters[hid] = {"up": cur_up, "down": cur_dn}

    db["last_habit_counters"] = last_habit_counters
    db["weekly_habit_clicks"] = weekly_habit_clicks
    db["weekly_habit_neg"] = weekly_habit_neg
    db["today_habit_clicks"] = today_habit_clicks
    db["today_habit_neg"] = today_habit_neg
    db["monthly_habit_clicks"] = monthly_habit_clicks

    current_completed_todos = set(t.get("id") for t in c_res)
    newly_completed_todos = current_completed_todos - set(db.get("last_completed_todo_ids", []))
    if db["all_time_todos_completed"] == 0: db["all_time_todos_completed"] = len(c_res)
    db["all_time_todos_completed"] += len(newly_completed_todos)
    db["last_completed_todo_ids"] = list(current_completed_todos)

    top_h = sorted(weekly_habit_clicks.values(), key=lambda x: x["count"], reverse=True)[:5]
    top_hneg3 = sorted(weekly_habit_neg.values(), key=lambda x: x["count"], reverse=True)[:3]
    top_h_month = sorted(monthly_habit_clicks.values(), key=lambda x: x["count"], reverse=True)[:5]

    touched_ids_week = set(weekly_habit_clicks.keys()) | set(weekly_habit_neg.keys())
    habits_untouched_week = sum(1 for h in habits if h.get("id") not in touched_ids_week)
    total_habits_count = len(habits)
    idle_week_pct = int(round(habits_untouched_week / total_habits_count * 100)) if total_habits_count else 0

    if db["last_daily_date"] != today_str:
        db.setdefault("habit_daily_log", [])
        if db["today_habit_clicks"] or db["today_habit_neg"]:
            db["habit_daily_log"].append({
                "date": db["last_daily_date"],
                "clicks": db["today_habit_clicks"],
                "neg": db["today_habit_neg"],
            })
        db["habit_daily_log"] = db["habit_daily_log"][-3:]
        db["last_daily_date"] = today_str
        db["daily_habit_baseline"] = db["all_time_habits_pos"]
        db["today_habit_clicks"] = {}
        db["today_habit_neg"] = {}
        today_habit_clicks = {}

    _log = db.get("habit_daily_log", [])
    if _log:
        _yesterday = _log[-1]
        touched_yesterday_ids = set(_yesterday.get("clicks", {}).keys()) | set(_yesterday.get("neg", {}).keys())
        idle_yesterday_count = sum(1 for h in habits if h.get("id") not in touched_yesterday_ids)
    else:
        idle_yesterday_count = total_habits_count

    top_h5_daily = sorted(today_habit_clicks.values(), key=lambda x: x["count"], reverse=True)[:5]

    def merge_click_dicts(*dicts):
        merged = {}
        for d in dicts:
            for tid, entry in d.items():
                m = merged.get(tid, {"text": entry["text"], "count": 0})
                m["text"] = entry["text"]
                m["count"] += entry["count"]
                merged[tid] = m
        return merged

    recent_logs = [entry["clicks"] for entry in db.get("habit_daily_log", [])[-2:]]
    rolling3_source = merge_click_dicts(today_habit_clicks, *recent_logs)
    top_h_3day = sorted(rolling3_source.values(), key=lambda x: x["count"], reverse=True)[:5]

    def trunc(s, n=17):
        return s if len(s) <= n else s[:n - 1].rstrip() + "…"

    h_today = max(0, db["all_time_habits_pos"] - db["daily_habit_baseline"])
    t_today = sum(1 for t in c_res if t.get("dateCompleted") and datetime.fromisoformat(t["dateCompleted"].replace("Z", "+00:00")).astimezone(WIB).strftime("%Y-%m-%d") == today_str)
    t_active = len([t for t in t_res if t.get("type") == "todo"])
    t_cleared = len(c_res)

    g_total = db["all_time_habits_pos"] + db["all_time_todos_completed"] + db["all_time_dailies_completed"]

    streak = max([t.get("streak", 0) for t in dailies], default=0)
    days = max(1, (adjusted.date() - week_start).days + 1)
    avg_dmg = db["weekly_damage"] / days

    def fmt(n): return f"{n/1000000:.2f}m" if n >= 1000000 else f"{n/1000:.1f}k" if n >= 1000 else str(int(n))

    quote_text = "Consistency is not perfection, it is simply refusing to give up."
    try:
        quote_path = os.path.join(os.path.dirname(__file__), "quote.txt")
        if os.path.exists(quote_path):
            with open(quote_path, "r", encoding="utf-8") as qf:
                lines = [line.strip() for line in qf.readlines() if line.strip()]
                if lines: quote_text = " ".join(lines)
    except Exception:
        pass

    # ---- Update bio Habitica (link gambar sekarang statis / stabil, tidak perlu ?v=timestamp) ----
    STATS_IMG_URL = os.environ.get("PUBLIC_STATS_URL", "")
    if STATS_IMG_URL:
        habit_bio_lines = "\n".join(f"{i+1}. {it['text']} (+{it['count']})" for i, it in enumerate(top_h)) or "-"
        daily_bio_lines = "\n".join(f"{i+1}. {it['text']} ({it['count']}x)" for i, it in enumerate(top_d)) or "-"
        bio = f"""### PERFORMANCE MATRIX

![]({STATS_IMG_URL})

⚡ **Streak:** {streak} hari • 💰 **Peak Gold:** {fmt(db['peak_gold'])} G • 🗡️ **Peak Dmg/Hari:** {fmt(db['peak_daily_damage'])}

---
🔴 **COMBAT & EXPEDITION**
- Total Damage (All-Time): **{fmt(db['all_time_damage'])}**
- Weekly Damage: **{fmt(db['weekly_damage'])}**
- Bosses Slain: **{db['bosses_slain']}**
- Buffs Cast: **{db['buffs_cast']}** • Mana Spent: **{fmt(db['total_mana_spent'])} MP**

---
🔵 **PRODUCTIVITY MATRIX**
- Dailies Hari Ini: **{len(done)}/{len(due)} ({pct}%)**
- Habit Mastery: **{hratio}% Positive**
- Selesai Hari Ini: **{h_today} Habits • {len(done)} Dailies • {t_today} To-Dos**

---
🟠 **TOP 5 HABITS (MINGGUAN)**
{habit_bio_lines}

🟢 **TOP 5 DAILIES (MINGGUAN)**
{daily_bio_lines}

---
> "{quote_text}"
"""
        try:
            requests.put("https://habitica.com/api/v3/user", headers=headers, json={"profile.blurb": bio}, timeout=10)
        except Exception:
            pass

    # ==========================================
    # LOGO, IKON, HUTAN, DLL — SAMA PERSIS SEPERTI SKRIP LAMA
    # ==========================================
    logo_svg = '''
    <rect x="14" y="20" width="100" height="100" rx="22" fill="url(#logoBgGlow)" stroke="url(#goldRing)" stroke-width="3"/>
    <rect x="21" y="27" width="86" height="86" rx="17" fill="none" stroke="#f5d78e" stroke-width="1" opacity="0.35"/>
    <circle cx="64" cy="66" r="34" fill="#f2b705" opacity="0.14"/>
    <g filter="url(#goldGlow)">
    <path d="M64 36 L86 66 L64 96 L42 66 Z" fill="#fbbf24" opacity="0.5"/>
    </g>
    <path d="M64 36 L86 66 L64 96 L42 66 Z" fill="url(#gemGlow)" stroke="#78350f" stroke-width="2"/>
    <path d="M64 36 L86 66 L64 66 Z" fill="#fff7d6" opacity="0.5"/>
    <circle cx="64" cy="60" r="7" fill="#fffbe8" opacity="0.9"/>
    <path d="M64 22 L67 31 L76 33 L67 35 L64 44 L61 35 L52 33 L61 31 Z" fill="#fde68a"/>
    <path d="M40 92 L42 97 L47 99 L42 101 L40 106 L38 101 L33 99 L38 97 Z" fill="#f5d78e" opacity="0.85"/>
    <path d="M87 46 L89 51 L94 53 L89 55 L87 60 L85 55 L80 53 L85 51 Z" fill="#fff7d6" opacity="0.9"/>
    <path d="M45 82 L46.5 85.5 L50 87 L46.5 88.5 L45 92 L43.5 88.5 L40 87 L43.5 85.5 Z" fill="#fde68a" opacity="0.85"/>
    '''

    random.seed(42)
    pine_trees = ""
    for i in range(16):
        x = random.randint(-30, 430)
        scale = random.uniform(0.7, 1.3)
        y = 128 - scale * 80 + random.uniform(-4, 4)
        opacity = random.uniform(0.55, 0.95)
        pine_trees += f'<g transform="translate({x}, {y:.1f}) scale({scale:.2f})" opacity="{opacity:.2f}">'
        pine_trees += '<polygon points="25,0 0,35 50,35" fill="#0d7a58"/>'
        pine_trees += '<polygon points="25,15 0,50 50,50" fill="#0a6b4d"/>'
        pine_trees += '<polygon points="25,30 0,65 50,65" fill="#085c42"/>'
        pine_trees += '<rect x="21" y="65" width="8" height="15" fill="#3f2c22"/></g>'

    random.seed(21)
    night_stars = ""
    for i in range(30):
        sx = random.randint(5, 455); sy = random.randint(5, 125)
        r = random.uniform(0.6, 1.8); op = random.uniform(0.4, 0.95)
        night_stars += f'<circle cx="{sx}" cy="{sy}" r="{r}" fill="#fef9e7" opacity="{op}"/>'

    ground_band = '<rect x="0" y="90" width="460" height="50" fill="url(#groundGrad)"/>'
    random.seed(33)
    grass = ""
    for i in range(45):
        gx = random.randint(0, 460)
        gh = random.uniform(5, 12)
        gy = 140 - gh
        op = random.uniform(0.5, 0.9)
        grass += f'<polygon points="{gx-2},140 {gx},{gy:.1f} {gx+2},140" fill="#15803d" opacity="{op:.2f}"/>'

    random.seed(58)
    rocks = ""
    base_xs = [265, 335, 405]
    for bx in base_xs:
        rx = bx + random.randint(-15, 15)
        ry = random.randint(126, 136)
        rs = random.uniform(0.8, 1.3)
        rocks += f'<g transform="translate({rx},{ry}) scale({rs:.2f})">'
        rocks += '<ellipse cx="0" cy="0" rx="9" ry="5" fill="#57534e" stroke="#3f3a36" stroke-width="1"/>'
        rocks += '<ellipse cx="-3" cy="-2" rx="3" ry="1.6" fill="#78716c" opacity="0.6"/>'
        rocks += '</g>'

    ic_sw = '<path d="M4 20L20 4M8 20L20 8" stroke="#fb7185" stroke-width="2.5" stroke-linecap="round"/>'
    ic_fr = '<path d="M12 22C12 22 5 15 5 10C5 6 8 2 12 2C12 2 10 6 10 10C10 12 12 14 12 14C12 14 15 11 15 8C17 10 19 13 19 16C19 19.5 16 22 12 22Z" fill="#f59e0b"/>'
    ic_tr = '<path d="M4 6H20M5 6V11C5 14.8 8.1 18 12 18C15.9 18 19 14.8 19 11V6M8 18V22M16 18V22M6 22H18" stroke="#facc15" stroke-width="2" stroke-linecap="round" fill="none"/>'
    ic_gd = '<circle cx="12" cy="12" r="8" fill="#f59e0b"/><text x="12" y="16" font-size="11" fill="#141724" text-anchor="middle" font-weight="bold" font-family="sans-serif">G</text>'
    ic_ch = '<path d="M18 20V10M12 20V4M6 20V14" stroke="#60a5fa" stroke-width="2.5" stroke-linecap="round"/>'
    ic_sp = '<path d="M12 2L14 9L21 11L14 13L12 20L10 13L3 11L10 9Z" fill="#b45309"/>'
    ic_ck = '<path d="M5 12L10 17L19 7" stroke="#059669" stroke-width="2.5" stroke-linecap="round" fill="none"/>'
    ic_tg = '<circle cx="12" cy="12" r="8" stroke="#0284c7" stroke-width="2" fill="none"/><circle cx="12" cy="12" r="3" fill="#0284c7"/>'
    ic_st = '<path d="M12 2L15 9L22 9L16 14L18 21L12 17L6 21L8 14L2 9L9 9Z" fill="#ca8a04"/>'
    ic_sparkle = '<path d="M12 2L14 9L21 11L14 13L12 20L10 13L3 11L10 9Z" fill="#facc15"/>'
    ic_drop = '<path d="M12 2C12 2 5 11 5 15.5C5 19.6 8.1 22 12 22C15.9 22 19 19.6 19 15.5C19 11 12 2 12 2Z" fill="#60a5fa"/>'
    ic_thumb_up = '<path d="M2 21H6V10H2V21ZM9 21H17C17.8 21 18.5 20.4 18.7 19.6L21 12.4C21.3 11.4 20.5 10.5 19.5 10.5H14.4L15 6.5C15.1 5.7 14.5 5 13.7 5C13.3 5 12.9 5.2 12.6 5.5L8.3 10.3C8.1 10.5 8 10.8 8 11.1V19.5C8 20.3 8.7 21 9 21Z" fill="#22c55e"/>'
    ic_thumb_down = '<path d="M22 3H18V14H22V3ZM15 3H7C6.2 3 5.5 3.6 5.3 4.4L3 11.6C2.7 12.6 3.5 13.5 4.5 13.5H9.6L9 17.5C8.9 18.3 9.5 19 10.3 19C10.7 19 11.1 18.8 11.4 18.5L15.7 13.7C15.9 13.5 16 13.2 16 12.9V4.5C16 3.7 15.3 3 15 3Z" fill="#ef4444"/>'
    ic_x = '<path d="M6 6L18 18M6 18L18 6" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round"/>'
    ic_clip = '<rect x="5" y="4" width="14" height="17" rx="2" stroke="#a78bfa" stroke-width="2" fill="none"/><path d="M9 2H15V6H9V2Z" fill="#a78bfa"/>'

    ic_class_war = '<path d="M4 20L18 6M8 20L18 10" stroke="#fb7185" stroke-width="2.2" stroke-linecap="round"/><path d="M15 3L21 9L18 12L12 6Z" fill="#fb7185"/>'
    ic_class_mag = '<path d="M12 2L14 9L21 11L14 13L12 20L10 13L3 11L10 9Z" fill="#60a5fa"/>'
    ic_class_rog = '<path d="M4 20L16 8M16 8L14 4L20 6L16 8Z" fill="#f59e0b" stroke="#f59e0b" stroke-linejoin="round"/>'
    ic_class_hea = '<path d="M12 21C12 21 4 14.5 4 9.5C4 6.5 6.5 4 9.5 4C11 4 12 5 12 5C12 5 13 4 14.5 4C17.5 4 20 6.5 20 9.5C20 14.5 12 21 12 21Z" fill="#34d399"/>'
    ic_moon = '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" fill="#94a3b8"/>'
    ic_calendar = '<rect x="3" y="4" width="18" height="17" rx="2" stroke="#a5b4fc" stroke-width="1.8" fill="none"/><path d="M3 9.5H21" stroke="#a5b4fc" stroke-width="1.8"/><path d="M7 2.2V6M17 2.2V6" stroke="#a5b4fc" stroke-width="1.8" stroke-linecap="round"/>'

    cfg = {"warrior": {"sec": "#fb7185", "bg": "#3a0914", "n": "WARRIOR"}, "mage": {"sec": "#60a5fa", "bg": "#0f172a", "n": "ARCHMAGE"}, "rogue": {"sec": "#fbbf24", "bg": "#321706", "n": "SHADOW ROGUE"}, "healer": {"sec": "#34d399", "bg": "#062b20", "n": "HIGH HEALER"}}.get(c_class, {"sec": "#fb7185", "bg": "#3a0914", "n": "WARRIOR"})

    quote_lines = textwrap.wrap(quote_text, width=50)[:4]
    quote_tspans = "".join(
        f'<tspan x="28" dy="{0 if i == 0 else 18}">{html.escape(line)}</tspan>'
        for i, line in enumerate(quote_lines)
    )

    canvas_w = 460
    QUOTE_Y = 1335
    quote_box_h = 40 + max(1, len(quote_lines)) * 18 + 12
    canvas_h = QUOTE_Y + quote_box_h + 20

    random.seed(7)
    bg_pattern = ""
    for i in range(24):
        x = random.randint(-20, canvas_w - 20)
        y = random.randint(150, canvas_h - 40)
        scale = random.uniform(0.5, 1.0)
        bg_pattern += f'<g transform="translate({x},{y}) scale({scale})" opacity="0.045">'
        bg_pattern += '<polygon points="25,0 0,35 50,35" fill="#94a3b8"/>'
        bg_pattern += '<polygon points="25,15 0,50 50,50" fill="#94a3b8"/>'
        bg_pattern += '</g>'

    h5daily_str = "".join(f'<text x="28" y="{696+i*18}" class="list">{i+1}. {it["text"]} (+{it["count"]})</text>' for i, it in enumerate(top_h5_daily))
    h53day_str = "".join(f'<text x="28" y="{834+i*18}" class="list">{i+1}. {it["text"]} (+{it["count"]})</text>' for i, it in enumerate(top_h_3day))
    hneg_str = "".join(f'<text x="28" y="{972+i*18}" class="list">{i+1}. {it["text"]} (-{it["count"]})</text>' for i, it in enumerate(top_hneg3))
    h_str = "".join(f'<text x="28" y="{1072+i*18}" class="list">{i+1}. {trunc(it["text"])} (+{it["count"]})</text>' for i, it in enumerate(top_h))
    d_str = "".join(f'<text x="248" y="{1072+i*18}" class="list">{i+1}. {trunc(it["text"])} ({it["count"]}x)</text>' for i, it in enumerate(top_d))
    hmonth_str = "".join(f'<text x="28" y="{1220+i*18}" class="list">{i+1}. {trunc(it["text"])} (+{it["count"]})</text>' for i, it in enumerate(top_h_month))

    svg = f"""<svg width="{canvas_w*2}" height="{canvas_h*2}" viewBox="0 0 {canvas_w} {canvas_h}" fill="none" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <defs>
    <clipPath id="rc"><rect width="{canvas_w}" height="{canvas_h}" rx="18"/></clipPath>
    <linearGradient id="g1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#141724"/><stop offset="100%" stop-color="#07080f"/></linearGradient>
    <linearGradient id="gB" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#f59e0b"/><stop offset="100%" stop-color="#78350f"/></linearGradient>
    <linearGradient id="gC" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#24121b"/><stop offset="100%" stop-color="#180c13"/></linearGradient>
    <linearGradient id="gP" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#12182b"/><stop offset="100%" stop-color="#0b101e"/></linearGradient>
    <linearGradient id="gH" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#332010"/><stop offset="100%" stop-color="#1c1106"/></linearGradient>
    <linearGradient id="gD" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#0a2c1e"/><stop offset="100%" stop-color="#051a12"/></linearGradient>
    <linearGradient id="gI" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#3d2b0a"/><stop offset="100%" stop-color="#1c1405"/></linearGradient>
    <linearGradient id="gBar" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#10b981"/><stop offset="100%" stop-color="#34d399"/></linearGradient>
    <linearGradient id="gT5H" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#082629"/><stop offset="100%" stop-color="#051619"/></linearGradient>
    <linearGradient id="gT5V" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#2a1145"/><stop offset="100%" stop-color="#170a28"/></linearGradient>
    <linearGradient id="gT5M" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#1e1b4b"/><stop offset="100%" stop-color="#0f0d2e"/></linearGradient>
    <linearGradient id="gNeg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#2a0f14"/><stop offset="100%" stop-color="#180a0d"/></linearGradient>
    <linearGradient id="goldRing" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#fde68a"/><stop offset="50%" stop-color="#f59e0b"/><stop offset="100%" stop-color="#92400e"/></linearGradient>
    <linearGradient id="gemGrad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#fde68a"/><stop offset="50%" stop-color="#f59e0b"/><stop offset="100%" stop-color="#b45309"/></linearGradient>
    <radialGradient id="logoBgGlow" cx="50%" cy="42%" r="72%"><stop offset="0%" stop-color="#1e4534"/><stop offset="45%" stop-color="#123024"/><stop offset="100%" stop-color="#061410"/></radialGradient>
    <radialGradient id="gemGlow" cx="50%" cy="32%" r="68%"><stop offset="0%" stop-color="#fff7d6"/><stop offset="35%" stop-color="#fde68a"/><stop offset="70%" stop-color="#f2b705"/><stop offset="100%" stop-color="#8a5a10"/></radialGradient>
    <linearGradient id="groundGrad" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#2a1f14" stop-opacity="0"/><stop offset="45%" stop-color="#2a1f14" stop-opacity="0.9"/><stop offset="100%" stop-color="#120d09" stop-opacity="1"/></linearGradient>
    <filter id="goldGlow" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="3.2" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <style>
    .t {{ font-family: sans-serif; font-weight: 900; fill: #fff; }}
    .s {{ font-family: sans-serif; font-size: 11.5px; fill: #94a3b8; }}
    .l {{ font-family: sans-serif; font-size: 9.5px; fill: #94a3b8; font-weight: 600; letter-spacing: 0.5px; }}
    .v {{ font-family: sans-serif; font-size: 14px; font-weight: bold; fill: #f8fafc; }}
    .list {{ font-family: sans-serif; font-size: 11.5px; fill: #cbd5e1; }}
  </style>
  <g clip-path="url(#rc)">
    <rect width="{canvas_w}" height="{canvas_h}" fill="url(#g1)"/>
    {bg_pattern}

    <rect x="0" y="0" width="460" height="140" fill="#0f172a"/>
    {night_stars}
    {ground_band}
    {pine_trees}
    {rocks}
    {grass}
    <rect width="460" height="140" fill="#0b0e18" opacity="0.22"/>
    <line x1="0" y1="140" x2="460" y2="140" stroke="url(#gB)" stroke-width="1.5"/>

    {logo_svg}

    <text x="128" y="38" font-family="sans-serif" font-size="9" font-weight="700" letter-spacing="1.5" fill="#d4a72c" opacity="0.85">PLAYER IDENTIFICATION</text>
    <text x="128" y="70" class="t" font-size="22">{svg_name}</text>
    <text x="128" y="90" class="s">Level {lvl} • <tspan fill="{cfg['sec']}">{cfg['n']}</tspan></text>

    <g transform="translate(128, 100) scale(0.75)" opacity="{'1.0' if 'warrior' in db['classes_used'] else '0.2'}">{ic_class_war}</g>
    <g transform="translate(156, 100) scale(0.75)" opacity="{'1.0' if 'mage' in db['classes_used'] else '0.2'}">{ic_class_mag}</g>
    <g transform="translate(184, 100) scale(0.75)" opacity="{'1.0' if 'rogue' in db['classes_used'] else '0.2'}">{ic_class_rog}</g>
    <g transform="translate(212, 100) scale(0.75)" opacity="{'1.0' if 'healer' in db['classes_used'] else '0.2'}">{ic_class_hea}</g>

    <text x="18" y="162" font-family="sans-serif" font-size="11" fill="#fb7185" font-weight="bold">COMBAT &amp; EXPEDITION LOG</text>
    <rect x="16" y="172" width="208" height="46" rx="8" fill="url(#gC)" stroke="#4c1d2c"/><text x="26" y="188" class="l">TOTAL DMG</text><g transform="translate(26, 193) scale(0.8)">{ic_sw}</g><text x="50" y="207" class="v">{fmt(db['all_time_damage'])}</text>
    <rect x="236" y="172" width="208" height="46" rx="8" fill="url(#gC)" stroke="#4c1d2c"/><text x="246" y="188" class="l">WEEKLY DMG</text><g transform="translate(246, 193) scale(0.8)">{ic_sw}</g><text x="270" y="207" class="v">{fmt(db['weekly_damage'])}</text>
    <rect x="16" y="226" width="208" height="46" rx="8" fill="url(#gC)" stroke="#4c1d2c"/><text x="26" y="242" class="l">DAILY AVG DMG</text><g transform="translate(26, 247) scale(0.8)">{ic_ch}</g><text x="50" y="261" class="v">{fmt(avg_dmg)}/day</text>
    <rect x="236" y="226" width="208" height="46" rx="8" fill="url(#gC)" stroke="#4c1d2c"/><text x="246" y="242" class="l">PEAK DAILY RECORD</text><g transform="translate(246, 247) scale(0.8)">{ic_fr}</g><text x="270" y="261" class="v">{fmt(db['peak_daily_damage'])}</text>
    <rect x="16" y="280" width="208" height="46" rx="8" fill="url(#gC)" stroke="#4c1d2c"/><text x="26" y="296" class="l">BOSSES SLAIN</text><g transform="translate(26, 301) scale(0.8)">{ic_tr}</g><text x="50" y="315" class="v">{db['bosses_slain']}</text>
    <rect x="236" y="280" width="208" height="46" rx="8" fill="url(#gC)" stroke="#4c1d2c"/><text x="246" y="296" class="l">PEAK GOLD HOARDED</text><g transform="translate(246, 301) scale(0.8)">{ic_gd}</g><text x="270" y="315" class="v" fill="#fbbf24">{fmt(db['peak_gold'])} G</text>
    <rect x="16" y="334" width="428" height="36" rx="8" fill="url(#gC)" stroke="#4c1d2c"/>
    <g transform="translate(26, 344) scale(0.7)">{ic_sparkle}</g><text x="42" y="357" class="s">Buffs: <tspan class="v">{db['buffs_cast']}</tspan> Casts</text>
    <g transform="translate(190, 344) scale(0.7)">{ic_drop}</g><text x="206" y="357" class="s">Mana Spent: <tspan class="v">{fmt(db['total_mana_spent'])} MP</tspan></text>

    <text x="18" y="404" font-family="sans-serif" font-size="11" fill="#60a5fa" font-weight="bold">PRODUCTIVITY &amp; DISCIPLINE MATRIX</text>
    <text x="18" y="424" class="s">Dailies Today: <tspan class="v">{len(done)}/{len(due)} ({pct}%)</tspan></text>
    <rect x="16" y="432" width="428" height="11" rx="5.5" fill="#151b2e"/><rect x="16" y="432" width="{int(428*(pct/100))}" height="11" rx="5.5" fill="url(#gBar)"/>
    <rect x="16" y="451" width="428" height="34" rx="7" fill="url(#gP)" stroke="#1e293b"/>
    <g transform="translate(26, 460) scale(0.7)">{ic_thumb_up}</g><text x="42" y="472" class="s">Habit Mastery: <tspan class="v">{hratio}% Positive</tspan></text>
    <g transform="translate(280, 460) scale(0.7)">{ic_thumb_up}</g><text x="296" y="472" class="s">{up}</text>
    <g transform="translate(330, 460) scale(0.7)">{ic_thumb_down}</g><text x="346" y="472" class="s">{dn}</text>

    <rect x="16" y="493" width="101" height="46" rx="7" fill="#1f1610" stroke="#b45309"/><text x="22" y="509" class="l">HABITS TODAY</text><g transform="translate(22, 513) scale(0.75)">{ic_sp}</g><text x="44" y="528" class="v">{h_today}</text>
    <rect x="125" y="493" width="101" height="46" rx="7" fill="#0d1f18" stroke="#059669"/><text x="131" y="509" class="l">DAILIES TODAY</text><g transform="translate(131, 513) scale(0.75)">{ic_ck}</g><text x="153" y="528" class="v">{len(done)}</text>
    <rect x="234" y="493" width="101" height="46" rx="7" fill="#0f1f33" stroke="#0284c7"/><text x="240" y="509" class="l">TO-DOS TODAY</text><g transform="translate(240, 513) scale(0.75)">{ic_tg}</g><text x="262" y="528" class="v">{t_today}</text>
    <rect x="343" y="493" width="101" height="46" rx="7" fill="#241b0b" stroke="#ca8a04"/><text x="349" y="509" class="l">ALL COMPLETED</text><g transform="translate(349, 513) scale(0.75)">{ic_st}</g><text x="371" y="528" class="v" fill="#fbbf24">{fmt(g_total)}</text>

    <rect x="16" y="547" width="101" height="46" rx="7" fill="#0d2818" stroke="#16a34a"/><text x="22" y="563" class="l">HABITS POSITIF</text><g transform="translate(22, 567) scale(0.7)">{ic_thumb_up}</g><text x="40" y="581" class="v">{fmt(db['all_time_habits_pos'])}</text>
    <rect x="125" y="547" width="101" height="46" rx="7" fill="#2a0f14" stroke="#dc2626"/><text x="131" y="563" class="l">HABITS NEGATIF</text><g transform="translate(131, 567) scale(0.7)">{ic_thumb_down}</g><text x="149" y="581" class="v">{fmt(db['all_time_habits_neg'])}</text>

    <rect x="234" y="547" width="101" height="46" rx="7" fill="#2a1608" stroke="#ea580c"/><text x="240" y="563" class="l">DAILIES GAGAL</text><g transform="translate(240, 567) scale(0.75)">{ic_x}</g><text x="260" y="581" class="v">{dailies_gagal}</text>
    <rect x="343" y="547" width="101" height="46" rx="7" fill="#170f33" stroke="#7c3aed"/><text x="349" y="563" class="l">TODO BELUM</text><g transform="translate(349, 567) scale(0.7)">{ic_clip}</g><text x="367" y="581" class="v">{t_active}</text>

    <rect x="16" y="601" width="208" height="46" rx="8" fill="url(#gP)" stroke="#1e293b"/><text x="26" y="617" class="l">BOUNTY BOARD</text><g transform="translate(26, 622) scale(0.8)">{ic_tg}</g><text x="50" y="636" class="v">{t_active} Open / {t_cleared} Done</text>
    <rect x="236" y="601" width="208" height="46" rx="8" fill="url(#gP)" stroke="#1e293b"/><text x="246" y="617" class="l">DISCIPLINE FLAME</text><g transform="translate(246, 622) scale(0.8)">{ic_fr}</g><text x="270" y="636" class="v">{streak} Days Streak</text>

    <rect x="16" y="655" width="428" height="130" rx="8" fill="url(#gT5H)" stroke="#06b6d4"/><text x="28" y="675" font-family="sans-serif" font-size="11" font-weight="bold" fill="#22d3ee">TOP 5 HABITS (HARI INI)</text>{h5daily_str}
    <rect x="16" y="793" width="428" height="130" rx="8" fill="url(#gT5V)" stroke="#a855f7"/><text x="28" y="813" font-family="sans-serif" font-size="11" font-weight="bold" fill="#c084fc">TOP 5 HABITS (3 HARI TERAKHIR)</text>{h53day_str}

    <rect x="16" y="931" width="428" height="92" rx="8" fill="url(#gNeg)" stroke="#dc2626"/><text x="28" y="951" font-family="sans-serif" font-size="11" font-weight="bold" fill="#f87171">TOP 3 HABITS NEGATIF (MINGGUAN)</text>{hneg_str}

    <rect x="16" y="1031" width="208" height="140" rx="8" fill="url(#gH)" stroke="#f59e0b"/><text x="28" y="1051" font-family="sans-serif" font-size="10.5" font-weight="bold" fill="#fbbf24">TOP 5 HABITS (MINGGUAN)</text>{h_str}
    <rect x="236" y="1031" width="208" height="140" rx="8" fill="url(#gD)" stroke="#10b981"/><text x="248" y="1051" font-family="sans-serif" font-size="10.5" font-weight="bold" fill="#34d399">TOP 5 DAILIES (MINGGUAN)</text>{d_str}

    <rect x="16" y="1179" width="208" height="140" rx="8" fill="url(#gT5M)" stroke="#6366f1"/><text x="28" y="1199" font-family="sans-serif" font-size="10.5" font-weight="bold" fill="#818cf8">TOP 5 HABITS (BULANAN)</text>{hmonth_str}

    <rect x="236" y="1179" width="208" height="140" rx="8" fill="url(#gP)" stroke="#1e293b"/>
    <text x="248" y="1199" font-family="sans-serif" font-size="10.5" font-weight="bold" fill="#cbd5e1" letter-spacing="0.5">IDLE HABITS</text>
    <g transform="translate(248, 1212) scale(0.85)">{ic_moon}</g><text x="270" y="1227" font-family="sans-serif" font-size="11.5px" fill="#cbd5e1">Yesterday</text>
    <text x="270" y="1244" class="v">{idle_yesterday_count}<tspan font-family="sans-serif" font-size="11.5px" fill="#cbd5e1"> / {total_habits_count} habits</tspan></text>
    <line x1="246" y1="1256" x2="442" y2="1256" stroke="#334155" stroke-width="1"/>
    <g transform="translate(248, 1263) scale(0.85)">{ic_calendar}</g><text x="270" y="1278" font-family="sans-serif" font-size="11.5px" fill="#cbd5e1">This Week</text>
    <text x="270" y="1295" class="v">{habits_untouched_week}<tspan font-family="sans-serif" font-size="11.5px" fill="#cbd5e1"> ({idle_week_pct}%)</tspan></text>

    <rect x="16" y="{QUOTE_Y}" width="428" height="{quote_box_h}" rx="9" fill="url(#gI)" stroke="url(#gB)"/>
    <text x="28" y="{QUOTE_Y+23}" font-family="sans-serif" font-size="11" font-weight="bold" fill="#facc15">SCROLL OF INSIGHT</text>
    <text x="28" y="{QUOTE_Y+45}" font-family="Georgia, serif" font-size="12" font-style="italic" fill="#e2e8f0">{quote_tspans}</text>
  </g>
  <rect width="{canvas_w}" height="{canvas_h}" rx="18" fill="none" stroke="url(#gB)" stroke-width="3.5"/>
</svg>"""

    save_db(db)
    return svg


# ==========================================
# HANDLER VERCEL (WAJIB persis pola ini)
# ==========================================
class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            svg = generate_svg()
            self.send_response(200)
            self.send_header('Content-type', 'image/svg+xml')
            self.send_header('Cache-Control', 'no-store, max-age=0')
            self.end_headers()
            self.wfile.write(svg.encode('utf-8'))
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-type', 'text/plain')
            self.end_headers()
            self.wfile.write(f"Error generating stats: {e}".encode('utf-8'))
        return
