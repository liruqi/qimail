/**
 * What a month of sending costs, and when a paid one ends.
 *
 * The price is money — yuan and fen — so everything here is integer arithmetic on
 * fen. A float would turn 6.50 into 6.499999999999999 and the amount sent to
 * Alipay would not be the amount the order asked for.
 *
 * Kept free of imports: the Worker, the settings page and the tests all need
 * exactly these numbers.
 */

export const ORDER_MIN_MONTHS = 1;
export const ORDER_MAX_MONTHS = 12;

/** How long an unpaid order holds its amount before Alipay refuses it anyway. */
export const ORDER_TTL_MINUTES = 30;

/** One month of sending. A fixed 30 days, not a calendar month. */
export const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The default price of one month, in fen: ¥6.00.
 *
 * A deployment overrides it with `SEND_PRICE_CNY`. Six yuan is a price a person
 * can decide on without thinking, which is the point of selling mail by the
 * month rather than by the message.
 */
export const DEFAULT_PRICE_CENTS = 600;

/** The range a configured price is allowed to be in: ¥1.00 to ¥1000.00. */
export const MIN_PRICE_CENTS = 100;
export const MAX_PRICE_CENTS = 100_000;

export function isValidMonthCount(months: unknown): months is number {
	return typeof months === "number" && Number.isInteger(months) && months >= ORDER_MIN_MONTHS && months <= ORDER_MAX_MONTHS;
}

/**
 * Reads `SEND_PRICE_CNY` as fen.
 *
 * Anything that is not a plain price — unset, "cheap", "0", "6.005", a price off
 * the rails — falls back to the default instead of refusing to start: a typo in a
 * secret must not be able to take the settings page down. Out-of-range values are
 * clamped rather than silently accepted, because ¥0.01 and ¥1e6 are both mistakes.
 */
export function priceCentsFrom(value: string | null | undefined): number {
	const text = value?.trim() ?? "";
	if (!/^\d{1,6}(\.\d{1,2})?$/.test(text)) return DEFAULT_PRICE_CENTS;
	const cents = Math.round(Number(text) * 100);
	if (!Number.isFinite(cents) || cents < MIN_PRICE_CENTS) return MIN_PRICE_CENTS;
	if (cents > MAX_PRICE_CENTS) return MAX_PRICE_CENTS;
	return cents;
}

/** What `months` of sending costs at `priceCents` a month. */
export function orderAmountCents(months: number, priceCents: number): number {
	if (!isValidMonthCount(months)) throw new RangeError(`months must be an integer in ${ORDER_MIN_MONTHS}..${ORDER_MAX_MONTHS}`);
	if (!Number.isInteger(priceCents) || priceCents <= 0) throw new RangeError("priceCents must be a positive integer");
	return months * priceCents;
}

/** "6.00" — the shape Alipay's `total_amount` wants. */
export function formatCny(cents: number): string {
	const whole = Math.trunc(cents / 100);
	const fraction = Math.abs(cents % 100);
	return `${whole}.${String(fraction).padStart(2, "0")}`;
}

/** "¥6.00" — for the page. The symbol is the deployment's, not the marketplace's. */
export function formatPrice(cents: number): string {
	return `¥${formatCny(cents)}`;
}

/**
 * Reads an Alipay amount back into fen.
 *
 * Alipay answers with a string like "6.00" and the comparison against the order
 * has to be exact: a notification saying 6.0 when the order asked for 6.00 is the
 * same money, and one saying 0.06 is not.
 */
export function parseCny(text: unknown): number | null {
	if (typeof text !== "string") return null;
	const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text.trim());
	if (!match) return null;
	const fraction = Number((match[2] ?? "").padEnd(2, "0") || 0);
	return Number(match[1]) * 100 + fraction;
}

/**
 * When sending stays paid up to. Buying time while still paid extends the
 * existing expiry instead of restarting it, so a subscriber who renews a week
 * early keeps the week they paid for.
 */
export function paidUntilAfter(current: Date | number | null, months: number, now: Date | number): Date {
	const currentMs = current instanceof Date ? current.getTime() : current;
	const nowMs = now instanceof Date ? now.getTime() : now;
	const base = typeof currentMs === "number" && Number.isFinite(currentMs) && currentMs > nowMs ? currentMs : nowMs;
	return new Date(base + months * MONTH_MS);
}

/** Whether sending is paid for at `now`. An expired timestamp is not a boolean. */
export function isPaidActive(paidUntil: Date | number | null | undefined, now: Date | number): boolean {
	if (!paidUntil) return false;
	const until = paidUntil instanceof Date ? paidUntil.getTime() : paidUntil;
	const nowMs = now instanceof Date ? now.getTime() : now;
	return Number.isFinite(until) && until > nowMs;
}

/** Whole days left, rounded up, for the "12 days left" line. 0 when not paid. */
export function paidDaysLeft(paidUntil: Date | number | null | undefined, now: Date | number): number {
	if (!paidUntil) return 0;
	const until = paidUntil instanceof Date ? paidUntil.getTime() : paidUntil;
	const nowMs = now instanceof Date ? now.getTime() : now;
	if (!Number.isFinite(until) || until <= nowMs) return 0;
	return Math.ceil((until - nowMs) / (24 * 60 * 60 * 1000));
}

/**
 * The expiry as an ISO string, or null.
 *
 * Deliberately tolerant of the driver value: the column is a timestamp, but a
 * schema that has drifted from the migrations can hand back a plain number, and
 * `new Date("…").toISOString` on a number is a TypeError. That TypeError used to
 * be the difference between a settings page and a blank 500, so it is not allowed
 * to be one any more.
 */
export function paidUntilIso(paidUntil: Date | number | null | undefined): string | null {
	if (paidUntil instanceof Date) return Number.isFinite(paidUntil.getTime()) ? paidUntil.toISOString() : null;
	// Timestamps are whole seconds everywhere else in this schema.
	if (typeof paidUntil === "number" && Number.isFinite(paidUntil) && paidUntil > 0) {
		return new Date(paidUntil * 1000).toISOString();
	}
	return null;
}
