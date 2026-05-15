const { Pool } = require('pg');
const logger = require('../utils/logger');

let pool = null;

function getDatabaseUrl() {
  return (
    process.env.DB_CONNECTION_URL ||
    process.env.SUPABASE_DB_URL ||
    process.env.DATABASE_URL ||
    null
  );
}

function getPgPool() {
  if (pool) return pool;

  const connectionString = getDatabaseUrl();
  if (!connectionString) {
    return null;
  }

  const useSsl =
    connectionString.includes('supabase') ||
    process.env.DB_SSL === 'true' ||
    process.env.PGSSLMODE === 'require';

  pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined
  });

  pool.on('error', (err) => {
    logger.error('PostgreSQL pool error', { error: err.message });
  });

  logger.info('PostgreSQL pool initialized for heavy admin operations');
  return pool;
}

function quoteTable(table) {
  return /[A-Z]/.test(table) ? `"${table}"` : table;
}

/**
 * Run a callback with a dedicated client and extended statement timeout.
 */
async function withPgClient(fn, { statementTimeoutMs = 120000 } = {}) {
  const pgPool = getPgPool();
  if (!pgPool) {
    return fn(null);
  }

  const client = await pgPool.connect();
  try {
    await client.query(`SET statement_timeout = ${Math.max(5000, statementTimeoutMs)}`);
    return await fn(client);
  } finally {
    client.release();
  }
}

module.exports = {
  getPgPool,
  getDatabaseUrl,
  quoteTable,
  withPgClient
};
