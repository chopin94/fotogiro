// Piatto motorizzato con ESP32 via Web Bluetooth (servizio "UART" Nordic,
// così si può provare anche con app generiche come nRF Connect).
// Protocollo a righe di testo, vedi firmware/fotogiro_esp32/fotogiro_esp32.ino:
//   R <gradi>   ruota di tot gradi (positivo = antiorario visto dall'alto) -> "DONE <posizione>"
//   A <gradi>   vai alla posizione assoluta                               -> "DONE <posizione>"
//   Z           la posizione attuale diventa 0                           -> "OK"
//   S <gradi/s> velocità                                                 -> "OK"
//   E 0|1       spegni / accendi le bobine del motore                   -> "OK"
//   ?           stato                                                    -> "POS <posizione> IDLE|BUSY"
//   STOP        ferma subito                                             -> "OK"

export const UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // scriviamo qui
const TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // notifiche dal piatto

export const bluetoothAvailable = () => typeof navigator !== 'undefined' && !!navigator.bluetooth;

export class Turntable extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.rx = null;
    this.buffer = '';
    this.waiters = [];
    this.position = 0;
  }

  get connected() { return !!(this.device && this.device.gatt && this.device.gatt.connected); }

  async connect() {
    if (!bluetoothAvailable()) throw new Error('Web Bluetooth non disponibile (usa Chrome su Android)');
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'Fotogiro' }],
      optionalServices: [UART_SERVICE],
    });
    this.device.addEventListener('gattserverdisconnected', () => {
      this.rx = null;
      this.rejectAll(new Error('piatto disconnesso'));
      this.dispatchEvent(new Event('change'));
    });
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(UART_SERVICE);
    this.rx = await svc.getCharacteristic(RX);
    const tx = await svc.getCharacteristic(TX);
    await tx.startNotifications();
    tx.addEventListener('characteristicvaluechanged', (e) => this.onData(new TextDecoder().decode(e.target.value)));
    this.dispatchEvent(new Event('change'));
    await this.command('?', /^POS/);
  }

  disconnect() {
    if (this.connected) this.device.gatt.disconnect();
  }

  onData(text) {
    this.buffer += text;
    let k;
    while ((k = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, k).trim();
      this.buffer = this.buffer.slice(k + 1);
      if (!line) continue;
      const m = line.match(/^(?:DONE|POS)\s+(-?[\d.]+)/);
      if (m) this.position = parseFloat(m[1]);
      this.dispatchEvent(new CustomEvent('line', { detail: line }));
      const i = this.waiters.findIndex((w) => w.re.test(line));
      if (i >= 0) {
        const [w] = this.waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(line);
      }
      if (/^ERR/.test(line) && this.waiters.length) {
        const w = this.waiters.shift();
        clearTimeout(w.timer);
        w.reject(new Error(line));
      }
    }
  }

  rejectAll(err) {
    for (const w of this.waiters) { clearTimeout(w.timer); w.reject(err); }
    this.waiters = [];
  }

  async command(cmd, expect = /^(OK|DONE)/, timeout = 30000) {
    if (!this.rx) throw new Error('piatto non connesso');
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`nessuna risposta a "${cmd}"`));
      }, timeout);
      this.waiters.push({ re: expect, resolve, reject, timer });
    });
    await this.send(cmd);
    return p;
  }

  // Invia una riga senza aspettare risposta (console di debug).
  async send(cmd) {
    if (!this.rx) throw new Error('piatto non connesso');
    await this.rx.writeValue(new TextEncoder().encode(cmd + '\n'));
    this.dispatchEvent(new CustomEvent('sent', { detail: cmd }));
  }

  rotate(deg) { return this.command(`R ${deg.toFixed(2)}`, /^DONE/); }
  zero() { return this.command('Z'); }
  speed(dps) { return this.command(`S ${dps}`); }
  motor(on) { return this.command(`E ${on ? 1 : 0}`); }
  stop() { return this.command('STOP'); }
}
