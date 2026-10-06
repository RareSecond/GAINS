import { PrismaClient } from '@prisma/client'
const globalDB = globalThis as unknown as { gainsDB?: PrismaClient }
export const db = globalDB.gainsDB ?? new PrismaClient()
if (process.env.NODE_ENV !== 'production') globalDB.gainsDB = db
