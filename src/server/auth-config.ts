import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { jwt } from 'better-auth/plugins'
import { mcp } from '@better-auth/mcp'
import { cimd } from '@better-auth/cimd'
import { fetchClientMetadataResource } from '@better-auth/cimd/node'
import type { PrismaClient } from '@prisma/client'
import { config } from './config'
export const scopes = ['openid', 'profile', 'email', 'offline_access', 'profile:read', 'workouts:read', 'workouts:write']
export function authOptions(db: PrismaClient) {
  return {
    logger: { disabled: true }, appName: 'GAINS', baseURL: config.authURL, secret: process.env.BETTER_AUTH_SECRET,
    database: prismaAdapter(db, { provider: 'postgresql' }), trustedOrigins: [config.origin],
    socialProviders: { google: { clientId: process.env.GOOGLE_CLIENT_ID ?? '', clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '', prompt: 'select_account' } },
    user: { additionalFields: { mcpEpoch: { type: 'number', defaultValue: 0, input: false } } },
    advanced: { ipAddress: { ipAddressHeaders: ['x-real-ip'] } },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 100, customRules: { '/sign-in/social': { window: 60, max: 15 }, '/oauth2/*': { window: 60, max: 60 } } },
    disabledPaths: ['/token'],
    plugins: [jwt(), mcp({ loginPage: '/login', consentPage: '/oauth/consent', resource: config.resource, resources: [{ identifier: config.resource, allowedScopes: scopes }], scopes, grantTypes: ['authorization_code', 'refresh_token'], accessTokenExpiresIn: 300,
      clientPrivileges: () => false,
      customAccessTokenClaims: async ({ user }) => ({ gains_epoch: user ? (await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { mcpEpoch: true } })).mcpEpoch : -1 }),
    }), cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' })],
  } satisfies BetterAuthOptions
}
export function createAuth(db: PrismaClient) { return betterAuth(authOptions(db)) }
