import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { cashierUrlFor, getOrder, sweepAlipayOrdersOnDemand } from "@/lib/payments/orders";
import { getSendStatus } from "@/lib/payments/entitlement";

type OrderRouteParams = {
	params: Promise<{ id: string }>;
};

/**
 * The state of one order.
 *
 * Polling this is how the page knows a payment landed, and it is the only place
 * that asks Alipay on demand — throttled inside `sweepAlipayOrdersOnDemand`, so
 * fifty tabs watching one payment cost one request, not fifty.
 *
 * A pending order also comes back with a freshly signed cashier URL: the page is
 * polled, reloaded and left behind, and every one of those should be able to send
 * the payer back to the same order rather than open another.
 */
export async function GET(request: Request, { params }: OrderRouteParams) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;

	const { id } = await params;
	const before = await getOrder(env, auth.user.id, id);
	if (!before) return NextResponse.json({ error: "Not found" }, { status: 404 });

	if (before.status === "pending") await sweepAlipayOrdersOnDemand(env).catch(() => null);
	const order = (await getOrder(env, auth.user.id, id)) ?? before;
	const status = order.status === "paid" ? await getSendStatus(env, { userId: auth.user.id }) : null;
	const payUrl = order.status === "pending" ? await cashierUrlFor(env, order, { origin: new URL(request.url).origin }) : null;
	return NextResponse.json({ order, payUrl, send: status }, { headers: { "Cache-Control": "no-store" } });
}
