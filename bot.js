// bot.js
// Versi final: reminder + laporan kerja dengan time-presets (inline buttons) + CRUD
import TelegramBot from "node-telegram-bot-api";
import Database from "better-sqlite3";
import * as chrono from "chrono-node";
import schedule from "node-schedule";
import moment from "moment-timezone";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- CONFIG ----------
const TOKEN = process.env.TELEGRAM_TOKEN;
const DB_FILE = process.env.DATABASE_FILE || path.join(__dirname, "notes.db");
const TIMEZONE = process.env.TIMEZONE || "Asia/Makassar";

if (!TOKEN) {
  console.error("TELEGRAM_TOKEN belum diatur di .env");
  process.exit(1);
}
moment.tz.setDefault(TIMEZONE);

// ---------- INIT BOT & DB ----------
const bot = new TelegramBot(TOKEN, { polling: true });
const db = new Database(DB_FILE);

// buat tabel jika belum ada
db.exec(`
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  reminder_at TEXT,
  reminded INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  completion TEXT,
  report_time TEXT,
  receive_time TEXT,
  done_time TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

// prepared statements
const insertNoteStmt = db.prepare(
  "INSERT INTO notes (chat_id, text, reminder_at) VALUES (?, ?, ?)"
);
const getNotesByChatStmt = db.prepare(
  "SELECT * FROM notes WHERE chat_id = ? ORDER BY created_at DESC"
);
const getNoteByIdStmt = db.prepare(
  "SELECT * FROM notes WHERE id = ? AND chat_id = ?"
);
const deleteNoteByIdStmt = db.prepare(
  "DELETE FROM notes WHERE id = ? AND chat_id = ?"
);
const updateNoteTextStmt = db.prepare(
  "UPDATE notes SET text = ? WHERE id = ? AND chat_id = ?"
);
const updateNoteReminderStmt = db.prepare(
  "UPDATE notes SET reminder_at = ?, reminded = 0 WHERE id = ? AND chat_id = ?"
);
const updateNoteStatusStmt = db.prepare(
  "UPDATE notes SET status = ? WHERE id = ? AND chat_id = ?"
);

const insertReportStmt = db.prepare(
  `INSERT INTO reports (chat_id, title, completion, report_time, receive_time, done_time, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const getReportsByChatStmt = db.prepare(
  "SELECT * FROM reports WHERE chat_id = ? ORDER BY report_time DESC"
);
const getReportByIdStmt = db.prepare(
  "SELECT * FROM reports WHERE id = ? AND chat_id = ?"
);
const deleteReportByIdStmt = db.prepare(
  "DELETE FROM reports WHERE id = ? AND chat_id = ?"
);
const updateReportStmt = db.prepare(
  `UPDATE reports SET title = ?, completion = ?, report_time = ?, receive_time = ?, done_time = ?, notes = ? WHERE id = ? AND chat_id = ?`
);

// ---------- SCHEDULER ----------
const scheduledJobs = new Map();

function scheduleNoteJob(note) {
  if (!note || !note.reminder_at) return;
  const id = note.id;
  const when = moment.tz(note.reminder_at, TIMEZONE);
  if (!when.isValid()) return;
  if (when.isBefore(moment.tz(TIMEZONE))) return; // skip past

  // cancel existing
  if (scheduledJobs.has(id)) {
    try {
      scheduledJobs.get(id).cancel();
    } catch {}
    scheduledJobs.delete(id);
  }

  const job = schedule.scheduleJob(when.toDate(), async () => {
    try {
      await bot.sendMessage(note.chat_id, `🔔 *Pengingat:* ${note.text}`, {
        parse_mode: "Markdown",
      });
      db.prepare("UPDATE notes SET reminded = 1 WHERE id = ?").run(id);
    } catch (e) {
      console.error("Gagal mengirim reminder:", e);
    }
    scheduledJobs.delete(id);
  });
  scheduledJobs.set(id, job);
}

// schedule existing on startup
const existing = db
  .prepare("SELECT * FROM notes WHERE reminder_at IS NOT NULL AND reminded = 0")
  .all();
for (const n of existing) scheduleNoteJob(n);

// ---------- STATE MANAGEMENT (per chat) ----------
const userState = new Map(); // chatId -> { mode, step, data }
const stateTimeouts = new Map();

function setState(chatId, stateObj) {
  userState.set(chatId, stateObj);
  // reset timeout
  if (stateTimeouts.has(chatId)) clearTimeout(stateTimeouts.get(chatId));
  const t = setTimeout(() => {
    userState.delete(chatId);
    stateTimeouts.delete(chatId);
    bot.sendMessage(
      chatId,
      "⏰ Sesi kadaluarsa (2 menit). Kembali ke menu utama."
    );
    showMainMenu(chatId);
  }, 2 * 60 * 1000);
  stateTimeouts.set(chatId, t);
}
function clearState(chatId) {
  userState.delete(chatId);
  if (stateTimeouts.has(chatId)) {
    clearTimeout(stateTimeouts.get(chatId));
    stateTimeouts.delete(chatId);
  }
}

// ---------- TIME HELPERS & PARSING ----------

// Normalisasi frasa Indonesia untuk chrono
function normalizeIndo(text) {
  let t = String(text || "").toLowerCase();
  t = t
    .replace(/\bbesok\b/g, "tomorrow")
    .replace(/\blusa\b/g, "day after tomorrow")
    .replace(/\bnanti malam\b/g, "tonight")
    .replace(/\bpagi\b/g, "morning")
    .replace(/\bsiang\b/g, "noon")
    .replace(/\bsore\b/g, "afternoon")
    .replace(/\bmalam\b/g, "evening")
    .replace(/\bminggu depan\b/g, "next week")
    .replace(/\bhari ini\b/g, "today")
    .replace(/\bsebentar\b/g, "later")
    .replace(/\bnanti\b/g, "later")
    .replace(/\bpukul\s*(\d{1,2})([:.](\d{2}))?/g, "at $1:$3")
    .replace(/\bjam\s*(\d{1,2})([:.](\d{2}))?/g, "at $1:$3")
    .replace(/\s+/g, " ")
    .replace(/:undefined/g, "");
  return t.trim();
}

// ekstraksi jam/menit manual (fix minute parsing)
function extractHourPreferToday(text) {
  const re =
    /(pukul|jam)\s*(\d{1,2})([:.](\d{2}))?\s*(pagi|siang|sore|malam|am|pm)?/i;
  const m = text.match(re);
  if (!m) return null;
  let hour = Number(m[2]);
  const minute = m[4] ? Number(m[4]) : 0; // m[4] already captures digits without colon
  const meridiem = (m[5] || "").toLowerCase();

  if (meridiem) {
    if (meridiem === "pagi" && hour === 12) hour = 0;
    else if (
      (meridiem === "siang" || meridiem === "sore" || meridiem === "malam") &&
      hour < 12
    )
      hour += 12;
    else if (meridiem === "pm" && hour < 12) hour += 12;
    else if (meridiem === "am" && hour === 12) hour = 0;
  }

  const candidate = moment
    .tz(TIMEZONE)
    .hour(hour)
    .minute(minute)
    .second(0)
    .millisecond(0);
  return candidate;
}

// Parser untuk reminders: prefer today unless user explicitly said "hari ini" and time passed -> ask
function parseIndoPrefer(text) {
  const now = moment.tz(TIMEZONE);
  const manual = extractHourPreferToday(text);
  const containsHariIni = /\bhari ini\b/i.test(text) || /\btoday\b/i.test(text);

  if (manual) {
    if (manual.isAfter(now)) return manual;
    if (containsHariIni) {
      // user said "hari ini" but time already passed -> signal to ask
      return { error: "time_passed_today", candidate: manual };
    }
    // otherwise assume next day
    return manual.add(1, "day");
  }

  // try normalized chrono
  const normalized = normalizeIndo(text);
  let parsed = null;
  try {
    parsed = chrono.parseDate(normalized, now.toDate(), { forwardDate: true });
  } catch (e) {
    parsed = null;
  }
  if (parsed) {
    let m = moment(parsed).tz(TIMEZONE);
    if (m.isBefore(now) && !/tomorrow|besok|lusa/i.test(text)) {
      m = m.add(1, "day");
    }
    return m;
  }

  // fallback raw chrono
  try {
    parsed = chrono.parseDate(text, now.toDate(), { forwardDate: true });
  } catch (e) {
    parsed = null;
  }
  if (parsed) return moment(parsed).tz(TIMEZONE);
  return null;
}

// parse custom typed timestamp (YYYY-MM-DD HH:mm) or try chrono
function parseCustomTimestamp(input) {
  const s = input.trim();
  // try strict format
  const strict = moment.tz(s, "YYYY-MM-DD HH:mm", true, TIMEZONE);
  if (strict.isValid()) return strict;
  // try chrono natural
  const chronoParsed = chrono.parseDate(s, moment.tz(TIMEZONE).toDate(), {
    forwardDate: false,
  });
  if (chronoParsed) return moment(chronoParsed).tz(TIMEZONE);
  return null;
}

function fmt(m) {
  return moment(m).tz(TIMEZONE).format("dddd, DD MMM YYYY HH:mm");
}
function fmtShortISO(m) {
  return moment(m).tz(TIMEZONE).format("YYYY-MM-DD HH:mm");
}

// ---------- UI / MENU ----------
function showMainMenu(chatId) {
  const keyboard = [
    ["🕰️ Catat Pengingat", "🧾 Laporan Kerja Harian"],
    ["🕓 Cek Waktu Bot", "📜 Lihat Pengingat"],
    ["📥 Lihat Laporan", "📅 Lihat Laporan (range)"],
    ["🗑️ Hapus Pengingat", "✏️ Edit Pengingat"],
    ["✅ Tandai Selesai", "✏️ Edit Laporan", "🗑️ Hapus Laporan"],
    ["🏠 Kembali ke Menu Utama"],
  ];
  bot.sendMessage(chatId, "Silahkan Mulai Proses :", {
    reply_markup: { keyboard, resize_keyboard: true },
  });
}

// ---------- HELPERS untuk inline time presets ----------
function timePresetKeyboard(prefixField) {
  // prefixField: 'report_time' | 'receive_time' | 'done_time' and we use it in callback_data
  return {
    inline_keyboard: [
      [
        { text: "Sekarang", callback_data: `preset|${prefixField}|now` },
        {
          text: "Hari Ini 08:00",
          callback_data: `preset|${prefixField}|today_08`,
        },
      ],
      [
        {
          text: "Hari Ini 13:00",
          callback_data: `preset|${prefixField}|today_13`,
        },
        {
          text: "Besok 08:00",
          callback_data: `preset|${prefixField}|tomorrow_08`,
        },
      ],
      [
        {
          text: "Custom (ketik manual)",
          callback_data: `preset|${prefixField}|custom`,
        },
      ],
    ],
  };
}

function computePresetDatetime(tag) {
  const now = moment.tz(TIMEZONE);
  if (tag === "now") return now.clone();
  if (tag === "today_08")
    return now.clone().hour(8).minute(0).second(0).millisecond(0);
  if (tag === "today_13")
    return now.clone().hour(13).minute(0).second(0).millisecond(0);
  if (tag === "tomorrow_08")
    return now.clone().add(1, "day").hour(8).minute(0).second(0).millisecond(0);
  return null;
}

// ---------- COMMANDS ----------

bot.onText(/\/start|\/menu/, (msg) => showMainMenu(msg.chat.id));

bot.onText(/\/timecheck/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `🕒 Waktu bot sekarang (${TIMEZONE}): ${moment
      .tz(TIMEZONE)
      .format("dddd, DD MMMM YYYY HH:mm:ss")}`
  );
});

