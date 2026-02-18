import pkg from '@prisma/client'
const { PrismaClient } = pkg
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  console.warn('DATABASE_URL environment variable is not set! Prisma client will not be available.')
}

let prisma = null

function getPrismaClient() {
  if (!prisma && connectionString) {
    try {
      // Create a connection pool
      const pool = new Pool({
        connectionString,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000, // Increased timeout
      })

      // Create the adapter
      const adapter = new PrismaPg(pool)

      // Create the PrismaClient instance
      prisma = new PrismaClient({
        adapter,
        log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error']
      })

      console.log('Prisma client initialized successfully')
    } catch (error) {
      console.error('Failed to initialize Prisma client:', error.message)
      // Don't exit process, let the application handle it
    }
  }
  return prisma
}

// Initialize on first access
let prismaClient = null
try {
  prismaClient = getPrismaClient()
} catch (error) {
  console.error('Prisma initialization failed:', error.message)
}

export default prismaClient
