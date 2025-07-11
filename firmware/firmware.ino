// ADC Simulator - generates test waveforms for different channels
#include <math.h>

// Protocol constants
const uint8_t START_BYTE = 0xAA;  // 10101010
const uint8_t STOP_BYTE = 0x55;   // 01010101
const uint8_t TRIGGER_BYTE = 0xCC; // 11001100 - marks trigger point

// Timing constants
const unsigned long SAMPLE_INTERVAL = 10;  // 10µs = 100kHz sampling rate
const int SERIAL_BUFFER_SIZE = 64;        // Buffer size for serial transmission

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

// Serial output buffer
uint8_t serialBuffer[SERIAL_BUFFER_SIZE];
int serialBufferIndex = 0;

// Timing variables
unsigned long lastSampleTime = 0;
unsigned long lastSerialFlushTime = 0;
const unsigned long SERIAL_FLUSH_INTERVAL = 1000;  // Flush serial buffer every 1ms

// Waveform parameters
struct WaveformConfig {
    float frequency;    // Hz
    float amplitude;    // Vpp (peak-to-peak voltage)
    bool isSquare;      // true for square wave, false for sine
    float phase;        // Current phase for continuous generation
};

WaveformConfig channels[4] = {
    {10000.0f,  2.0f,  false, 0.0f}, // Ch1: 10kHz 2Vpp sine
    {100000.0f, 4.0f,  true,  0.0f}, // Ch2: 100kHz 4Vpp square
    {60000.0f,  10.0f, false, 0.0f}, // Ch3: 60kHz 10Vpp sine  
    {10000.0f,  5.0f,  true,  0.0f}  // Ch4: 10kHz 5Vpp square
};

void setup() {
    Serial.begin(2000000);  // Increased baud rate for better performance
}

// Add data to serial buffer and flush if necessary
void addToSerialBuffer(uint8_t byte) {
    serialBuffer[serialBufferIndex++] = byte;
    
    // Flush buffer if it's nearly full or enough time has passed
    if (serialBufferIndex >= SERIAL_BUFFER_SIZE - 5 || 
        (micros() - lastSerialFlushTime >= SERIAL_FLUSH_INTERVAL && serialBufferIndex > 0)) {
        Serial.write(serialBuffer, serialBufferIndex);
        serialBufferIndex = 0;
        lastSerialFlushTime = micros();
    }
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

// Send data packet with start/stop bytes using buffered output
void sendChannelData(uint8_t channel, uint16_t rawData, bool is_trigger) {
    addToSerialBuffer(START_BYTE);
    addToSerialBuffer(channel);
    addToSerialBuffer((rawData >> 8) & 0xFF);
    addToSerialBuffer(rawData & 0xFF);
    
    if (is_trigger) {
        addToSerialBuffer(TRIGGER_BYTE);
    }
    
    addToSerialBuffer(STOP_BYTE);
}

// Generate waveform value for a given channel
float generateWaveform(uint8_t channel, unsigned long timeUs) {
    WaveformConfig& config = channels[channel];
    
    // Update phase based on time and frequency
    float phaseIncrement = 2.0f * PI * config.frequency * (SAMPLE_INTERVAL / 1000000.0f);
    config.phase += phaseIncrement;
    if (config.phase >= 2.0f * PI) {
        config.phase -= 2.0f * PI;
    }
    
    float voltage;
    if (config.isSquare) {
        // Square wave: +/- amplitude/2
        voltage = (sin(config.phase) >= 0) ? (config.amplitude / 2.0f) : -(config.amplitude / 2.0f);
    } else {
        // Sine wave: amplitude/2 * sin(phase)
        voltage = (config.amplitude / 2.0f) * sin(config.phase);
    }
    
    return voltage;
}

// Convert voltage to 16-bit signed ADC value (±10V range)
uint16_t voltageToADC(float voltage) {
    // Clamp voltage to ±10V range
    if (voltage > 10.0f) voltage = 10.0f;
    if (voltage < -10.0f) voltage = -10.0f;
    
    // Convert to signed 16-bit (-32768 to +32767)
    int16_t signed_val = (int16_t)(voltage * 32768.0f / 10.0f);
    
    // Reinterpret as unsigned for transmission
    return *reinterpret_cast<uint16_t*>(&signed_val);
}

void loop() {
    // Check for serial commands
    processSerialCommands();
    
    unsigned long currentTime = micros();
    
    // Generate and send waveform data at precise intervals
    if (currentTime - lastSampleTime >= SAMPLE_INTERVAL) {
        lastSampleTime = currentTime;
        
        // Generate data for all enabled channels
        for (uint8_t ch = 0; ch < 4; ch++) {
            if (channelEnabled & (1 << ch)) {
                // Generate waveform voltage
                float voltage = generateWaveform(ch, currentTime);
                uint16_t adcValue = voltageToADC(voltage);
                
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
                    addToBuffer(ch, adcValue, is_trigger);
                }
                
                // Send data
                sendChannelData(ch, adcValue, is_trigger);
            }
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
    }
    
    // Ensure serial buffer is flushed periodically
    if (serialBufferIndex > 0 && currentTime - lastSerialFlushTime >= SERIAL_FLUSH_INTERVAL) {
        Serial.write(serialBuffer, serialBufferIndex);
        serialBufferIndex = 0;
        lastSerialFlushTime = currentTime;
    }
}