/**
 * RSA2 signing, and taking money with Alipay through Vibe Pay's web checkout.
 *
 * Vibe Pay's basic collection capability is the ordinary Alipay open API:
 * `alipay.trade.page.pay` opens the cashier, `alipay.trade.query` is the second
 * opinion on whether a trade was paid, and the asynchronous notification to
 * `notify_url` is the primary one. Nothing here stores money or decides
 * entitlement — `orders.ts` does that against the database — this module only
 * speaks to Alipay.
 *
 * A deployment with no Alipay application says so by returning null from
 * `alipayConfig`, which is what turns "buy sending time" off instead of showing a
 * button that cannot work.
 *
 * Deliberately free of imports, like the other modules the tests load directly:
 * two small money helpers are repeated from `pricing.ts`, and a test asserts the
 * copies agree, which is cheaper than making this file unloadable from Node.
 */

const RSA2 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/**
 * Bytes backed by a plain `ArrayBuffer`, not the `ArrayBufferLike` a default
 * `TextEncoder` hands back: Web Crypto will not take a view that might sit on a
 * shared buffer, and the copy is a few hundred bytes of signed content.
 */
const toBytes = (value: string) => {
	const encoded = new TextEncoder().encode(value);
	const bytes = new Uint8Array(new ArrayBuffer(encoded.length));
	bytes.set(encoded);
	return bytes;
};

/**
 * RSA2 is RSASSA-PKCS1-v1_5 over SHA-256, and there is no SDK here on purpose:
 * the official Java one is a few megabytes of everything, and this app needs
 * three operations — sign a request, verify a notification, nothing else.
 *
 * Two rules are easy to get subtly wrong, and both are pinned by tests:
 *
 * 1. The signed content is the parameters sorted by name, joined `k=v&k=v`, with
 *    values *not* URL-encoded and empty values dropped.
 * 2. A request signs everything except `sign` — `sign_type` included. A
 *    notification verifies everything except `sign` and `sign_type`, because
 *    Alipay's own documentation excludes both when it signs the callback.
 */

export type SignableParams = Record<string, string | number | undefined | null>;

/** A key as the body of its PEM: no header, no footer, no newlines. */
export function pemBody(key: string): string {
	return key.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "");
}

function fromBase64(value: string) {
	const raw = atob(pemBody(value));
	const bytes = new Uint8Array(new ArrayBuffer(raw.length));
	for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
	return bytes;
}

function toBase64(buffer: ArrayBuffer): string {
	const view = new Uint8Array(buffer);
	let text = "";
	for (let index = 0; index < view.length; index += 1) text += String.fromCharCode(view[index]);
	return btoa(text);
}

/**
 * The exact string Alipay signs.
 *
 * `omitSignType` is the one difference between a request and a notification: an
 * outbound request includes `sign_type` in what it signs, a callback excludes it.
 */
export function signContent(params: SignableParams, options: { omitSignType?: boolean } = {}): string {
	const skip = options.omitSignType ? new Set(["sign", "sign_type"]) : new Set(["sign"]);
	return Object.keys(params)
		.filter((key) => !skip.has(key))
		.filter((key) => params[key] !== undefined && params[key] !== null && String(params[key]) !== "")
		.sort()
		.map((key) => `${key}=${String(params[key])}`)
		.join("&");
}

/** Signs `params` with the application's private key (PKCS#8, base64 or PEM). */
export async function signParams(params: SignableParams, privateKey: string): Promise<string> {
	const key = await crypto.subtle.importKey("pkcs8", fromBase64(privateKey), RSA2, false, ["sign"]);
	const signature = await crypto.subtle.sign(RSA2, key, toBytes(signContent(params)));
	return toBase64(signature);
}

/**
 * Checks a callback against Alipay's public key (X.509 SubjectPublicKeyInfo,
 * base64 or PEM). Anything unreadable is a failed verification, not an exception:
 * a malformed key must not look like a valid payment.
 */
export async function verifyParams(
	params: SignableParams,
	publicKey: string,
	options: { omitSignType?: boolean } = {},
): Promise<boolean> {
	const signature = params.sign;
	if (typeof signature !== "string" || !signature.trim()) return false;
	try {
		const key = await crypto.subtle.importKey("spki", fromBase64(publicKey), RSA2, false, ["verify"]);
		return await crypto.subtle.verify(RSA2, key, fromBase64(signature), toBytes(signContent(params, options)));
	} catch {
		return false;
	}
}

/** Alipay's production gateway. Sandbox deployments override it with `ALIPAY_GATEWAY`. */
export const ALIPAY_GATEWAY = "https://openapi.alipay.com/gateway.do";
export const ALIPAY_SANDBOX_GATEWAY = "https://openapi-sandbox.dl.alipaydev.com/gateway.do";

