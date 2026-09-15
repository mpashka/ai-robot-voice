const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const bin = process.env.ROBOT_VOICE_CLAUDE_BIN || 'claude';
const maxBytes = 33554432;
const maxWords = 18;
const agentTailChars = 4000;

// Дочерний claude запускается с --setting-sources '' и пустым --mcp-config: без этого
// он поднял бы наши же хуки (бесконечная рекурсия) и весь системный промпт с описаниями
// инструментов — 24k токенов и шесть секунд вместо двух сотен токенов и двух секунд.
const flags = [
  '--system-prompt', 'Ты классификатор. Отвечай одной строкой JSON, без пояснений и markdown.',
  '--exclude-dynamic-system-prompt-sections',
  '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--setting-sources', '',
  '--tools', '',
  '--no-session-persistence',
];

function clean(text) {
  return String(text || '')
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Настоящий запрос пользователя отличается от записи с результатом инструмента полем
// promptSource: у type:"user" оба вида, и в длинной сессии сорок tool_result вытесняют
// пару реальных запросов. Поэтому предфильтр по подстроке, а не по хвосту файла.
function userTexts(raw, limit) {
  const result = [];
  const lines = raw.split('\n');
  let turns = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (!line.includes('"promptSource"')) continue;
    let entry;
    try { entry = JSON.parse(line.trim()); } catch { continue; }
    if (entry.type !== 'user' || entry.isMeta) continue;
    turns += 1;
    if (result.length >= limit) continue;
    const content = entry.message?.content;
    const text = clean(typeof content === 'string'
      ? content
      : Array.isArray(content) ? content.filter((block) => block?.type === 'text').map((block) => block.text).join(' ') : '');
    if (!text || text.startsWith('Caveat:')) continue;
    result.push(text.slice(0, 200));
  }
  return { turns, previous: result.reverse() };
}

// Короткий запрос вроде «готов» или «второй» — ответ на вопрос агента, и без этого вопроса
// классификатор принимает его за бессмыслицу. Берётся хвост: вопрос стоит в конце ответа.
// Поиск останавливается на предыдущем запросе пользователя — раньше него ответ уже не к
// текущему запросу. Claude Code пишет блок текста записью type:"assistant", Codex — записью
// response_item с role:"assistant".
function lastAgentText(raw) {
  const lines = raw.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (line.includes('"promptSource"')) return '';
    if (!line.includes('"assistant"')) continue;
    let entry;
    try { entry = JSON.parse(line.trim()); } catch { continue; }
    const content = entry.type === 'assistant'
      ? entry.message?.content
      : entry.payload?.role === 'assistant' ? entry.payload.content : null;
    if (!Array.isArray(content)) continue;
    const text = clean(content
      .filter((block) => block?.type === 'text' || block?.type === 'output_text')
      .map((block) => block.text)
      .join(' '));
    if (text) return text.slice(-agentTailChars);
  }
  return '';
}

// Размер контекста берётся не из размера файла, а из usage последнего ответа модели: это
// настоящее число токенов, которое ушло в окно, а килобайты стенограммы с ним связаны слабо.
function contextTokens(raw) {
  const lines = raw.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (!line.includes('"usage"')) continue;
    let entry;
    try { entry = JSON.parse(line.trim()); } catch { continue; }
    const usage = entry.message?.usage;
    if (!usage) continue;
    return (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  }
  return 0;
}

// Метка сжатия контекста у Claude Code — запись subtype compact_boundary, у Codex — запись
// type compacted. Подстрока только отбирает кандидатов: те же слова встречаются и в тексте
// переписки, поэтому запись подтверждается разбором.
function compactions(raw) {
  let count = 0;
  for (const line of raw.split('\n')) {
    if (!line.includes('"compact_boundary"') && !line.includes('"compacted"')) continue;
    try {
      const entry = JSON.parse(line.trim());
      if (entry.subtype === 'compact_boundary' || entry.type === 'compacted') count += 1;
    } catch {}
  }
  return count;
}

