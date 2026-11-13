"""
MT5 Bridge — API HTTP nội bộ cho bot Node.js đặt lệnh trên MetaTrader 5.

Chạy trên máy Windows có cài MT5 (terminal đã đăng nhập tài khoản Exness, hoặc điền MT5_LOGIN/PASSWORD/SERVER):

    pip install -r requirements.txt
    copy .env.example .env      (rồi sửa BRIDGE_TOKEN, ...)
    python mt5_bridge.py

Mọi request phải có header `x-bridge-token`. Thời gian trả về là UTC (milliseconds),
đã quy đổi từ giờ server của broker.
"""

import os
import secrets
import threading
import time
from contextlib import contextmanager
from typing import Literal, Optional

import MetaTrader5 as mt5
import uvicorn
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

load_dotenv()

TOKEN = os.environ.get("BRIDGE_TOKEN", "")
if len(TOKEN) < 16:
    raise SystemExit("BRIDGE_TOKEN phải có ít nhất 16 ký tự (đặt trong bridge/.env)")

HOST = os.environ.get("BRIDGE_HOST", "127.0.0.1")
PORT = int(os.environ.get("BRIDGE_PORT", "8765"))
MT5_PATH = os.environ.get("MT5_PATH") or None
MT5_LOGIN = os.environ.get("MT5_LOGIN") or None
MT5_PASSWORD = os.environ.get("MT5_PASSWORD") or None
MT5_SERVER = os.environ.get("MT5_SERVER") or None
MAGIC = int(os.environ.get("MT5_MAGIC", "20261112"))
DEVIATION = int(os.environ.get("MT5_DEVIATION", "20"))
OFFSET_SETTING = os.environ.get("MT5_SERVER_UTC_OFFSET_HOURS", "auto")

TIMEFRAMES = {
    "1m": mt5.TIMEFRAME_M1,
    "5m": mt5.TIMEFRAME_M5,
    "15m": mt5.TIMEFRAME_M15,
    "1h": mt5.TIMEFRAME_H1,
    "4h": mt5.TIMEFRAME_H4,
}
OK_RETCODES = {10008, 10009, 10010}  # PLACED, DONE, DONE_PARTIAL
SYMBOL_FILLING_FOK = 1
SYMBOL_FILLING_IOC = 2

# Thư viện MetaTrader5 không thread-safe → mọi lời gọi đi qua một lock
lock = threading.RLock()
_offset_sec: Optional[int] = None if OFFSET_SETTING == "auto" else int(float(OFFSET_SETTING) * 3600)


def fail(status: int, message: str, **extra):
    raise HTTPException(status_code=status, detail={"message": message, **extra})


def last_error() -> list:
    return list(mt5.last_error())


def connect() -> None:
    kwargs = {}
    if MT5_PATH:
        kwargs["path"] = MT5_PATH
    if MT5_LOGIN and MT5_PASSWORD and MT5_SERVER:
        kwargs.update(login=int(MT5_LOGIN), password=MT5_PASSWORD, server=MT5_SERVER)
    if not mt5.initialize(**kwargs):
        raise RuntimeError(f"Không kết nối được MT5: {mt5.last_error()}")


def ensure_connected() -> None:
    info = mt5.terminal_info()
    if info is None or not info.connected:
        mt5.shutdown()
        connect()


@contextmanager
def session():
    with lock:
        try:
            ensure_connected()
        except RuntimeError as e:
            fail(503, str(e))
        yield


def server_offset(symbol: Optional[str]) -> int:
    """Giây chênh giữa giờ server broker và UTC (MT5 trả thời gian theo giờ server)."""
    global _offset_sec
    if OFFSET_SETTING != "auto":
        return _offset_sec or 0
    tick = mt5.symbol_info_tick(symbol) if symbol else None
    if tick is not None:
        diff = tick.time - time.time()
        detected = int(round(diff / 3600) * 3600)
        # chỉ tin khi tick còn mới (< 5 phút); cuối tuần tick cũ sẽ bị bỏ qua
        if abs(diff - detected) <= 300 and abs(detected) <= 14 * 3600:
            _offset_sec = detected
    return _offset_sec or 0


def to_utc_ms(server_ms: int, offset_sec: int) -> int:
    return int(server_ms - offset_sec * 1000)


