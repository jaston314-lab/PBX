'use strict';

const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const express = require('express');
const sip = require('sip');
const sqlite3 = require('sqlite3').verbose();
const dotenv = require('dotenv');
const { initializeDatabase, seedEngineersIfEmpty } = require('./db/init');

dotenv.config();

const HTTP_PORT = Number(process.env.PORT || 8080);
const SIP_PORT = Number(process.env.SIP_PORT || 5060);
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
const FALLBACK_NUMBER = (process.env.FALLBACK_NUMBER || '15551234567').trim();
const SIP_REDIRECT_HOST = (process.env.SIP_REDIRECT_HOST || '').trim();
const SIP_REDIRECT_PORT = Number(process.env.SIP_REDIRECT_PORT || 0);
const SIP_REDIRECT_NUMBER_FORMAT = (process.env.SIP_REDIRECT_NUMBER_FORMAT || 'plus').trim().toLowerCase();
const NTP_ENABLED = String(process.env.NTP_ENABLED || 'false').toLowerCase() === 'true';
const NTP_SERVER = (process.env.NTP_SERVER || 'pool.ntp.org').trim();
const NTP_SYNC_INTERVAL_MS = Number(process.env.NTP_SYNC_INTERVAL_MS || 300000);
const NTP_TIMEOUT_MS = Number(process.env.NTP_TIMEOUT_MS || 3000);

const dataDir = path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'router.db');

fs.mkdirSync(dataDir, { recursive: true });

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Unable to open SQLite database:', err.message);
  }
});

db.run('PRAGMA foreign_keys = ON');

const serverClockState = {
  source: 'system',
  offsetMs: 0,
  ntpServer: NTP_SERVER || null,
  lastSyncAt: null,
  lastError: null,
  intervalRef: null
};

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        return reject(err);
      }
      return resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        return reject(err);
      }
      return resolve(row);
    });
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        return reject(err);
      }
      return resolve(rows);
    });
  });
}

function unauthorized(res) {
  res.set('WWW-Authenticate', 'Basic realm="On-Call Router", charset="UTF-8"');
  return res.status(401).json({ error: 'Unauthorized' });
}