// Файл читается целиком: 500 КБ разбираются за пару миллисекунд, а запросы пользователя
// в длинной сессии лежат в начале. Хвост берётся только у аномально разросшихся стенограмм.
function transcript(transcriptPath) {
  const facts = { kb: 0, turns: 0, tokens: 0, compactions: 0, previous: [], agent: '' };
  if (!transcriptPath) return facts;
  try {
    const { size } = fs.statSync(transcriptPath);
    facts.kb = Math.round(size / 1024);
    const start = size > maxBytes ? size - maxBytes : 0;
    const buffer = Buffer.alloc(size - start);
    const handle = fs.openSync(transcriptPath, 'r');
    try { fs.readSync(handle, buffer, 0, buffer.length, start); } finally { fs.closeSync(handle); }
    const raw = buffer.toString('utf8');
    Object.assign(facts, userTexts(raw, 3));
    facts.agent = lastAgentText(raw);
    facts.tokens = contextTokens(raw);
    facts.compactions = compactions(raw);
  } catch {}
  return facts;
}

function parse(output) {
  const match = String(output || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  let value;
  try { value = JSON.parse(match[0]); } catch { return null; }
  const phrase = clean(value.phrase);
  if (!phrase || phrase.length > 240) return null;
  // Классификатор изредка выдаёт абзац вместо реплики. Оценки при этом остаются верными,
  // поэтому длинная фраза не отменяет анализ — её заменяет фраза из таблицы.
  // Тире и прочая пунктуация отдельными токенами словами не считаются: иначе реплика
  // ровно нужной длины бракуется из-за одного «—» и молча уходит в откат.
  const usable = phrase.split(' ').filter((token) => /[\p{L}\p{N}]/u.test(token)).length <= maxWords;
  const score = (raw) => {
    const number = Math.round(Number(raw));
    return Number.isFinite(number) ? Math.min(3, Math.max(0, number)) : null;
  };
  const clarity = score(value.clarity);
  const complexity = score(value.complexity);
  if (clarity === null || complexity === null) return null;
  return { clarity, complexity, signal: clean(value.signal).slice(0, 120), phrase: usable ? phrase : '' };
}

// Стенограмма разбирается вызывающим и передаётся готовой: она нужна и для оценки размера
// контекста, а полтора мегабайта читать дважды за один ход незачем.
function analyze(options) {
  const facts = options.facts;
  const request = [
    options.style,
    options.rules,
    `Уровень мата: ${options.level}.`,
    options.avoid.length ? `Не повторяй эти недавние реплики и близкие к ним: ${options.avoid.map((phrase) => `«${phrase}»`).join('; ')}` : '',
    '--- Контекст ---',
    `Рабочий каталог: ${path.basename(options.cwd || '') || 'неизвестен'}`,
    `Сессия: запросов до этого ${facts.turns}, стенограмма ${facts.kb} КБ.`,
    facts.previous.length
      ? `Предыдущие запросы пользователя в этой сессии:\n${facts.previous.map((text) => `- ${text}`).join('\n')}`
      : 'Это первый запрос в сессии, предыдущего контекста нет.',
    facts.agent ? `Последнее сообщение агента, на которое отвечает пользователь (конец):\n${facts.agent}` : '',
    '--- Текущий запрос ---',
    String(options.prompt || '').slice(0, 2000),
    'Верни строго одну строку JSON и ничего больше: {"clarity":<0-3>,"complexity":<0-3>,"signal":"…","phrase":"…"}',
  ].filter(Boolean).join('\n\n');

  const run = spawnSync(bin, ['-p', '--model', options.model, ...flags, request], {
    encoding: 'utf8',
    timeout: options.timeoutMs,
    cwd: os.tmpdir(),
    env: { ...process.env, MAX_THINKING_TOKENS: '0' },
    maxBuffer: 1024 * 1024,
  });
  // Откат происходит молча, поэтому причину брака иначе не увидеть: хук пишет в stdout
  // строгий JSON протокола, и отладочный вывод может идти только в stderr.
  if (process.env.ROBOT_VOICE_RAW === '1') {
    process.stderr.write(`[robot-voice] status=${run.status} error=${run.error || 'нет'}\n[robot-voice] ответ: ${String(run.stdout || '').trim()}\n`);
  }
  // Гонка «классификатор против таймера» — это и есть timeout у spawnSync: чей результат
  // раньше, тот и берётся. Проигрыш по таймеру отличается от прочих отказов кодом ETIMEDOUT,
  // и отличать их важно: таймаут чинится настройкой, а остальное — нет.
  if (run.error) return { ok: false, failure: run.error.code === 'ETIMEDOUT' ? 'timeout' : 'unavailable' };
  if (run.status !== 0) return { ok: false, failure: 'unavailable' };
  const parsed = parse(run.stdout);
  return parsed ? { ok: true, ...parsed } : { ok: false, failure: 'garbage' };
}

module.exports = { analyze, transcript };
