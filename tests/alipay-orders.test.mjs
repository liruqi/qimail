import assert from "node:assert/strict";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import test from "node:test";

const pricing = await import("../src/lib/payments/pricing.ts");
const alipay = await import("../src/lib/payments/alipay.ts");
const sign = alipay;

/**
 * Sending time is money now, so these pin two things that silently break it:
 * the arithmetic (fen, never floats) and the signature (what Alipay signs and
 * what we sign must be the same string, or every cashier opens unsigned and every
 * notification is refused).
 */

/** A throwaway RSA key pair in the shapes Alipay hands out: base64 PKCS#8 / SPKI. */
function keyPair() {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "spki", format: "der" },
		privateKeyEncoding: { type: "pkcs8", format: "der" },
	});
	return { privateKey: privateKey.toString("base64"), publicKey: publicKey.toString("base64") };
}

const merchant = keyPair();
const alipayKeys = keyPair();

const config = {
	appId: "2021000000000001",
	privateKey: merchant.privateKey,
	publicKey: alipayKeys.publicKey,
	gateway: "https://openapi.alipay.com/gateway.do",
};

test("the amount helpers agree with the ones in pricing", () => {
	// alipay.ts repeats these two helpers to stay import-free; this keeps the
	// copies from drifting, the way the old TronGrid module guarded its constant.
	for (const cents of [0, 1, 6, 99, 100, 600, 650, 1800, 999_999]) {
		assert.equal(alipay.formatAmount(cents), pricing.formatCny(cents), String(cents));
		assert.equal(alipay.parseAmount(alipay.formatAmount(cents)), cents, String(cents));
		assert.equal(alipay.parseAmount("not money"), null);
	}
});

test("an order costs yuan, in fen, as integers", () => {
	assert.equal(pricing.priceCentsFrom("6"), 600);
	assert.equal(pricing.priceCentsFrom(" 6.50 "), 650);
	assert.equal(pricing.orderAmountCents(3, 650), 1950);
	assert.equal(pricing.formatCny(1950), "19.50");
	assert.equal(pricing.formatCny(600), "6.00");
	assert.equal(pricing.formatPrice(600), "¥6.00");
	// Float drift here is the difference between a paid order and a refused one.
	for (let months = 1; months <= 12; months += 1) {
		const cents = pricing.orderAmountCents(months, 650);
		assert.equal(Number.isInteger(cents), true);
		assert.equal(pricing.parseCny(pricing.formatCny(cents)), cents);
	}
});

test("a bad or missing price falls back instead of refusing to start", () => {
	assert.equal(pricing.priceCentsFrom(undefined), pricing.DEFAULT_PRICE_CENTS);
	assert.equal(pricing.priceCentsFrom(""), pricing.DEFAULT_PRICE_CENTS);
	assert.equal(pricing.priceCentsFrom("cheap"), pricing.DEFAULT_PRICE_CENTS);
	assert.equal(pricing.priceCentsFrom("6.005"), pricing.DEFAULT_PRICE_CENTS);
	// Out of range is clamped, not accepted: ¥0.01 and ¥1e6 are both typos.
	assert.equal(pricing.priceCentsFrom("0"), pricing.MIN_PRICE_CENTS);
	assert.equal(pricing.priceCentsFrom("999999"), pricing.MAX_PRICE_CENTS);
});

test("only 1..12 months can be bought", () => {
	for (const bad of [0, 13, -1, 1.5, NaN, "3", null]) {
		assert.equal(pricing.isValidMonthCount(bad), false, String(bad));
		assert.throws(() => pricing.orderAmountCents(bad, 600));
	}
	for (let months = 1; months <= 12; months += 1) assert.equal(pricing.isValidMonthCount(months), true);
});

test("amounts read back exactly, and wrong shapes are refused", () => {
	assert.equal(pricing.parseCny("6.00"), 600);
	assert.equal(pricing.parseCny("6"), 600);
	assert.equal(pricing.parseCny("6.0"), 600);
	assert.equal(pricing.parseCny("0.06"), 6);
	for (const bad of ["", "6.005", "abc", "6,00", "-1", "6.00 CNY", 6]) assert.equal(pricing.parseCny(bad), null, String(bad));
});

