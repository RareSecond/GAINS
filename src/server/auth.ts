import { createAuth } from './auth-config'
import { db } from './db'
export const auth = createAuth(db)
