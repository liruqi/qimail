import { and, desc, eq, gte, lt, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { alipayOrders, users } from "@/db/schema";
import { newId } from "@/lib/ids";
import { alipayConfig, buildCashierUrl, queryTrade } from "@/lib/payments/alipay";
import {
	ORDER_TTL_MINUTES,
	formatCny,
	isValidMonthCount,
	orderAmountCents,
	paidUntilAfter,
	priceCentsFrom,
} from "@/lib/payments/pricing";

/**
 * Buying sending time with Alipay.
 *
 * An order is a row, and the money is taken by Alipay's own cashier — there is no
 * card data and no payment page of ours. Two things can then tell us an order was
 * paid: Alipay's asynchronous notification (`/api/billing/alipay/notify`, the
 * primary source) and a query against Alipay (`alipay.trade.query`, run by the
 * five-minute cron and by the page while somebody watches it). Both end in
 * `creditOrder`, which is idempotent: the sweep and the notification race, and
 * exactly one of them wins the row.
 */

/**
 * How long past its window an order is still credited.
 *
 * Alipay closes the trade at `time_expire`, but a notification can arrive late.
 * Nothing is lost by waiting a little longer before calling an order abandoned:
 * crediting a paid order twice is impossible, and refusing a payment because our
 * clock was a minute ahead of Alipay's is not something the payer can fix.
 */
export const MATCH_GRACE_MS = 15 * 60 * 1000;

/** Whether this deployment can take money at all. */
export function paymentsConfigured(env: CloudflareEnv): boolean {
	return alipayConfig(env) !== null;
}

export type OrderView = {
	id: string;
	months: number;
	amountCents: number;
	/** "6.00" — the figure Alipay charges, in the shape Alipay speaks. */
	amount: string;
	status: "pending" | "paid" | "expired";
	tradeNo: string | null;
	createdAt: string;
	expiresAt: string;
	paidAt: string | null;
	paidUntil: string | null;
};

function toView(row: typeof alipayOrders.$inferSelect): OrderView {
	return {
		id: row.id,
		months: row.months,
		amountCents: row.amountCents,
		amount: formatCny(row.amountCents),
		status: row.status,
		tradeNo: row.tradeNo,
		createdAt: row.createdAt.toISOString(),
		expiresAt: row.expiresAt.toISOString(),
		paidAt: row.paidAt?.toISOString() ?? null,
		paidUntil: row.paidUntil?.toISOString() ?? null,
	};
}

export type CreateOrderOutcome =
	| { ok: true; order: OrderView; payUrl: string }
	| { ok: false; status: number; error: string };

/**
 * Where Alipay sends the payer back to, and where it reports the result.
 *
 * Both are absolute and both are derived from the request that asked for the
 * order, so a deployment behind any hostname works without being told its own
 * address. `APP_URL` wins when it is set, because a Worker behind a proxy can see
 * an internal origin.
 */
export function callbackUrls(env: CloudflareEnv, origin: string, orderId: string): { notifyUrl: string; returnUrl: string } {
	const base = (env.APP_URL?.trim() || origin).replace(/\/+$/, "");
	return {
		notifyUrl: `${base}/api/billing/alipay/notify`,
		returnUrl: `${base}/settings/sending?order=${encodeURIComponent(orderId)}`,
	};
}

function subjectFor(months: number): string {
	// Alipay refuses `=`, `&` and `/` in a subject; Chinese is fine, and it is what
	// the person paying reads on the cashier.
	return `其意邮箱发信 ${months} 个月`;
}

/**
 * Opens an order and returns the cashier to send the payer to.
 *
 * Only one order per account may be open: two live orders from one account would
 * mean two payments for one purchase. The older one is expired rather than left
 * to be paid by accident.
 */
export async function createOrder(
	env: CloudflareEnv,
	userId: string,
	months: unknown,
	options: { origin: string; now?: Date },
): Promise<CreateOrderOutcome> {
	if (!isValidMonthCount(months)) return { ok: false, status: 400, error: "Choose between 1 and 12 months" };
	const config = alipayConfig(env);
	if (!config) {
		// Nothing to pay into: refuse before a row exists, so no order is left
		// holding an amount nobody can settle.
		return { ok: false, status: 503, error: "This deployment does not sell sending time" };
	}

	const db = getDb(env);
	const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
	if (!user) return { ok: false, status: 404, error: "Account not found" };

	const now = options.now ?? new Date();
	await db
		.update(alipayOrders)
		.set({ status: "expired" })
		.where(and(eq(alipayOrders.userId, userId), eq(alipayOrders.status, "pending")));

	const id = newId("ord");
	const amountCents = orderAmountCents(months, priceCentsFrom(env.SEND_PRICE_CNY));
	const expiresAt = new Date(now.getTime() + ORDER_TTL_MINUTES * 60 * 1000);
	const row: typeof alipayOrders.$inferInsert = {
		id,
		userId,
		months,
		amountCents,
		status: "pending",
		createdAt: now,
		expiresAt,
	};
	await db.insert(alipayOrders).values(row);

	const { notifyUrl, returnUrl } = callbackUrls(env, options.origin, id);
	const payUrl = await buildCashierUrl(config, {
		outTradeNo: id,
		subject: subjectFor(months),
		amountCents,
		notifyUrl,
		returnUrl,
		expiresAt,
		now,
	});

	return {
		ok: true,
		order: {
			id,
			months,
			amountCents,
			amount: formatCny(amountCents),
			status: "pending",
			tradeNo: null,
			createdAt: now.toISOString(),
			expiresAt: expiresAt.toISOString(),
			paidAt: null,
			paidUntil: null,
		},
		payUrl,
	};
}

/**
 * A cashier URL for an order that is already open.
 *
 * Signing is per request, so the URL can be rebuilt any time before the window
 * closes — which is what lets a page that was reloaded, or a tab that was closed,
 * offer the same order again instead of opening a second one for the same months.
 */
export async function cashierUrlFor(
	env: CloudflareEnv,
	order: OrderView,
	options: { origin: string; now?: Date },
): Promise<string | null> {
	const config = alipayConfig(env);
	if (!config || order.status !== "pending") return null;
	const now = options.now ?? new Date();
	if (new Date(order.expiresAt).getTime() <= now.getTime()) return null;
	const { notifyUrl, returnUrl } = callbackUrls(env, options.origin, order.id);
	return buildCashierUrl(config, {
		outTradeNo: order.id,
		subject: subjectFor(order.months),
		amountCents: order.amountCents,
		notifyUrl,
		returnUrl,
		expiresAt: new Date(order.expiresAt),
		now,
	});
}

export async function listOrders(env: CloudflareEnv, userId: string, limit = 10): Promise<OrderView[]> {	const rows = await getDb(env)
		.select()
		.from(alipayOrders)
		.where(eq(alipayOrders.userId, userId))
		.orderBy(desc(alipayOrders.createdAt))
		.limit(limit);
	return rows.map(toView);
}

export async function getOrder(env: CloudflareEnv, userId: string, orderId: string): Promise<OrderView | null> {
	const [row] = await getDb(env)
		.select()
		.from(alipayOrders)
		.where(and(eq(alipayOrders.id, orderId), eq(alipayOrders.userId, userId)))
		.limit(1);
	return row ? toView(row) : null;
}

export type CreditOutcome = { ok: true; orderId: string; months: number; paidUntil: Date } | { ok: false; reason: string };

/**
 * Credits a paid order, once.
 *
 * The row is claimed with a conditional update before the account is touched, so
 * a notification and a sweep arriving together cannot both extend the month —
 * the loser's update matches no row and returns without crediting. `trade_no` is
 * unique as the second lock, because the first only holds inside one database.
 *
 * The amount is checked here rather than by the caller: one fen is not a paid
 * month, whatever the notification claims.
 *
 * An order our own sweep already called expired is still credited when Alipay
 * says it was paid. Alipay closes the trade at the order's own `time_expire`, so
 * a paid trade means the money left before the window shut; a late notification
 * is our slowness, not the payer's mistake, and it must not cost them the month.
 */
export async function creditOrder(
	env: CloudflareEnv,
	options: { orderId: string; tradeNo: string; amountCents: number; paidAt?: Date; now?: Date },
): Promise<CreditOutcome> {
	const db = getDb(env);
	const now = options.now ?? new Date();
	const [order] = await db.select().from(alipayOrders).where(eq(alipayOrders.id, options.orderId)).limit(1);
	if (!order) return { ok: false, reason: "no such order" };
	if (order.status === "paid") return { ok: false, reason: "already paid" };
	if (order.amountCents !== options.amountCents) {
		return { ok: false, reason: `paid ${formatCny(options.amountCents)} for an order of ${formatCny(order.amountCents)}` };
	}

	const [account] = await db
		.select({ sendPaidUntil: users.sendPaidUntil })
		.from(users)
		.where(eq(users.id, order.userId))
		.limit(1);
	const paidUntil = paidUntilAfter(account?.sendPaidUntil ?? null, order.months, now);

	const claimed = await db
		.update(alipayOrders)
		.set({ status: "paid", tradeNo: options.tradeNo, paidAt: options.paidAt ?? now, paidUntil })
		.where(and(eq(alipayOrders.id, order.id), ne(alipayOrders.status, "paid")))
		.returning({ id: alipayOrders.id });
	if (!claimed.length) return { ok: false, reason: "claimed by another writer" };

	await db.update(users).set({ sendPaidUntil: paidUntil }).where(eq(users.id, order.userId));
	return { ok: true, orderId: order.id, months: order.months, paidUntil };
}

export type SweepResult = {
	expired: number;
	paid: number;
	closed: number;
	/** Orders Alipay could not be asked about this round; they stay pending. */
	unread: number;
	/** Orders whose payment did not match them: wrong amount, or a trade we cannot read. */
	mismatched: number;
	error?: string;
};

/** How many orders one sweep asks Alipay about. A handful in practice; a bound anyway. */
const SWEEP_BATCH = 25;

/**
 * Marks paid orders and extends the buyer's sending time.
 *
 * Runs from the five-minute cron and from the order page. Every order is asked
 * about by its own `out_trade_no`, so there is no matching to guess at: Alipay
 * knows which order a payment belongs to, and this reads the answer.
 */
export async function sweepAlipayOrders(env: CloudflareEnv, now: Date = new Date()): Promise<SweepResult> {
	const db = getDb(env);
	const result: SweepResult = { expired: 0, paid: 0, closed: 0, unread: 0, mismatched: 0 };
	const config = alipayConfig(env);
	if (!config) return result;

	const expired = await db
		.update(alipayOrders)
		.set({ status: "expired" })
		.where(and(eq(alipayOrders.status, "pending"), lt(alipayOrders.expiresAt, new Date(now.getTime() - MATCH_GRACE_MS))))
		.returning({ id: alipayOrders.id });
	result.expired = expired.length;

	// Anything still matchable: open now, or closed recently enough that a payment
	// made before the window shut may not have been noticed yet.
	const open = await db
		.select()
		.from(alipayOrders)
		.where(
			and(eq(alipayOrders.status, "pending"), gte(alipayOrders.expiresAt, new Date(now.getTime() - MATCH_GRACE_MS))),
		)
		.limit(SWEEP_BATCH);
	if (!open.length) return result;

	const fetchImpl = fetch as unknown as Parameters<typeof queryTrade>[2];
	try {
		for (const order of open) {
			const trade = await queryTrade(config, order.id, fetchImpl, { now });
			if (trade.state === "paid") {
				if (trade.amountCents === null || trade.tradeNo === null) {
					result.mismatched += 1;
					console.warn("alipay trade paid without amount or trade_no", { order: order.id });
					continue;
				}
				const credit = await creditOrder(env, {
					orderId: order.id,
					tradeNo: trade.tradeNo,
					amountCents: trade.amountCents,
					paidAt: now,
					now,
				});
				if (credit.ok) result.paid += 1;
				else result.mismatched += 1;
				continue;
			}
			if (trade.state === "closed") {
				const closed = await db
					.update(alipayOrders)
					.set({ status: "expired" })
					.where(and(eq(alipayOrders.id, order.id), eq(alipayOrders.status, "pending")))
					.returning({ id: alipayOrders.id });
				if (closed.length) result.closed += 1;
				continue;
			}
			// "open" is Alipay saying the payer has not finished; "missing" is an order
			// nobody opened with Alipay; "unknown" is a failure to read. None of them is
			// a reason to change the row.
			if (trade.state === "unknown") result.unread += 1;
		}
	} catch (error) {
		result.error = error instanceof Error ? error.message : "Alipay could not be read";
		console.warn("alipay sweep could not ask Alipay", result.error);
	}
	return result;
}

/**
 * Runs the sweep at most once per interval per isolate.
 *
 * The order page polls, and every poll would otherwise be an Alipay request: one
 * person watching their payment should not be able to spend the whole quota. The
 * cron still runs on its own schedule; this only stops the page from doing the
 * work.
 */
let lastOnDemandSweep = 0;
export async function sweepAlipayOrdersOnDemand(
	env: CloudflareEnv,
	minimumIntervalMs = 20_000,
	now: Date = new Date(),
): Promise<SweepResult | null> {
	const stamp = Date.now();
	if (stamp - lastOnDemandSweep < minimumIntervalMs) return null;
	lastOnDemandSweep = stamp;
	return sweepAlipayOrders(env, now);
}