test("the signed content is sorted, unencoded, and drops empties", () => {
	assert.equal(sign.signContent({ b: "2", a: "1", c: "" }), "a=1&b=2");
	assert.equal(sign.signContent({ sign: "nope", a: "1" }), "a=1");
	// A request signs sign_type; a notification excludes it. This is the rule that
	// decides whether every callback verifies or none do.
	assert.equal(sign.signContent({ sign: "x", sign_type: "RSA2", a: "1" }), "a=1&sign_type=RSA2");
	assert.equal(sign.signContent({ sign: "x", sign_type: "RSA2", a: "1" }, { omitSignType: true }), "a=1");
});

test("RSA2 round-trips, and a changed value does not", async () => {
	const params = { app_id: "2021", method: "alipay.trade.query", amount: "6.00" };
	const signature = await sign.signParams(params, merchant.privateKey);
	assert.equal(await sign.verifyParams({ ...params, sign: signature }, merchant.publicKey), true);
	assert.equal(await sign.verifyParams({ ...params, amount: "0.06", sign: signature }, merchant.publicKey), false);
	// No signature at all is a failure, not an exception.
	assert.equal(await sign.verifyParams(params, merchant.publicKey), false);
	assert.equal(await sign.verifyParams({ ...params, sign: "not base64" }, merchant.publicKey), false);
});

test("verification agrees with an independent signer", async () => {
	// The same bytes signed by Node's crypto, which is not our code: if these two
	// ever disagree, real Alipay notifications would be refused in production.
	const params = { app_id: config.appId, out_trade_no: "ord_1", trade_status: "TRADE_SUCCESS" };
	const content = sign.signContent(params, { omitSignType: true });
	const signature = nodeSign("sha256", Buffer.from(content), {
		key: Buffer.from(merchant.privateKey, "base64"),
		format: "der",
		type: "pkcs8",
	}).toString("base64");
	assert.equal(await sign.verifyParams({ ...params, sign: signature }, merchant.publicKey, { omitSignType: true }), true);
});

test("Alipay's clock is Beijing time", () => {
	assert.equal(alipay.alipayTimestamp(new Date("2026-11-08T12:00:00Z")), "2026-11-08 20:00:00");
	assert.equal(alipay.alipayTimestamp(new Date("2026-11-08T16:30:00Z")), "2026-11-09 00:30:00");
});

test("a cashier URL carries the order, the price, and a signature", async () => {
	const expiresAt = new Date("2026-11-08T12:30:00Z");
	const url = await alipay.buildCashierUrl(config, {
		outTradeNo: "ord_test",
		subject: "其意邮箱发信 3 个月",
		amountCents: 1800,
		notifyUrl: "https://mail.example.com/api/billing/alipay/notify",
		returnUrl: "https://mail.example.com/settings/sending?order=ord_test",
		expiresAt,
		now: new Date("2026-11-08T12:00:00Z"),
	});
	const parsed = new URL(url);
	assert.equal(parsed.origin + parsed.pathname, "https://openapi.alipay.com/gateway.do");
	assert.equal(parsed.searchParams.get("method"), "alipay.trade.page.pay");
	assert.equal(parsed.searchParams.get("sign_type"), "RSA2");
	assert.equal(parsed.searchParams.get("timestamp"), "2026-11-08 20:00:00");

	const biz = JSON.parse(parsed.searchParams.get("biz_content"));
	assert.equal(biz.out_trade_no, "ord_test");
	assert.equal(biz.total_amount, "18.00");
	assert.equal(biz.product_code, "FAST_INSTANT_TRADE_PAY");
	// The cashier stops taking this order when our window does, in Alipay's clock.
	assert.equal(biz.time_expire, "2026-11-08 20:30:00");

	// The URL is only worth anything if every parameter above is signed, so verify
	// the way Alipay would.
	const params = Object.fromEntries(parsed.searchParams.entries());
	assert.equal(await sign.verifyParams(params, merchant.publicKey), true);
});

