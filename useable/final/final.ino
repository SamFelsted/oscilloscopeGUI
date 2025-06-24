// Combined ADC Oscilloscope Firmware
// Combines real ADC reading with advanced trigger and serial communication
#include <math.h>

// Protocol constants
const uint8_t START_BYTE = 0xAA;  // 10101010
const uint8_t STOP_BYTE = 0x55;   // 01010101
const uint8_t TRIGGER_BYTE = 0xCC; // 11001100 - marks trigger point

// ADC Pin Definitions
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

// Channel enable/disable state (bits 0-3 for channels 1-4)
volatile uint8_t channelEnabled = 0x03; // Only channels 1 and 2 enabled by default

// Trigger configuration
struct TriggerConfig {
    bool enabled;        // Whether trigger is enabled
    uint8_t channel;     // Channel to trigger on (0-3)
    float level;         // Trigger level in volts
    float hysteresis;    // Hysteresis in volts to prevent noise
    bool rising_edge;    // true for rising edge, false for falling edge
    bool armed;          // Whether trigger is armed
    bool triggered;      // Whether trigger has fired
};

TriggerConfig trigger = {
    false,              // disabled by default
    0,                  // channel 1
    0.0f,               // 0V level
    0.1f,               // 100mV hysteresis
    true,               // rising edge
    false,              // not armed
    false               // not triggered
};

// Circular buffer for pre-trigger data
const int BUFFER_SIZE = 1000;  // Store 1000 samples
struct Sample {
    uint8_t channel;
    uint16_t value;
    bool is_trigger;
};
Sample sampleBuffer[BUFFER_SIZE];
int bufferHead = 0;
int bufferTail = 0;
int bufferCount = 0;

// Change to 1µs for 1MHz sampling rate
const unsigned long SAMPLE_INTERVAL = 1;  // 1µs = 1MHz sampling rate

