const { Pool } = require('pg');
const logger = require('../utils/logger');

let pool = null;
let pgUnavailable = false;

function isPgConnectionError(error) {
  const code = error?.code || '';
  const message = error?.message || '';
  return (
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    /getaddrinfo|connection terminated|connect ENOENT|password authentication failed/i.test(message)
  );
}

/**
 * Prefer Supabase Postgres URL when set — many deployments still have an old
 * DigitalOcean DB_CONNECTION_URL that no longer resolves.
 */
function getDatabaseUrl() {
  if (process.env.DISABLE_DIRECT_PG === 'true') {
    return null;
  }

  const candidates = [
    process.env.SUPABASE_DB_URL,
    process.env.DB_CONNECTION_URL,
    process.env.DATABASE_URL
  ].filter(Boolean);

  for (const url of candidates) {
    if (/ondigitalocean\.com/i.test(url) && !process.env.ALLOW_DIGITALOCEAN_PG) {
      logger.warn('Skipping DigitalOcean DB URL for direct PG (set ALLOW_DIGITALOCEAN_PG=true to enable)', {
        host: safeHostFromUrl(url)
      });
      continue;
    }
    return url;
  }

  return null;
}

function safeHostFromUrl(url) {
  try {
    return new URL(url.replace(/^postgres(ql)?:\/\//, 'http://')).hostname;
  } catch {
    return 'unknown';
  }
}

function getPgPool() {
  if (pgUnavailable) return null;
  if (pool) return pool;

  const connectionString = getDatabaseUrl();
  if (!connectionString) {
    return null;
  }

  const useSsl =
    connectionString.includes('supabase') ||
    connectionString.includes('ondigitalocean') ||
    process.env.DB_SSL === 'true' ||
    process.env.PGSSLMODE === 'require';

  pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined
  });

  pool.on('error', (err) => {
    logger.error('PostgreSQL pool error', { error: err.message });
    if (isPgConnectionError(err)) {
      pgUnavailable = true;
      pool = null;
    }
  });

  logger.info('PostgreSQL pool initialized for heavy admin operations', {
    host: safeHostFromUrl(connectionString)
  });
  return pool;
}

function quoteTable(table) {
  return /[A-Z]/.test(table) ? `"${table}"` : table;
}

/**
 * Run a callback with a dedicated client and extended statement timeout.
 * Falls back to Supabase (fn(null)) when direct Postgres is unreachable.
 */
async function withPgClient(fn, { statementTimeoutMs = 120000 } = {}) {
  if (pgUnavailable) {
    return fn(null);
  }

  const pgPool = getPgPool();
  if (!pgPool) {
    return fn(null);
  }

  let client;
  try {
    client = await pgPool.connect();
    await client.query(`SET statement_timeout = ${Math.max(5000, statementTimeoutMs)}`);
    return await fn(client);
  } catch (error) {
    if (isPgConnectionError(error)) {
      pgUnavailable = true;
      pool = null;
      logger.warn('Direct PostgreSQL unavailable, using Supabase client fallback', {
        error: error.message,
        code: error.code
      });
      return fn(null);
    }
    throw error;
  } finally {
    if (client) {
      client.release();
    }
  }
}

module.exports = {
  getPgPool,
  getDatabaseUrl,
  quoteTable,
  withPgClient,
  isPgConnectionError
};
