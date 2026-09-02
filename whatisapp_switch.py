# whatisapp_switch.py
# Always-on-top, translucent quick-switch widget for Whatisapp AI Auto-replier.
# Toggles AI auto-replies on click, and glows:
#   - Steady Cyan/Green when active, steady Gray when inactive
#   - Pulse Red temporarily when an incoming message is received
#   - Pulse Green temporarily when an AI reply is sent
# Built with Python, PyQt5, and WebSockets.
import sys
import os
import time
import math
import json
import threading
import requests

# Reconfigure stdout/stderr to use UTF-8 to prevent charmap encoding errors on Windows
if sys.platform.startswith('win'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

from PyQt5.QtWidgets import (
    QApplication, QWidget, QSystemTrayIcon, QMenu, QAction
)
from PyQt5.QtCore import (
    Qt, QPoint, QTimer, QPointF, pyqtSignal, QObject
)
from PyQt5.QtGui import (
    QIcon, QPixmap, QColor, QPainter, QPen, QBrush, QRadialGradient,
    QPainterPath, QFont
)

# WebSocket client library loading
try:
    import websocket
except ImportError:
    # If not installed, run pip install
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "websocket-client"])
    import websocket

# Thread-safe signal carrier for WebSocket events
class WebSocketsWorkerSignals(QObject):
    state_synced = pyqtSignal(bool, str) # isActive, clientState
    msg_received = pyqtSignal()
    reply_sent = pyqtSignal()