void setup() {
    Serial.begin(1000000);  // Use higher baud rate for better performance

    // ADC Configuration
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

// Convert ADC value to voltage (±10V range)
float adcToVoltage(uint16_t adcValue) {
    int16_t signed_val = toSigned(adcValue);
    return (float)signed_val * 10.0f / 32768.0f;
}

// Process incoming serial commands
void processSerialCommands() {
    while (Serial.available() >= 3) {
        if (Serial.peek() == START_BYTE) {
            Serial.read();  // Consume start byte
            uint8_t cmd = Serial.read();
            uint8_t value = Serial.read();
            
            if (cmd == 0xFF) {  // Channel enable/disable command
                uint8_t channel = value & 0x03;  // Channel number (0-3)
                uint8_t enable = (value >> 2) & 0x01;  // Enable/disable (0/1)
                
                if (enable == 1) {
                    // If enabling a new channel, disable the oldest active one
                    if ((channelEnabled & 0x03) == 0x03) { // If both channels 0 and 1 are active
                        channelEnabled &= ~(1 << 0); // Disable channel 0
                    } else if ((channelEnabled & 0x0C) == 0x0C) { // If both channels 2 and 3 are active
                        channelEnabled &= ~(1 << 2); // Disable channel 2
                    }
                    channelEnabled |= (1 << channel);
                } else {
                    channelEnabled &= ~(1 << channel);
                }
            } else if (cmd == 0xFE) {  // Trigger configuration command
                uint8_t subcmd = value & 0x0F;
                switch (subcmd) {
                    case 0:  // Enable/disable trigger
                        trigger.enabled = (value >> 4) & 0x01;
                        trigger.armed = trigger.enabled;
                        trigger.triggered = false;
                        break;
                    case 1:  // Set trigger channel
                        trigger.channel = (value >> 4) & 0x03;
                        break;
                    case 2:  // Set trigger level (high byte)
                        trigger.level = ((float)(value << 8)) / 32768.0f * 10.0f;
                        break;
                    case 3:  // Set trigger level (low byte)
                        trigger.level = ((float)((int16_t)((value << 8) | (uint8_t)(trigger.level * 32768.0f / 10.0f)))) / 32768.0f * 10.0f;
                        break;
                    case 4:  // Set trigger edge
                        trigger.rising_edge = (value >> 4) & 0x01;
                        break;
                    case 5:  // Force trigger
                        trigger.triggered = true;
                        break;
                }
            }
        } else {
            Serial.read();  // Skip invalid byte
        }
    }
}

// Add sample to circular buffer
void addToBuffer(uint8_t channel, uint16_t value, bool is_trigger) {
    if (bufferCount < BUFFER_SIZE) {
        sampleBuffer[bufferHead].channel = channel;
        sampleBuffer[bufferHead].value = value;
        sampleBuffer[bufferHead].is_trigger = is_trigger;
        bufferHead = (bufferHead + 1) % BUFFER_SIZE;
        bufferCount++;
    }
}

// Check if trigger condition is met
bool checkTrigger(float voltage) {
    if (!trigger.enabled || !trigger.armed) return false;
    
    static bool was_above = false;
    bool is_above = voltage > trigger.level;
    
    if (trigger.rising_edge) {
        if (was_above && voltage < (trigger.level - trigger.hysteresis)) {
            was_above = false;
        } else if (!was_above && voltage > (trigger.level + trigger.hysteresis)) {
            was_above = true;
            return true;
        }
    } else {
        if (!was_above && voltage > (trigger.level + trigger.hysteresis)) {
            was_above = true;
        } else if (was_above && voltage < (trigger.level - trigger.hysteresis)) {
            was_above = false;
            return true;
        }
    }
    return false;
}

// Send data packet with start/stop bytes
void sendChannelData(uint8_t channel, uint16_t rawData, bool is_trigger) {
    // Send start byte
    Serial.write(START_BYTE);
    
    // Send channel and data
    Serial.write(channel);  // Channel number (0-3)
    Serial.write((rawData >> 8) & 0xFF);  // Data high byte
    Serial.write(rawData & 0xFF);         // Data low byte
    
    // Send trigger marker if this is a trigger point
    if (is_trigger) {
        Serial.write(TRIGGER_BYTE);
    }
    
    // Send stop byte
    Serial.write(STOP_BYTE);
}

void loop() {
    // Check for serial commands
    processSerialCommands();

    // 1) start conversion
    triggerConversion();

    // 2) wait for BUSY → HIGH, then → LOW
    while (digitalRead(BUSY_PIN) == LOW)  ;  // wait for conversion to begin
    while (digitalRead(BUSY_PIN) == HIGH) ;  // wait for conversion to finish

    // 3) clock out four channels via RD strobe and process enabled channels
    for (uint8_t ch = 0; ch < 4; ch++) {
        digitalWrite(RD_PIN, LOW);
        delayMicroseconds(1);              // tD_RDDB ≥ 17 ns
        uint16_t rawU = readBusRaw();
        digitalWrite(RD_PIN, HIGH);
        delayMicroseconds(1);              // tPH_RD ≥ 15 ns

        // Only process data if channel is enabled
        if (channelEnabled & (1 << ch)) {
            // Convert ADC value to voltage for trigger checking
            float voltage = adcToVoltage(rawU);
            
            // Check for trigger
            bool is_trigger = false;
            if (ch == trigger.channel) {
                is_trigger = checkTrigger(voltage);
                if (is_trigger) {
                    trigger.triggered = true;
                    trigger.armed = false;  // Disarm trigger after firing
                }
            }
            
            // Add to buffer if trigger is enabled
            if (trigger.enabled) {
                addToBuffer(ch, rawU, is_trigger);
            }
            
            // Send data
            sendChannelData(ch, rawU, is_trigger);
        }

        delayMicroseconds(3);              // tCYC ≈ 3 µs until next channel
    }

    // If trigger fired, send buffered data
    if (trigger.triggered && bufferCount > 0) {
        while (bufferCount > 0) {
            Sample& sample = sampleBuffer[bufferTail];
            sendChannelData(sample.channel, sample.value, sample.is_trigger);
            bufferTail = (bufferTail + 1) % BUFFER_SIZE;
            bufferCount--;
        }
        trigger.triggered = false;  // Reset trigger state
        if (trigger.enabled) {
            trigger.armed = true;   // Re-arm trigger if still enabled
        }
    }

    delay(10);  // Main loop delay
} 