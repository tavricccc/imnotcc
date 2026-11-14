fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "get_state",
                "use_remote",
                "install_local",
                "open_url",
                "open_node_download",
                "save_local_settings",
                "set_autostart",
                "restart_local",
                "open_data_dir",
                "open_log_dir",
                "open_setup",
                "open_external",
                "show_password",
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}
