export type Side = 'BUY' | 'SELL';
export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h';

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Quote {
  bid: number;
  ask: number;
  time: number;
}

export interface AccountInfo {
  balance: number;
  equity: number;
  currency: string;
}

export interface Position {
  id: string;
  symbol: string;
  side: Side;
  volume: number;
  openPrice: number;
  currentPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  profit: number;
  openTime: number;
  comment?: string;
}

export interface OpenOrderRequest {
  side: Side;
  volume: number;
  stopLoss: number;
  takeProfit: number;
  comment?: string;
}

export type OrderStatus = 'LIVE' | 'CLOSED';

/** Một lệnh được lưu trong DB (bảng `orders`). */
export interface TradeOrder {
  id: number;
  broker: string;
  positionId: string;
  symbol: string;
  side: Side;
  status: OrderStatus;
  volume: number;
  entryPrice: number;
  initialSL: number | null;
  currentSL: number | null;
  takeProfit: number | null;
  currentPrice: number | null;
  floatingProfit: number | null;
  closePrice: number | null;
  profit: number | null;
  rMultiple: number | null;
  closeReason: string | null;
  source: string;
  aiConfidence: number | null;
  reasoning: string | null;
  openedAt: number;
  closedAt: number | null;
}

export type NewsImpact = 'High' | 'Medium' | 'Low' | 'Holiday';

export interface NewsEvent {
  title: string;
  currency: string;
  time: number;
  impact: NewsImpact;
  forecast?: string;
  previous?: string;
}

export interface MarketSnapshot {
  quote: Quote;
  m1: Candle[];
  m5: Candle[];
  m15: Candle[];
  h1: Candle[];
  h4: Candle[];
}

export interface SignalCandidate {
  side: Side;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  candleTime: number;
  reasons: string[];
}

export interface AIDecision {
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  stopLoss?: number;
  takeProfit?: number;
  reasoning: string;
  riskNotes?: string;
}
