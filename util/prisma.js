import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

const connectionString = process.env.DATABASE_URL

// Create a connection pool
const pool = new Pool({ connectionString })

// Create the adapter
const adapter = new PrismaPg(pool)

// Create and export the PrismaClient instance
const prisma = new PrismaClient({ adapter })

export default prisma
