use std::{
    io::{self, Read},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use serde::{Serialize, Deserialize};

pub mod adc {
    use std::{
        collections::VecDeque,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };
    use serde::{Serialize, Deserialize};

    const START_BYTE: u8 = 0xAA;  // 10101010
    const STOP_BYTE: u8 = 0x55;   // 01010101
    const TRIGGER_BYTE: u8 = 0xCC; // 11001100 - marks trigger point

    #[derive(Debug, Clone, Serialize)]
    pub struct AdcSample {
        pub channel: u8,
        pub raw_value: u16,
        pub voltage: f32,
        pub timestamp: u128,
        pub is_trigger: bool,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct TriggerConfig {
        pub enabled: bool,
        pub channel: u8,
        pub level: f32,
        pub rising_edge: bool,
    }

    pub struct PacketProcessor {
        buffer: VecDeque<u8>,
        samples_received: usize,
        channel_counts: [usize; 4],
        active_channels: [bool; 4],
        trigger_config: TriggerConfig,
    }

    impl PacketProcessor {
        pub fn new() -> Self {
            Self {
                buffer: VecDeque::with_capacity(1024),
                samples_received: 0,
                channel_counts: [0; 4],
                active_channels: [true, true, false, false], // Default: channels 1 and 2 active
                trigger_config: TriggerConfig {
                    enabled: false,
                    channel: 0,
                    level: 0.0,
                    rising_edge: true,
                },
            }
        }

        pub fn add_bytes(&mut self, bytes: &[u8]) {
            self.buffer.extend(bytes);
        }

        pub fn set_active_channels(&mut self, channels: [bool; 4]) {
            // Ensure only 2 channels are active
            let active_count = channels.iter().filter(|&&x| x).count();
            if active_count > 2 {
                // If more than 2 channels selected, keep only the first two
                let mut new_channels = [false; 4];
                let mut count = 0;
                for (i, &active) in channels.iter().enumerate() {
                    if active && count < 2 {
                        new_channels[i] = true;
                        count += 1;
                    }
                }
                self.active_channels = new_channels;
            } else {
                self.active_channels = channels;
            }
        }

        pub fn configure_trigger(&mut self, config: TriggerConfig) {
            // Clone config before moving it
            self.trigger_config = config.clone();
            
            // Send trigger configuration to firmware
            let mut cmd = [START_BYTE, 0xFE, 0, 0, 0, STOP_BYTE];  // Full 6-byte command
            cmd[2] = (config.enabled as u8) << 4;  // Enable/disable in upper 4 bits
            cmd[2] |= config.channel & 0x03;  // Channel in lower 2 bits
            cmd[3] = ((config.level * 32768.0 / 10.0) as i16 >> 8) as u8;  // Level high byte
            cmd[4] = ((config.level * 32768.0 / 10.0) as i16 & 0xFF) as u8;  // Level low byte
            cmd[5] = if config.rising_edge { 0x01 } else { 0x00 };  // Edge type
            
            // Send the command to the firmware
            if let Ok(mut port) = serialport::new("COM3", 1000000).open() {
                let _ = port.write_all(&cmd);
            }
        }

        pub fn process_packets(&mut self) -> Vec<AdcSample> {
            let mut samples = Vec::new();
            let mut triggered = false;
            
            // Process all available bytes
            while self.buffer.len() >= 5 {  // Need at least 5 bytes: start + channel + data(2) + stop
                // Look for start byte
                while self.buffer.len() >= 5 && self.buffer[0] != START_BYTE {
                    self.buffer.pop_front();  // Skip until we find start byte
                }
                
                if self.buffer.len() < 5 {
                    break;  // Not enough bytes for a complete packet
                }
                
                // Check if we have a trigger marker
                let has_trigger = self.buffer.len() >= 6 && self.buffer[4] == TRIGGER_BYTE;
                let packet_size = if has_trigger { 6 } else { 5 };
                
                if self.buffer.len() < packet_size {
                    break;  // Not enough bytes for complete packet
                }
                
                // Verify stop byte
                let stop_pos = if has_trigger { 5 } else { 4 };
                if self.buffer[stop_pos] != STOP_BYTE {
                    self.buffer.pop_front();  // Skip invalid packet
                    continue;
                }
                
                // Extract packet data
                let mut packet = vec![0u8; packet_size];
                for i in 0..packet_size {
                    packet[i] = self.buffer.pop_front().unwrap();
                }
                
                if let Some(sample) = self.decode_packet(&packet) {
                    // Only process samples for active channels
                    if self.active_channels[sample.channel as usize] {
                        // If trigger is enabled and this is the trigger channel,
                        // check if it's a trigger point
                        let is_trigger_point = if self.trigger_config.enabled && 
                            sample.channel == self.trigger_config.channel {
                            let voltage = sample.voltage;
                            if self.trigger_config.rising_edge {
                                voltage > self.trigger_config.level
                            } else {
                                voltage < self.trigger_config.level
                            }
                        } else {
                            sample.is_trigger
                        };

                        // If we see a trigger point, mark that we're triggered
                        if is_trigger_point {
                            triggered = true;
                        }

                        // Only add samples if we're not using trigger or if we're triggered
                        if !self.trigger_config.enabled || triggered {
                            // Create a new sample with the trigger status
                            let sample = AdcSample {
                                is_trigger: is_trigger_point,
                                ..sample
                            };

                            samples.push(sample.clone());  // Clone the sample before moving it
                            self.samples_received += 1;
                            self.channel_counts[sample.channel as usize] += 1;
                        }
                    }
                }
            }
            samples
        }

        fn decode_packet(&self, packet: &[u8]) -> Option<AdcSample> {
            // Verify start and stop bytes
            if packet[0] != START_BYTE || packet[packet.len() - 1] != STOP_BYTE {
                return None;
            }
            
            // Extract channel and data
            let channel = packet[1] & 0x03;  // Channel number (0-3)
            let raw_data = ((packet[2] as u16) << 8) | (packet[3] as u16);
            let is_trigger = packet.len() > 5 && packet[4] == TRIGGER_BYTE;

            let voltage = (raw_data as i16 as f32) * (10.0 / 32768.0);
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or(Duration::from_secs(0))
                .as_nanos();

            Some(AdcSample { 
                channel, 
                raw_value: raw_data, 
                voltage, 
                timestamp,
                is_trigger,
            })
        }

        pub fn get_stats(&self) -> (usize, [usize; 4]) {
            (self.samples_received, self.channel_counts)
        }

        pub fn get_active_channels(&self) -> [bool; 4] {
            self.active_channels
        }

        pub fn get_trigger_config(&self) -> TriggerConfig {
            self.trigger_config.clone()
        }
    }
}

mod logger {
    use std::{
        fs::File,
        io::Write,
        sync::{atomic::{AtomicBool, Ordering}, Mutex},
    };
    use crate::adc;  // Import the adc module

    pub struct Logger {
        recording: AtomicBool,
        file: Mutex<Option<File>>,
    }

    impl Logger {
        pub fn new() -> Self {
            Self {
                recording: AtomicBool::new(false),
                file: Mutex::new(None),
            }
        }

        pub fn start(&self) -> Result<(), String> {
            let file = File::create("log.csv")
                .map_err(|e| format!("Failed to create file: {}", e))?;

            writeln!(&file, "timestamp,channel,voltage,raw_value")
                .map_err(|e| format!("Failed to write CSV header: {}", e))?;

            let mut lock = self.file.lock()
                .map_err(|_| "Failed to lock file".to_string())?;
            *lock = Some(file);

            self.recording.store(true, Ordering::Relaxed);
            Ok(())
        }

        pub fn stop(&self) -> Result<(), String> {
            self.recording.store(false, Ordering::Relaxed);
            let mut lock = self.file.lock()
                .map_err(|_| "Failed to lock file".to_string())?;
            *lock = None;
            Ok(())
        }

        pub fn is_recording(&self) -> bool {
            self.recording.load(Ordering::Relaxed)
        }

        pub fn log_sample(&self, sample: &adc::AdcSample) -> Result<(), String> {
            if !self.is_recording() {
                return Ok(());
            }

            if let Ok(mut lock) = self.file.lock() {
                if let Some(file) = lock.as_mut() {
                    let csv_line = format!("{},{},{:.4},{}\n",
                        sample.timestamp,
                        sample.channel,
                        sample.voltage,
                        sample.raw_value
                    );

                    if let Err(e) = file.write_all(csv_line.as_bytes()) {
                        return Err(format!("Failed to write to log file: {}", e));
                    }
                    if let Err(e) = file.flush() {
                        return Err(format!("Failed to flush log file: {}", e));
                    }
                }
            }
            Ok(())
        }
    }
}

static mut BUFFER: Option<Arc<Mutex<Vec<String>>>> = None;
static mut ADC_PROCESSOR: Option<Arc<Mutex<adc::PacketProcessor>>> = None;
static mut LOGGER: Option<Arc<logger::Logger>> = None;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let buffer = Arc::new(Mutex::new(Vec::new()));
    let adc_processor = Arc::new(Mutex::new(adc::PacketProcessor::new()));
    let logger = Arc::new(logger::Logger::new());
    
    unsafe {
        BUFFER = Some(buffer.clone());
        ADC_PROCESSOR = Some(adc_processor.clone());
        LOGGER = Some(logger.clone());
    }

    thread::spawn(move || {
        loop {
            if let Err(e) = read_serial_into_buffer(
                buffer.clone(), 
                adc_processor.clone(),
                logger.clone(),
                1024
            ) {
                eprintln!("Serial read error: {}", e);
                thread::sleep(Duration::from_secs(1));
            }
        }
    });

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_serial_data,
            toggle_log,
            set_active_channels,
            configure_trigger
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn toggle_log(enable: bool) -> Result<(), String> {
    unsafe {
        if let Some(logger) = &LOGGER {
            if enable {
                logger.start()?;
            } else {
                logger.stop()?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn get_serial_data() -> Result<Vec<String>, String> {
    unsafe {
        if let Some(buffer) = &BUFFER {
            let mut buf = buffer.lock().map_err(|_| "Failed to lock buffer".to_string())?;
            let data = buf.clone();
            //println!("Sending {} data points to frontend", data.len());
            buf.clear();
            Ok(data)
        } else {
            Err("Buffer not initialized".to_string())
        }
    }
}

#[tauri::command]
fn set_active_channels(channels: [bool; 4]) -> Result<(), String> {
    unsafe {
        if let Some(processor) = &ADC_PROCESSOR {
            let mut proc = processor.lock().map_err(|_| "Failed to lock ADC processor".to_string())?;
            proc.set_active_channels(channels);
        }
    }
    Ok(())
}

#[tauri::command]
fn configure_trigger(config: adc::TriggerConfig) -> Result<(), String> {
    unsafe {
        if let Some(processor) = &ADC_PROCESSOR {
            let mut proc = processor.lock().map_err(|_| "Failed to lock ADC processor".to_string())?;
            proc.configure_trigger(config);
        }
    }
    Ok(())
}

fn read_serial_into_buffer(
    buffer: Arc<Mutex<Vec<String>>>, 
    adc_processor: Arc<Mutex<adc::PacketProcessor>>,
    logger: Arc<logger::Logger>,
    buffer_size: usize
) -> Result<(), String> {
    let available_ports = serialport::available_ports()
        .map_err(|e| format!("Failed to list ports: {}", e))?;

    println!("Available ports: {:?}", available_ports);

    let port_info = available_ports
        .into_iter()
        .find(|p| p.port_name.to_uppercase().starts_with("COM"))
        .ok_or("No COM ports found")?;

    println!("Selected port: {}", port_info.port_name);

    let mut port = serialport::new(&port_info.port_name, 1000000)  // Changed to match Arduino's baud rate
        .timeout(Duration::from_millis(100))
        .open()
        .map_err(|e| format!("Failed to open {}: {}", port_info.port_name, e))?;

    println!("Port opened successfully");

    let mut buffer_read = vec![0; 1024];

    loop {
        match port.read(&mut buffer_read) {
            Ok(bytes_read) => {
                if bytes_read > 0 {
                    //println!("Read {} bytes", bytes_read);
                    //println!("Raw data: {:?}", &buffer_read[..bytes_read]);

                    let mut processor = adc_processor.lock()
                        .map_err(|_| "Failed to lock ADC processor".to_string())?;
                    processor.add_bytes(&buffer_read[..bytes_read]);
                    let samples = processor.process_packets();
                    
                    //println!("Processed {} samples", samples.len());
                    
                    let mut buf = buffer.lock()
                        .map_err(|_| "Failed to lock buffer".to_string())?;
                    
                    for sample in samples {
                        // Format for frontend display
                        let line = format!("Ch{}: {:.4} V", 
                            sample.channel + 1, 
                            sample.voltage
                        );
                        
                        //println!("Formatted sample: {}", line);
                        
                        if buf.len() >= buffer_size {
                            buf.remove(0);
                        }
                        buf.push(line);

                        // Log the sample if recording
                        if let Err(e) = logger.log_sample(&sample) {
                            eprintln!("Logging error: {}", e);
                        }
                    }
                }
            }
            Err(ref e) if e.kind() == io::ErrorKind::TimedOut => {
                // Don't print on timeout to avoid console spam
            }
            Err(e) => {
                eprintln!("Serial read error: {}", e);
                return Err(format!("Serial read error: {}", e));
            }
        }
    }
}