export type AlipayConfig = {
	appId: string;
	/** The application's RSA2 private key (PKCS#8). */
	privateKey: string;
	/** Alipay's public key, for verifying what Alipay sends us. */
	publicKey: string;
	gateway: string;
};

/**
 * All three credentials or nothing.
 *
 * A half-configured application is worse than an absent one: it would open a
 * cashier whose notifications cannot be verified, so a payer could pay and stay
 * unpaid. Refusing to sell is the honest answer.
 */
export function alipayConfig(env: CloudflareEnv): AlipayConfig | null {
	const appId = env.ALIPAY_APP_ID?.trim() ?? "";
	const privateKey = env.ALIPAY_PRIVATE_KEY?.trim() ?? "";
	const publicKey = env.ALIPAY_PUBLIC_KEY?.trim() ?? "";
	if (!appId || !privateKey || !publicKey) return null;
	return { appId, privateKey, publicKey, gateway: env.ALIPAY_GATEWAY?.trim() || ALIPAY_GATEWAY };
}

/**
 * Alipay's clock: `yyyy-MM-dd HH:mm:ss`, in Beijing time, and it will reject a
 * timestamp that is more than a few minutes off its own.
 */
export function alipayTimestamp(date: Date): string {
	const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
	return shifted.toISOString().slice(0, 19).replace("T", " ");
}

/** "6.00" — Alipay's shape for `total_amount`. Copy of `pricing.formatCny`. */
export function formatAmount(cents: number): string {
	const whole = Math.trunc(cents / 100);
	const fraction = Math.abs(cents % 100);
	return `${whole}.${String(fraction).padStart(2, "0")}`;
}

/** Reads an Alipay amount back into fen. Copy of `pricing.parseCny`. */
export function parseAmount(text: unknown): number | null {
	if (typeof text !== "string") return null;
	const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text.trim());
	if (!match) return null;
	return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0") || 0);
}

export type CashierRequest = {
	outTradeNo: string;
	subject: string;
	amountCents: number;
	notifyUrl: string;
	returnUrl: string;
	/** When the cashier stops accepting this order. */
	expiresAt: Date;
	now?: Date;
};

/**
 * The signed cashier URL for one order.
 *
 * A GET to the gateway rather than a self-submitting form: the cashier is a
 * redirect either way, and a URL is something the page can also offer as a plain
 * link when the browser blocks the popup.
 */
export async function buildCashierUrl(config: AlipayConfig, request: CashierRequest): Promise<string> {
	const params: SignableParams = {
		app_id: config.appId,
		method: "alipay.trade.page.pay",
		format: "JSON",
		charset: "utf-8",
		sign_type: "RSA2",
		timestamp: alipayTimestamp(request.now ?? new Date()),
		version: "1.0",
		notify_url: request.notifyUrl,
		return_url: request.returnUrl,
		biz_content: JSON.stringify({
			out_trade_no: request.outTradeNo,
			product_code: "FAST_INSTANT_TRADE_PAY",
			total_amount: formatAmount(request.amountCents),
			subject: request.subject,
			// Alipay closes the trade itself at this point, so an abandoned order
			// cannot be paid later and then credit a window that has passed.
			time_expire: alipayTimestamp(request.expiresAt),
		}),
	};
	const sign = await signParams(params, config.privateKey);
	const query = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) query.set(key, String(value));
	query.set("sign", sign);
	return `${config.gateway}?${query.toString()}`;
}

