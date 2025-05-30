// ADC Simulator - generates test waveforms for different channels
#include <math.h>

// Protocol constants
const uint8_t START_BYTE = 0xAA;  // 10101010
const uint8_t STOP_BYTE = 0x55;   // 01010101

// Channel enable/disable state (bits 0-3 for channels 1-4)
volatile uint8_t channelEnabled = 0x03; // Only channels 1 and 2 enabled by default

// Timing variables for waveform generation
unsigned long lastUpdate = 0;
const unsigned long UPDATE_INTERVAL = 10; // Update every 10µs (100kHz sample rate)

// Waveform parameters
struct WaveformConfig {
    float frequency;    // Hz
    float amplitude;    // Vpp (peak-to-peak voltage)
    bool isSquare;      // true for square wave, false for sine
};

const WaveformConfig channels[4] = {
    {10000.0f,  2.0f,  false}, // Ch1: 10kHz 2Vpp sine
    {100000.0f, 4.0f,  true},  // Ch2: 100kHz 4Vpp square
    {60000.0f,  10.0f, false}, // Ch3: 60kHz 10Vpp sine  
    {10000.0f,  5.0f,  true}   // Ch4: 10kHz 5Vpp square
};

void setup() {
    Serial.begin(1000000);
}

// Process incoming serial commands for channel enable/disable
void processSerialCommands() {
    while (Serial.available() >= 3) {  // Need 3 bytes: start + channel + enable
        if (Serial.peek() == START_BYTE) {
            Serial.read();  // Consume start byte
            uint8_t channel = Serial.read() & 0x03;  // Channel number (0-3)
            uint8_t enable = Serial.read();  // Enable/disable (0/1)
            
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
        } else {
            Serial.read();  // Skip invalid byte
        }
    }
}

// Generate waveform value for a given channel
float generateWaveform(uint8_t channel, unsigned long timeUs) {
    const WaveformConfig& config = channels[channel];
    
    // Calculate phase (0 to 2π)
    float timeSeconds = timeUs / 1000000.0f;
    float phase = 2.0f * PI * config.frequency * timeSeconds;
    
    float voltage;
    if (config.isSquare) {
        // Square wave: +/- amplitude/2
        voltage = (sin(phase) >= 0) ? (config.amplitude / 2.0f) : -(config.amplitude / 2.0f);
    } else {
        // Sine wave: amplitude/2 * sin(phase)
        voltage = (config.amplitude / 2.0f) * sin(phase);
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

// Send data packet with start/stop bytes
void sendChannelData(uint8_t channel, uint16_t rawData) {
    // Send start byte
    Serial.write(START_BYTE);
    
    // Send channel and data
    Serial.write(channel);  // Channel number (0-3)
    Serial.write((rawData >> 8) & 0xFF);  // Data high byte
    Serial.write(rawData & 0xFF);         // Data low byte
    
    // Send stop byte
    Serial.write(STOP_BYTE);
}

void loop() {
    // Check for serial commands
    processSerialCommands();
    
    unsigned long currentTime = micros();
    
    // Generate and send waveform data at regular intervals
    if (currentTime - lastUpdate >= UPDATE_INTERVAL) {
        lastUpdate = currentTime;
        
        // Generate data for all enabled channels
        for (uint8_t ch = 0; ch < 4; ch++) {
            if (channelEnabled & (1 << ch)) {
                // Generate waveform voltage
                float voltage = generateWaveform(ch, currentTime);
                
                // Convert to ADC format and send
                uint16_t adcValue = voltageToADC(voltage);
                sendChannelData(ch, adcValue);
            }
        }
    }
}