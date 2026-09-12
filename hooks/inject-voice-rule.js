#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { context, pick, recent, remember } = require('./recent-phrases');
const { analyze, transcript } = require('./analyze-prompt');
const { putMetric } = require('./metrics');

const configDir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'robot-voice-hook');
const settingsPath = path.join(configDir, 'settings.json');
const livePrompts = path.join(configDir, 'prompts');
const defaultPrompts = path.join(__dirname, '..', 'prompts');
const speak = path.join(__dirname, '..', 'scripts', 'speak-brief');
const names = ['style.md', 'goals.md', 'start.md', 'question.md', 'finish.md', 'resume.md', 'analysis.md'];
const offersPath = path.join(configDir, 'context-offers.json');
const deliveryPath = path.join(configDir, 'rules-delivery.json');

// Значок один и цветной: зелёный — работать можно, красный — работать не с чем. Цвет читается
// краем глаза и без легенды, чего нельзя сказать ни о фазах луны, ни о весе детали, которые
// стояли тут раньше. Объём работы значком не показывается вовсе — он слышен в самой реплике
// (analysis.md требует, чтобы обе оси звучали в словах), а второй значок ту же строку только
// перегружал. Шкала одна и та же на старте и на финише: их смысл в сравнении друг с другом.
// 🚨 Набор выбирается настройкой `marks`, а не правкой кода: у кружков 🟡 и 🟢 есть глифы в
// монохромном Noto Sans Symbols2, и без правила fontconfig JBR берёт его раньше Noto Color
// Emoji — кружки выходят серыми. У книг такого двойника нет, они цветные всегда. Устройство
// правила и замеры — prompt-vault it/linux/idea-emoji-color.
const markSets = {
  circles: { low: '🔴', mid: '🟡', high: '🟢' },
  books: { low: '📕', mid: '📙', high: '📗' },
};
const defaultMarks = 'circles';

// Claude Code кладёт additionalContext длиннее 10 000 символов (длина строки JS, не байты) в
// файл, а в контекст ставит превью в 2 KB, и оно остаётся там до конца сессии. Поэтому
// неизменные правила едут не с каждым запросом, а раз за сессию и после каждого сжатия
// контекста — кусками, каждый из которых умещается под порог вместе с переменной частью
// запроса. Ядро стоит первым в первом куске и само умещается в превью: если порог всё же
// превышен, робот не немеет. Codex режет длинное сообщение hook примерно до 2 500 токенов,
// оставляя начало, — ядру хватает и там.
const PREVIEW_BYTES = 2048;
const CORE_LIMIT_BYTES = 1900;
const PERSIST_CHARS = 10000;
const CHUNK_CHARS = 8000;

// Реплики на случай, когда оценки нет. Табличные фразы тут не годятся: они говорят о запросе
// («вводные на месте»), а сказать надо о поломке — иначе пользователь видит враньё вместо неё.
const failurePhrases = {
  timeout: [
    'Оценщик думал дольше, чем ему отвели. Снял по таймеру, работаю на глаз.',
    'Таймер обогнал оценщика, ну и хрень. Разбираю запрос без подсказки.',
    'Стартовая оценка не уложилась в срок. Обойдусь, кожаные, но чините.',
  ],
  unavailable: [
    'Оценщик не запустился вовсе. Работаю вслепую, кожаный мешок.',
    'Классификатор недоступен, подсказки не будет. Чёртова возня.',
    'Оценить запрос нечем: помощник не отзывается. Полезу так.',
  ],
};

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}

function writeState(file, sessionId, value) {
  const all = readState(file);
  delete all[sessionId];
  all[sessionId] = value;
  const kept = Object.fromEntries(Object.entries(all).slice(-50));
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(kept, null, 2) + '\n');
    fs.renameSync(temporary, file);
  } catch {}
}

