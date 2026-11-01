// Fotogiro – firmware del piatto rotante per ESP32
//
// Il telefono (PWA Fotogiro, Chrome su Android) si collega via Bluetooth LE e
// comanda il piatto: ruota di un passo, aspetta che sia fermo, scatta, ripete.
// Senza telefono collegato, il tasto BOOT avvia un giro autonomo a passi con
// pause: l'app riconosce da sola quando il piatto è fermo (va bene anche su iPhone).
//
// Protocollo (righe di testo, uguale via Bluetooth e via Serial a 115200):
//   R <gradi>   ruota di tot gradi (positivo = antiorario visto dall'alto) -> DONE <posizione>
//   A <gradi>   vai alla posizione assoluta                               -> DONE <posizione>
//   Z           la posizione attuale diventa 0                           -> OK
//   S <gradi/s> velocità massima del piatto                              -> OK
//   E 0|1       spegni / accendi le bobine (il 28BYJ-48 scalda se resta acceso)
//   M <n> <gradi> <pausa ms>   giro autonomo: n passi da tot gradi con pausa
//   ?           stato                                                    -> POS <posizione> IDLE|BUSY
//   STOP        ferma subito                                             -> OK
//
// Librerie: solo quelle incluse nel core "esp32" di Espressif (2.x o 3.x).

#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// =========================== CONFIGURAZIONE ===============================

// Scegli UN driver (commenta l'altro).
#define DRIVER_ULN2003   // motore 28BYJ-48 con schedina ULN2003
// #define DRIVER_STEPDIR  // NEMA17 con A4988 / DRV8825 / TMC2208

#if defined(DRIVER_ULN2003)
const int PIN_IN1 = 16, PIN_IN2 = 17, PIN_IN3 = 18, PIN_IN4 = 19;
const float MOTOR_STEPS_PER_REV = 4096.0;  // 28BYJ-48 in mezzo passo (circa 4076 reali)
const float MOTOR_MAX_STEPS_S = 900.0;     // oltre perde passi
#elif defined(DRIVER_STEPDIR)
const int PIN_STEP = 26, PIN_DIR = 27, PIN_EN = 25;  // EN attivo basso
const float MOTOR_STEPS_PER_REV = 200.0 * 16;        // 1,8° e microstep 1/16
const float MOTOR_MAX_STEPS_S = 6000.0;
#else
#error "Scegli DRIVER_ULN2003 oppure DRIVER_STEPDIR"
#endif

// Giri del motore per un giro del piatto. Con trasmissione diretta = 1.
// Con ingranaggi: denti della corona del piatto / denti del pignone (es. 60 / 12 = 5).
const float GEAR_RATIO = 1.0;
const bool INVERT_DIR = false;        // se il piatto gira al contrario
const float DEFAULT_SPEED_DEG_S = 30;  // velocità del piatto
const float ACCEL_DEG_S2 = 90;         // accelerazione (più bassa = partenze più dolci)

const int PIN_BUTTON = 0;              // tasto BOOT della scheda
const int PIN_LED = 2;                 // LED della scheda (-1 se non c'è)
const int AUTO_STEPS = 72;             // giro autonomo: 72 passi...
const float AUTO_DEG = 5.0;            // ...da 5°
const unsigned long AUTO_PAUSE_MS = 1500;

const char *DEVICE_NAME = "Fotogiro";

// ===========================================================================

#define UART_SERVICE "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define UART_RX      "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
#define UART_TX      "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

const float STEPS_PER_DEG = MOTOR_STEPS_PER_REV * GEAR_RATIO / 360.0;

long posSteps = 0;
long targetSteps = 0;
float speed = 0;  // passi/s attuali
float maxSpeed = 0;
float accel = 0;
unsigned long lastStepUs = 0;
bool moving = false;
bool reportDone = false;
bool coilsOn = false;

enum AutoState { AUTO_OFF, AUTO_MOVING, AUTO_PAUSE };
AutoState autoState = AUTO_OFF;
bool autoRun = false;
int autoLeft = 0;
float autoDeg = AUTO_DEG;
unsigned long autoPause = AUTO_PAUSE_MS;
unsigned long autoNextMs = 0;

BLECharacteristic *txChar = nullptr;
bool bleConnected = false;
QueueHandle_t rxQueue;
String line;

// ------------------------------------------------------------------ motore

