/**
 * The ledger: the slice of the self-hosted Wealthfolio (`WEALTHFOLIO_URL`)
 * this Worker reads, through its MCP endpoint (`/mcp`, Streamable HTTP)
 * with a personal access token (`WEALTHFOLIO_TOKEN`) minted with read
 * scopes only — it cannot change an activity.
 *
 * Wealthfolio values every account daily with its cash and records every
 * deposit and withdrawal, which is what a return on the money put in
 * needs. Those amounts reach this file and `compose.ts` and stop there:
 * every type below is the narrowed slice composition reads, and the
 * payload carries only ratios of them.
 */

import { fetchOk } from "../../lib/http";
import { isNumber, isRecord, textOrNull } from "../../lib/narrow";

/** A tool that values a whole history takes a while on a cold server. */
const WEALTHFOLIO_TIMEOUT_MS = 20_000;

/** The MCP revision the endpoint speaks (Wealthfolio 3.12). */
const PROTOCOL_VERSION = "2025-06-18";

export interface WfAccount {
  id: string;
  name: string;
}

/** One calendar day of an account (or of every account), in the base
 *  currency. */
export interface WfDay {
  date: string;
  /** Holdings and cash at the day's close. */
  value: number;
  /** Money put in to date, net of money taken out. */
  invested: number;
}

export interface WfHolding {
  symbol: string;
  name: string;
  /** ISO 4217, the currency it is quoted in. */
  currency: string;
  /** Market value in the base currency. */
  value: number;
  /** Average price paid per share, in `currency`; null when the position
   *  has no cost on record. A price, never an amount. */
  cost: number | null;
  /** The position's own return: gain (realised, unrealised and income)
   *  over what went into it. */
  performance: number | null;
  /** The day it was first bought. */
  since: string | null;
}

export interface WfHoldings {
  holdings: WfHolding[];
  /** Every holding's value, cash excluded — the endpoint lists at most a
   *  page of positions and leaves the smallest out, but counts them here. */
  total: number;
}

/** Cash in one currency, valued in the base currency. */
export interface WfCash {
  currency: string;
  value: number;
}

