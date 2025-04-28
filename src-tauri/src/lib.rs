// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

static RECORDING: AtomicBool = AtomicBool::new(false);
static LOG_FILE: Mutex<Option<std::fs::File>> = Mutex::new(None);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            read_serial_data,
            toggle_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn toggle_log(enable: bool) -> Result<(), String> {
    if enable {
        // Start recording
        let file = std::fs::File::create("log.csv")
            .map_err(|e| format!("Failed to create file: {}", e))?;

        // Write CSV header
        writeln!(&file, "timestamp,data")
            .map_err(|e| format!("Failed to write CSV header: {}", e))?;

        let mut lock = LOG_FILE.lock().map_err(|_| "Failed to lock file".to_string())?;
        *lock = Some(file);

        RECORDING.store(true, Ordering::Relaxed);
    } else {
        // Stop recording
        RECORDING.store(false, Ordering::Relaxed);

        let mut lock = LOG_FILE.lock().map_err(|_| "Failed to lock file".to_string())?;
        *lock = None;
    }

    Ok(())
}

#[tauri::command]
fn read_serial_data() -> Result<String, String> {
    let available_ports = serialport::available_ports()
        .map_err(|e| format!("Failed to list ports: {}", e))?;

    let port_info = available_ports
        .into_iter()
        .find(|p| p.port_name.to_uppercase().starts_with("COM"))
        .ok_or("No COM ports found")?;

    let mut port = serialport::new(&port_info.port_name, 1000000)
        .timeout(Duration::from_secs(2))
        .open()
        .map_err(|e| format!("Failed to open {}: {}", port_info.port_name, e))?;

    let mut buffer = vec![0; 1024];
    let bytes_read = port.read(&mut buffer)
        .map_err(|e| format!("Failed to read serial data: {}", e))?;

    let data = String::from_utf8_lossy(&buffer[..bytes_read]).to_string();

    // If recording is active, log the data
    if RECORDING.load(Ordering::Relaxed) {
        if let Ok(mut lock) = LOG_FILE.lock() {
            if let Some(file) = lock.as_mut() {
                let timestamp = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(|e| format!("Failed to get timestamp: {}", e))?
                    .as_millis();

                let csv_line = format!("{},{}\n", timestamp, data.trim_end());

                if let Err(e) = file.write_all(csv_line.as_bytes()) {
                    eprintln!("Failed to write to log file: {}", e);
                }
            }
        }
    }

    Ok(data)
}
