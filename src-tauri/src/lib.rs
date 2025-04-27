// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

use std::io::Read;
use std::time::Duration;
use serialport::SerialPort;


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![read_serial_data])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}


#[tauri::command]
fn read_serial_data() -> Result<String, String> {
    let available_ports = serialport::available_ports().map_err(|e| e.to_string())?;

    let port_info = available_ports
        .into_iter()
        .find(|p| p.port_name.to_uppercase().starts_with("COM"))
        .ok_or("No COM ports found")?;

    let mut port = serialport::new(&port_info.port_name, 1000000)
        .timeout(Duration::from_secs(2))
        .open()
        .map_err(|e| format!("Failed to open {}: {}", port_info.port_name, e))?;

    let mut buffer = vec![0; 1024];
    let bytes_read = port.read(&mut buffer).map_err(|e| e.to_string())?;

    Ok(String::from_utf8_lossy(&buffer[..bytes_read]).to_string())
}
