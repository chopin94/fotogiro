# Firmware del piatto (ESP32)

Il piatto parla con l'app via **Bluetooth LE** (servizio "UART" Nordic, nome `Fotogiro`).
Funziona anche **senza telefono collegato**: premi il tasto **BOOT** della scheda e il
piatto fa un giro completo a passi da 5° con una pausa di 1,5 s dopo ogni passo.
L'app si accorge da sola che il piatto è fermo e scatta (utile anche su iPhone, dove
Safari non ha Web Bluetooth).

## Cosa serve

| Opzione | Motore | Driver | Alimentazione |
|---|---|---|---|
| Economica | 28BYJ-48 (5 V) | schedina ULN2003 | 5 V dall'USB va bene |
| Più precisa e veloce | NEMA17 | A4988, DRV8825 o TMC2208 | 12 V a parte per il motore |

Più un ESP32 qualsiasi (DevKit, WROOM-32, C3, S3...).

## Collegamenti

### 28BYJ-48 + ULN2003 (impostazione predefinita)

| ULN2003 | ESP32 |
|---|---|
| IN1 | GPIO 16 |
| IN2 | GPIO 17 |
| IN3 | GPIO 18 |
| IN4 | GPIO 19 |
| + (5–12 V) | 5V / VIN |
| − | GND |

### NEMA17 + A4988 / DRV8825 / TMC2208

Nel file `.ino` commenta `#define DRIVER_ULN2003` e togli il commento a `#define DRIVER_STEPDIR`.

| Driver | ESP32 |
|---|---|
| STEP | GPIO 26 |
| DIR | GPIO 27 |
| EN | GPIO 25 |
| VDD / GND logica | 3V3 / GND |
| VMOT / GND motore | 12 V a parte (condensatore 100 µF vicino al driver) |

Imposta il microstep (1/16 di default) e regola la corrente del driver prima di collegare il motore.

## Da sistemare nel file `.ino`

- `GEAR_RATIO`: giri del motore per un giro del piatto. Se il motore muove il piatto con
  ingranaggi, è *denti della corona del piatto ÷ denti del pignone del motore*
  (esempio: 60 ÷ 12 = 5). Con trasmissione diretta lascia 1.
- `INVERT_DIR`: se il piatto gira al contrario.
- `MOTOR_STEPS_PER_REV`: 4096 per il 28BYJ-48 in mezzo passo; 200 × microstep per il NEMA17.

L'app non ha bisogno che l'angolo sia esatto (lo misura dai marker), ma un rapporto
sbagliato rende i passi più lunghi o più corti del previsto.

## Caricare il firmware

1. Arduino IDE → *Impostazioni* → URL schede aggiuntive:
   `https://espressif.github.io/arduino-esp32/package_esp32_index.json`
2. *Gestore schede* → installa **esp32** di Espressif (versione 2.x o 3.x).
3. Apri `fotogiro_esp32/fotogiro_esp32.ino`, scegli la tua scheda (es. *ESP32 Dev Module*) e carica.
4. *Monitor seriale* a 115200: deve comparire `Fotogiro pronto`. Puoi provare i comandi
   scrivendoli lì (`R 90`, `R -90`, `?`, `M 8 45 1000`).

## Protocollo

Righe di testo terminate da a capo, uguali via Bluetooth e via seriale:

| Comando | Effetto | Risposta |
|---|---|---|
| `R <gradi>` | ruota di tot gradi (positivo = antiorario visto dall'alto) | `DONE <posizione>` a fine movimento |
| `A <gradi>` | vai alla posizione assoluta | `DONE <posizione>` |
| `Z` | la posizione attuale diventa 0 | `OK` |
| `S <gradi/s>` | velocità massima del piatto | `OK` |
| `E 0` / `E 1` | spegni / accendi le bobine | `OK` |
| `M <n> <gradi> <ms>` | giro autonomo: n passi con pausa | `OK AUTO`, poi `DONE AUTO` |
| `?` | stato | `POS <posizione> IDLE` o `BUSY` |
| `STOP` | ferma subito | `OK` |

Per provarlo senza l'app va bene anche *nRF Connect* (Android/iOS): servizio
`6e400001-…`, scrivi su `6e400002-…`, notifiche su `6e400003-…`.
