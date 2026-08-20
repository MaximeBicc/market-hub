import type { Money } from "./types.js";

/** Parse "12.34" / 12.34 vers des centimes, sans passer par un float intermédiaire arrondi. */
export function toMinorUnits(value: string | number, currency: string): Money {
  const s = typeof value === "number" ? value.toFixed(2) : value.trim();
  const negative = s.startsWith("-");
  const [whole = "0", frac = ""] = s.replace("-", "").split(".");
  const cents = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return { amount: negative ? -cents : cents, currency: currency.toUpperCase() };
}

export function formatMoney(m: Money, locale = "fr-FR"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: m.currency,
  }).format(m.amount / 100);
}
