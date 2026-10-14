import { openCodexApp, signInToCodex } from "@/lib/server/codex";
import { checkMac, retryCodex } from "@/lib/server/mac";
import { findCodex, installStatus } from "@/lib/server/codex-cli";
import { fromThisMac } from "@/lib/server/owner-email";
import { getState } from "@/lib/server/store";
import { notReady } from "@/lib/server/ready";

export const dynamic = "force-dynamic";

/** Codex on this Mac: where it is, Bops' own install of it ({ state, error?, version? }), and the Mac's readiness (state.mac). */
export async function GET() {
  return Response.json({ codex: findCodex() ?? null, install: installStatus() ?? null, mac: getState().mac ?? null });
}

/** Install the shared CLI, or sign in to the private subscription runtime and enable native computer use. */
export async function POST(request: Request) {
  const { action } = (await request.json().catch(() => ({}))) as { action?: unknown };
  const unready = notReady();
  if (unready) return unready;
  if (!fromThisMac(request)) return Response.json({ ok: false, error: "This works in the Bops app on your Mac." }, { status: 403 });
  try {
    if (action === "install") await retryCodex();
    else if (action === "sign-in") await signInToCodex();
    else if (action === "open") {
      openCodexApp();
      await checkMac();
    } else return Response.json({ ok: false, error: "action: install, sign-in or open" }, { status: 400 });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
  return Response.json({ ok: true });
}
