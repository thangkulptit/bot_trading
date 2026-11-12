/**
 * Đăng nhập tài khoản MT5 (Exness) vào MetaApi cloud để bot đặt lệnh từ Linux/Node.js.
 *
 *   METAAPI_TOKEN=... MT5_LOGIN=... MT5_PASSWORD=... MT5_SERVER=Exness-MT5Trial8 npm run mt5:connect
 *
 * - MT5_PASSWORD phải là mật khẩu giao dịch (master), không phải investor password.
 * - Chạy lại an toàn: nếu tài khoản đã có trên MetaApi thì dùng lại, không tạo trùng.
 * - Kết quả in ra METAAPI_ACCOUNT_ID, METAAPI_REGION và tên symbol vàng để điền vào .env.
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import { MetaApiClient } from '../market/MetaApiClient';

const PROVISIONING = 'https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts';

interface MetaApiAccount {
  _id?: string;
  id?: string;
  login: string;
  server: string;
  name: string;
  region?: string;
  state: string;
  connectionStatus?: string;
}

function env(name: string, fallback?: string): string {
  const v = process.env[name] || fallback;
  if (!v) {
    console.error(`Thiếu biến môi trường ${name}`);
    process.exit(1);
  }
  return v;
}

const token = env('METAAPI_TOKEN');
const login = env('MT5_LOGIN');
const server = env('MT5_SERVER');
const region = env('METAAPI_PROVISION_REGION', 'london');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const accountId = (a: MetaApiAccount) => String(a._id ?? a.id);

async function call<T>(url: string, init: RequestInit = {}): Promise<{ status: number; body: T; headers: Headers }> {
  const res = await fetch(url, {
    ...init,
    headers: { 'auth-token': token, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  const body = (text ? JSON.parse(text) : undefined) as T;
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}: ${text.slice(0, 400)}`);
  return { status: res.status, body, headers: res.headers };
}

async function findExisting(): Promise<MetaApiAccount | undefined> {
  const { body } = await call<MetaApiAccount[] | { items: MetaApiAccount[] }>(PROVISIONING);
  const list = Array.isArray(body) ? body : (body.items ?? []);
  return list.find((a) => String(a.login) === login && a.server === server);
}

async function create(): Promise<string> {
  const transactionId = crypto.randomBytes(16).toString('hex');
  const payload = JSON.stringify({
    name: `Exness ${login}`,
    type: 'cloud-g2',
    login,
    password: env('MT5_PASSWORD'),
    server,
    platform: 'mt5',
    magic: Number(process.env.MT5_MAGIC ?? 20261112),
    region,
  });
  // MetaApi trả 202 khi đang xác thực với server MT5 → gửi lại cùng transaction-id cho đến khi có id
  for (let attempt = 0; attempt < 30; attempt++) {
    const { status, body, headers } = await call<{ id?: string; message?: string }>(PROVISIONING, {
      method: 'POST',
      headers: { 'transaction-id': transactionId },
      body: payload,
    });
    if (status !== 202 && body?.id) return body.id;
    const wait = Number(headers.get('retry-after')) || 10;
    console.log(`… MetaApi đang kết nối tới ${server} (${body?.message ?? 'pending'}), thử lại sau ${wait}s`);
    await sleep(wait * 1000);
  }
  throw new Error('Hết thời gian chờ tạo tài khoản MetaApi');
}

async function waitConnected(id: string): Promise<MetaApiAccount> {
  for (let i = 0; i < 60; i++) {
    const { body } = await call<MetaApiAccount>(`${PROVISIONING}/${id}`);
    console.log(`… state=${body.state} connection=${body.connectionStatus ?? '-'}`);
    if (body.state === 'DEPLOYED' && body.connectionStatus === 'CONNECTED') return body;
    if (body.state === 'UNDEPLOYED') await call(`${PROVISIONING}/${id}/deploy`, { method: 'POST' });
    await sleep(10000);
  }
  throw new Error('Tài khoản chưa CONNECTED sau 10 phút — kiểm tra login/password/server');
}

async function main() {
  const existing = await findExisting();
  const id = existing ? accountId(existing) : await create();
  console.log(existing ? `Đã có tài khoản trên MetaApi: ${id}` : `Đã tạo tài khoản MetaApi: ${id}`);

  const account = await waitConnected(id);
  const accRegion = account.region ?? region;
  const client = new MetaApiClient(token, id, accRegion, 'XAUUSD');
  const [info, symbols] = await Promise.all([client.getAccount(), client.getSymbols()]);
  const gold = symbols.filter((s) => s.toUpperCase().startsWith('XAU') && s.toUpperCase().includes('USD'));

  console.log(`\nĐăng nhập MT5 thành công: balance ${info.balance} ${info.currency}, equity ${info.equity}`);
  console.log(`Symbol vàng trên tài khoản: ${gold.join(', ') || '(không tìm thấy)'}`);
  console.log('\nĐiền vào .env:');
  console.log(`METAAPI_ACCOUNT_ID=${id}`);
  console.log(`METAAPI_REGION=${accRegion}`);
  console.log(`SYMBOL=${gold[0] ?? 'XAUUSDm'}`);
  console.log('\nCó thể xoá MT5_PASSWORD khỏi .env sau bước này — MetaApi đã lưu thông tin đăng nhập.');
}

main().catch((e) => {
  console.error('Kết nối MT5 thất bại:', e instanceof Error ? e.message : e);
  process.exit(1);
});
