// Voice stack glue: re-exports the STT/TTS/install commands for lib.rs and
// hosts the two helpers shared across the three submodules.
mod stt;
mod tts;
mod voice_install;

// rustfmt-friendly flat re-export of all voice commands consumed by lib.rs
pub use voice_install::{
    install_bin_finalize, install_kokoro_gpu_part, install_model_finalize, install_piper_bin,
    install_tts_voice_part, voice_download, voice_remove_all, voice_remove_gpu, voice_remove_model,
};
pub use tts::{
    kokoro_remove_engine, tts_clear_debug, tts_debug_log, tts_gpu_remove, tts_remove_voice,
    tts_speak, tts_speak_pcm, tts_status, tts_warm,
};
pub use stt::{
    shutdown_whisper_server, voice_gpu, voice_status, voice_transcribe, voice_transcribe_pcm,
};

// PCM → WAV bytes (16-bit LE, 16 kHz mono). Used for the persistent
// whisper-server multipart POST and for the CLI fallback temp file, and as
// the TTS WAV encoder (24 kHz).
// Keeps audio as f32 internally until the last moment, no double WAV decode.
pub(crate) fn pcm_f32_to_wav_bytes(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(44 + samples.len() * 2);
    let len = samples.len() as u32;
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + len * 2).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(len * 2).to_le_bytes());
    for s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

// collision-resistant temp path for audio scratch files (pid + time + seq +
// thread hash); shared by the STT CLI paths via voice_install::unique_temp_path
pub(crate) use voice_install::unique_temp_path;
