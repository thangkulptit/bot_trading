import type { Mt5BridgeClient } from '../market/Mt5BridgeClient';
import type { AccountInfo, OpenOrderRequest, Position, Quote } from '../types';
import type { Broker } from './Broker';

/** Đặt lệnh thật trên tài khoản MT5 (vd: Exness) qua bridge Python chạy cạnh terminal. */
export class Mt5Broker implements Broker {
  readonly name = 'mt5-live';

  constructor(private client: Mt5BridgeClient) {}

  getQuote(): Promise<Quote> {
    return this.client.getQuote();
  }

  getAccount(): Promise<AccountInfo> {
    return this.client.getAccount();
  }

  getPositions(): Promise<Position[]> {
    return this.client.getPositions();
  }

  openPosition(req: OpenOrderRequest): Promise<string> {
    return this.client.openPosition(req);
  }

  closePosition(id: string): Promise<void> {
    return this.client.closePosition(id);
  }

  modifyPosition(id: string, stopLoss?: number, takeProfit?: number): Promise<void> {
    return this.client.modifyPosition(id, stopLoss, takeProfit);
  }

  getRealizedProfit(id: string): Promise<number | undefined> {
    return this.client.getRealizedProfit(id);
  }
}