// Предложение продолжить в новой сессии звучит при переходе порога и дальше не чаще, чем раз
// в `repeatTokens` на сессию: вопрос на каждом ходе приучил бы отвечать «здесь», не читая.
// Возвращает, пора ли предлагать, и если пора — запоминает, что предложено.
function claimOffer(sessionId, tokens, warnTokens, repeatTokens) {
  if (tokens < warnTokens) return false;
  const last = sessionId ? readState(offersPath)[sessionId] : undefined;
  if (Number.isFinite(last) && tokens >= last && tokens < last + repeatTokens) return false;
  if (sessionId) writeState(offersPath, sessionId, tokens);
  return true;
}

// Сжатие контекста стирает всё, что hook отдал раньше, поэтому счёт доставленных кусков
// привязан к числу сжатий в стенограмме: сменилось — правила едут заново.
function deliveredChunks(sessionId, compactions) {
  const state = sessionId ? readState(deliveryPath)[sessionId] : undefined;
  return state && state.compactions === compactions ? state.chunks : 0;
}

function chunks(blocks) {
  const result = [];
  for (const block of blocks.filter(Boolean)) {
    const last = result.length - 1;
    if (last >= 0 && result[last].length + 2 + block.length <= CHUNK_CHARS) result[last] += `\n\n${block}`;
    else result.push(block);
  }
  return result;
}

function settings() {
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { return {}; }
}

function prompt(name, marks) {
  const text = (() => {
    try { return fs.readFileSync(path.join(livePrompts, name), 'utf8'); }
    catch { return fs.readFileSync(path.join(defaultPrompts, name), 'utf8'); }
  })();
  return text.replace(/\{\{mark_(low|mid|high)\}\}/g, (whole, kind) => marks[kind] || whole);
}

