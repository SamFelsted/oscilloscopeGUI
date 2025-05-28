// ADS8584S ↔ Teensy 4.1 parallel interface — complete sketch
// DB0–DB13 → pins 14–27, DB14→38, DB15→39
// OS0, OS1, OS2 → pins 0, 1, 7 (all LOW for 1× sampling)
// RESET → pin 28  (unused; INPUT)
// CONVSTA & CONVSTB → pin 8
// BUSY → pin 29
// FRSTDATA → pin 2  (INPUT; not strictly required once RD strobing is in place)
// RD/SCLK → pin 33  (strobed in software)
// CS → GND (permanently low)

constexpr uint8_t DATA_PINS[16] = {
  14, 15, 16, 17, 18, 19, 20, 21,
  22, 23, 24, 25, 26, 27,
  38, 39
};
constexpr uint8_t OS0_PIN      = 0;
constexpr uint8_t OS1_PIN      = 1;
constexpr uint8_t OS2_PIN      = 7;
constexpr uint8_t RESET_PIN    = 28;
constexpr uint8_t CONVST_PIN   = 8;
constexpr uint8_t BUSY_PIN     = 29;
constexpr uint8_t FRSTDATA_PIN = 2;
constexpr uint8_t RD_PIN       = 33;

void setup() {
  Serial.begin(115200);

  // oversample = 1×
  pinMode(OS0_PIN, OUTPUT); digitalWrite(OS0_PIN, LOW);
  pinMode(OS1_PIN, OUTPUT); digitalWrite(OS1_PIN, LOW);
  pinMode(OS2_PIN, OUTPUT); digitalWrite(OS2_PIN, LOW);

  // conversion control
  pinMode(CONVST_PIN, OUTPUT); digitalWrite(CONVST_PIN, LOW);
  pinMode(BUSY_PIN, INPUT);

  // FRSTDATA (optional)
  pinMode(FRSTDATA_PIN, INPUT);

  // RD strobe
  pinMode(RD_PIN, OUTPUT); digitalWrite(RD_PIN, HIGH);

  // data bus inputs
  for (auto p : DATA_PINS) {
    pinMode(p, INPUT);
  }

  // ADC reset left unused
  pinMode(RESET_PIN, INPUT);
}

// pulse CONVST to start a new conversion
inline void triggerConversion() {
  digitalWrite(CONVST_PIN, HIGH);
  delayMicroseconds(1);
  digitalWrite(CONVST_PIN, LOW);
}

// read raw 16-bit unsigned from DB0–DB15
inline uint16_t readBusRaw() {
  uint16_t v = 0;
  for (uint8_t b = 0; b < 16; b++) {
    v |= (uint16_t(digitalRead(DATA_PINS[b])) << b);
  }
  return v;
}

// reinterpret unsigned 16-bit as signed two's-complement
inline int16_t toSigned(uint16_t u) {
  return *reinterpret_cast<int16_t*>(&u);
}

// map raw ±32768 → ±10.0 V
inline float toVoltage(int16_t rawCount) {
  return rawCount * (10.0f / 32768.0f);
}

void loop() {
  // 1) start conversion
  triggerConversion();

  // 2) wait for BUSY → HIGH, then → LOW
  while (digitalRead(BUSY_PIN) == LOW)  ;  // wait for conversion to begin
  while (digitalRead(BUSY_PIN) == HIGH) ;  // wait for conversion to finish

  // 3) clock out four channels via RD strobe
  float volts[4];
  for (uint8_t ch = 0; ch < 4; ch++) {
    digitalWrite(RD_PIN, LOW);
    delayMicroseconds(1);              // tD_RDDB ≥ 17 ns
    uint16_t rawU = readBusRaw();
    digitalWrite(RD_PIN, HIGH);
    delayMicroseconds(1);              // tPH_RD ≥ 15 ns

    int16_t rawS = toSigned(rawU);
    volts[ch]    = toVoltage(rawS);

    delayMicroseconds(3);              // tCYC ≈ 3 µs until next channel
  }

  // 4) print results
  for (uint8_t ch = 0; ch < 4; ch++) {
    Serial.print("Ch"); Serial.print(ch+1);
    Serial.print(": "); Serial.print(volts[ch], 4);
    Serial.println(" V");
  }

  delay(10);
}