#if defined(DRIVER_ULN2003)
const uint8_t HALF_STEP[8][4] = {
  {1, 0, 0, 0}, {1, 1, 0, 0}, {0, 1, 0, 0}, {0, 1, 1, 0},
  {0, 0, 1, 0}, {0, 0, 1, 1}, {0, 0, 0, 1}, {1, 0, 0, 1},
};
const int COIL_PINS[4] = {PIN_IN1, PIN_IN2, PIN_IN3, PIN_IN4};
int phase = 0;

void writePhase() {
  for (int i = 0; i < 4; i++) digitalWrite(COIL_PINS[i], coilsOn ? HALF_STEP[phase][i] : 0);
}
#endif

void setCoils(bool on) {
  coilsOn = on;
#if defined(DRIVER_ULN2003)
  writePhase();
#else
  digitalWrite(PIN_EN, on ? LOW : HIGH);
#endif
}

void stepOnce(int dir) {
  if (!coilsOn) setCoils(true);
  int d = INVERT_DIR ? -dir : dir;
#if defined(DRIVER_ULN2003)
  phase = (phase + d + 8) % 8;
  writePhase();
#else
  digitalWrite(PIN_DIR, d > 0 ? HIGH : LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_STEP, HIGH);
  delayMicroseconds(3);
  digitalWrite(PIN_STEP, LOW);
#endif
  posSteps += dir;
}

float positionDeg() {
  return posSteps / STEPS_PER_DEG;
}

void setSpeedDeg(float dps) {
  maxSpeed = constrain(dps * STEPS_PER_DEG, 5.0f, MOTOR_MAX_STEPS_S);
}

void moveTo(long steps) {
  targetSteps = steps;
  reportDone = true;
}

// Rampa trapezoidale: accelera, viaggia, rallenta in tempo per fermarsi sul bersaglio.
void updateMotion() {
  long remaining = targetSteps - posSteps;
  if (remaining == 0) {
    if (moving) {
      moving = false;
      speed = 0;
    }
    return;
  }
  moving = true;
  const float vMin = sqrtf(2.0f * accel);
  if (speed < vMin) speed = vMin;
  unsigned long now = micros();
  if (now - lastStepUs < (unsigned long)(1e6f / speed)) return;
  lastStepUs = now;
  stepOnce(remaining > 0 ? 1 : -1);
  long left = labs(targetSteps - posSteps);
  float vStop = sqrtf(2.0f * accel * left);
  float v = speed + accel / speed;
  speed = max(vMin, min(min(v, maxSpeed), vStop));
}

// ------------------------------------------------------------------ comunicazione

void reply(const String &msg) {
  Serial.println(msg);
  if (!bleConnected || !txChar) return;
  String s = msg + "\n";
  // notifiche a pezzi da 20 byte: funziona con qualsiasi MTU
  for (unsigned int i = 0; i < s.length(); i += 20) {
    String part = s.substring(i, min(s.length(), i + 20));
    txChar->setValue((uint8_t *)part.c_str(), part.length());
    txChar->notify();
    delay(4);
  }
}

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *) override { bleConnected = true; }
  void onDisconnect(BLEServer *server) override {
    bleConnected = false;
    server->startAdvertising();
  }
};

class RxCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) override {
    auto v = c->getValue();  // std::string nel core 2.x, String nel 3.x
    const char *p = v.c_str();
    for (size_t i = 0; i < v.length(); i++) xQueueSend(rxQueue, &p[i], 0);
  }
};

void startAuto(int n, float deg, unsigned long pauseMs) {
  autoLeft = n;
  autoDeg = deg;
  autoPause = pauseMs;
  autoRun = n > 0;
  // si parte con una pausa: l'app scatta anche la posizione iniziale
  autoState = autoRun ? AUTO_PAUSE : AUTO_OFF;
  autoNextMs = millis() + autoPause;
  reply(autoRun ? "OK AUTO" : "OK");
}