class WhatisappSwitchButton(QWidget):
    WIDGET_SIZE = 96
    OUTER_R = 40
    INNER_R = 26

    def __init__(self, parent):
        super().__init__(parent)
        self._parent = parent
        self.setFixedSize(self.WIDGET_SIZE, self.WIDGET_SIZE)
        self.setMouseTracking(True)

        self._drag_pos = QPoint()
        self._is_dragging = False
        self._press_pos = QPoint()

        # State flags
        self.is_active = False
        self.client_state = "CONNECTING"
        self._hover = False
        self._pressed = False

        # Pulse glow effect states
        # "normal", "flash_red" (incoming msg), "flash_green" (reply sent)
        self.glow_mode = "normal" 
        self.flash_counter = 0

        # Animation ticker
        self._pulse_t = 0.0
        self._pulse_timer = QTimer(self)
        self._pulse_timer.timeout.connect(self._tick_pulse)
        self._pulse_timer.start(30)

    def _tick_pulse(self):
        self._pulse_t = (self._pulse_t + 0.06) % (2 * math.pi)
        
        # If in a flash state, count down frames (~1.5s total = 50 frames)
        if self.glow_mode != "normal":
            self.flash_counter -= 1
            if self.flash_counter <= 0:
                self.glow_mode = "normal"
        
        self.update()

    def set_active_state(self, is_active, client_state):
        self.is_active = is_active
        self.client_state = client_state
        self.update()

    def trigger_flash(self, mode):
        self.glow_mode = mode
        self.flash_counter = 45 # ~1.3 seconds at 30fps
        self.update()

    def _is_inside_circle(self, pos: QPoint):
        cx = self.WIDGET_SIZE / 2
        cy = self.WIDGET_SIZE / 2
        dx = pos.x() - cx
        dy = pos.y() - cy
        r = math.sqrt(dx * dx + dy * dy)
        return r <= self.OUTER_R

    def paintEvent(self, event):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)

        cx = self.WIDGET_SIZE / 2
        cy = self.WIDGET_SIZE / 2
        pulse = 0.5 + 0.5 * math.sin(self._pulse_t)

        # ── 1. Outer Glow (Shadow / Pulse) ───────────────────────────────────
        glow_r = self.OUTER_R + 8 + 4 * pulse
        glow = QRadialGradient(cx, cy, glow_r)

        # Decide glow color based on flash state or current connection state
        if self.glow_mode == "flash_red":
            glow_color = QColor(255, 50, 50, int(150 * (self.flash_counter / 45.0)))
        elif self.glow_mode == "flash_green":
            glow_color = QColor(16, 185, 129, int(150 * (self.flash_counter / 45.0)))
        elif self.is_active:
            # Active glowing Green/Cyan
            glow_color = QColor(16, 185, 129, int(40 + 20 * pulse))
        else:
            # Inactive dark state
            glow_color = QColor(75, 85, 99, int(20 + 10 * pulse))

        glow.setColorAt(0.0, glow_color)
        glow.setColorAt(1.0, QColor(0, 0, 0, 0))
        p.setBrush(QBrush(glow))
        p.setPen(Qt.NoPen)
        p.drawEllipse(QPointF(cx, cy), glow_r, glow_r)

        # ── 2. Button Background ─────────────────────────────────────────────
        bg = QRadialGradient(cx, cy - 6, self.OUTER_R)
        if self._pressed:
            bg.setColorAt(0.0, QColor(17, 24, 39, 255))
            bg.setColorAt(1.0, QColor(10, 15, 25, 255))
        elif self._hover:
            bg.setColorAt(0.0, QColor(31, 41, 55, 230))
            bg.setColorAt(1.0, QColor(17, 24, 39, 240))
        else:
            bg.setColorAt(0.0, QColor(17, 24, 39, 210))
            bg.setColorAt(1.0, QColor(11, 15, 25, 220))

        p.setBrush(QBrush(bg))
        p.setPen(Qt.NoPen)
        p.drawEllipse(QPointF(cx, cy), self.OUTER_R, self.OUTER_R)

        # ── 3. Border Ring ───────────────────────────────────────────────────
        if self.glow_mode == "flash_red":
            border_color = QColor(255, 50, 50, 255)
        elif self.glow_mode == "flash_green":
            border_color = QColor(16, 185, 129, 255)
        elif self.is_active:
            border_color = QColor(16, 185, 129, int(180 + 75 * pulse))
        else:
            border_color = QColor(75, 85, 99, 120)

        pen = QPen(border_color)
        pen.setWidthF(2.5)
        p.setPen(pen)
        p.setBrush(Qt.NoBrush)
        p.drawEllipse(QPointF(cx, cy), self.OUTER_R - 1.25, self.OUTER_R - 1.25)

        # ── 4. Inner Toggle State Circle ─────────────────────────────────────
        inner_bg = QRadialGradient(cx, cy - 3, self.INNER_R)
        if self.is_active:
            inner_bg.setColorAt(0.0, QColor(16, 185, 129, 240))
            inner_bg.setColorAt(1.0, QColor(6, 95, 70, 255))
        else:
            inner_bg.setColorAt(0.0, QColor(75, 85, 99, 200))
            inner_bg.setColorAt(1.0, QColor(31, 41, 55, 220))

        p.setBrush(QBrush(inner_bg))
        p.setPen(Qt.NoPen)
        p.drawEllipse(QPointF(cx, cy), self.INNER_R, self.INNER_R)

        # ── 5. Status text / Symbol ──────────────────────────────────────────
        p.setPen(QColor(255, 255, 255, 230))
        p.setFont(QFont("Outfit", 9, QFont.Bold))
        text = "ON" if self.is_active else "OFF"
        p.drawText(self.rect(), Qt.AlignCenter, text)

        p.end()

    # ---- Mouse & Click Events -----------------------------------------------
    def mouseMoveEvent(self, event):
        self._hover = self._is_inside_circle(event.pos())
        
        if event.buttons() & Qt.LeftButton and not self._parent.is_locked:
            diff = event.globalPos() - self._press_pos
            if diff.manhattanLength() > 15:  # 15px threshold to distinguish click from drag
                self._is_dragging = True
            if self._is_dragging:
                self._parent.move(event.globalPos() - self._drag_pos)
        self.update()
        event.accept()


    def mousePressEvent(self, event):
        if event.button() == Qt.LeftButton:
            print("[Quick Switch] Mouse press event detected.")
            modifiers = event.modifiers()
            if modifiers & Qt.AltModifier:
                print("[Quick Switch] Alt+Click → Quitting.")
                QApplication.quit()
                return
            if modifiers & Qt.ShiftModifier:
                print("[Quick Switch] Shift+Click → Toggling lock.")
                self._parent.toggle_lock()
                event.accept()
                return

            if self._is_inside_circle(event.pos()):
                print("[Quick Switch] Pressed inside circle.")
                self._pressed = True
                self._press_pos = event.globalPos()
                self._drag_pos = event.globalPos() - self._parent.frameGeometry().topLeft()
                self._is_dragging = False
                self.update()
            else:
                print("[Quick Switch] Pressed outside circle.")
        event.accept()

    def mouseReleaseEvent(self, event):
        if event.button() == Qt.LeftButton:
            inside = self._is_inside_circle(event.pos())
            # Check if the total drag distance was small enough to be a click
            total_drag = (event.globalPos() - self._press_pos).manhattanLength()
            is_click = not self._is_dragging and inside
            print(f"[Quick Switch] Mouse release. drag_dist={total_drag}, is_dragging={self._is_dragging}, inside={inside}, treating as click: {is_click}")
            self._pressed = False
            self.update()
            if is_click:
                print("[Quick Switch] Click verified, toggling auto reply...")
                self._parent.toggle_auto_reply()
            self._is_dragging = False
        event.accept()

    def leaveEvent(self, event):
        self._hover = False
        self.update()

    def enterEvent(self, event):
        self.update()


