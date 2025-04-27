#include <Arduino.h>

const int sampleRate = 200000;  
const float frequency = 10; 
const int amplitude = 1000;  
const int offset = 1000;     
unsigned long lastSampleTime = 0;
float phase = 0.0;
const float twoPi = 2.0 * 3.14159265;

void setup() {
  Serial.begin(1000000); 
}

void loop() {
  unsigned long now = millis();
  if (now - lastSampleTime >= (1000 / sampleRate)) {
    lastSampleTime = now;

    float value = sin(phase) * amplitude + offset;
    Serial.println((int)value); 

    phase += twoPi * frequency / sampleRate;
    if (phase >= twoPi) {
      phase -= twoPi;
    }
  }
}
