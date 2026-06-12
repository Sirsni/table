export const APP_IDS = { CS2: 730, DOTA2: 570, RUST: 252490 } as const;

export type AppId = (typeof APP_IDS)[keyof typeof APP_IDS];

export interface Item {
  id: number;
  appId: number;
  marketHashName: string;
  itemNameId: number | null;
  iconUrl: string | null;
  updatedAt: string;
}

// Цены в минимальных единицах валюты (копейки), integer.
export interface PriceSnapshot {
  itemId: number;
  provider: string;
  buyOrder: number | null;
  sellPrice: number | null;
  volume: number | null;
  fetchedAt: string;
}

export interface PriceQuote {
  marketHashName: string;
  buyOrder: number | null;
  sellPrice: number | null;
  volume: number | null;
}

export interface MarketProvider {
  id: string;
  fetchPrices(appId: AppId): Promise<PriceQuote[]>;
}