bot.onText(/\/list/, (msg) => {
  const chatId = msg.chat.id;
  const rows = getNotesByChatStmt.all(chatId);
  if (!rows.length) return bot.sendMessage(chatId, "Belum ada pengingat.");
  let s = "📋 *Pengingat:*\n";
  rows.forEach((r) => {
    s += `\n#${r.id} • ${r.text}\n   ⏰ ${
      r.reminder_at
        ? moment(r.reminder_at).tz(TIMEZONE).format("DD MMM YYYY HH:mm")
        : "tanpa waktu"
    }\n`;
  });
  bot.sendMessage(chatId, s, { parse_mode: "Markdown" });
});

bot.onText(/\/done\s+(\d+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const id = Number(match[1]);
  const note = getNoteByIdStmt.get(id, chatId);

  if (!note)
    return bot.sendMessage(chatId, `Pengingat #${id} tidak ditemukan.`);
  if (note.status === "done")
    return bot.sendMessage(chatId, `Pengingat #${id} sudah ditandai selesai.`);
  updateNoteStatusStmt.run("done", id, chatId);
  bot.sendMessage(chatId, `✅ Pengingat #${id} ditandai selesai.`);
});

// lihat laporan biasa
bot.onText(/\/laporan|\/reports/, (msg) => {
  const chatId = msg.chat.id;
  const rows = getReportsByChatStmt.all(chatId);
  if (!rows.length) return bot.sendMessage(chatId, "Belum ada laporan.");

  let s = "🗂️ *Laporan:*
});
  rows.forEach((r) => {
    s += `#${r.id} - ${r.title}\n`;
    s += `🕒 ${r.report_time ? moment(r.report_time).tz(TIMEZONE).format("YYYY-MM-DD HH:mm") : "-"}, `;
    s += `📥 ${r.receive_time ? moment(r.receive_time).tz(TIMEZONE).format("YYYY-MM-DD HH:mm") : "-"}, `;
    s += `✅ ${r.done_time ? moment(r.done_time).tz(TIMEZONE).format("YYYY-MM-DD HH:mm") : "-"}\n`;
  });
  bot.sendMessage(chatId, s, { parse_mode: "Markdown" });