class WhatisappSwitchWidget(QWidget):
    def __init__(self):
        super().__init__()
        self.is_locked = False

        self.setWindowFlags(
            Qt.FramelessWindowHint |
            Qt.WindowStaysOnTopHint |
            Qt.Tool |
            Qt.SubWindow |
            Qt.WindowDoesNotAcceptFocus
        )
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setFixedSize(96, 96)

        # Create button
        self.btn = WhatisappSwitchButton(self)

        # Set up system tray icon
        self._setup_tray()

        # Connect WebSocket signals
        self.signals = WebSocketsWorkerSignals()
        self.signals.state_synced.connect(self.btn.set_active_state)
        self.signals.msg_received.connect(lambda: self.btn.trigger_flash("flash_red"))
        self.signals.reply_sent.connect(lambda: self.btn.trigger_flash("flash_green"))

        # Re-position to bottom-right of primary screen
        screen = QApplication.primaryScreen().geometry()
        self.move(screen.width() - 120, screen.height() - 180)

        # Start WebSocket listener thread
        self.ws_thread = threading.Thread(target=self._ws_listener_loop, daemon=True)
        self.ws_thread.start()

        # HTTP polling fallback: sync state every 5 seconds regardless of WS
        self._poll_timer = QTimer(self)
        self._poll_timer.timeout.connect(self._poll_state)
        self._poll_timer.start(5000)
        # Also poll immediately after a short delay
        QTimer.singleShot(1000, self._poll_state)

    def _setup_tray(self):
        self.tray_icon = QSystemTrayIcon(self)
        
        # Simple tray pixel map
        pixmap = QPixmap(16, 16)
        pixmap.fill(QColor(16, 185, 129))
        self.tray_icon.setIcon(QIcon(pixmap))
        self.tray_icon.setToolTip("Whatisapp AI Switch")

        menu = QMenu()
        toggle_lock_act = QAction("Lock Position", self, checkable=True)
        toggle_lock_act.triggered.connect(self.toggle_lock)
        
        quit_act = QAction("Quit", self)
        quit_act.triggered.connect(QApplication.quit)

        menu.addAction(toggle_lock_act)
        menu.addSeparator()
        menu.addAction(quit_act)
        self.tray_icon.setContextMenu(menu)
        self.tray_icon.show()

    def toggle_lock(self):
        self.is_locked = not self.is_locked
        print(f"[Quick Switch] Position locked: {self.is_locked}")

    def _poll_state(self):
        """HTTP polling fallback to keep button in sync with server state."""
        def do_poll():
            try:
                res = requests.get("http://localhost:3000/api/config", timeout=2)
                if res.status_code == 200:
                    config = res.json()
                    self.signals.state_synced.emit(config["autoReply"], "CONNECTED")
            except Exception:
                pass  # Server offline, don't crash

        threading.Thread(target=do_poll, daemon=True).start()

    def toggle_auto_reply(self):
        # Trigger config update via API
        threading.Thread(target=self._api_toggle_call, daemon=True).start()

    def _api_toggle_call(self):
        try:
            # Fetch current config
            res = requests.get("http://localhost:3000/api/config", timeout=2)
            if res.status_code == 200:
                config = res.json()
                config["autoReply"] = not config.get("autoReply", False)
                
                # Save config
                post_res = requests.post("http://localhost:3000/api/config", json=config, timeout=2)
                if post_res.status_code == 200:
                    result = post_res.json()
                    self.signals.state_synced.emit(result["config"]["autoReply"], self.btn.client_state)
        except Exception as e:
            print("API toggle request failed:", e)

    def _ws_listener_loop(self):
        reconnect_delay = 2
        while True:
            try:
                # Get current config once at start
                try:
                    res = requests.get("http://localhost:3000/api/config", timeout=2)
                    if res.status_code == 200:
                        config = res.json()
                        self.signals.state_synced.emit(config["autoReply"], "CONNECTED")
                        reconnect_delay = 2  # reset on success
                except Exception:
                    pass

                ws = websocket.WebSocketApp(
                    "ws://localhost:3000",
                    on_message=self._on_ws_message,
                    on_error=self._on_ws_error,
                    on_close=self._on_ws_close,
                    on_open=self._on_ws_open
                )
                ws.run_forever(ping_interval=20, ping_timeout=10)
            except Exception as e:
                print("WebSocket listener error:", e)
            
            time.sleep(reconnect_delay)
            reconnect_delay = min(reconnect_delay * 1.5, 15)  # exponential backoff, max 15s

    def _on_ws_message(self, ws, message):
        try:
            data = json.loads(message)
            if data["type"] == "STATUS_SYNC":
                self.signals.state_synced.emit(
                    data["state"]["autoReply"],
                    data["state"]["clientState"]
                )
            elif data["type"] == "NEW_LOG":
                log = data["log"]
                # Flash red on incoming messages, green on reply sent
                if not log.get("reply"):
                    self.signals.msg_received.emit()
                elif log.get("status") == "SUCCESS":
                    self.signals.reply_sent.emit()
        except Exception as e:
            print("Error parsing WebSocket event:", e)

    def _on_ws_open(self, ws):
        print("[Quick Switch] WebSocket connected successfully.")

    def _on_ws_error(self, ws, error):
        print("WebSocket Error:", error)

    def _on_ws_close(self, ws, *args, **kwargs):
        self.signals.state_synced.emit(self.btn.is_active, "OFFLINE")


if __name__ == "__main__":
    app = QApplication(sys.argv)
    widget = WhatisappSwitchWidget()
    widget.show()
    sys.exit(app.exec_())
