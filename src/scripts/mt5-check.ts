/**
 * Kiểm tra kết nối bot → MT5 bridge → terminal MT5 và gợi ý tên symbol vàng.
 *
 *   npm run mt5:check
 */
import 'dotenv/config';
import { Mt5BridgeClient } from '../market/Mt5BridgeClient';

async function main() {
  const url = process.env.MT5_BRIDGE_URL || 'http://127.0.0.1:8765';
  const token = process.env.MT5_BRIDGE_TOKEN;
  if (!token) throw new Error('Thiếu MT5_BRIDGE_TOKEN trong .env');
  const symbol = process.env.SYMBOL || 'XAUUSD';
  const client = new Mt5BridgeClient(url, token, symbol);

  const health = await client.health();
  console.log(`Bridge ${url}: MT5 ${health.connected ? 'ĐÃ kết nối' : 'CHƯA kết nối'} — ${health.company ?? '?'}`);
  console.log(`Tài khoản ${health.login} @ ${health.server}, giờ server lệch UTC ${health.server_utc_offset_hours}h`);
  console.log(`Algo Trading: ${health.algo_trading ? 'BẬT' : 'TẮT ← cần bật nút Algo Trading trong MT5'}`);
  if (!health.account_trade_allowed) console.log('Tài khoản đang bị chặn giao dịch (account trade not allowed)');

  const [account, gold] = await Promise.all([client.getAccount(), client.getSymbols('XAU')]);
  console.log(`Balance ${account.balance} ${account.currency}, equity ${account.equity}`);
  console.log(`Symbol vàng trên tài khoản: ${gold.join(', ') || '(không có)'}`);

  if (!gold.includes(symbol)) {
    console.log(`\nSYMBOL=${symbol} không có trên tài khoản → sửa .env: SYMBOL=${gold.find((s) => s.includes('USD')) ?? gold[0]}`);
    return;
  }
  const [quote, m5] = await Promise.all([client.getQuote(), client.getCandles('5m', 3)]);
  const lag = Math.round((Date.now() - quote.time) / 1000);
  console.log(`\n${symbol}: bid ${quote.bid} / ask ${quote.ask} (spread ${(quote.ask - quote.bid).toFixed(2)}), tick cách đây ${lag}s`);
  console.log(`Nến M5 gần nhất (UTC): ${new Date(m5[m5.length - 1].time).toISOString()}`);
  console.log('\nKết nối OK.');
}

main().catch((e) => {
  console.error('Kiểm tra thất bại:', e instanceof Error ? e.message : e);
  process.exit(1);
});
