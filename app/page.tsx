import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

// This instance is single-tenant, so the root path is the front door rather
// than a marketing page: signed-in visitors land on the dashboard, everyone
// else gets the login screen. The upstream landing page is in git history.
export const metadata: Metadata = {
  title: "OpenReply",
  robots: { index: false, follow: false },
};

export default async function Home() {
  const session = await auth();
  redirect(session?.user ? "/dashboard" : "/login");
}