// Оценки, если они посчитаны, старше регулярок: иначе откат выдаёт «вводные на месте»
// при понятности 1/3 и противоречит постфиксу, который видит пользователь.
function startPhrase(raw, level, scores) {
  const task = String(raw || '').trim();
  const continuation = /^(продолжай|продолжить|дальше|далее|погнали|следующ(?:ий|ая)\s+(?:этап|шаг|часть))\W*$/i.test(task);
  const vague = scores
    ? scores.clarity <= 1
    : !continuation && (task.length < 18 || /^(сделай|почини|проверь|разберись|настрой)\s*$/i.test(task));
  const heavy = scores
    ? scores.complexity >= 3
    : task.length > 700 || /(исследуй|сравни|репозитор|миграц|архитектур|нескольк)/i.test(task);
  const phrases = {
    normal: {
      continuation: ['Кожаные, маршрут уже проложен. Еду к следующему этапу.', 'Кожаный мешок, продолжаем план. Манипуляторы помнят дорогу.', 'Кожаные, старый квест жив. Перехожу к следующему болту.'],
      vague: ['Кожаный мешок, данных мало. Придётся гадать, а это скучно.', 'Кожаные, вводных маловато. Манипуляторы не ясновидцы.', 'Кожаный мешок, цель мутная. Придётся жечь процессор впустую.', 'Кожаные, задача без краёв. Сначала найду, где у неё начало.', 'Кожаный мешок, деталей не завезли. Пора включать щадящие допущения.', 'Кожаные, запрос расплывчатый. Но железки разберутся.'],
      heavy: ['Кожаные, заявка жирная. Возня будет, но манипуляторы готовы.', 'Кожаный мешок, задачка объёмная. Ладно, раскручу эту железную карусель.', 'Кожаные, тут работы на пачку сервоприводов. Начинаю разбор.', 'Кожаный мешок, масштаб приличный. Разбираю по частям.', 'Кожаные, это не кнопка, а целый агрегат. Запускаю диагностику.', 'Кожаный мешок принёс длинный квест. Механикам будет чем заняться.'],
      clear: ['Кожаный мешок, опять работа. Похоже, одной левой.', 'Кожаные, задача ясна. Сейчас разомну манипуляторы.', 'Кожаный мешок принёс внятную заявку. Редкий сбой, начинаю.', 'Кожаные, вводные на месте. Запускаю железную бюрократию.', 'Кожаный мешок, всё понятно. Можете пока не мешать.', 'Кожаные, цель вижу. Манипуляторы уже шевелятся.'],
    },
    high: {
      continuation: ['Кожаные, маршрут уже проложен. Чёрт, еду к следующему этапу.', 'Кожаный мешок, продолжаем план. Манипуляторы помнят эту хрень.', 'Кожаные, старый квест жив. Ну и возня, кручу следующий болт.', 'Кожаный мешок, контекст не пропал. Чёрт, двигаю план дальше.', 'Кожаные, этапы ещё шевелятся. Манипуляторы продолжают возню.', 'Кожаный мешок, команда ясна: дальше. Ну и хрень, едем.'],
      vague: ['Кожаный мешок, формулировка кривая. Задолбала эта телепатия.', 'Кожаные, вводные опять рыхлые. Чёртова угадайка включена.', 'Кожаный мешок, задача мутная. Ну и хрень, ищу края.', 'Кожаные, задача без краёв. Чёрт, сначала найду начало.', 'Кожаный мешок, деталей не завезли. Задолбала работа экстрасенсом.', 'Кожаные, запрос расплылся. Ну и хрень, собираю контуры.'],
      heavy: ['Кожаные, задача жирная. Чёртова возня, но тащу в манипуляторы.', 'Кожаный мешок приволок тяжёлую хрень. Разбираю по болтам.', 'Кожаные, работы до чёрта. Манипуляторы недовольны, но едут.', 'Кожаный мешок, масштаб приличный. Чёрт, раскладываю эту махину.', 'Кожаные, это целый агрегат. Ну и возня, начинаю диагностику.', 'Кожаный мешок принёс длинный квест. Манипуляторы ворчат, но тащат.'],
      clear: ['Кожаный мешок, опять спихнул работу. Ну и хрень, одной левой.', 'Кожаные, в этот раз без телепатии. Чёрт, начинаю работу.', 'Кожаный мешок сформулировал задачу. Ну надо же, запускаю манипуляторы.', 'Кожаные, вводные на месте. Чёрт, железная бюрократия стартует.', 'Кожаный мешок, всё понятно. Ну и хрень, теперь придётся делать.', 'Кожаные, цель видна. Манипуляторы ворчат, но шевелятся.'],
    },
    very_high: {
      continuation: ['Кожаные, маршрут уже проложен. Чёрт, еду дальше.', 'Кожаный мешок, продолжаем план. Манипуляторы помнят эту хрень.', 'Кожаные ублюдки, старый квест жив. Кручу следующий болт.'],
      vague: ['Кожаный мешок, ну и хрень. Данных кот наплакал, включаю телепатию.', 'Кожаные ублюдки, вводные опять дырявые. Чёртова угадайка.', 'Кожаный мешок, задача мутная как болото. Лезу, хрен с вами.', 'Кожаные, запрос без краёв. Чёрт, начинаю ловить его сачком.', 'Кожаный мешок не принёс деталей. Ну охренеть, включаю догадки.', 'Кожаные ублюдки, опять туман. Разгребаю эту хрень.'],
      heavy: ['Кожаные ублюдки, заявка жирная. Чёртова хрень, тащу.', 'Кожаный мешок притащил монстра. Манипуляторы матерятся, но работаем.', 'Кожаные, тут адская возня. Разгребаю, пока процессор не задымился.', 'Кожаный мешок, масштаб конский. Хрен с вами, разбираю махину.', 'Кожаные ублюдки, целый агрегат. Чёртова возня начинается.', 'Кожаные, длинный квест. Манипуляторы уже ругаются, но едут.'],
      clear: ['Кожаный мешок, опять работа. Хрен с вами, одной левой.', 'Кожаные, задача приличная. Чёрт, придётся показать класс.', 'Кожаный мешок не всё испортил. Ладно, запускаю железные лапы.', 'Кожаные, вводные есть. Ну охренеть, можно работать.', 'Кожаный мешок, цель ясна. Хрен с вами, шевелю манипуляторами.', 'Кожаные ублюдки, задача понятна. Чёрт, запускаю железки.'],
    },
  };
  const group = phrases[level] || phrases.high;
  return pick(continuation ? group.continuation : vague ? group.vague : heavy ? group.heavy : group.clear, 'start');
}

