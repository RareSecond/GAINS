// Generation-only entry: expose configuration without initializing database-backed plugins.
import type { PrismaClient } from '@prisma/client'
import { authOptions } from './auth-config'
export const auth = { options: authOptions({} as PrismaClient) }
