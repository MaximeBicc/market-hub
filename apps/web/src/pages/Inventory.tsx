import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, money, type ListingRow } from "../lib/api.js";
import { Empty } from "../components/Empty.js";
import { toast } from "../components/Toast.js";

/**
 * Stock multi-canal.
 *
 * Le bloc « présent sur plusieurs canaux » est la raison d'être de l'outil :
 * repérer d'un coup d'œil un même SKU vendu à deux prix différents, ou dont
 * le stock a divergé entre deux plateformes.
 *
 * Toute écriture part dans la file d'attente et revient de façon asynchrone :
 * le message dit « demandée », jamais « effectuée ». Mentir sur ce point
 * rendrait l'interface incompréhensible le jour où une plateforme rejette
 * la modification.
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

  if (data.listings.length === 0) {
    return (
      <>
        <div className="page-head">
          <h1>Stock</h1>
        </div>
        <Empty icon="box" title="Aucune annonce">
          Le catalogue se remplira à la première synchronisation d'une boutique
          connectée. Le catalogue complet est relu une fois par jour, le stock
          toutes les quinze minutes.
        </Empty>
      </>
    );
  }

  const low = data.listings.filter((l) => l.quantity > 0 && l.quantity <= 3).length;
  const out = data.listings.filter((l) => l.quantity === 0).length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Stock</h1>
          <p>
            {data.listings.length} annonce{data.listings.length > 1 ? "s" : ""}
            {out > 0 && ` · ${out} en rupture`}
            {low > 0 && ` · ${low} bas`}
          </p>
        </div>
      </div>

      {data.multiChannel.length > 0 && (
        <>
          <h2 className="sec">
            Présent sur plusieurs canaux
            <span>{data.multiChannel.length} références</span>
          </h2>
          {data.multiChannel.map((g) => {
            const prices = g.listings.map((l) => l.price);
            const spread = Math.max(...prices) - Math.min(...prices);
            return (
              <div className="card" key={g.sku} style={{ marginBottom: 9 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 10,
                  }}
                >
                  <code className="amount">{g.sku}</code>
                  {spread > 0 ? (
                    <span className="pill pill--warn">écart {money(spread)}</span>
                  ) : (
                    <span className="pill pill--ok">aligné</span>
                  )}
                </div>
                <div className="rows">
                  {g.listings.map((l) => (
                    <div className="row" key={l.id} style={{ background: "var(--card-2)" }}>
                      <span className="row__main">{l.platform}</span>
                      <span className="amount">{money(l.price, l.currency)}</span>
                      <span className="muted">{l.quantity} en stock</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </>
      )}

      <h2 className="sec">
        Tout le stock <span>{data.listings.length}</span>
      </h2>
      <div className="rows">
        {data.listings.map((l) => (
          <div
            className={
              l.quantity === 0 ? "row row--out" : l.quantity <= 3 ? "row row--low" : "row"
            }
            key={l.id}
          >
            {l.imageUrl ? (
              <img className="thumb" src={l.imageUrl} alt="" loading="lazy" />
            ) : (
              <span className="mono-badge">{(l.sku ?? "—").slice(0, 2)}</span>
            )}
            <div className="row__main">
              <div className="row__t">{l.title}</div>
              <div className="row__s">
                {l.shopName} · {l.sku ?? "sans SKU"}
              </div>
            </div>
            <div className="row__end">
              <span className="amount">{money(l.price, l.currency)}</span>
              <input
                className="qty"
                type="number"
                min={0}
                defaultValue={l.quantity}
                aria-label={`Quantité — ${l.title}`}
                onBlur={(e) => {
                  const q = Number(e.target.value);
                  if (q !== l.quantity && Number.isInteger(q) && q >= 0) {
                    setStock.mutate({
                      shopId: l.shopId,
                      externalId: l.externalId,
                      quantity: q,
                    });
                    toast(`${l.title} → ${q} · mise à jour demandée`);
                  }
                }}
              />
            </div>
          </div>
        ))}
      </div>

      <p className="muted" style={{ marginTop: 14, lineHeight: 1.55 }}>
        Modifier une quantité part dans la file d'attente. L'écriture chez la
        plateforme est confirmée à la synchronisation suivante, pas au clic.
      </p>
    </>
  );
}