export interface Wealthfolio {
  accounts(): Promise<WfAccount[]>;
  /** The whole history of one account, or of every account together. */
  days(accountId?: string): Promise<WfDay[]>;
  holdings(accountId?: string): Promise<WfHoldings>;
  /** Cash by account id. */
  cash(): Promise<Map<string, WfCash[]>>;
  /** End the MCP session. */
  close(): Promise<void>;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const day = (value: unknown): string | null =>
  typeof value === "string" && DAY_RE.test(value.slice(0, 10)) ? value.slice(0, 10) : null;

const list = (body: unknown, key: string, what: string): unknown[] => {
  const items = isRecord(body) ? body[key] : null;
  if (!Array.isArray(items)) throw new Error(`Wealthfolio ${what} has no ${key}`);
  return items;
};

function narrowAccounts(body: unknown): WfAccount[] {
  return list(body, "accounts", "accounts").map((account) => {
    const id = isRecord(account) ? textOrNull(account.id) : null;
    const name = isRecord(account) ? textOrNull(account.name) : null;
    if (!id || !name) throw new Error("Wealthfolio account without id or name");
    return { id, name };
  });
}

function narrowDays(body: unknown): WfDay[] {
  return list(body, "valuations", "valuations").map((item) => {
    const date = isRecord(item) ? day(item.date) : null;
    if (!date || !isRecord(item) || !isNumber(item.totalValue) || !isNumber(item.netContribution)) {
      throw new Error("Wealthfolio valuation lacks a date, value or contribution");
    }
    return { date, value: item.totalValue, invested: item.netContribution };
  });
}

function narrowHoldings(body: unknown): WfHoldings {
  const total = isRecord(body) ? body.totalValue : null;
  if (!isNumber(total)) throw new Error("Wealthfolio holdings have no total");
  const holdings = list(body, "holdings", "holdings").map((item): WfHolding => {
    if (!isRecord(item)) throw new Error("Wealthfolio holding is not an object");
    const symbol = textOrNull(item.symbol);
    const currency = textOrNull(item.localCurrency) ?? textOrNull(item.currency);
    const { marketValueBase: value, quantity, costBasisLocal } = item;
    if (!symbol || !currency || !isNumber(value)) {
      throw new Error("Wealthfolio holding lacks a symbol, currency or value");
    }
    return {
      symbol,
      name: textOrNull(item.name) ?? symbol,
      currency,
      value,
      cost:
        isNumber(quantity) && isNumber(costBasisLocal) && quantity > 0 && costBasisLocal > 0
          ? costBasisLocal / quantity
          : null,
      performance: isNumber(item.totalReturnPct) ? item.totalReturnPct : null,
      since: day(item.openDate),
    };
  });
  return { holdings, total };
}

/**
 * Cash by account. Each balance is in its own currency and only the
 * account's total is valued in the base currency, so a balance in the
 * account's currency is taken as is and the rest of the total is shared
 * among the others by amount — exact while an account holds at most one
 * foreign currency, which is all a stray conversion leaves behind.
 */
function narrowCash(body: unknown): Map<string, WfCash[]> {
  const cash = new Map<string, WfCash[]>();
  for (const account of list(body, "accounts", "cash balances")) {
    if (!isRecord(account)) throw new Error("Wealthfolio cash entry is not an object");
    const id = textOrNull(account.accountId);
    const home = textOrNull(account.accountCurrency);
    const total = account.totalBaseCurrency;
    if (!id || !home || !isNumber(total)) {
      throw new Error("Wealthfolio cash entry lacks an account, currency or total");
    }
    const balances = list(account, "balances", "cash entry").flatMap((balance) => {
      const currency = isRecord(balance) ? textOrNull(balance.currency) : null;
      const amount = isRecord(balance) ? balance.amount : null;
      return currency && isNumber(amount) ? [{ currency, amount }] : [];
    });
    const homeValue = balances
      .filter((balance) => balance.currency === home)
      .reduce((sum, balance) => sum + balance.amount, 0);
    const foreign = balances.filter((balance) => balance.currency !== home);
    const foreignAmount = foreign.reduce((sum, balance) => sum + balance.amount, 0);
    cash.set(id, [
      ...(homeValue !== 0 ? [{ currency: home, value: homeValue }] : []),
      ...foreign.map((balance) => ({
        currency: balance.currency,
        value: foreignAmount === 0 ? 0 : ((total - homeValue) * balance.amount) / foreignAmount,
      })),
    ]);
  }
  return cash;
}

/** The JSON-RPC message an MCP answer carries, from a JSON body or the
 *  last data line of an event stream. */
function message(text: string): unknown {
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  return JSON.parse(data.at(-1) ?? text);
}

/** Open a session and return a reader bound to it. */
export async function connect(env: Env): Promise<Wealthfolio> {
  const endpoint = new URL("/mcp", env.WEALTHFOLIO_URL);
  let session: string | null = null;
  let id = 0;

  const post = async (body: Record<string, unknown>) => {
    const response = await fetchOk("Wealthfolio", endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${env.WEALTHFOLIO_TOKEN}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        ...(session ? { "Mcp-Session-Id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      signal: AbortSignal.timeout(WEALTHFOLIO_TIMEOUT_MS),
    });
    session = response.headers.get("Mcp-Session-Id") ?? session;
    return response;
  };

  const request = async (method: string, params: Record<string, unknown>) => {
    const answer = message(await (await post({ id: ++id, method, params })).text());
    if (!isRecord(answer) || !isRecord(answer.result)) {
      const error =
        isRecord(answer) && isRecord(answer.error) ? textOrNull(answer.error.message) : null;
      throw new Error(`Wealthfolio ${method} failed: ${error ?? "no result"}`);
    }
    return answer.result;
  };

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const result = await request("tools/call", { name, arguments: args });
    const text = Array.isArray(result.content)
      ? result.content
          .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
          .join("")
      : "";
    if (result.isError === true)
      throw new Error(`Wealthfolio ${name} failed: ${text.slice(0, 200)}`);
    return result.structuredContent ?? JSON.parse(text);
  };

  await request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "cf-workers-api", version: "1" },
  });
  await post({ method: "notifications/initialized" });

  const scoped = (accountId?: string) => (accountId ? { accountId } : {});
  return {
    accounts: async () => narrowAccounts(await call("get_accounts", { displayMode: "compact" })),
    days: async (accountId) =>
      narrowDays(
        await call("get_valuation_history", { startDate: "1970-01-01", ...scoped(accountId) })
      ),
    holdings: async (accountId) =>
      narrowHoldings(await call("get_holdings", { viewMode: "table", ...scoped(accountId) })),
    cash: async () => narrowCash(await call("get_cash_balances")),
    close: async () => {
      if (!session) return;
      await fetch(endpoint, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${env.WEALTHFOLIO_TOKEN}`, "Mcp-Session-Id": session },
        signal: AbortSignal.timeout(5_000),
      }).catch(() => undefined);
    },
  };
}
