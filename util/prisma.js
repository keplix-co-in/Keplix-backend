import pkg from '@prisma/client'
const { PrismaClient } = pkg
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

let prisma = null

function getPrismaClient() {
  if (prisma) return prisma

  // Read lazily so dotenv has time to populate process.env
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.error('DATABASE_URL is not set. Prisma cannot be initialized.')
    return null
  }

  try {
    const pool = new Pool({ connectionString })
    const adapter = new PrismaPg(pool)
    prisma = new PrismaClient({
      adapter,
      log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error']
    })
    console.log('Prisma client initialized successfully')
  } catch (error) {
    console.error('Failed to initialize Prisma client:', error.message)
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