export type FetchLike = (
	input: string,
	init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export type TradeState = "paid" | "open" | "closed" | "missing" | "unknown";

export type TradeQuery = {
	state: TradeState;
	tradeNo: string | null;
	/** What Alipay says was paid, in fen. Null when it did not say. */
	amountCents: number | null;
	/** Alipay's own words, kept for the log rather than for the page. */
	detail: string;
};

type QueryResponse = {
	code?: string;
	msg?: string;
	sub_code?: string;
	sub_msg?: string;
	trade_no?: string;
	out_trade_no?: string;
	trade_status?: string;
	total_amount?: string;
};

/** The two shapes Alipay puts at the top level: a trade, or a gateway error. */
type QueryPayload = {
	alipay_trade_query_response?: QueryResponse;
	error_response?: QueryResponse;
};

/**
 * Asks Alipay what happened to one order.
 *
 * The notification is the primary source and this is the fallback, for the cases
 * where it never arrives: a Worker deployed behind a redirect, a callback lost, a
 * local development machine without a public address. It is also what makes the
 * settings page finish on its own while the payer watches it.
 *
 * `TRADE_CLOSED` and "no such trade" are different facts — the first means the
 * window closed, the second that Alipay never saw the order — but both mean this
 * order will never be paid, which is all the caller needs.
 */
export async function queryTrade(
	config: AlipayConfig,
	outTradeNo: string,
	fetchImpl: FetchLike,
	options: { timeoutMs?: number; now?: Date } = {},
): Promise<TradeQuery> {
	const params: SignableParams = {
		app_id: config.appId,
		method: "alipay.trade.query",
		format: "JSON",
		charset: "utf-8",
		sign_type: "RSA2",
		timestamp: alipayTimestamp(options.now ?? new Date()),
		version: "1.0",
		biz_content: JSON.stringify({ out_trade_no: outTradeNo }),
	};
	const sign = await signParams(params, config.privateKey);
	const body = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) body.set(key, String(value));
	body.set("sign", sign);

	const response = await fetchImpl(config.gateway, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8", Accept: "application/json" },
		body: body.toString(),
		signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
	});
	const text = await response.text();
	if (!response.ok) {
		return { state: "unknown", tradeNo: null, amountCents: null, detail: `Alipay answered ${response.status}` };
	}

	let payload: QueryPayload | null;
	try {
		payload = JSON.parse(text) as QueryPayload;
	} catch {
		return { state: "unknown", tradeNo: null, amountCents: null, detail: "Alipay answered something that is not JSON" };
	}
	const answer = payload?.alipay_trade_query_response;
	if (!answer) {
		const error = payload?.error_response;
		return {
			state: "unknown",
			tradeNo: null,
			amountCents: null,
			detail: error?.sub_msg || error?.msg || "Alipay answered without a trade",
		};
	}

	// 40004 with ACQ.TRADE_NOT_EXIST is "this order was never opened with us",
	// which happens when nobody followed the cashier URL.
	if (answer.code !== "10000") {
		const notExist = answer.sub_code === "ACQ.TRADE_NOT_EXIST" || answer.sub_code === "ACQ.TRADE_HAS_CLOSE";
		return {
			state: notExist ? "missing" : "unknown",
			tradeNo: answer.trade_no ?? null,
			amountCents: null,
			detail: answer.sub_msg || answer.msg || `Alipay answered ${answer.code}`,
		};
	}

	const amountCents = parseAmount(answer.total_amount);
	const tradeNo = answer.trade_no ?? null;
	switch (answer.trade_status) {
		case "TRADE_SUCCESS":
		case "TRADE_FINISHED":
			return { state: "paid", tradeNo, amountCents, detail: answer.trade_status };
		case "TRADE_CLOSED":
			return { state: "closed", tradeNo, amountCents, detail: answer.trade_status };
		case "WAIT_BUYER_PAY":
			return { state: "open", tradeNo, amountCents, detail: answer.trade_status };
		default:
			return { state: "unknown", tradeNo, amountCents, detail: answer.trade_status ?? "no trade_status" };
	}
}

export type NotifyReading =
	| { ok: true; outTradeNo: string; tradeNo: string; amountCents: number; paid: boolean; detail: string }
	| { ok: false; reason: string };

/**
 * Reads an asynchronous notification.
 *
 * The order of the checks is the order of what a forger would have to fake: the
 * signature first (so nothing unsigned is trusted at all), then the application
 * id (a notification meant for another merchant is not ours), then the trade
 * status, then the amount (a paid one fen is not a paid month). A callback that
 * says "paid" for an order we asked 6.00 for and Alipay reports as 0.06 is
 * refused rather than credited.
 */
export async function readNotify(config: AlipayConfig, params: Record<string, string>): Promise<NotifyReading> {
	if (params.sign_type && params.sign_type !== "RSA2") {
		return { ok: false, reason: `unexpected sign_type ${params.sign_type}` };
	}
	const verified = await verifyParams(params, config.publicKey, { omitSignType: true });
	if (!verified) return { ok: false, reason: "signature did not verify" };
	if (params.app_id !== config.appId) return { ok: false, reason: "notification is for another app_id" };

	const outTradeNo = params.out_trade_no?.trim();
	if (!outTradeNo) return { ok: false, reason: "notification has no out_trade_no" };
	const amountCents = parseAmount(params.total_amount);
	if (amountCents === null) return { ok: false, reason: "notification has no readable total_amount" };

	const status = params.trade_status ?? "";
	const paid = status === "TRADE_SUCCESS" || status === "TRADE_FINISHED";
	return { ok: true, outTradeNo, tradeNo: params.trade_no?.trim() ?? "", amountCents, paid, detail: status };
}