def symbol_info(symbol: str):
    if not mt5.symbol_select(symbol, True):
        fail(404, f"Symbol {symbol} không tồn tại trên tài khoản", last_error=last_error())
    info = mt5.symbol_info(symbol)
    if info is None:
        fail(404, f"Không đọc được thông tin symbol {symbol}", last_error=last_error())
    return info


def filling_mode(info) -> int:
    if info.filling_mode & SYMBOL_FILLING_FOK:
        return mt5.ORDER_FILLING_FOK
    if info.filling_mode & SYMBOL_FILLING_IOC:
        return mt5.ORDER_FILLING_IOC
    return mt5.ORDER_FILLING_RETURN


def get_position(ticket: int):
    items = mt5.positions_get(ticket=ticket)
    if not items:
        fail(404, f"Không tìm thấy vị thế {ticket}")
    return items[0]


def send(request: dict):
    terminal = mt5.terminal_info()
    if terminal is not None and not terminal.trade_allowed:
        fail(409, "Nút Algo Trading trong MT5 đang TẮT — bật lên để bot đặt lệnh")
    result = mt5.order_send(request)
    if result is None:
        fail(502, "order_send không phản hồi", last_error=last_error())
    if result.retcode not in OK_RETCODES:
        fail(422, f"Lệnh bị từ chối: {result.comment}", retcode=result.retcode)
    return result


def auth(x_bridge_token: str = Header(default="")):
    if not secrets.compare_digest(x_bridge_token, TOKEN):
        fail(401, "Unauthorized")


app = FastAPI(title="MT5 Bridge", dependencies=[Depends(auth)])


class OrderIn(BaseModel):
    symbol: str
    side: Literal["BUY", "SELL"]
    volume: float = Field(gt=0)
    sl: float = Field(gt=0, description="Bắt buộc có SL")
    tp: Optional[float] = None
    comment: str = "xau-bot"


class ModifyIn(BaseModel):
    sl: Optional[float] = None
    tp: Optional[float] = None


@app.get("/health")
def health(symbol: str = ""):
    with session():
        t = mt5.terminal_info()
        a = mt5.account_info()
        if symbol and mt5.symbol_select(symbol, True):
            server_offset(symbol)
        return {
            "connected": bool(t and t.connected),
            "algo_trading": bool(t and t.trade_allowed),
            "account_trade_allowed": bool(a and a.trade_allowed),
            "login": a.login if a else None,
            "server": a.server if a else None,
            "company": t.company if t else None,
            "server_utc_offset_hours": (_offset_sec or 0) / 3600,
        }


@app.get("/account")
def account():
    with session():
        a = mt5.account_info()
        if a is None:
            fail(503, "Không đọc được thông tin tài khoản", last_error=last_error())
        return {
            "login": a.login,
            "balance": a.balance,
            "equity": a.equity,
            "currency": a.currency,
            "leverage": a.leverage,
            "trade_allowed": a.trade_allowed,
        }


@app.get("/symbols")
def symbols(filter: str = ""):
    with session():
        items = mt5.symbols_get(group=f"*{filter}*") if filter else mt5.symbols_get()
        return [s.name for s in (items or [])]


@app.get("/quote/{symbol}")
def quote(symbol: str):
    with session():
        symbol_info(symbol)
        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            fail(503, f"Chưa có giá cho {symbol}", last_error=last_error())
        offset = server_offset(symbol)
        return {"bid": tick.bid, "ask": tick.ask, "time": to_utc_ms(tick.time_msc, offset)}


@app.get("/candles/{symbol}")
def candles(symbol: str, tf: str, count: int = 200):
    if tf not in TIMEFRAMES:
        fail(400, f"Khung thời gian không hỗ trợ: {tf}")
    count = max(1, min(count, 5000))
    with session():
        symbol_info(symbol)
        rates = mt5.copy_rates_from_pos(symbol, TIMEFRAMES[tf], 0, count)
        if rates is None:
            fail(503, f"Không lấy được nến {symbol} {tf}", last_error=last_error())
        offset = server_offset(symbol)
        return [
            {
                "time": to_utc_ms(int(r["time"]) * 1000, offset),
                "open": float(r["open"]),
                "high": float(r["high"]),
                "low": float(r["low"]),
                "close": float(r["close"]),
                "volume": int(r["tick_volume"]),
            }
            for r in rates
        ]