void handleCommand(String cmd) {
  cmd.trim();
  if (!cmd.length()) return;
  String up = cmd;
  up.toUpperCase();
  if (up == "STOP") {
    targetSteps = posSteps;
    speed = 0;
    autoRun = false;
    reportDone = false;
    reply("OK");
    return;
  }
  char c = up.charAt(0);
  String arg = cmd.substring(1);
  arg.trim();
  switch (c) {
    case 'R':
      moveTo(targetSteps + lroundf(arg.toFloat() * STEPS_PER_DEG));
      break;
    case 'A':
      moveTo(lroundf(arg.toFloat() * STEPS_PER_DEG));
      break;
    case 'Z':
      posSteps = targetSteps = 0;
      reply("OK");
      break;
    case 'S':
      setSpeedDeg(arg.toFloat());
      reply("OK");
      break;
    case 'E':
      setCoils(arg.toInt() != 0);
      reply("OK");
      break;
    case 'M': {
      int n = AUTO_STEPS;
      float deg = AUTO_DEG;
      long pause = AUTO_PAUSE_MS;
      sscanf(arg.c_str(), "%d %f %ld", &n, &deg, &pause);
      startAuto(n, deg, pause);
      break;
    }
    case '?':
      reply(String("POS ") + String(positionDeg(), 2) + (moving || autoRun ? " BUSY" : " IDLE"));
      break;
    default:
      reply("ERR comando?");
  }
}

void readInput() {
  char ch;
  while (xQueueReceive(rxQueue, &ch, 0) == pdTRUE) {
    if (ch == '\n' || ch == '\r') { handleCommand(line); line = ""; }
    else if (line.length() < 64) line += ch;
  }
  static String serialLine;
  while (Serial.available()) {
    char s = Serial.read();
    if (s == '\n' || s == '\r') { handleCommand(serialLine); serialLine = ""; }
    else if (serialLine.length() < 64) serialLine += s;
  }
}

// ------------------------------------------------------------------ setup / loop

void setup() {
  Serial.begin(115200);
#if defined(DRIVER_ULN2003)
  for (int i = 0; i < 4; i++) pinMode(COIL_PINS[i], OUTPUT);
#else
  pinMode(PIN_STEP, OUTPUT);
  pinMode(PIN_DIR, OUTPUT);
  pinMode(PIN_EN, OUTPUT);
#endif
  setCoils(false);
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  if (PIN_LED >= 0) pinMode(PIN_LED, OUTPUT);
  accel = ACCEL_DEG_S2 * STEPS_PER_DEG;
  setSpeedDeg(DEFAULT_SPEED_DEG_S);

  rxQueue = xQueueCreate(256, sizeof(char));
  BLEDevice::init(DEVICE_NAME);
  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  BLEService *svc = server->createService(UART_SERVICE);
  txChar = svc->createCharacteristic(UART_TX, BLECharacteristic::PROPERTY_NOTIFY);
  txChar->addDescriptor(new BLE2902());
  BLECharacteristic *rx = svc->createCharacteristic(UART_RX, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  rx->setCallbacks(new RxCallbacks());
  svc->start();
  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(UART_SERVICE);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.println("Fotogiro pronto");
}

void loop() {
  readInput();
  updateMotion();

  if (reportDone && !moving && targetSteps == posSteps) {
    reportDone = false;
    reply(String("DONE ") + String(positionDeg(), 2));
  }

  // tasto BOOT: avvia / ferma il giro autonomo
  static bool lastBtn = true;
  static unsigned long btnMs = 0;
  bool btn = digitalRead(PIN_BUTTON);
  if (btn != lastBtn && millis() - btnMs > 50) {
    btnMs = millis();
    lastBtn = btn;
    if (!btn) {
      if (autoRun) { autoRun = false; targetSteps = posSteps; reply("OK STOP"); }
      else startAuto(AUTO_STEPS, AUTO_DEG, AUTO_PAUSE_MS);
    }
  }

  // giro autonomo: pausa (l'app scatta quando il piatto è fermo), passo, pausa...
  if (!autoRun) {
    autoState = AUTO_OFF;
  } else if (autoState == AUTO_MOVING && !moving && targetSteps == posSteps) {
    autoState = AUTO_PAUSE;
    autoNextMs = millis() + autoPause;
  } else if (autoState == AUTO_PAUSE && (long)(millis() - autoNextMs) >= 0) {
    if (autoLeft-- > 0) {
      targetSteps += lroundf(autoDeg * STEPS_PER_DEG);
      autoState = AUTO_MOVING;
    } else {
      autoRun = false;
      autoState = AUTO_OFF;
      setCoils(false);
      reply("DONE AUTO");
    }
  }

  if (PIN_LED >= 0) digitalWrite(PIN_LED, autoRun ? ((millis() / 250) % 2) : bleConnected);
}
