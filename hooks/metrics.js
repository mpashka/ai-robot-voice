#!/usr/bin/env node
// Точка метрики из хука. Хук живёт десятки миллисекунд и обязан отработать, даже когда
// приёмника нет вовсе, поэтому запись отправляется отдельным процессом без ожидания и
// молча: упавший `metrics put` не должен ни задержать ответ агента, ни его сломать.
//
// Молчание тут допустимо ровно потому, что оно само измеряется: метрика, в которую
// перестали приходить точки, отдельно видна в `metrics diagnose` строкой «писатель молчит».
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const BIN =
  process.env.METRICS_BIN ||
  path.join(os.homedir(), 'Projects', 'home', 'metrics', 'bin', 'metrics');

function putMetric(name, value, labels = {}) {
  try {
    const args = ['put', name, String(value)];
    for (const [key, label] of Object.entries(labels)) args.push(`--${key}=${label}`);
    const child = spawn(BIN, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

module.exports = { putMetric };
