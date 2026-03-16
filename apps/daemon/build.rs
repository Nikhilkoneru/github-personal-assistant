use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=../client/package.json");
    println!("cargo:rerun-if-changed=../client/public");
    println!("cargo:rerun-if-changed=../client/scripts/build.mjs");
    println!("cargo:rerun-if-changed=../client/src");
    println!("cargo:rerun-if-changed=../client/tsconfig.build.json");
    println!("cargo:rerun-if-changed=../../pnpm-lock.yaml");

    if let Ok(target) = env::var("TARGET") {
        println!("cargo:rustc-env=GCPA_BUILD_TARGET={target}");
    }

    if env::var_os("GCPA_SKIP_CLIENT_BUILD").is_some() {
        return;
    }

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let workspace_root = manifest_dir
        .parent()
        .and_then(|path| path.parent())
        .expect("workspace root");

    let output = Command::new("node")
        .arg("apps/client/scripts/build.mjs")
        .current_dir(workspace_root)
        .output()
        .expect("Failed to execute the client build");

    if !output.status.success() {
        panic!(
            "Bundled client build failed.\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
