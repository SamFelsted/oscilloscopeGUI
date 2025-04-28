#include <Arduino.h>

const int sampleRate = 200000;  
const float frequency = 10000;  
const int amplitude = 100;    
const int offset = 100;       
unsigned long lastSampleTime = 0;  
float phase = 0.0;              
const float twoPi = 2.0 * 3.14159265; 

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
