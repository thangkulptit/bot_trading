import type { AccountInfo, OpenOrderRequest, Position, Quote } from '../types';
import type { MetaApiClient } from '../market/MetaApiClient';
import type { Broker } from './Broker';

/** Đặt lệnh thật trên tài khoản MT5 (vd: Exness) thông qua MetaApi cloud. */
export class MetaApiBroker implements Broker {
  readonly name = 'metaapi-live';

  constructor(private client: MetaApiClient) {}

  getQuote(): Promise<Quote> {
    return this.client.getQuote();
  }

  getAccount(): Promise<AccountInfo> {
    return this.client.getAccount();
  }

  getPositions(): Promise<Position[]> {
    return this.client.getPositions();
  }

  async openPosition(req: OpenOrderRequest): Promise<string> {
    const res = await this.client.trade({
      actionType: req.side === 'BUY' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL',
      symbol: this.client.symbol,
      volume: req.volume,
      stopLoss: req.stopLoss,
      takeProfit: req.takeProfit,
      // MT5 giới hạn comment ~31 ký tự
      comment: (req.comment ?? 'xau-bot').slice(0, 31),
    });
    const id = res.positionId ?? res.orderId;
    if (!id) throw new Error('MetaApi không trả về positionId');
    return String(id);
  }

  async closePosition(id: string): Promise<void> {
    await this.client.trade({ actionType: 'POSITION_CLOSE_ID', positionId: id });
  }

  async modifyPosition(id: string, stopLoss?: number, takeProfit?: number): Promise<void> {
    await this.client.trade({ actionType: 'POSITION_MODIFY', positionId: id, stopLoss, takeProfit });
  }

  getRealizedProfit(id: string): Promise<number | undefined> {
    return this.client.getRealizedProfit(id);
  }
}
