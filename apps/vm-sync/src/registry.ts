import {
  AlibabaAdapter,
  EbayAdapter,
  EtsyAdapter,
  MarketplaceRegistry,
  MockAdapter,
  ShopifyAdapter,
  VintedSafeAdapter,
} from "@hub/engine";

export function buildVmRegistry(): MarketplaceRegistry {
  return new MarketplaceRegistry()
    .register(new MockAdapter())
    .register(new VintedSafeAdapter())
    .register(new ShopifyAdapter())
    .register(new EbayAdapter())
    .register(new EtsyAdapter())
    .register(new AlibabaAdapter());
}
