import { getEnv } from "@/lib/cloudflare";
import { alipayConfig, readNotify } from "@/lib/payments/alipay";
import { creditOrder } from "@/lib/payments/orders";

/**
 * Alipay's asynchronous notification.
 *
 * Public by necessity — Alipay has no session with this app — so the signature is
 * the whole security model. Nothing is credited before `readNotify` has verified
 * the RSA2 signature, the `app_id`, and the amount; a forged callback therefore
 * achieves exactly one thing, an entry in the log.
 *
 * The answer is Alipay's protocol, not JSON: the plain word `success` stops the
 * retries, anything else keeps them coming. So a callback we cannot use is
 * answered `failure` on purpose — a payment we refuse to credit must keep
 * knocking, because somebody has to look at it.
 */
export async function POST(request: Request) {
	const env = getEnv();
	const config = alipayConfig(env);
	if (!config) {
		console.error("[alipay] notification arrived but this deployment has no Alipay application configured");
		return new Response("failure", { status: 503 });
	}

	const form = await request.formData().catch(() => null);
	if (!form) return new Response("failure", { status: 400 });
	const params: Record<string, string> = {};
	for (const [key, value] of form.entries()) if (typeof value === "string") params[key] = value;

	const reading = await readNotify(config, params);
	if (!reading.ok) {
		console.warn("[alipay] notification refused:", reading.reason, { outTradeNo: params.out_trade_no ?? "" });
		return new Response("failure", { status: 400 });
	}

	// Not paid yet is not an error: Alipay also reports "the buyer opened the
	// cashier". Acknowledging keeps the retries down to the ones that matter.
	if (!reading.paid) return new Response("success", { status: 200 });

	const credit = await creditOrder(env, {
		orderId: reading.outTradeNo,
		tradeNo: reading.tradeNo || `notify_${reading.outTradeNo}`,
		amountCents: reading.amountCents,
	});
	if (credit.ok) {
		console.log("[alipay] credited", { order: credit.orderId, months: credit.months, until: credit.paidUntil.toISOString() });
		return new Response("success", { status: 200 });
	}
	if (credit.reason === "already paid" || credit.reason === "claimed by another writer") {
		// Two notifications for one trade, or the sweep got there first. Both are
		// the system working; retrying would only repeat this answer.
		return new Response("success", { status: 200 });
	}
	console.error("[alipay] paid but not credited:", credit.reason, {
		outTradeNo: reading.outTradeNo,
		tradeNo: reading.tradeNo,
		amount: reading.amountCents,
	});
	return new Response("failure", { status: 500 });
}