// range filter
bot.onText(
  /\/laporan_range\s+(\d{4}-\d{2}-\d{2})\s+(\d{4}-\d{2}-\d{2})/,
  (msg, match) => {
    const chatId = msg.chat.id;
    const from = moment
      .tz(match[1], "YYYY-MM-DD", TIMEZONE)
      .startOf("day")
      .toISOString();
    const to = moment
      .tz(match[2], "YYYY-MM-DD", TIMEZONE)
      .endOf("day")
      .toISOString();
    const rows = db
      .prepare(
        "SELECT * FROM reports WHERE chat_id = ? AND report_time BETWEEN ? AND ? ORDER BY report_time ASC"
      )
      .all(chatId, from, to);
    if (!rows.length)
      return bot.sendMessage(
        chatId,
        `Tidak ada laporan antara ${match[1]} dan ${match[2]}.`
      );
    let s = `🗂️ Laporan dari ${match[1]} sampai ${match[2]}:\n`;
    for (const r of rows) {
      s += `#${r.id} - ${r.title}\n`;
      s += `🕒 ${r.report_time ? moment(r.report_time).tz(TIMEZONE).format("YYYY-MM-DD HH:mm") : "-"}, `;
      s += `📥 ${r.receive_time ? moment(r.receive_time).tz(TIMEZONE).format("YYYY-MM-DD HH:mm") : "-"}, `;
      s += `✅ ${r.done_time ? moment(r.done_time).tz(TIMEZONE).format("YYYY-MM-DD HH:mm") : "-"}\n`;
    }
    bot.sendMessage(chatId, s);
  }
);

// delete command (notes or reports)
bot.onText(/\/delete\s+(\d+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const id = Number(match[1]);
  const note = getNoteByIdStmt.get(id, chatId);
  if (note) {
    deleteNoteByIdStmt.run(id, chatId);
    if (scheduledJobs.has(id)) {
      try {
        scheduledJobs.get(id).cancel();
      } catch {}
      scheduledJobs.delete(id);
    }
    bot.sendMessage(chatId, `✅ Pengingat #${id} dihapus.`);
    return;
  }
  const rep = getReportByIdStmt.get(id, chatId);
  if (rep) {
    deleteReportByIdStmt.run(id, chatId);
    bot.sendMessage(chatId, `✅ Laporan #${id} dihapus.`);
    return;
  }
  bot.sendMessage(chatId, `ID ${id} tidak ditemukan.`);
});

