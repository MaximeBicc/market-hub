import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, money, type ListingRow } from "../lib/api.js";

/**
 * Stock multi-canal.
 *
 * Le bloc « présent sur plusieurs canaux » est la raison d'être de l'outil :
 * repérer d'un coup d'œil un SKU vendu 24 € sur Etsy et 29 € sur eBay, ou dont
 * le stock a divergé entre deux plateformes.
 *
 * Toute écriture part dans la Queue et revient de façon asynchrone : le bouton
 * confirme « mise à jour demandée », jamais « mise à jour effectuée ». Mentir
 * sur ce point rendrait l'interface incompréhensible le jour où une plateforme
 * rejette la modification.
 */
export function Inventory() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["inventory"],
    queryFn: () =>
      api.get<{
        listings: ListingRow[];
        multiChannel: Array<{ sku: string; listings: ListingRow[] }>;
      }>("/inventory"),
  });

  const setStock = useMutation({
    mutationFn: (v: { shopId: string; externalId: string; quantity: number }) =>
      api.post(
        `/listings/${v.shopId}/${encodeURIComponent(v.externalId)}/stock`,
        { quantity: v.quantity },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inventory"] }),
  });

  if (isLoading || !data) return <div className="boot">Chargement…</div>;

  return (
    <div className="page">
      <h1>Stock</h1>

      {data.multiChannel.length > 0 && (
        <>
          <h2>Présent sur plusieurs canaux</h2>
          {data.multiChannel.map((g) => {
            const prices = g.listings.map((l) => l.price);
            const spread = Math.max(...prices) - Math.min(...prices);
            return (
              <div key={g.sku} className="group">
                <div className="group__head">
                  <code>{g.sku}</code>
                  {spread > 0 && (
                    <span className="chip">écart {money(spread)}</span>
                  )}
                </div>
                {g.listings.map((l) => (
                  <div key={l.id} className="row">
                    <span className={`badge badge--${l.platform}`}>
                      {l.platform}
                    </span>
                    <span className="row__main">
                      {money(l.price, l.currency)}
                    </span>
                    <span className="row__end">{l.quantity} en stock</span>
                  </div>
                ))}
              </div>
            );
          })}
        </>
      )}

      <h2>Tout le stock</h2>
      <ul className="list">
        {data.listings.map((l) => (
          <li key={l.id} className={l.quantity <= 3 ? "row row--warn" : "row"}>
            {l.imageUrl && (
              <img src={l.imageUrl} alt="" className="thumb" loading="lazy" />
            )}
            <div className="row__main">
              <div>{l.title}</div>
              <small>
                {l.shopName} · {l.sku ?? "sans SKU"}
              </small>
            </div>
            <div className="row__end">
              <strong>{money(l.price, l.currency)}</strong>
              <input
                type="number"
                min={0}
                defaultValue={l.quantity}
                className="qty"
                onBlur={(e) => {
                  const q = Number(e.target.value);
                  if (q !== l.quantity) {
                    setStock.mutate({
                      shopId: l.shopId,
                      externalId: l.externalId,
                      quantity: q,
                    });
                  }
                }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
