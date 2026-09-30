'use strict';

// Ingestion de l'export historique dans Loki
// Usage : node scripts/ingest-history.js

const fs = require('node:fs');

const FILE = 'data/admin-export-2026-09-20_26.log';
const LOKI_URL = process.env.LOKI_URL || 'http://localhost:3100';
const BATCH_SIZE = 500;

// Convertit "9/27/2026, 12:04:13 AM" (heure de Paris) en timestamp UTC (ms)
function parseDate(text) {
  const [date, time, ampm] = text.replace(',', '').split(' ');
  const [month, day, year] = date.split('/');
  let [hour, minute, second] = time.split(':').map(Number);
  if (ampm === 'PM' && hour !== 12) hour += 12; // 1 PM -> 13 h
  if (ampm === 'AM' && hour === 12) hour = 0; // 12 AM -> minuit
  const pad = (n) => String(n).padStart(2, '0');
  // En septembre, Paris est en heure d'été : UTC+2
  return Date.parse(`${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}+02:00`);
}

// Un bloc = en-tête, ligne de résumé, JSON sur plusieurs lignes. Les blocs sont séparés par une ligne vide.
const blocks = fs.readFileSync(FILE, 'utf8').trim().split('\n\n');
const seen = {};
const events = [];

for (const block of blocks) {
  const lines = block.split('\n');
  const header = lines[0]; // ex. "Game completed Ju73lcJQS · 9/27/2026, 12:04:13 AM"
  const summary = lines[1];
  const jsonText = lines.slice(2).join('\n');

  const [left, dateText] = header.split(' · ');
  const type = left.startsWith('Game completed') ? 'game_completed' : 'perf_spike';
  const headerId = left.split(' ').pop();

  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    data = { raw: jsonText, jsonCasse: true };
  }

  // Doublons exacts : on les numérote, sinon Loki n'en garderait qu'un
  seen[block] = (seen[block] || 0) + 1;

  events.push({
    ts: parseDate(dateText),
    event: type,
    line: { headerId, summary, occurrence: seen[block], ...data },
  });
}

// Spikes dont la partie n'a pas de "Game completed" dans l'export
const gameIds = events.filter((e) => e.event === 'game_completed').map((e) => e.line.id);
for (const e of events) {
  if (e.event === 'perf_spike') e.line.orphan = !gameIds.includes(e.line.server.id);
}

// Le fichier va du plus récent au plus ancien, Loki veut l'ordre croissant
events.sort((a, b) => a.ts - b.ts);

async function main() {
  let sent = 0;
  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const batch = events.slice(i, i + BATCH_SIZE);
    // Un flux Loki par type d'événement (label event)
    const streams = ['game_completed', 'perf_spike']
      .map((event) => ({
        stream: { job: 'telemetry-historique', event },
        // Loki attend [timestamp en nanosecondes (texte), ligne de log]
        values: batch.filter((e) => e.event === event).map((e) => [e.ts + '000000', JSON.stringify(e.line)]),
      }))
      .filter((s) => s.values.length > 0);

    const res = await fetch(`${LOKI_URL}/loki/api/v1/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ streams }),
    });
    if (res.ok) sent += batch.length;
    else console.error(`Lot ${i} refusé par Loki (${res.status}) :`, await res.text());
  }

  console.log(`${sent}/${events.length} événements envoyés à Loki`);
  if (sent < events.length) process.exitCode = 1;
}

main();