// edit report start
bot.onText(/\/edit_report\s+(\d+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const id = Number(match[1]);
  const rep = getReportByIdStmt.get(id, chatId);
  if (!rep) return bot.sendMessage(chatId, `Laporan #${id} tidak ditemukan.`);
  // prepare state to edit report in multi-step (reuse create flow)
  setState(chatId, {
    mode: "edit_report",
    id,
    step: 1,
    data: {
      title: rep.title,
      completion: rep.completion,
      report_time: rep.report_time,
      receive_time: rep.receive_time,
      done_time: rep.done_time,
      notes: rep.notes,
    },
  });
  bot.sendMessage(
    chatId,
    `Mengedit Laporan #${id}. Kirim judul baru (atau ketik - untuk tetap):`
  );
});

// edit note text
bot.onText(/\/edit\s+(\d+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const id = Number(match[1]);
  const note = getNoteByIdStmt.get(id, chatId);
  if (!note)
    return bot.sendMessage(chatId, `Pengingat #${id} tidak ditemukan.`);
  setState(chatId, { mode: "edit_note_text", id });
  bot.sendMessage(
    chatId,
    `Kirim teks baru untuk pengingat #${id} (sebelumnya: "${note.text}")`
  );
});

// edit note time
bot.onText(/\/edit_time\s+(\d+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const id = Number(match[1]);
  const note = getNoteByIdStmt.get(id, chatId);
  if (!note)
    return bot.sendMessage(chatId, `Pengingat #${id} tidak ditemukan.`);
  setState(chatId, { mode: "edit_note_time", id });
  bot.sendMessage(
    chatId,
    `Kirim waktu baru untuk pengingat #${id} (contoh: 'besok jam 9 pagi' atau pilih dari tombol saat diminta)`
  );
});

