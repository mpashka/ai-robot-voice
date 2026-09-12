#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { context, remember } = require('./recent-phrases');
const { putMetric } = require('./metrics');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let payload = {};
  let transcript = '';
  try {
    payload = JSON.parse(input);
    const source = payload.transcript_path;
    if (source) transcript = fs.readFileSync(source, 'utf8').slice(-524288);
  } catch {}
  const text = `${payload.last_assistant_message || ''}\n${transcript}`;
  const robotLines = [...text.matchAll(/^🤖\s*([^\r\n]{1,240})\s*$/gmi)];
  const oldMarkers = [...text.matchAll(/<!--\s*ROBOT_VOICE:\s*([^<\r\n]{1,240})\s*-->/gi)];
  const raw = robotLines.at(-1)?.[1]?.trim() || oldMarkers.at(-1)?.[1]?.trim();
  // Значки исхода — для глаз, а не для синтезатора: он читает их названиями или молчит.
  // Убираются и перед озвучкой, и перед записью в историю, чтобы не мусорить в «не повторяй».
  const phrase = String(raw || '').replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').replace(/\s+/g, ' ').trim();
  const spoken = Boolean(phrase) && phrase.toUpperCase() !== 'OFF';
  if (process.env.ROBOT_VOICE_HOOK_DRY_RUN !== '1') {
    putMetric('robot_voice_replies_total', 1, { present: spoken ? 'yes' : 'no' });
  }
  if (!spoken) return;
  if (process.env.ROBOT_VOICE_HOOK_DRY_RUN === '1') return process.stdout.write(`${phrase}\n`);
  remember('finish', phrase, context(payload));
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'robot-voice-hook', 'settings.json'), 'utf8'));
    if (settings.audio_enabled === false) return;
  } catch {}
  spawnSync(path.join(__dirname, '..', 'scripts', 'speak-brief'), [phrase], { stdio: 'ignore', timeout: 7000 });
});
