#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let launched_by_browser = std::env::args()
        .skip(1)
        .any(|argument| argument.starts_with("chrome-extension://"));

    if launched_by_browser {
        if let Err(error) = neptune_runtime_lib::run_native_host() {
            eprintln!("Neptune native host error: {error}");
        }
        return;
    }

    neptune_runtime_lib::run();
}