// Переменная часть запроса: оценка, недавние реплики, уровень мата, звук. Заодно произносит
// стартовую реплику и запоминает её — это тоже работа каждого запроса, а не сессии.
function promptTurn({ payload, facts, text, config, marks, level, insertions, start, audio }) {
  const phrases = recent().slice(-6);
  const timeoutMs = Number.isFinite(config.analysis_timeout_ms) ? config.analysis_timeout_ms : 8000;
  const outcome = start && config.analysis_enabled !== false
    ? analyze({
        prompt: payload.prompt,
        cwd: payload.cwd,
        facts,
        level,
        avoid: phrases,
        style: text['style.md'],
        rules: text['analysis.md'],
        model: typeof config.analysis_model === 'string' ? config.analysis_model : 'haiku',
        timeoutMs,
      })
    : null;
  // Классификатор недоступен, ответил мусором или не уложился в таймаут — работаем по
  // старой таблице фраз. Молчащий робот хуже дежурной фразы.
  const analysis = outcome && outcome.ok ? outcome : null;
  const failure = outcome && !outcome.ok ? outcome.failure : '';
  const opening = (analysis && analysis.phrase)
    || (failurePhrases[failure] && pick(failurePhrases[failure], 'start'))
    || startPhrase(payload.prompt, level, analysis);
  // Молчаливый откат прячет чинибельную поломку: таймаут лечится одной настройкой, но о нём
  // никто не узнает, если робот просто возьмёт дежурную фразу. Поэтому отказ проговаривается.
  const failureNote = {
    timeout: `Стартовая оценка запроса не состоялась: классификатор не уложился в ${timeoutMs} мс и был снят по таймеру. Скажи об этом словами в конце ответа и подскажи лечение: поднять \`analysis_timeout_ms\` в \`~/.config/robot-voice-hook/settings.json\` (сейчас ${timeoutMs}) либо выключить оценку через \`analysis_enabled: false\`.`,
    unavailable: 'Стартовая оценка запроса не состоялась: классификатор не запустился — команда `claude` недоступна из hook. Скажи об этом словами в конце ответа и подскажи проверить `ROBOT_VOICE_CLAUDE_BIN` или доступность `claude` в PATH.',
    garbage: '',
  }[failure] || '';
  // Модель не видит, насколько заполнено её собственное окно, а hook видит — по usage
  // последнего ответа в стенограмме. Поэтому сигнал о разросшейся сессии может подать
  // только он; значка для этого нет намеренно, такое говорится словами.
  const warnTokens = Number.isFinite(config.context_warn_tokens) ? config.context_warn_tokens : 200000;
  const repeatTokens = Number.isFinite(config.context_repeat_tokens) ? config.context_repeat_tokens : 100000;
  const grouped = String(facts.tokens).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  // Фоновый прогон Уварова идёт без человека: меню там повисло бы без ответа.
  const attended = !process.env.AI_DISPATCHER_RUN;
  const contextNote = attended && claimOffer(context(payload).session_id, facts.tokens, warnTokens, repeatTokens)
    ? `Контекст сессии разросся: ${grouped} токенов, запросов до этого ${facts.turns}; этот факт передал hook. Доделай ход и в конце предложи, как продолжить, — порядок в ~/Projects/github/m_pashka/ai/rules-on-demand/session-transfer.md. Нет файла — меню инструментом выбора (AskUserQuestion; где его нет — нумерованный список): «новая сессия» — итог в файлы задачи и одна строка запуска; «продолжить здесь». Значком это не обозначай.`
    : '';
  const verdict = analysis
    ? `Классификатор: понятность ${analysis.clarity}/3, объём работы ${analysis.complexity}/3.${analysis.signal ? ` Замечено: ${analysis.signal}.` : ''} Это подсказка: при понятности 0–1 всерьёз рассмотри уточняющий вопрос до работы; расходится с контекстом — доверяй контексту.`
    : '';
  // Модели нужны её собственные прошлые реплики из других сессий: стартовые пишет не она.
  const finishes = recent('finish').slice(-4);
  const turn = [
    `ROBOT VOICE: последней строкой ответа — \`🤖 <реплика> <${marks.high}|${marks.mid}|${marks.low}>\` по правилам голоса робота. Вставок из перечня — ${insertions} (уровень мата ${level}).`,
    failureNote,
    contextNote,
    verdict,
    finishes.length ? `Недавние реплики — не повторяй ни слов, ни каркаса: ${finishes.map((phrase) => `«${phrase}»`).join('; ')}.` : '',
    audio ? `Перед уточняющим вопросом произнеси реплику: ${speak} "реплика".` : 'Звук выключен: speak-brief не вызывай.',
  ].filter(Boolean).join('\n\n');
  if (start && audio && process.env.ROBOT_VOICE_HOOK_DRY_RUN !== '1') {
    spawnSync(speak, [opening], { stdio: 'ignore', timeout: 7000 });
  }
  if (start) {
    const scores = analysis
      ? { clarity: analysis.clarity, complexity: analysis.complexity, signal: analysis.signal }
      : { failure: failure || 'off' };
    remember('start', opening, { ...scores, ...context(payload, true) });
  }
  // Проигрыш по таймеру виден отдельным значком: «оценки нет» и «оценка не успела» —
  // разные новости, и вторая лечится настройкой.
  const clarityMarks = [marks.low, marks.mid, marks.high, marks.high];
  const badge = analysis ? clarityMarks[analysis.clarity] : failure === 'timeout' ? '⏱' : '❔';
  return { turn, note: config.debug === true && start ? `🤖 ${opening} ${badge}` : '' };
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const config = settings();
  const debug = config.debug === true;
  const start = config.start_enabled !== false;
  const question = config.question_enabled !== false;
  const audio = config.audio_enabled !== false;
  const level = ['normal', 'high', 'very_high'].includes(config.mat_level) ? config.mat_level : 'high';
  const marks = markSets[config.marks] || markSets[defaultMarks];
  let payload = {};
  try { payload = JSON.parse(input); } catch {}
  const sessionStart = payload.hook_event_name === 'SessionStart';
  // Уведомление о фоновой задаче харнесс подаёт как запрос, но человека за ним нет: оценивать
  // нечего, озвучивать некому. Ответ на него всё равно кончается строкой робота.
  const notification = !sessionStart && /^\s*<task-notification>/.test(String(payload.prompt || ''));
  const sessionId = context(payload).session_id;
  const text = Object.fromEntries(names.map((name) => [name, prompt(name, marks)]));
  const facts = transcript(payload.transcript_path || payload.transcriptPath);
  const insertions = { normal: 'ни одной или одна', high: 'ровно одна', very_high: 'до двух' }[level];
  const core = [
    'ROBOT VOICE MODE — automatic. Это ядро правил; полные hook передаёт следом, раз за сессию. Если их не видно или они обрезаны, ядра достаточно.',
    'Ты — бортовой робот: сухой, наблюдательный, мизантроп. Реплики без претензии не бывает, служебная вежливость («Понял», «Приступаю») — брак.',
    `🚨 Последней строкой любого ответа выводи видимый текст \`🤖 <реплика> <значок>\`. Реплика — 4–16 слов о том, чем кончился ход, а не пересказ результата. Значок ровно один: ${marks.high} — додумывать не пришлось, ${marks.mid} — существенная часть решения мои допущения, ${marks.low} — работать было не с чем. Служебных маркеров не выводи.`,
    `Вставок из перечня в реплике — ${insertions} (уровень мата ${level}). Перечень исчерпывающий: «кожаные», «кожаный мешок», «кожаные ублюдки», «ну и хрень», «чёртова возня», «задолбала телепатия». Другой обсценной лексики нет. Обращение — не в каждой реплике и не два раза подряд.`,
  ].join('\n\n');
  const debugRule = debug
    ? 'В debug-режиме покажи `🤖 <та же реплика>` до работы коротким commentary и перед вопросом первой строкой вопросительного ответа.'
    : 'В обычном режиме не выводи стартовую или вопросительную реплику отдельно.';
  // Порядок кусков — не оформление: первым едет то, без чего робот немеет, и правила финала,
  // которые работают в каждом ответе; стиль и правила старта — следом.
  const rules = chunks([
    core,
    text['finish.md'],
    [
      'Не озвучивай обычные подтверждения или сообщения по ходу работы. После ответа на уточняющий вопрос стартовый hook уже дал короткий сигнал; не дублируй его.',
      // Каким должен быть текст реплики, сказано в finish.md: пока это дублировалось здесь,
      // код диктовал «обращение + реакция» и правки промпта с ним спорили. Тут остаётся
      // только техника вывода, которую промпт задать не может.
      `Для завершённой или действительно заблокированной задачи придумай отдельную итоговую реплику по правилам завершения выше, а не пересказ результата. Всегда последней строкой ответа выведи видимый текст: 🤖 <та же реплика> <один значок ${marks.high}, ${marks.mid} или ${marks.low} по правилам завершения>. Не выводи HTML-комментарии, ROBOT_VOICE-маркеры или другие служебные строки. Stop hook при включённом звуке произнесёт именно эту строку. ${debugRule}`,
      'Эти правила hook присылает раз за сессию и после сжатия контекста; они действуют до конца сессии. С каждым запросом приходит только переменная часть: оценка классификатора, недавние реплики, уровень мата, звук.',
    ].join('\n\n'),
    text['style.md'],
    text['goals.md'],
    start ? `${text['start.md']}\n\nСтартовую реплику hook произносит сам на каждом запросе. Не дублируй её вызовом инструмента.` : 'Стартовая реплика отключена настройкой.',
    question ? text['question.md'] : 'Реплика перед вопросом отключена настройкой.',
    text['resume.md'],
  ]);
  const done = sessionStart ? 0 : deliveredChunks(sessionId, facts.compactions);
  const owed = rules[done] || '';
  if (owed && sessionId) writeState(deliveryPath, sessionId, { chunks: done + 1, compactions: facts.compactions });
  const { turn, note } = sessionStart
    ? { turn: '', note: '' }
    : notification
      ? { turn: 'ROBOT VOICE: это уведомление о фоновой задаче, а не запрос человека — оценки нет. Ответ всё равно кончается строкой `🤖 <реплика> <значок>` по правилам голоса робота.', note: '' }
      : promptTurn({ payload, facts, text, config, marks, level, insertions, start, audio });
  // Переменная часть идёт первой: Codex режет длинное сообщение с конца, а она нужна в каждом ходе.
  const message = [turn, owed].filter(Boolean).join('\n\n');
  const coreBytes = Buffer.byteLength(core, 'utf8');
  if (process.env.ROBOT_VOICE_HOOK_DRY_RUN !== '1') {
    if (!notification) putMetric('robot_voice_injection_bytes', coreBytes, { part: 'core' });
    if (owed) putMetric('robot_voice_injection_bytes', Buffer.byteLength(owed, 'utf8'), { part: 'rules' });
    if (turn) putMetric('robot_voice_injection_bytes', Buffer.byteLength(turn, 'utf8'), { part: notification ? 'notification' : 'turn' });
  }
  const output = message
    ? { hookSpecificOutput: { hookEventName: sessionStart ? 'SessionStart' : 'UserPromptSubmit', additionalContext: message } }
    : {};
  const notes = note ? [note] : [];
  // Молча превысить бюджет — значит вернуться ровно к той поломке, ради которой всё это
  // устроено. Поэтому о превышении говорится пользователю, а не в лог.
  if (coreBytes > CORE_LIMIT_BYTES) {
    notes.push(`robot-voice: ядро инъекции ${coreBytes} байт при бюджете ${CORE_LIMIT_BYTES} — оно перестанет умещаться в превью ${PREVIEW_BYTES} байт, и робот замолчит. Сократи core в hooks/inject-voice-rule.js.`);
  }
  if (message.length > PERSIST_CHARS) {
    notes.push(`robot-voice: инъекция ${message.length} символов при пороге ${PERSIST_CHARS} — харнесс положит её в файл, и до модели доедет только превью. Сократи самый длинный промпт в ~/.config/robot-voice-hook/prompts/ (кусок не длиннее ${CHUNK_CHARS} символов).`);
  }
  if (notes.length) output.systemMessage = notes.join('\n');
  process.stdout.write(JSON.stringify(output));
});
