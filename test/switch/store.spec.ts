import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchStoreFacts,
  RATE_PAIR,
  refreshExchangeRate,
  resolveStoreFacts,
} from "../../src/services/switch/store";

afterEach(() => vi.restoreAllMocks());

const page = (body: string, status = 200) =>
  new Response(`<html><head>${body}</head><body>hi</body></html>`, {
    status,
    headers: { "Content-Type": "text/html" },
  });

const ld = (data: unknown) => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;

const offer = (price: string, priceCurrency = "HKD", name = "Test Game") => ({
  "@type": "VideoGame",
  name,
  offers: { "@type": "Offer", price, priceCurrency },
});

/** The two storefronts answer in the order fetchStoreFacts asks: HK, US. */
const storefronts = (hk: Response, us: Response) => {
  const answers = [hk, us];
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input) =>
      Promise.resolve(String(input).endsWith("/HK") ? answers[0].clone() : answers[1].clone())
    );
};

describe("fetchStoreFacts", () => {
  it("takes the price from HK and the name from US", async () => {
    storefronts(
      page(ld(offer("198", "HKD", "《測試遊戲》"))),
      page(ld(offer("19.99", "USD", "Test Game")))
    );
    expect(await fetchStoreFacts("0400984020BE8000")).toEqual({
      priceCents: 19800,
      title: "Test Game",
    });
  });

  it("looks past blocks that carry no answer of its own", async () => {
    storefronts(
      page(
        `<script type="application/ld+json">{ not json </script>` +
          ld({ "@type": "BreadcrumbList" }) +
          ld({ "@graph": [offer("59.99", "USD"), offer("548")] })
      ),
      page(ld({ "@graph": [{ "@type": "BreadcrumbList" }, offer("69.99", "USD", "Named")] }))
    );
    expect(await fetchStoreFacts("A")).toEqual({
      priceCents: 54800,
      title: "Named",
    });
  });

  it("returns nothing a storefront could not answer", async () => {
    storefronts(page("", 404), page(ld(offer("19.99", "USD", "Test Game"))));
    expect(await fetchStoreFacts("A")).toEqual({
      priceCents: null,
      title: "Test Game",
    });

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    expect(await fetchStoreFacts("A")).toEqual({ priceCents: null, title: null });
  });
});

describe("refreshExchangeRate", () => {
  it("stores the rate and ignores a nonsense answer", async () => {
    const api = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ rates: { CNY: 0.8573 } }));

    expect(await refreshExchangeRate(env, 1_000)).toBe(0.8573);
    const row = await env.SWITCH_DB.prepare(`SELECT rate FROM exchange_rates WHERE pair = ?`)
      .bind(RATE_PAIR)
      .first<{ rate: number }>();
    expect(row?.rate).toBe(0.8573);

    api.mockResolvedValue(Response.json({ rates: {} }));
    expect(await refreshExchangeRate(env, 2_000)).toBeNull();
  });
});

describe("resolveStoreFacts", () => {
  const now = Date.now();

  beforeEach(async () => {
    await env.SWITCH_DB.prepare(`DELETE FROM games`).run();
    await env.SWITCH_DB.batch([
      env.SWITCH_DB.prepare(
        `INSERT INTO games (application_id, title, total_playing_time, first_seen, updated_at)
         VALUES ('PLAYED', '集合啦', 40, ?, ?)`
      ).bind(now, now),
      env.SWITCH_DB.prepare(
        `INSERT INTO games (application_id, title, total_playing_time, first_seen, updated_at)
         VALUES ('UNPLAYED', 'Owned only', 0, ?, ?)`
      ).bind(now, now),
    ]);
  });

  const facts = () =>
    env.SWITCH_DB.prepare(
      `SELECT price_hkd_cents AS cents, store_title AS title
       FROM games WHERE application_id = 'PLAYED'`
    ).first<{ cents: number | null; title: string | null }>();

  it("looks a played title up once and never asks again", async () => {
    const store = storefronts(
      page(ld(offer("329"))),
      page(ld(offer("59.99", "USD", "Animal Crossing")))
    );

    expect(await resolveStoreFacts(env, now)).toBe(1);
    expect(store).toHaveBeenCalledTimes(2);
    expect(await facts()).toMatchObject({
      cents: 32900,
      title: "Animal Crossing",
    });

    expect(await resolveStoreFacts(env, now)).toBe(0);
    expect(store).toHaveBeenCalledTimes(2);
  });

  it("records a failed lookup so it retries monthly, not daily", async () => {
    const store = storefronts(page("", 404), page("", 404));

    expect(await resolveStoreFacts(env, now)).toBe(0);
    expect(await resolveStoreFacts(env, now)).toBe(0);
    expect(store).toHaveBeenCalledTimes(2);

    storefronts(page(ld(offer("198"))), page(ld(offer("19.99", "USD", "Kick-Off"))));
    expect(await resolveStoreFacts(env, now + 40 * 24 * 3600e3)).toBe(1);
    expect(await facts()).toMatchObject({ cents: 19800, title: "Kick-Off" });
  });

  it("never lets a quiet storefront erase an answer it already had", async () => {
    storefronts(page(ld(offer("198"))), page(ld(offer("19.99", "USD", "Kick-Off"))));
    await resolveStoreFacts(env, now);

    await env.SWITCH_DB.prepare(
      `UPDATE games SET store_title = NULL WHERE application_id = 'PLAYED'`
    ).run();
    storefronts(page("", 404), page("", 404));
    await resolveStoreFacts(env, now + 40 * 24 * 3600e3);

    expect(await facts()).toMatchObject({ cents: 19800, title: null });
  });
});

describe("store lookup budget", () => {
  it("caps each sync at twelve titles and four in-flight region requests", async () => {
    await env.SWITCH_DB.prepare("DELETE FROM games").run();
    await env.SWITCH_DB.batch(
      Array.from({ length: 14 }, (_, i) =>
        env.SWITCH_DB.prepare(
          "INSERT INTO games (application_id, title, total_playing_time, first_seen, updated_at) VALUES (?, 'Game', 10, 1, 1)"
        ).bind(`GAME${i}`)
      )
    );
    let active = 0;
    let peak = 0;
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return page("", 404);
    });
    expect(await resolveStoreFacts(env, Date.now())).toBe(0);
    expect(fetched).toHaveBeenCalledTimes(24);
    expect(peak).toBe(4);
    expect(
      await env.SWITCH_DB.prepare(
        "SELECT COUNT(*) AS count FROM games WHERE store_checked_at IS NOT NULL"
      ).first()
    ).toEqual({ count: 12 });
  });
});
