const fs = require('fs');
const os = require('os');
const path = require('path');

const configDir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'robot-voice-hook');
const historyPath = process.env.ROBOT_VOICE_HISTORY_PATH || path.join(configDir, 'recent-phrases.json');
const limit = 24;
const window = 8;

function normalize(phrase) {
  return String(phrase || '').toLowerCase().replace(/^🤖\s*/, '').replace(/\s+/g, ' ').trim();
}

function recent(kind) {
  return entries().filter((entry) => !kind || entry.kind === kind).map((entry) => entry.phrase);
}

function entries() {
  try {
    const value = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    return Array.isArray(value) ? value.map((entry) => typeof entry === 'string' ? { phrase: entry } : entry).filter((entry) => entry && entry.phrase).slice(-limit) : [];
  } catch { return []; }
}

function context(payload, includePrompt = false) {
  const value = (keys) => keys.map((key) => payload?.[key]).find((item) => typeof item === 'string' && item);
  const result = {};
  const sessionId = value(['session_id', 'sessionId', 'conversation_id', 'conversationId']);
  const requestId = value(['request_id', 'requestId', 'turn_id', 'turnId']);
  if (sessionId) result.session_id = sessionId;
  if (requestId) result.request_id = requestId;
  if (includePrompt && typeof payload?.prompt === 'string') result.prompt = payload.prompt.replace(/\s+/g, ' ').trim().slice(0, 240);
  return result;
}

function remember(kind, phrase, metadata = {}) {
  const value = entries();
  value.push({ kind, phrase, ...metadata, at: new Date().toISOString() });
  try {
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.writeFileSync(`${historyPath}.tmp`, JSON.stringify(value.slice(-limit), null, 2) + '\n');
    fs.renameSync(`${historyPath}.tmp`, historyPath);
  } catch {}
}

// История общая на старт и финиш, поэтому окно берётся по своему виду реплики: иначе
// длинная серия финальных фраз вытесняет стартовые и выбор схлопывается в одну-две.
// Выбор случайный: «первый свободный кандидат» даёт всегда одну и ту же фразу.
function pick(candidates, kind) {
  const used = new Set(recent(kind).slice(-window).map(normalize));
  const free = candidates.filter((phrase) => !used.has(normalize(phrase)));
  const pool = free.length ? free : candidates;
  return pool[Math.floor(Math.random() * pool.length)];
}

module.exports = { context, pick, recent, remember };
