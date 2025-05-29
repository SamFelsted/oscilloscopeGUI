use std::{
    io::{self, Read},
    sync::{Arc, Mutex},
    thread,
    time::{Duration},
};

pub mod adc {
    use std::collections::VecDeque;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use serde::Serialize;

    #[derive(Debug, Clone, Serialize)]
    pub struct AdcSample {
        pub channel: u8,
        pub raw_value: u16,
        pub voltage: f32,
        pub timestamp: u128, // Changed to u128 for JSON serialization
    }

    pub struct PacketProcessor {
        buffer: VecDeque<u8>,
        samples_received: usize,
        channel_counts: [usize; 4],
    }

    impl PacketProcessor {
        pub fn new() -> Self {
            Self {
                buffer: VecDeque::with_capacity(1024),
                samples_received: 0,
                channel_counts: [0; 4],
            }
        }

        pub fn add_bytes(&mut self, bytes: &[u8]) {
            self.buffer.extend(bytes);
        }

        pub fn process_packets(&mut self) -> Vec<AdcSample> {
            let mut samples = Vec::new();
            while self.buffer.len() >= 3 {
                let mut current_packet = [0u8; 3];
                current_packet[0] = self.buffer.pop_front().unwrap();
                current_packet[1] = self.buffer.pop_front().unwrap();
                current_packet[2] = self.buffer.pop_front().unwrap();

                if let Some(sample) = self.decode_packet(&current_packet) {
                    let channel = sample.channel;  // Extract channel before moving sample
                    samples.push(sample);
                    self.samples_received += 1;
                    self.channel_counts[channel as usize] += 1;
                }
            }
            samples
        }

        fn decode_packet(&self, packet: &[u8; 3]) -> Option<AdcSample> {
            let combined = ((packet[0] as u32) << 10) | 
                          ((packet[1] as u32) << 2) | 
                          ((packet[2] as u32) >> 6);
            
            let channel = ((combined >> 16) & 0x03) as u8;
            let raw_data = (combined & 0xFFFF) as u16;
            let voltage = (raw_data as i16 as f32) * (10.0 / 32768.0);
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or(Duration::from_secs(0))
                .as_nanos();

            Some(AdcSample { 
                channel, 
                raw_value: raw_data, 
                voltage, 
                timestamp 
            })
        }

        pub fn get_stats(&self) -> (usize, [usize; 4]) {
            (self.samples_received, self.channel_counts)
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
            toggle_log
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
            println!("Sending {} data points to frontend", data.len());
            buf.clear();
            Ok(data)
        } else {
            Err("Buffer not initialized".to_string())
        }
    }
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

    let mut port = serialport::new(&port_info.port_name, 115200)  // Changed to match Arduino's baud rate
        .timeout(Duration::from_millis(100))
        .open()
        .map_err(|e| format!("Failed to open {}: {}", port_info.port_name, e))?;

    println!("Port opened successfully");

    let mut buffer_read = vec![0; 1024];

    loop {
        match port.read(&mut buffer_read) {
            Ok(bytes_read) => {
                if bytes_read > 0 {
                    println!("Read {} bytes", bytes_read);
                    println!("Raw data: {:?}", &buffer_read[..bytes_read]);

                    let mut processor = adc_processor.lock()
                        .map_err(|_| "Failed to lock ADC processor".to_string())?;
                    processor.add_bytes(&buffer_read[..bytes_read]);
                    let samples = processor.process_packets();
                    
                    println!("Processed {} samples", samples.len());
                    
                    let mut buf = buffer.lock()
                        .map_err(|_| "Failed to lock buffer".to_string())?;
                    
                    for sample in samples {
                        // Format for frontend display
                        let line = format!("Ch{}: {:.4} V", 
                            sample.channel + 1, 
                            sample.voltage
                        );
                        
                        println!("Formatted sample: {}", line);
                        
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