// ---------- INTERACTIVE FLOWS (messages) ----------
bot.on("message", async (msg) => {
  if (!msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  // if state exists, handle it first
  if (userState.has(chatId)) {
    const st = userState.get(chatId);

    // EDIT NOTE TEXT
    if (st.mode === "edit_note_text") {
      updateNoteTextStmt.run(text, st.id, chatId);
      clearState(chatId);
      bot.sendMessage(chatId, `✅ Teks pengingat #${st.id} diperbarui.`);
      return showMainMenu(chatId);
    }

    // EDIT NOTE TIME
    if (st.mode === "edit_note_time") {
      const parsed = parseIndoPrefer(text);
      if (parsed && parsed.error === "time_passed_today") {
        return bot.sendMessage(
          chatId,
          "Waktu yang kamu berikan untuk *hari ini* sudah lewat. Ketik 'besok' atau kirim waktu baru.",
          { parse_mode: "Markdown" }
        );
      }
      if (!parsed || parsed.error)
        return bot.sendMessage(
          chatId,
          "Waktu tidak dikenali. Contoh: 'besok jam 9 pagi' atau '2025-10-20 14:30'."
        );
      updateNoteReminderStmt.run(parsed.toISOString(), st.id, chatId);
      scheduleNoteJob(getNoteByIdStmt.get(st.id, chatId));
      clearState(chatId);
      bot.sendMessage(
        chatId,
        `✅ Waktu pengingat #${st.id} diperbarui: ${fmt(parsed)}`
      );
      return showMainMenu(chatId);
    }

    // CREATE REMINDER flow
    if (st.mode === "create_reminder") {
      if (st.step === 1) {
        // got note text
        st.text = text;
        st.step = 2;
        setState(chatId, st);
        return bot.sendMessage(
          chatId,
          "Kapan saya harus mengingatkan? (ketik natural seperti 'besok jam 9 pagi' atau tekan tombol waktu jika muncul)"
        );
      } else if (st.step === 2) {
        const parsed = parseIndoPrefer(text);
        if (parsed && parsed.error === "time_passed_today") {
          // confirm next day
          setState(chatId, {
            mode: "confirm_next_for_reminder",
            text: st.text,
            candidate: parsed.candidate.format("HH:mm"),
          });
          return bot.sendMessage(
            chatId,
            `Waktu hari ini (${parsed.candidate.format(
              "HH:mm"
            )}) sudah lewat. Jadwalkan besok jam yang sama? (ketik 'ya' untuk besok atau kirim waktu baru)`
          );
        }
        if (!parsed || parsed.error)
          return bot.sendMessage(
            chatId,
            "Waktu tidak dikenali. Coba contoh: 'besok jam 9 pagi' atau '2025-10-21 08:00'."
          );
        const res = insertNoteStmt.run(chatId, st.text, parsed.toISOString());
        const id = res.lastInsertRowid;
        scheduleNoteJob(getNoteByIdStmt.get(id, chatId));
        clearState(chatId);
        bot.sendMessage(
          chatId,
          `✅ Pengingat disimpan (#${id}) pada ${fmt(parsed)}`
        );
        return showMainMenu(chatId);
      }
    }

    // confirm next for reminder
    if (st.mode === "confirm_next_for_reminder") {
      if (/^y(es|a)?$/i.test(text) || text.toLowerCase() === "ya") {
        const hhmm = st.candidate;
        const [hh, mm] = hhmm.split(":").map((n) => Number(n));
        const dt = moment
          .tz(TIMEZONE)
          .add(1, "day")
          .hour(hh)
          .minute(mm)
          .second(0)
          .millisecond(0);
        const res = insertNoteStmt.run(chatId, st.text, dt.toISOString());
        const id = res.lastInsertRowid;
        scheduleNoteJob(getNoteByIdStmt.get(id, chatId));
        clearState(chatId);
        bot.sendMessage(chatId, `✅ Dijadwalkan besok ${fmt(dt)} (ID: ${id}).`);
        return showMainMenu(chatId);
      } else {
        // let user send new time -> go back to create_reminder step2
        setState(chatId, { mode: "create_reminder", step: 2, text: st.text });
        return bot.sendMessage(
          chatId,
          "Oke, kirim waktu baru (contoh: 'besok jam 9 pagi' atau '2025-10-21 08:00'):"
        );
      }
    }

    // awaiting time for pending note (after "ingat ...")
    if (st.mode === "await_time_for_note") {
      const parsed = parseIndoPrefer(text);
      if (!parsed || parsed.error)
        return bot.sendMessage(
          chatId,
          "Waktu tidak dikenali. Coba contoh: 'besok jam 9 pagi'."
        );
      updateNoteReminderStmt.run(parsed.toISOString(), st.id, chatId);
      scheduleNoteJob(getNoteByIdStmt.get(st.id, chatId));
      bot.sendMessage(chatId, `✅ Pengingat #${st.id} diset ke ${fmt(parsed)}`);
      clearState(chatId);
      return showMainMenu(chatId);
    }

    // ==== CREATE REPORT FLOW (with presets) ====
    if (st.mode === "create_report") {
      const d = st.data;
      // step 1: title
      if (st.step === 1) {
        d.title = text;
        st.step = 2;
        setState(chatId, st);
        return bot.sendMessage(chatId, "Bagaimana penyelesaiannya?");
      }
      // step 2: completion
      if (st.step === 2) {
        d.completion = text;
        st.step = 3;
        setState(chatId, st);
        // ask for report_time with inline presets
        await bot.sendMessage(
          chatId,
          "Pilih Tanggal & Jam Laporan atau ketik custom:",
          { reply_markup: timePresetKeyboard("report_time") }
        );
        return;
      }
      // step 3: unreachable here because we expect callback for preset or custom; but accept manual too
      if (st.step === 3) {
        // user typed manual datetime -> parse custom
        const parsed = parseCustomTimestamp(text);
        if (!parsed)
          return bot.sendMessage(
            chatId,
            "Tanggal/jam tidak dikenali. Ketik format `YYYY-MM-DD HH:mm` atau pilih dari tombol."
          );
        d.report_time = parsed.toISOString();
        st.step = 4;
        setState(chatId, st);
        await bot.sendMessage(
          chatId,
          "Pilih Tanggal & Jam Terima atau ketik custom:",
          { reply_markup: timePresetKeyboard("receive_time") }
        );
        return;
      }
      // step 4: receive_time
      if (st.step === 4) {
        const parsed = parseCustomTimestamp(text);
        if (!parsed)
          return bot.sendMessage(
            chatId,
            "Tanggal/jam tidak dikenali. Ketik format `YYYY-MM-DD HH:mm` atau pilih dari tombol."
          );
        d.receive_time = parsed.toISOString();
        st.step = 5;
        setState(chatId, st);
        await bot.sendMessage(
          chatId,
          "Pilih Tanggal & Jam Selesai atau ketik custom:",
          { reply_markup: timePresetKeyboard("done_time") }
        );
        return;
      }
      // step 5: done_time
      if (st.step === 5) {
        const parsed = parseCustomTimestamp(text);
        if (!parsed)
          return bot.sendMessage(
            chatId,
            "Tanggal/jam tidak dikenali. Ketik format `YYYY-MM-DD HH:mm` atau pilih dari tombol."
          );
        d.done_time = parsed.toISOString();
        st.step = 6;
        setState(chatId, st);
        return bot.sendMessage(
          chatId,
          "Tambahkan catatan tambahan (boleh kosong):"
        );
      }
      // step 6: notes -> show preview with inline confirm
      if (st.step === 6) {
        d.notes = text || "-";
        const preview = `
📋 *Preview Laporan*
🧾 Judul: ${d.title}
⚙️ Penyelesaian: ${d.completion}
🕒 Tanggal Laporan: ${
          d.report_time
            ? moment(d.report_time).tz(TIMEZONE).format("DD MMM YYYY HH:mm")
            : "-"
        }
📥 Diterima: ${
          d.receive_time
            ? moment(d.receive_time).tz(TIMEZONE).format("DD MMM YYYY HH:mm")
            : "-"
        }
✅ Selesai: ${
          d.done_time
            ? moment(d.done_time).tz(TIMEZONE).format("DD MMM YYYY HH:mm")
            : "-"
        }
📝 Catatan: ${d.notes}

Simpan laporan ini?
        `;
        await bot.sendMessage(chatId, preview, {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Simpan", callback_data: "report_confirm_save" },
                { text: "❌ Batal", callback_data: "report_confirm_cancel" },
              ],
            ],
          },
        });
        st.step = 7;
        setState(chatId, st);
        return;
      }
    } // end create_report

    // ==== EDIT REPORT FLOW ====
    if (st.mode === "edit_report") {
      const d = st.data;
      if (st.step === 1) {
        if (text !== "-") d.title = text;
        st.step = 2;
        setState(chatId, st);
        return bot.sendMessage(
          chatId,
          "Kirim penyelesaian baru (atau - untuk tetap):"
        );
      }
      if (st.step === 2) {
        if (text !== "-") d.completion = text;
        st.step = 3;
        setState(chatId, st);
        return bot.sendMessage(
          chatId,
          "Kirim Tanggal & Jam Laporan (ketik 'skip' untuk tetap) atau pilih dari tombol:",
          { reply_markup: timePresetKeyboard("edit_report_time") }
        );
      }
      if (st.step === 3) {
        if (text.toLowerCase() !== "skip" && text !== "-") {
          const parsed = parseCustomTimestamp(text);
          if (!parsed)
            return bot.sendMessage(
              chatId,
              "Tanggal/jam tidak dikenali. Ketik `YYYY-MM-DD HH:mm` atau pilih tombol."
            );
          d.report_time = parsed.toISOString();
        }
        st.step = 4;
        setState(chatId, st);
        return bot.sendMessage(
          chatId,
          "Kirim Tanggal & Jam Terima (atau 'skip'):",
          { reply_markup: timePresetKeyboard("edit_receive_time") }
        );
      }
      if (st.step === 4) {
        if (text.toLowerCase() !== "skip" && text !== "-") {
          const parsed = parseCustomTimestamp(text);
          if (!parsed)
            return bot.sendMessage(chatId, "Tanggal/jam tidak dikenali.");
          d.receive_time = parsed.toISOString();
        }
        st.step = 5;
        setState(chatId, st);
        return bot.sendMessage(
          chatId,
          "Kirim Tanggal & Jam Selesai (atau 'skip'):",
          { reply_markup: timePresetKeyboard("edit_done_time") }
        );
      }
      if (st.step === 5) {
        if (text.toLowerCase() !== "skip" && text !== "-") {
          const parsed = parseCustomTimestamp(text);
          if (!parsed)
            return bot.sendMessage(chatId, "Tanggal/jam tidak dikenali.");
          d.done_time = parsed.toISOString();
        }
        st.step = 6;
        setState(chatId, st);
        return bot.sendMessage(
          chatId,
          "Kirim catatan baru (atau - untuk tetap):"
        );
      }
      if (st.step === 6) {
        if (text !== "-") d.notes = text;
        await updateReportStmt.run(
          d.title,
          d.completion,
          d.report_time,
          d.receive_time,
          d.done_time,
          d.notes,
          st.id,
          chatId
        );
        clearState(chatId);
        bot.sendMessage(chatId, `✅ Laporan #${st.id} diperbarui.`);
        return showMainMenu(chatId);
      }
    } // end edit_report
  } // end if state exists

  // not in a running state -> handle menu keyboard
  const lower = text.toLowerCase();

  if (lower === "🕰️ catat pengingat".toLowerCase()) {
    setState(chatId, { mode: "create_reminder", step: 1 });
    return bot.sendMessage(
      chatId,
      "Ketik isi pengingat (contoh: 'Beli tinta printer'):"
    );
  }

  if (lower === "🕓 cek waktu bot".toLowerCase()) {
    return bot.sendMessage(
      chatId,
      `🕒 Waktu bot sekarang: ${moment
        .tz(TIMEZONE)
        .format("dddd, DD MMMM YYYY HH:mm:ss")}`
    );
  }

  if (lower === "📜 lihat pengingat".toLowerCase()) {
    const rows = getNotesByChatStmt.all(chatId);
    if (!rows.length) return bot.sendMessage(chatId, "Tidak ada pengingat.");
    let s = "📋 *Pengingat:*\n";
    rows.forEach((r) => {
      s += `\n#${r.id} • ${r.text}\n   ⏰ ${
        r.reminder_at
          ? moment(r.reminder_at).tz(TIMEZONE).format("DD MMM YYYY HH:mm")
          : "tanpa waktu"
      }\n   📌 Status: ${r.status === "done" ? "✅ Selesai" : "⏳ Pending"}\n`;
    });
    return bot.sendMessage(chatId, s, { parse_mode: "Markdown" });
  }

  if (lower === "🧾 laporan kerja harian".toLowerCase()) {
    setState(chatId, { mode: "create_report", step: 1, data: {} });
    return bot.sendMessage(chatId, "Masukkan *judul laporan*:", {
      parse_mode: "Markdown",
    });
  }

  if (lower === "📥 lihat laporan".toLowerCase()) {
    const rows = getReportsByChatStmt.all(chatId);
    if (!rows.length) return bot.sendMessage(chatId, "Belum ada laporan.");

    let s = "🗂️ *Laporan:*\n";
    s +=
      "ID | Judul | Laporan | Terima | Selesai\n" +
      "---|-------|---------|--------|--------\n";

    rows.forEach((r) => {
      s += `${r.id} | ${r.title} | ${
        r.report_time
          ? moment(r.report_time).tz(TIMEZONE).format("DD/MM HH:mm")
          : "-"
      } | ${
        r.receive_time
          ? moment(r.receive_time).tz(TIMEZONE).format("DD/MM HH:mm")
          : "-"
      } | ${
        r.done_time
          ? moment(r.done_time).tz(TIMEZONE).format("DD/MM HH:mm")
          : "-"
      }\n`;
    });

    return bot.sendMessage(chatId, s, { parse_mode: "Markdown" });
  }

  if (lower === "📅 lihat laporan (range)".toLowerCase()) {
    return bot.sendMessage(
      chatId,
      "Gunakan perintah: /laporan_range YYYY-MM-DD YYYY-MM-DD"
    );
  }

  if (lower === "🗑️ hapus pengingat".toLowerCase()) {
    const rows = getNotesByChatStmt.all(chatId);
    if (!rows.length)
      return bot.sendMessage(chatId, "Tidak ada pengingat untuk dihapus.");
    let s = "Ketik /delete <id> untuk menghapus. Daftar pengingat:\n";
    rows.forEach(
      (r) =>
        (s += `#${r.id} • ${r.text} — ${
          r.reminder_at
            ? moment(r.reminder_at).tz(TIMEZONE).format("DD/MM HH:mm")
            : "tanpa waktu"
        }\n`)
    );
    return bot.sendMessage(chatId, s);
  }

  if (lower === "✏️ edit pengingat".toLowerCase()) {
    const rows = getNotesByChatStmt.all(chatId);
    if (!rows.length)
      return bot.sendMessage(chatId, "Tidak ada pengingat untuk diedit.");
    let s = "Gunakan /edit <id> atau /edit_time <id>. Daftar:\n";
    rows.forEach(
      (r) =>
        (s += `#${r.id} • ${r.text} — ${
          r.reminder_at
            ? moment(r.reminder_at).tz(TIMEZONE).format("DD/MM HH:mm")
            : "tanpa waktu"
        }\n`)
    );
    return bot.sendMessage(chatId, s);
  }

  if (lower === "✏️ edit laporan".toLowerCase()) {
    const rows = getReportsByChatStmt.all(chatId);
    if (!rows.length)
      return bot.sendMessage(chatId, "Tidak ada laporan untuk diedit.");
    let s = "Gunakan /edit_report <id> untuk mengedit. Daftar:\n";
    rows.forEach(
      (r) =>
        (s += `#${r.id} • ${r.title} — ${
          r.report_time
            ? moment(r.report_time).tz(TIMEZONE).format("DD/MM HH:mm")
            : "-"
        }\n`)
    );
    return bot.sendMessage(chatId, s);
  }

  if (lower === "🗑️ hapus laporan".toLowerCase()) {
    const rows = getReportsByChatStmt.all(chatId);
    if (!rows.length)
      return bot.sendMessage(chatId, "Tidak ada laporan untuk dihapus.");
    let s = "Ketik /delete <id> untuk menghapus laporan. Daftar:\n";
    rows.forEach(
      (r) =>
        (s += `#${r.id} • ${r.title} — ${
          r.report_time
            ? moment(r.report_time).tz(TIMEZONE).format("DD/MM HH:mm")
            : "-"
        }\n`)
    );
    return bot.sendMessage(chatId, s);
  }

  if (lower === "🏠 kembali ke menu utama".toLowerCase()) {
    clearState(chatId);
    if (userState.has(chatId)) {
      userState.delete(chatId);
    }

    bot.sendMessage(chatId, "Kembali ke menu utama. Semua form dibatalkan.");
    return showMainMenu(chatId);
  }

  // natural "ingatkan ..." fallback
  if (/^(ingatkan|ingat|tolong ingatkan|remind)/i.test(text)) {
    const noteText = text
      .replace(/^(ingatkan|ingat|tolong ingatkan)( saya| aku)?/i, "")
      .trim();
    if (!noteText) return bot.sendMessage(chatId, "Tentang apa pengingatnya?");
    const parsed = parseIndoPrefer(text);
    if (parsed && parsed.error === "time_passed_today") {
      const res = insertNoteStmt.run(chatId, noteText, null);
      setState(chatId, {
        mode: "confirm_next_for_reminder",
        id: res.lastInsertRowid,
        text: noteText,
        candidate: parsed.candidate.format("HH:mm"),
      });
      return bot.sendMessage(
        chatId,
        `Waktu 'hari ini' yang kamu sebut sudah lewat. Mau jadwalkan besok jam yang sama? (ketik 'ya' untuk besok atau kirim waktu baru)`
      );
    }
    if (!parsed) {
      const res = insertNoteStmt.run(chatId, noteText, null);
      setState(chatId, {
        mode: "await_time_for_note",
        id: res.lastInsertRowid,
      });
      return bot.sendMessage(
        chatId,
        `Catatan disimpan sementara (#${res.lastInsertRowid}). Kapan saya harus mengingatkan?`
      );
    }
    const res = insertNoteStmt.run(chatId, noteText, parsed.toISOString());
    const id = res.lastInsertRowid;
    scheduleNoteJob(getNoteByIdStmt.get(id, chatId));
    bot.sendMessage(
      chatId,
      `✅ Pengingat disimpan (#${id}) pada ${fmt(parsed)}`
    );
    return showMainMenu(chatId);
  }

  // fallback
  return bot.sendMessage(
    chatId,
    "Saya belum mengerti. Gunakan /menu atau pilih tombol pada keyboard."
  );
});

