import pkg from '@prisma/client'
const { PrismaClient } = pkg
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import Logger from './logger.js'

let prisma = null

function getPrismaClient() {
  if (prisma) return prisma

  // Read lazily so dotenv has time to populate process.env
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    Logger.error('DATABASE_URL is not set. Prisma cannot be initialized.')
    return null
  }

  try {
    // node-pg's own default (10) is what this ran on with no explicit limit
    // at all (audit #29) -- not literally unbounded, but undocumented and
    // untied to how this actually deploys: one Cloud Run instance at
    // concurrency 80 (deploy.yml), so a burst of concurrent requests could
    // exhaust the pool with no visibility into why. PGPOOL_MAX makes the
    // ceiling explicit and tunable without a code change; 20 leaves headroom
    // under Supabase's connection cap for the migration step and any manual
    // psql session while still covering realistic concurrent load.
    const pool = new Pool({
      connectionString,
      max: Number(process.env.PGPOOL_MAX) || 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    })
    const adapter = new PrismaPg(pool)
    prisma = new PrismaClient({
      adapter,
      log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error']
    })
    Logger.info('Prisma client initialized successfully')
  } catch (error) {
    Logger.error('Failed to initialize Prisma client:', error.message)
  }
  return prisma
}

// Lazy proxy — client is created on first actual DB call, not at import time
const prismaClient = new Proxy({}, {
  get(_, prop) {
    const client = getPrismaClient()
    if (!client) throw new Error('Prisma client unavailable. Check DATABASE_URL.')
    const value = client[prop]
    return typeof value === 'function' ? value.bind(client) : value
  }
})

export default prismaClient
