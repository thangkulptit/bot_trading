import type { AccountInfo, OpenOrderRequest, Position, Quote } from '../types';

export interface Broker {
  readonly name: string;
  init?(): Promise<void>;
  /** Giá khớp lệnh thực tế trên broker (có thể lệch so với nguồn phân tích). */
  getQuote(): Promise<Quote>;
  getAccount(): Promise<AccountInfo>;
  /** Chỉ trả về các vị thế của SYMBOL đang giao dịch. */
  getPositions(): Promise<Position[]>;
  /** Trả về id của vị thế mới. */
  openPosition(req: OpenOrderRequest): Promise<string>;
  closePosition(id: string): Promise<void>;
  modifyPosition(id: string, stopLoss?: number, takeProfit?: number): Promise<void>;
  getRealizedProfit(id: string): Promise<number | undefined>;
}