test("a notification is read only after the signature, the app and the amount", async () => {
	const params = (over = {}) => ({
		app_id: config.appId,
		out_trade_no: "ord_test",
		trade_no: "2026110822001400000000000001",
		trade_status: "TRADE_SUCCESS",
		total_amount: "18.00",
		sign_type: "RSA2",
		...over,
	});
	// Alipay signs a callback over everything except `sign` and `sign_type`, so the
	// fixture is signed that way — by Node, not by our own signer, so this also
	// checks that the rule we verify with is the rule Alipay documents.
	const signed = async (values) => {
		const content = sign.signContent(values, { omitSignType: true });
		const signature = nodeSign("sha256", Buffer.from(content), {
			key: Buffer.from(alipayKeys.privateKey, "base64"),
			format: "der",
			type: "pkcs8",
		}).toString("base64");
		return { ...values, sign: signature };
	};

	const good = await alipay.readNotify(config, await signed(params()));
	assert.equal(good.ok, true);
	assert.equal(good.paid, true);
	assert.equal(good.amountCents, 1800);
	assert.equal(good.tradeNo, "2026110822001400000000000001");

	// Someone else's notification, or a forged one.
	const foreign = await signed(params({ app_id: "2021999999999999" }));
	assert.equal((await alipay.readNotify(config, foreign)).ok, false);
	const unsigned = params();
	assert.equal((await alipay.readNotify(config, unsigned)).ok, false);
	const tampered = await signed(params({ total_amount: "0.06" }));
	// Signature is over the tampered amount, so it verifies — the amount check is
	// what stops a one-fen "payment" from crediting a month.
	const reading = await alipay.readNotify(config, tampered);
	assert.equal(reading.ok, true);
	assert.equal(reading.amountCents, 6);

	// Not paid yet is a reading, not an error.
	const waiting = await alipay.readNotify(config, await signed(params({ trade_status: "WAIT_BUYER_PAY" })));
	assert.equal(waiting.ok, true);
	assert.equal(waiting.paid, false);

	const noAmount = await alipay.readNotify(config, await signed(params({ total_amount: "" })));
	assert.equal(noAmount.ok, false);
});

test("a trade query tells paid, open and closed apart", async () => {
	const answer = (body) => ({
		ok: true,
		status: 200,
		text: async () => JSON.stringify(body),
	});
	const ask = async (body) =>
		alipay.queryTrade(config, "ord_test", async () => answer(body), { now: new Date("2026-11-08T12:00:00Z") });

	const paid = await ask({
		alipay_trade_query_response: {
			code: "10000",
			trade_no: "2026110822001400000000000001",
			trade_status: "TRADE_SUCCESS",
			total_amount: "18.00",
		},
	});
	assert.equal(paid.state, "paid");
	assert.equal(paid.amountCents, 1800);
	assert.equal(paid.tradeNo, "2026110822001400000000000001");

	const open = await ask({ alipay_trade_query_response: { code: "10000", trade_status: "WAIT_BUYER_PAY" } });
	assert.equal(open.state, "open");

	const closed = await ask({ alipay_trade_query_response: { code: "10000", trade_status: "TRADE_CLOSED" } });
	assert.equal(closed.state, "closed");

	const missing = await ask({
		alipay_trade_query_response: { code: "40004", sub_code: "ACQ.TRADE_NOT_EXIST", sub_msg: "交易不存在" },
	});
	assert.equal(missing.state, "missing");

	const broken = await alipay.queryTrade(
		config,
		"ord_test",
		async () => ({ ok: false, status: 502, text: async () => "" }),
	);
	assert.equal(broken.state, "unknown");
});

test("a deployment without an application sells nothing", () => {
	assert.equal(alipay.alipayConfig({}), null);
	assert.equal(alipay.alipayConfig({ ALIPAY_APP_ID: "2021" }), null);
	assert.equal(alipay.alipayConfig({ ALIPAY_APP_ID: "2021", ALIPAY_PRIVATE_KEY: "k" }), null);
	const configured = alipay.alipayConfig({ ALIPAY_APP_ID: "2021", ALIPAY_PRIVATE_KEY: "k", ALIPAY_PUBLIC_KEY: "p" });
	assert.equal(configured.gateway, alipay.ALIPAY_GATEWAY);
	assert.equal(
		alipay.alipayConfig({
			ALIPAY_APP_ID: "2021",
			ALIPAY_PRIVATE_KEY: "k",
			ALIPAY_PUBLIC_KEY: "p",
			ALIPAY_GATEWAY: alipay.ALIPAY_SANDBOX_GATEWAY,
		}).gateway,
		alipay.ALIPAY_SANDBOX_GATEWAY,
	);
});
