#[cfg(target_os = "macos")]
mod platform {
    use security_framework::{
        base::Result,
        passwords::{
            generic_password, set_generic_password_options, AccessControlOptions, PasswordOptions,
        },
    };

    const SERVICE: &str = "com.securenote.vault.touchid";
    const ACCOUNT: &str = "vault-key-material";

    pub fn store(value: &[u8]) -> Result<()> {
        let mut options = PasswordOptions::new_generic_password(SERVICE, ACCOUNT);
        options.set_access_control_options(AccessControlOptions::BIOMETRY_CURRENT_SET);
        set_generic_password_options(value, options)
    }

    pub fn load() -> Result<Vec<u8>> {
        generic_password(PasswordOptions::new_generic_password(SERVICE, ACCOUNT))
    }
    pub fn delete() -> Result<()> {
        security_framework::passwords::delete_generic_password(SERVICE, ACCOUNT)
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub fn store(_: &[u8]) -> Result<(), String> {
        Err("biometric unlock is only available on macOS".into())
    }
    pub fn load() -> Result<Vec<u8>, String> {
        Err("biometric unlock is only available on macOS".into())
    }
    pub fn delete() -> Result<(), String> {
        Err("biometric unlock is only available on macOS".into())
    }
}

pub fn store(value: &[u8]) -> Result<(), String> {
    platform::store(value).map_err(|error| error.to_string())
}
pub fn load() -> Result<Vec<u8>, String> {
    platform::load().map_err(|error| error.to_string())
}
pub fn delete() -> Result<(), String> {
    platform::delete().map_err(|error| error.to_string())
}
