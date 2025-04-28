use std::{
    io::{self, Read, Write},
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

static RECORDING: AtomicBool = AtomicBool::new(false);
static LOG_FILE: Mutex<Option<std::fs::File>> = Mutex::new(None);

static mut BUFFER: Option<Arc<Mutex<Vec<String>>>> = None;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let buffer = Arc::new(Mutex::new(Vec::new()));
    unsafe {
        BUFFER = Some(buffer.clone());
    }

    // Spawn the reader thread
    thread::spawn(move || {
        loop {
            if let Err(e) = read_serial_into_buffer(buffer.clone(), 1024) {
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
    if enable {
        let file = std::fs::File::create("log.csv")
            .map_err(|e| format!("Failed to create file: {}", e))?;

        writeln!(&file, "timestamp,data")
            .map_err(|e| format!("Failed to write CSV header: {}", e))?;

        let mut lock = LOG_FILE.lock().map_err(|_| "Failed to lock file".to_string())?;
        *lock = Some(file);

        RECORDING.store(true, Ordering::Relaxed);
    } else {
        RECORDING.store(false, Ordering::Relaxed);

        let mut lock = LOG_FILE.lock().map_err(|_| "Failed to lock file".to_string())?;
        *lock = None;
    }

    Ok(())
}

#[tauri::command]
fn get_serial_data() -> Result<Vec<String>, String> {
    unsafe {
        if let Some(buffer) = &BUFFER {
            let mut buf = buffer.lock().map_err(|_| "Failed to lock buffer".to_string())?;
            let data = buf.clone();
            buf.clear();
            Ok(data)
        } else {
            Err("Buffer not initialized".to_string())
        }
    }
}


fn read_serial_into_buffer(buffer: Arc<Mutex<Vec<String>>>, buffer_size: usize) -> Result<(), String> {
    let available_ports = serialport::available_ports()
        .map_err(|e| format!("Failed to list ports: {}", e))?;

    let port_info = available_ports
        .into_iter()
        .find(|p| p.port_name.to_uppercase().starts_with("COM"))
        .ok_or("No COM ports found")?;

    let mut port = serialport::new(&port_info.port_name, 1000000)
        .timeout(Duration::from_millis(100)) // shorter timeout for responsiveness
        .open()
        .map_err(|e| format!("Failed to open {}: {}", port_info.port_name, e))?;

    let mut buffer_read = vec![0; 1024];

    loop {
        match port.read(&mut buffer_read) {
            Ok(bytes_read) => {
                if bytes_read > 0 {
                    let data = String::from_utf8_lossy(&buffer_read[..bytes_read]).to_string();

                    let data_lines = data.split_whitespace();

                    for line in data_lines {
                        let line = line.trim();

                        if !line.is_empty() {
                            {
                                let mut buf = buffer.lock().map_err(|_| "Failed to lock buffer".to_string())?;
                                if buf.len() >= buffer_size {
                                    buf.remove(0);
                                }
                                buf.push(line.to_string());
                            }

                            // If recording, log each line
                            if RECORDING.load(Ordering::Relaxed) {
                                // Lock file safely
                                if let Ok(mut lock) = LOG_FILE.lock() {
                                    if let Some(file) = lock.as_mut() {
                                        let timestamp = SystemTime::now()
                                            .duration_since(UNIX_EPOCH)
                                            .map_err(|e| format!("Failed to get timestamp: {}", e))?
                                            .as_nanos();

                                        let csv_line = format!("{},{}\n", timestamp, line.trim_end());

                                        if let Err(e) = file.write_all(csv_line.as_bytes()) {
                                            eprintln!("Failed to write to log file: {}", e);
                                        }
                                        if let Err(e) = file.flush() {
                                            eprintln!("Failed to flush log file: {}", e);
                                        }
                                    }
                                } else {
                                    eprintln!("Failed to acquire lock for the log file.");
                                }
                            }
                        }
                    }
                }
            }
            Err(ref e) if e.kind() == io::ErrorKind::TimedOut => {
            }
            Err(e) => {
                return Err(format!("Serial read error: {}", e));
            }
        }
    }
}
