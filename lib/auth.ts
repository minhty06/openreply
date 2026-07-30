import NextAuth, { type NextAuthConfig } from "next-auth";
import Resend from "next-auth/providers/resend";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/db/client";
import { ensureWorkspaceForUser, getPrimaryWorkspace } from "@/lib/workspace";

type AdapterPrismaClient = Parameters<typeof PrismaAdapter>[0];

export const authConfig = {
  adapter: PrismaAdapter(prisma as unknown as AdapterPrismaClient),
  providers: [
    Resend({
      apiKey: process.env.RESEND_API_KEY ?? "missing-resend-api-key",
      from: process.env.EMAIL_FROM ?? "OpenReply <login@example.com>",
    }),
  ],
  callbacks: {
    // Single-tenant lockdown. Login is an open email magic link by default, so
    // anyone who finds the public URL can create a workspace and spend this
    // instance's Resend quota. ALLOWED_EMAILS restricts that to a fixed list.
    // Left unset, behaviour is unchanged (open signup), so this stays a no-op
    // for multi-tenant deployments.
    async signIn({ user, email }) {
      const allowed = (process.env.ALLOWED_EMAILS ?? "")
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);

      if (allowed.length === 0) return true;

      // The email provider calls signIn twice: once with
      // email.verificationRequest set, before the magic link is sent, and again
      // when the link is followed. Rejecting the first pass means a stranger's
      // address never receives mail at all, rather than being turned away after
      // the send has already cost quota.
      void email;

      const address = user.email?.trim().toLowerCase();
      return Boolean(address && allowed.includes(address));
    },
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
      }
      return session;
    },
  },
  events: {
    async createUser({ user }) {
      if (user.id) {
        await ensureWorkspaceForUser(user.id, user.email);
      }
    },
  },
  pages: {
    signIn: "/login",
    verifyRequest: "/verify-request",
  },
  session: {
    strategy: "database",
  },
  trustHost: true,
  secret: process.env.NEXTAUTH_SECRET,
} satisfies NextAuthConfig;

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

export async function getCurrentUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}

export async function getCurrentWorkspaceId(): Promise<string | null> {
  const userId = await getCurrentUserId();
  if (!userId) return null;

  const workspace = await getPrimaryWorkspace(userId);
  if (workspace) return workspace.id;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });

  const createdWorkspace = await ensureWorkspaceForUser(userId, user?.email);
  return createdWorkspace.id;
}