function basicAuth(req, res, next) {
  if (!ADMIN_USER || !ADMIN_PASS) {
    return res.status(500).json({ error: 'Server auth configuration is incomplete' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return unauthorized(res);
  }

  let decoded = '';
  try {
    decoded = Buffer.from(authHeader.split(' ')[1], 'base64').toString('utf8');
  } catch (err) {
    return unauthorized(res);
  }

  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex === -1) {
    return unauthorized(res);
  }

  const username = decoded.slice(0, separatorIndex);
  const password = decoded.slice(separatorIndex + 1);

  if (username !== ADMIN_USER || password !== ADMIN_PASS) {
    return unauthorized(res);
  }

  return next();
}

function normalizeDialTarget(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatDateUTC(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function parseIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

function toWeekStartMonday(date) {
  const start = new Date(date.getTime());
  const day = start.getUTCDay();
  const mondayDelta = day === 0 ? -6 : 1 - day;
  start.setUTCDate(start.getUTCDate() + mondayDelta);
  return start;
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function daysBetween(fromDate, toDate) {
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((toDate.getTime() - fromDate.getTime()) / millisecondsPerDay);
}

function positiveModulo(value, base) {
  return ((value % base) + base) % base;
}

function parseYearMonth(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value)) {
    return null;
  }

  const [year, month] = value.split('-').map(Number);
  if (month < 1 || month > 12) {
    return null;
  }

  return { year, month };
}

function formatYearMonth(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`;
}

function getCurrentServerTimeMs() {
  return Date.now() + serverClockState.offsetMs;
}

function queryNtpTime(server, timeoutMs) {
  return new Promise((resolve, reject) => {
    const client = dgram.createSocket('udp4');
    const packet = Buffer.alloc(48);
    packet[0] = 0x1b;

    let settled = false;
    const timeoutRef = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      client.close();
      reject(new Error('NTP request timed out'));
    }, timeoutMs);

    client.once('error', (err) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutRef);
      client.close();
      reject(err);
    });

    client.once('message', (message) => {
      if (settled) {
        return;
      }

      if (!message || message.length < 48) {
        settled = true;
        clearTimeout(timeoutRef);
        client.close();
        reject(new Error('Invalid NTP response length'));
        return;
      }

      const seconds = message.readUInt32BE(40);
      const fraction = message.readUInt32BE(44);
      const ntpEpochOffset = 2208988800;
      const unixSeconds = seconds - ntpEpochOffset;
      const unixMs = unixSeconds * 1000 + Math.round((fraction * 1000) / 0x100000000);

      settled = true;
      clearTimeout(timeoutRef);
      client.close();
      resolve(unixMs);
    });

    client.send(packet, 0, packet.length, 123, server, (err) => {
      if (err && !settled) {
        settled = true;
        clearTimeout(timeoutRef);
        client.close();
        reject(err);
      }
    });
  });
}

async function syncServerClockFromNtp() {
  if (!NTP_ENABLED || !NTP_SERVER) {
    return;
  }

  try {
    const ntpMs = await queryNtpTime(NTP_SERVER, NTP_TIMEOUT_MS);
    serverClockState.offsetMs = ntpMs - Date.now();
    serverClockState.source = 'ntp';
    serverClockState.ntpServer = NTP_SERVER;
    serverClockState.lastSyncAt = new Date().toISOString();
    serverClockState.lastError = null;
  } catch (err) {
    serverClockState.source = 'system';
    serverClockState.offsetMs = 0;
    serverClockState.lastError = err.message;
    console.error('NTP sync failed:', err.message);
  }
}

function startTimeSyncLoop() {
  if (!NTP_ENABLED || !NTP_SERVER) {
    return;
  }

  syncServerClockFromNtp();
  serverClockState.intervalRef = setInterval(syncServerClockFromNtp, Math.max(30000, NTP_SYNC_INTERVAL_MS));
}

function normalizeUkMobile(input) {
  if (typeof input !== 'string') {
    return null;
  }

  const digitsOnly = input.replace(/[^\d+]/g, '').trim();
  if (!digitsOnly) {
    return null;
  }

  let normalized = digitsOnly;

  if (normalized.startsWith('+44')) {
    normalized = normalized.slice(3);
  } else if (normalized.startsWith('44')) {
    normalized = normalized.slice(2);
  } else if (normalized.startsWith('0')) {
    normalized = normalized.slice(1);
  }

  if (!/^7\d{9}$/.test(normalized)) {
    return null;
  }

  return `+44${normalized}`;
}

function formatRedirectDialNumber(number) {
  const cleaned = normalizeDialTarget(number);
  if (!cleaned) {
    return null;
  }

  if (SIP_REDIRECT_NUMBER_FORMAT === 'no_plus') {
    return cleaned.startsWith('+') ? cleaned.slice(1) : cleaned;
  }

  return cleaned;
}

function formatRedirectHost(host) {
  if (!host) {
    return null;
  }

  const hasPortAlready = /:\d+$/.test(host);
  if (!hasPortAlready && Number.isInteger(SIP_REDIRECT_PORT) && SIP_REDIRECT_PORT > 0) {
    return `${host}:${SIP_REDIRECT_PORT}`;
  }

  return host;
}

function displayUkMobile(value) {
  if (typeof value !== 'string' || !/^\+447\d{9}$/.test(value)) {
    return value;
  }

  const local = `0${value.slice(3)}`;
  return `${local.slice(0, 5)} ${local.slice(5, 8)} ${local.slice(8)}`;
}

function validateEngineerName(name) {
  if (typeof name !== 'string') {
    return null;
  }

  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= 100 ? trimmed : null;
}

async function getOrderedEngineers() {
  return allAsync(
    `SELECT id, name, mobile_number, is_active, rota_position
     FROM engineers
     ORDER BY rota_position ASC, id ASC`
  );
}

async function getRotaConfig() {
  const config = await getAsync('SELECT rota_start_date FROM rota_config WHERE id = 1');
  const startDate = config && config.rota_start_date ? config.rota_start_date : formatDateUTC(new Date());
  return { rota_start_date: startDate };
}

async function computeBaseEngineerForDate(dateString, engineers, rotaStartDate) {
  if (!engineers.length) {
    return null;
  }

  const targetDate = parseIsoDate(dateString);
  const startDate = parseIsoDate(rotaStartDate);
  if (!targetDate || !startDate) {
    return null;
  }

  const weeksSinceStart = Math.floor(daysBetween(startDate, targetDate) / 7);
  const index = positiveModulo(weeksSinceStart, engineers.length);
  return engineers[index];
}

async function getEffectiveEngineerForDate(dateString) {
  const engineers = await getOrderedEngineers();
  if (!engineers.length) {
    return null;
  }

  const override = await getAsync(
    `SELECT ro.engineer_id, e.id, e.name, e.mobile_number
     FROM rota_overrides ro
     LEFT JOIN engineers e ON e.id = ro.engineer_id
     WHERE ro.override_date = ?`,
    [dateString]
  );

  if (override) {
    if (!override.engineer_id) {
      return null;
    }

    if (override.id) {
      return {
        id: override.id,
        name: override.name,
        mobile_number: override.mobile_number,
        source: 'override'
      };
    }
  }

  const config = await getRotaConfig();
  const base = await computeBaseEngineerForDate(dateString, engineers, config.rota_start_date);

  if (!base) {
    return null;
  }

  return {
    id: base.id,
    name: base.name,
    mobile_number: base.mobile_number,
    source: 'rota'
  };
}

async function getInviteTargetNumber() {
  const today = formatDateUTC(new Date(getCurrentServerTimeMs()));
  const rotaEngineer = await getEffectiveEngineerForDate(today);
  const rotaNumber = normalizeDialTarget(rotaEngineer && rotaEngineer.mobile_number);
  if (rotaNumber) {
    return rotaNumber;
  }

  const active = await getAsync(
    'SELECT mobile_number FROM engineers WHERE is_active = 1 ORDER BY id LIMIT 1'
  );

  const activeNumber = normalizeDialTarget(active && active.mobile_number);
  if (activeNumber) {
    return activeNumber;
  }

  const fallback = normalizeDialTarget(FALLBACK_NUMBER);
  if (!fallback) {
    throw new Error('No rota assignee, no active engineer, and FALLBACK_NUMBER is missing');
  }

  return fallback;
}

async function getWeekSchedule(weekStartString) {
  const weekStart = parseIsoDate(weekStartString);
  if (!weekStart) {
    throw new Error('Invalid week start date');
  }

  const monday = toWeekStartMonday(weekStart);
  const mondayString = formatDateUTC(monday);
  const engineers = await getOrderedEngineers();
  const config = await getRotaConfig();

  const overrides = await allAsync(
    `SELECT ro.override_date, ro.engineer_id, e.name AS engineer_name
     FROM rota_overrides ro
     LEFT JOIN engineers e ON e.id = ro.engineer_id
     WHERE ro.override_date BETWEEN ? AND ?
     ORDER BY ro.override_date ASC`,
    [mondayString, formatDateUTC(addDays(monday, 6))]
  );

  const overrideMap = new Map(overrides.map((item) => [item.override_date, item]));
  const days = [];

  for (let offset = 0; offset < 7; offset += 1) {
    const currentDate = addDays(monday, offset);
    const dateString = formatDateUTC(currentDate);
    const baseEngineer = await computeBaseEngineerForDate(dateString, engineers, config.rota_start_date);
    const override = overrideMap.get(dateString);

    const effectiveEngineer =
      override && override.engineer_id
        ? engineers.find((engineer) => engineer.id === override.engineer_id) || null
        : override && !override.engineer_id
          ? null
          : baseEngineer;

    days.push({
      date: dateString,
      weekday: currentDate.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' }),
      base_engineer_id: baseEngineer ? baseEngineer.id : null,
      base_engineer_name: baseEngineer ? baseEngineer.name : null,
      override_engineer_id: override ? override.engineer_id : undefined,
      effective_engineer_id: effectiveEngineer ? effectiveEngineer.id : null,
      effective_engineer_name: effectiveEngineer ? effectiveEngineer.name : null
    });
  }

  return {
    week_start: mondayString,
    rota_start_date: config.rota_start_date,
    days
  };
}

async function getMonthSchedule(monthString) {
  const parsedMonth = parseYearMonth(monthString);
  if (!parsedMonth) {
    throw new Error('Invalid month');
  }

  const monthStart = new Date(Date.UTC(parsedMonth.year, parsedMonth.month - 1, 1));
  const monthEnd = new Date(Date.UTC(parsedMonth.year, parsedMonth.month, 0));
  const monthStartString = formatDateUTC(monthStart);
  const monthEndString = formatDateUTC(monthEnd);

  const engineers = await getOrderedEngineers();
  const config = await getRotaConfig();
  const overrides = await allAsync(
    `SELECT override_date, engineer_id
     FROM rota_overrides
     WHERE override_date BETWEEN ? AND ?`,
    [monthStartString, monthEndString]
  );

  const overrideMap = new Map(overrides.map((item) => [item.override_date, item.engineer_id]));
  const days = [];
  const totalDays = monthEnd.getUTCDate();

  for (let day = 1; day <= totalDays; day += 1) {
    const current = new Date(Date.UTC(parsedMonth.year, parsedMonth.month - 1, day));
    const dateString = formatDateUTC(current);
    const baseEngineer = await computeBaseEngineerForDate(dateString, engineers, config.rota_start_date);
    const overrideEngineerId = overrideMap.has(dateString) ? overrideMap.get(dateString) : undefined;

    let effectiveEngineer = baseEngineer;
    if (overrideEngineerId !== undefined) {
      effectiveEngineer = overrideEngineerId
        ? engineers.find((engineer) => engineer.id === overrideEngineerId) || null
        : null;
    }

    days.push({
      date: dateString,
      day,
      week_start: formatDateUTC(toWeekStartMonday(current)),
      base_engineer_id: baseEngineer ? baseEngineer.id : null,
      base_engineer_name: baseEngineer ? baseEngineer.name : null,
      override_engineer_id: overrideEngineerId,
      effective_engineer_id: effectiveEngineer ? effectiveEngineer.id : null,
      effective_engineer_name: effectiveEngineer ? effectiveEngineer.name : null
    });
  }

  return {
    month: monthString,
    month_start: monthStartString,
    month_end: monthEndString,
    month_start_weekday: monthStart.getUTCDay(),
    rota_start_date: config.rota_start_date,
    days
  };
}

function extractSipSourceAddress(request) {
  if (request && request.source_address) {
    return request.source_address;
  }

  if (
    request &&
    request.headers &&
    Array.isArray(request.headers.via) &&
    request.headers.via[0] &&
    request.headers.via[0].host
  ) {
    return request.headers.via[0].host;
  }

  return '127.0.0.1';
}

async function handleInvite(request) {
  let targetNumber;

  try {
    targetNumber = await getInviteTargetNumber();
  } catch (err) {
    console.error('SIP INVITE routing lookup failed:', err.message);
    sip.send(sip.makeResponse(request, 500, 'Server Internal Error'));
    return;
  }

  const sourceAddress = extractSipSourceAddress(request);
  const requestHost =
    request && request.uri && typeof request.uri.host === 'string' && request.uri.host
      ? request.uri.host
      : null;
  const redirectHost = formatRedirectHost(SIP_REDIRECT_HOST || requestHost || sourceAddress);
  const formattedRedirectNumber = formatRedirectDialNumber(targetNumber);

  if (!formattedRedirectNumber) {
    console.error('SIP INVITE redirect number formatting failed');
    sip.send(sip.makeResponse(request, 500, 'Server Internal Error'));
    return;
  }

  const redirectUri = sip.parseUri(`sip:${formattedRedirectNumber}@${redirectHost};user=phone`);

  const response = sip.makeResponse(request, 302, 'Moved Temporarily');
  response.headers = response.headers || {};
  response.headers.contact = [{ uri: redirectUri }];

  try {
    sip.send(response);
    console.log(`SIP INVITE redirected to ${formattedRedirectNumber} via ${redirectHost}`);
  } catch (err) {
    console.error('Failed to send SIP 302 response:', err.message);
    sip.send(sip.makeResponse(request, 500, 'Server Internal Error'));
  }
}

function startSipServer() {
  sip.start(
    {
      protocol: 'UDP',
      address: '0.0.0.0',
      port: SIP_PORT
    },
    (request) => {
      try {
        if (!request || !request.method) {
          return;
        }

        if (request.method === 'OPTIONS') {
          sip.send(sip.makeResponse(request, 200, 'OK'));
          return;
        }

        if (request.method === 'INVITE') {
          handleInvite(request);
          return;
        }

        sip.send(sip.makeResponse(request, 405, 'Method Not Allowed'));
      } catch (err) {
        console.error('Unhandled SIP request error:', err.message);
        if (request) {
          sip.send(sip.makeResponse(request, 500, 'Server Internal Error'));
        }
      }
    }
  );

  console.log(`SIP server listening on UDP ${SIP_PORT}`);
}

function startHttpServer() {
  const app = express();

  app.use((req, res, next) => {
    if (req.path === '/health') {
      return next();
    }
    return basicAuth(req, res, next);
  });

  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/api/engineers', async (_req, res) => {
    try {
      const engineers = await getOrderedEngineers();
      res.json(
        engineers.map((engineer) => ({
          ...engineer,
          mobile_number_display: displayUkMobile(engineer.mobile_number)
        }))
      );
    } catch (err) {
      console.error('Failed to fetch engineers:', err.message);
      res.status(500).json({ error: 'Failed to fetch engineers' });
    }
  });

  app.post('/api/engineers', async (req, res) => {
    const name = validateEngineerName(req.body && req.body.name);
    const mobileNumber = normalizeUkMobile(req.body && req.body.mobile_number);

    if (!name) {
      return res.status(400).json({ error: 'Name is required and must be at most 100 characters' });
    }

    if (!mobileNumber) {
      return res.status(400).json({ error: 'Mobile number must be a valid UK mobile number' });
    }

    try {
      const maxPosition = await getAsync('SELECT COALESCE(MAX(rota_position), 0) AS max_position FROM engineers');
      const nextPosition = (maxPosition && maxPosition.max_position ? maxPosition.max_position : 0) + 1;

      const result = await runAsync(
        'INSERT INTO engineers (name, mobile_number, is_active, rota_position) VALUES (?, ?, 0, ?)',
        [name, mobileNumber, nextPosition]
      );

      return res.status(201).json({ id: result.lastID });
    } catch (err) {
      console.error('Failed to add engineer:', err.message);
      return res.status(500).json({ error: 'Failed to add engineer' });
    }
  });

  app.put('/api/engineers/reorder', async (req, res) => {
    const orderedIds = req.body && req.body.ordered_ids;

    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return res.status(400).json({ error: 'ordered_ids must be a non-empty array' });
    }

    if (!orderedIds.every((id) => Number.isInteger(id) && id > 0)) {
      return res.status(400).json({ error: 'ordered_ids must contain positive integers' });
    }

    try {
      const current = await getOrderedEngineers();
      if (current.length !== orderedIds.length) {
        return res.status(400).json({ error: 'ordered_ids must include all engineers exactly once' });
      }

      const currentIds = new Set(current.map((item) => item.id));
      const providedIds = new Set(orderedIds);

      if (providedIds.size !== orderedIds.length || orderedIds.some((id) => !currentIds.has(id))) {
        return res.status(400).json({ error: 'ordered_ids must include all engineers exactly once' });
      }

      await runAsync('BEGIN IMMEDIATE TRANSACTION');

      for (let index = 0; index < orderedIds.length; index += 1) {
        await runAsync('UPDATE engineers SET rota_position = ? WHERE id = ?', [index + 1, orderedIds[index]]);
      }

      await runAsync('COMMIT');
      return res.json({ success: true });
    } catch (err) {
      try {
        await runAsync('ROLLBACK');
      } catch (rollbackErr) {
        console.error('Rollback failed on reorder:', rollbackErr.message);
      }

      console.error('Failed to reorder engineers:', err.message);
      return res.status(500).json({ error: 'Failed to reorder engineers' });
    }
  });

  app.put('/api/engineers/:id', async (req, res) => {
    const engineerId = Number(req.params.id);
    const name = validateEngineerName(req.body && req.body.name);
    const mobileNumber = normalizeUkMobile(req.body && req.body.mobile_number);

    if (!Number.isInteger(engineerId) || engineerId <= 0) {
      return res.status(400).json({ error: 'Invalid engineer ID' });
    }

    if (!name) {
      return res.status(400).json({ error: 'Name is required and must be at most 100 characters' });
    }

    if (!mobileNumber) {
      return res.status(400).json({ error: 'Mobile number must be a valid UK mobile number' });
    }

    try {
      const result = await runAsync(
        'UPDATE engineers SET name = ?, mobile_number = ? WHERE id = ?',
        [name, mobileNumber, engineerId]
      );

      if (!result.changes) {
        return res.status(404).json({ error: 'Engineer not found' });
      }

      return res.json({ success: true });
    } catch (err) {
      console.error('Failed to update engineer:', err.message);
      return res.status(500).json({ error: 'Failed to update engineer' });
    }
  });

  app.delete('/api/engineers/:id', async (req, res) => {
    const engineerId = Number(req.params.id);

    if (!Number.isInteger(engineerId) || engineerId <= 0) {
      return res.status(400).json({ error: 'Invalid engineer ID' });
    }

    try {
      await runAsync('BEGIN IMMEDIATE TRANSACTION');

      await runAsync('DELETE FROM rota_overrides WHERE engineer_id = ?', [engineerId]);
      const result = await runAsync('DELETE FROM engineers WHERE id = ?', [engineerId]);

      if (!result.changes) {
        await runAsync('ROLLBACK');
        return res.status(404).json({ error: 'Engineer not found' });
      }

      const remainingEngineers = await allAsync(
        'SELECT id FROM engineers ORDER BY rota_position ASC, id ASC'
      );

      for (let index = 0; index < remainingEngineers.length; index += 1) {
        await runAsync('UPDATE engineers SET rota_position = ? WHERE id = ?', [
          index + 1,
          remainingEngineers[index].id
        ]);
      }

      const activeCount = await getAsync('SELECT COUNT(*) AS count FROM engineers WHERE is_active = 1');
      if (activeCount && activeCount.count === 0 && remainingEngineers.length > 0) {
        await runAsync('UPDATE engineers SET is_active = 1 WHERE id = ?', [remainingEngineers[0].id]);
      }

      await runAsync('COMMIT');
      return res.json({ success: true });
    } catch (err) {
      try {
        await runAsync('ROLLBACK');
      } catch (rollbackErr) {
        console.error('Rollback failed on delete:', rollbackErr.message);
      }

      console.error('Failed to delete engineer:', err.message);
      return res.status(500).json({ error: 'Failed to delete engineer' });
    }
  });

  app.put('/api/engineers/:id/activate', async (req, res) => {
    const engineerId = Number(req.params.id);

    if (!Number.isInteger(engineerId) || engineerId <= 0) {
      return res.status(400).json({ error: 'Invalid engineer ID' });
    }

    try {
      await runAsync('BEGIN IMMEDIATE TRANSACTION');
      await runAsync('UPDATE engineers SET is_active = 0');
      const result = await runAsync('UPDATE engineers SET is_active = 1 WHERE id = ?', [engineerId]);

      if (!result.changes) {
        await runAsync('ROLLBACK');
        return res.status(404).json({ error: 'Engineer not found' });
      }

      await runAsync('COMMIT');
      return res.json({ success: true, active_engineer_id: engineerId });
    } catch (err) {
      try {
        await runAsync('ROLLBACK');
      } catch (rollbackErr) {
        console.error('Rollback failed:', rollbackErr.message);
      }

      console.error('Failed to activate engineer:', err.message);
      return res.status(500).json({ error: 'Failed to activate engineer' });
    }
  });

  app.get('/api/rota/config', async (_req, res) => {
    try {
      const config = await getRotaConfig();
      return res.json(config);
    } catch (err) {
      console.error('Failed to load rota config:', err.message);
      return res.status(500).json({ error: 'Failed to load rota config' });
    }
  });

  app.put('/api/rota/config', async (req, res) => {
    const startDate = req.body && req.body.rota_start_date;
    if (!parseIsoDate(startDate)) {
      return res.status(400).json({ error: 'rota_start_date must be YYYY-MM-DD' });
    }

    try {
      await runAsync('UPDATE rota_config SET rota_start_date = ? WHERE id = 1', [startDate]);
      return res.json({ success: true });
    } catch (err) {
      console.error('Failed to save rota config:', err.message);
      return res.status(500).json({ error: 'Failed to save rota config' });
    }
  });

  app.get('/api/rota/week', async (req, res) => {
    const requestedStart = typeof req.query.start === 'string' ? req.query.start : formatDateUTC(new Date());

    try {
      const schedule = await getWeekSchedule(requestedStart);
      return res.json(schedule);
    } catch (err) {
      if (err.message === 'Invalid week start date') {
        return res.status(400).json({ error: 'start must be a valid YYYY-MM-DD date' });
      }

      console.error('Failed to load week schedule:', err.message);
      return res.status(500).json({ error: 'Failed to load week schedule' });
    }
  });

  app.get('/api/rota/month', async (req, res) => {
    const currentMonth = formatYearMonth(new Date(getCurrentServerTimeMs()));
    const requestedMonth = typeof req.query.month === 'string' ? req.query.month : currentMonth;

    try {
      const schedule = await getMonthSchedule(requestedMonth);
      return res.json(schedule);
    } catch (err) {
      if (err.message === 'Invalid month') {
        return res.status(400).json({ error: 'month must be YYYY-MM' });
      }

      console.error('Failed to load month schedule:', err.message);
      return res.status(500).json({ error: 'Failed to load month schedule' });
    }
  });

  app.get('/api/time', (_req, res) => {
    const nowMs = getCurrentServerTimeMs();
    return res.json({
      iso_now: new Date(nowMs).toISOString(),
      unix_ms: nowMs,
      source: serverClockState.source,
      ntp_server: serverClockState.ntpServer,
      offset_ms: serverClockState.offsetMs,
      last_sync_at: serverClockState.lastSyncAt,
      last_error: serverClockState.lastError
    });
  });

  app.put('/api/rota/override/day', async (req, res) => {
    const overrideDate = req.body && req.body.date;
    const engineerId = req.body && req.body.engineer_id;

    if (!parseIsoDate(overrideDate)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }

    if (engineerId !== null && (!Number.isInteger(engineerId) || engineerId <= 0)) {
      return res.status(400).json({ error: 'engineer_id must be null or a positive integer' });
    }

    try {
      if (engineerId !== null) {
        const engineer = await getAsync('SELECT id FROM engineers WHERE id = ?', [engineerId]);
        if (!engineer) {
          return res.status(404).json({ error: 'Engineer not found' });
        }
      }

      await runAsync(
        `INSERT INTO rota_overrides (override_date, engineer_id)
         VALUES (?, ?)
         ON CONFLICT(override_date) DO UPDATE SET engineer_id = excluded.engineer_id`,
        [overrideDate, engineerId]
      );

      return res.json({ success: true });
    } catch (err) {
      console.error('Failed to save day override:', err.message);
      return res.status(500).json({ error: 'Failed to save day override' });
    }
  });

  app.put('/api/rota/override/week', async (req, res) => {
    const weekStartDate = req.body && req.body.week_start;
    const engineerId = req.body && req.body.engineer_id;

    const parsedStart = parseIsoDate(weekStartDate);
    if (!parsedStart) {
      return res.status(400).json({ error: 'week_start must be YYYY-MM-DD' });
    }

    if (engineerId !== null && (!Number.isInteger(engineerId) || engineerId <= 0)) {
      return res.status(400).json({ error: 'engineer_id must be null or a positive integer' });
    }

    try {
      if (engineerId !== null) {
        const engineer = await getAsync('SELECT id FROM engineers WHERE id = ?', [engineerId]);
        if (!engineer) {
          return res.status(404).json({ error: 'Engineer not found' });
        }
      }

      const monday = toWeekStartMonday(parsedStart);
      await runAsync('BEGIN IMMEDIATE TRANSACTION');

      for (let offset = 0; offset < 7; offset += 1) {
        const dateString = formatDateUTC(addDays(monday, offset));
        await runAsync(
          `INSERT INTO rota_overrides (override_date, engineer_id)
           VALUES (?, ?)
           ON CONFLICT(override_date) DO UPDATE SET engineer_id = excluded.engineer_id`,
          [dateString, engineerId]
        );
      }

      await runAsync('COMMIT');
      return res.json({ success: true, week_start: formatDateUTC(monday) });
    } catch (err) {
      try {
        await runAsync('ROLLBACK');
      } catch (rollbackErr) {
        console.error('Rollback failed on week override:', rollbackErr.message);
      }

      console.error('Failed to save week override:', err.message);
      return res.status(500).json({ error: 'Failed to save week override' });
    }
  });

  app.use((err, _req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Malformed JSON request body' });
    }

    return next(err);
  });

  app.listen(HTTP_PORT, '0.0.0.0', () => {
    console.log(`Management portal listening on TCP ${HTTP_PORT}`);
  });
}

async function bootstrap() {
  await initializeDatabase(db);
  await seedEngineersIfEmpty(db);

  startTimeSyncLoop();
  startHttpServer();
  startSipServer();
}

bootstrap().catch((err) => {
  console.error('Fatal startup error:', err.message);
  process.exit(1);
});

process.on('SIGINT', () => {
  if (serverClockState.intervalRef) {
    clearInterval(serverClockState.intervalRef);
  }
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (serverClockState.intervalRef) {
    clearInterval(serverClockState.intervalRef);
  }
  db.close();
  process.exit(0);
});
