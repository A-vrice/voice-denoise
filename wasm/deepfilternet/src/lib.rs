/// DeepFilterNet3 WASM — extern "C" ABI stub.
///
/// Real deep_filter + tract-onnx wasm32 build requires 16GB+ RAM.
/// See https://github.com/Rikorose/DeepFilterNet for the upstream crate.

use std::slice;

static mut INITIALIZED: bool = false;

#[no_mangle]
pub extern "C" fn dfn3_init(_model: *const u8, _len: usize, _sr: u32) -> i32 {
    unsafe { INITIALIZED = true; }
    0
}

#[no_mangle]
pub extern "C" fn dfn3_process(
    input: *mut f32,
    output: *mut f32,
    frames: usize,
    atten: f32,
) {
    if unsafe { !INITIALIZED } { return; }
    let inp = unsafe { slice::from_raw_parts(input, frames) };
    let out = unsafe { slice::from_raw_parts_mut(output, frames) };
    let gain = (1.0 - atten * 0.5).max(0.1);
    for i in 0..frames { out[i] = inp[i] * gain; }
}

#[no_mangle]
pub extern "C" fn dfn3_reset() {
    unsafe { INITIALIZED = false; }
}
