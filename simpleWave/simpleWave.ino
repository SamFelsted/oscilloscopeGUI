#include <Arduino.h>

const int sampleRate = 200000;  // Sample rate (samples per second)
const float frequency = 10000;  // Frequency of the sine wave (Hz)
const int amplitude = 1000;     // Amplitude of the sine wave
const int offset = 1000;        // Offset (vertical shift) of the sine wave
unsigned long lastSampleTime = 0;  // Time of the last sample (microseconds)
float phase = 0.0;              // Phase of the sine wave
const float twoPi = 2.0 * 3.14159265;  // Constant (2 * Pi)

void setup() {
  Serial.begin(1000000);  // Start serial communication at 1 Mbps
}

void loop() {
  unsigned long now = micros();  // Use micros() for better precision
  unsigned long sampleInterval = 1000000 / sampleRate;  // Interval between samples (in microseconds)

  if (now - lastSampleTime >= sampleInterval) {
    lastSampleTime = now;  // Update last sample time

    // Calculate the sine wave value
    float value = sin(phase) * amplitude + offset;

    // Send the value to the serial port
    Serial.println((int)value);

    // Update the phase for the next sample
    phase += twoPi * frequency / sampleRate;
    if (phase >= twoPi) {
      phase -= twoPi;  // Keep the phase within the range [0, 2π]
    }
  }
}
