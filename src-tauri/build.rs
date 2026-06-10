fn main() {
    tauri_build::build();

    // Windows: keep the Common Controls v6 manifest scoped to test binaries.
    //
    // The main app binary must keep Tauri's default manifest handling; adding
    // an unconditional linker manifest here creates duplicate resources and
    // breaks WiX/MSI bundling.
    #[cfg(target_os = "windows")]
    {
        let manifest_path = std::path::PathBuf::from(
            std::env::var("CARGO_MANIFEST_DIR").expect("missing CARGO_MANIFEST_DIR"),
        )
        .join("common-controls.manifest");
        let manifest_arg = format!("/MANIFESTINPUT:{}", manifest_path.display());

        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg-tests={}", manifest_arg);
        println!("cargo:rerun-if-changed={}", manifest_path.display());
    }
}