@app.get("/positions")
def positions(symbol: str = ""):
    with session():
        items = mt5.positions_get(symbol=symbol) if symbol else mt5.positions_get()
        offset = server_offset(symbol or None)
        return [
            {
                "ticket": str(p.ticket),
                "symbol": p.symbol,
                "side": "BUY" if p.type == mt5.POSITION_TYPE_BUY else "SELL",
                "volume": p.volume,
                "open_price": p.price_open,
                "current_price": p.price_current,
                "sl": p.sl or None,
                "tp": p.tp or None,
                "profit": round(p.profit + p.swap, 2),
                "open_time": to_utc_ms(p.time_msc, offset),
                "comment": p.comment,
                "magic": p.magic,
            }
            for p in (items or [])
        ]


@app.post("/orders")
def open_order(body: OrderIn):
    with session():
        info = symbol_info(body.symbol)
        tick = mt5.symbol_info_tick(body.symbol)
        if tick is None:
            fail(503, f"Chưa có giá cho {body.symbol}")
        is_buy = body.side == "BUY"
        result = send(
            {
                "action": mt5.TRADE_ACTION_DEAL,
                "symbol": body.symbol,
                "volume": float(body.volume),
                "type": mt5.ORDER_TYPE_BUY if is_buy else mt5.ORDER_TYPE_SELL,
                "price": tick.ask if is_buy else tick.bid,
                "sl": round(body.sl, info.digits),
                "tp": round(body.tp, info.digits) if body.tp else 0.0,
                "deviation": DEVIATION,
                "magic": MAGIC,
                "comment": body.comment[:31],
                "type_time": mt5.ORDER_TIME_GTC,
                "type_filling": filling_mode(info),
            }
        )
        position_id = result.order
        if result.deal:
            deals = mt5.history_deals_get(ticket=result.deal)
            if deals:
                position_id = deals[0].position_id
        return {"ticket": str(position_id), "price": result.price, "volume": result.volume}


@app.post("/positions/{ticket}/modify")
def modify(ticket: int, body: ModifyIn):
    with session():
        pos = get_position(ticket)
        info = symbol_info(pos.symbol)
        send(
            {
                "action": mt5.TRADE_ACTION_SLTP,
                "position": ticket,
                "symbol": pos.symbol,
                "sl": round(body.sl, info.digits) if body.sl else 0.0,
                "tp": round(body.tp, info.digits) if body.tp else 0.0,
                "magic": MAGIC,
            }
        )
        return {"ok": True}


@app.post("/positions/{ticket}/close")
def close(ticket: int):
    with session():
        pos = get_position(ticket)
        info = symbol_info(pos.symbol)
        tick = mt5.symbol_info_tick(pos.symbol)
        is_buy = pos.type == mt5.POSITION_TYPE_BUY
        send(
            {
                "action": mt5.TRADE_ACTION_DEAL,
                "position": ticket,
                "symbol": pos.symbol,
                "volume": pos.volume,
                "type": mt5.ORDER_TYPE_SELL if is_buy else mt5.ORDER_TYPE_BUY,
                "price": tick.bid if is_buy else tick.ask,
                "deviation": DEVIATION,
                "magic": MAGIC,
                "comment": "xau-bot close",
                "type_time": mt5.ORDER_TIME_GTC,
                "type_filling": filling_mode(info),
            }
        )
        return {"ok": True}


@app.get("/deals/position/{ticket}")
def deals(ticket: int):
    with session():
        items = mt5.history_deals_get(position=ticket) or ()
        closed = any(d.entry == mt5.DEAL_ENTRY_OUT for d in items)
        total = sum(d.profit + d.commission + d.swap + getattr(d, "fee", 0.0) for d in items)
        return {"deals": len(items), "closed": closed, "profit": round(total, 2)}


if __name__ == "__main__":
    with lock:
        connect()
        acc = mt5.account_info()
    print(f"MT5 đã kết nối: login {acc.login if acc else '?'} @ {acc.server if acc else '?'}", flush=True)
    if HOST != "127.0.0.1":
        print(f"CẢNH BÁO: bridge mở ra ngoài ({HOST}) — chỉ dùng sau firewall/VPN, giữ BRIDGE_TOKEN bí mật", flush=True)
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