// ---------- CALLBACKS (inline buttons) ----------
bot.on("callback_query", async (query) => {
  const data = query.data || "";
  const chatId = query.message.chat.id;
  // presets: format: preset|field|tag
  if (data.startsWith("preset|")) {
    const parts = data.split("|");
    const field = parts[1]; // e.g. report_time / receive_time / done_time / edit_report_time ...
    const tag = parts[2];
    const st = userState.get(chatId);
    // determine which flow based on state
    if (!st) {
      bot.answerCallbackQuery(query.id, { text: "Tidak ada sesi aktif." });
      return;
    }

    // handle custom selection -> prompt user to type
    if (tag === "custom") {
      // set awaiting custom for this field
      st.awaiting_custom = field;
      setState(chatId, st);
      bot.sendMessage(
        chatId,
        `Ketik tanggal & jam untuk *${field.replace(
          "_",
          " "
        )}* dalam format \`YYYY-MM-DD HH:mm\` atau natural.`,
        { parse_mode: "Markdown" }
      );
      bot.answerCallbackQuery(query.id);
      return;
    }

    // compute preset datetime
    const dt = computePresetDatetime(tag);
    if (!dt) {
      bot.answerCallbackQuery(query.id, { text: "Preset tidak valid." });
      return;
    }

    // Now set into appropriate state data depending on st.mode
    if (st.mode === "create_report") {
      const d = st.data;
      if (field === "report_time") {
        d.report_time = dt.toISOString();
        st.step = 4; // next: receive_time
        setState(chatId, st);
        await bot.sendMessage(
          chatId,
          `✔️ Tanggal & Jam Laporan di-set: ${fmt(
            dt
          )}\nSelanjutnya: pilih Tanggal & Jam Terima`,
          { reply_markup: timePresetKeyboard("receive_time") }
        );
        bot.answerCallbackQuery(query.id);
        return;
      }
      if (field === "receive_time") {
        d.receive_time = dt.toISOString();
        st.step = 5;
        setState(chatId, st);
        await bot.sendMessage(
          chatId,
          `✔️ Tanggal & Jam Terima di-set: ${fmt(
            dt
          )}\nSelanjutnya: pilih Tanggal & Jam Selesai`,
          { reply_markup: timePresetKeyboard("done_time") }
        );
        bot.answerCallbackQuery(query.id);
        return;
      }
      if (field === "done_time") {
        d.done_time = dt.toISOString();
        st.step = 6;
        setState(chatId, st);
        await bot.sendMessage(
          chatId,
          `✔️ Tanggal & Jam Selesai di-set: ${fmt(
            dt
          )}\nSilakan kirim catatan tambahan (atau - untuk kosong).`
        );
        bot.answerCallbackQuery(query.id);
        return;
      }
    }

    // edit flows
    if (st.mode === "edit_report") {
      const d = st.data;
      // map edit_* field names to real fields
      if (field === "edit_report_time") {
        d.report_time = dt.toISOString();
        st.step = 4;
        setState(chatId, st);
        await bot.sendMessage(
          chatId,
          `✔️ Tanggal & Jam Laporan di-set: ${fmt(
            dt
          )}\nSelanjutnya kirim Tanggal & Jam Terima (atau pilih tombol)`,
          { reply_markup: timePresetKeyboard("edit_receive_time") }
        );
        bot.answerCallbackQuery(query.id);
        return;
      }
      if (field === "edit_receive_time") {
        d.receive_time = dt.toISOString();
        st.step = 5;
        setState(chatId, st);
        await bot.sendMessage(
          chatId,
          `✔️ Tanggal & Jam Terima di-set: ${fmt(
            dt
          )}\nSelanjutnya kirim Tanggal & Jam Selesai (atau pilih tombol)`,
          { reply_markup: timePresetKeyboard("edit_done_time") }
        );
        bot.answerCallbackQuery(query.id);
        return;
      }
      if (field === "edit_done_time") {
        d.done_time = dt.toISOString();
        st.step = 6;
        setState(chatId, st);
        await bot.sendMessage(
          chatId,
          `✔️ Tanggal & Jam Selesai di-set: ${fmt(
            dt
          )}\nKirim catatan baru (atau - untuk tetap).`
        );
        bot.answerCallbackQuery(query.id);
        return;
      }
    }

    // presets while editing report_time field names used in create as well
    // if st.mode is something else, ignore
    bot.answerCallbackQuery(query.id, { text: "Preset diterima." });
    return;
  }

  // report preview confirm/cancel
  if (data === "report_confirm_save") {
    const st = userState.get(chatId);
    if (!st || st.mode !== "create_report" || st.step !== 7) {
      bot.answerCallbackQuery(query.id, {
        text: "Tidak ada laporan untuk disimpan.",
      });
      return;
    }
    const d = st.data;
    const res = insertReportStmt.run(
      chatId,
      d.title,
      d.completion,
      d.report_time,
      d.receive_time,
      d.done_time,
      d.notes
    );
    bot.sendMessage(
      chatId,
      `✅ Laporan tersimpan (ID: ${res.lastInsertRowid}).`
    );
    clearState(chatId);
    showMainMenu(chatId);
    bot.answerCallbackQuery(query.id, { text: "Disimpan" });
    return;
  }
  if (data === "report_confirm_cancel") {
    clearState(chatId);
    bot.sendMessage(chatId, "❌ Simpan laporan dibatalkan.");
    showMainMenu(chatId);
    bot.answerCallbackQuery(query.id, { text: "Dibatalkan" });
    return;
  }

  // default
  bot.answerCallbackQuery(query.id).catch(() => {});
});

// ---------- Graceful shutdown ----------
process.on("SIGINT", () => {
  for (const job of scheduledJobs.values()) {
    try {
      job.cancel();
    } catch {}
  }
  process.exit();
});

console.log(
  `🤖 Bot berjalan (timezone: ${TIMEZONE}) — siap menerima perintah.`
);
